// The Google-verified Discord messages (plan: "BDA Absent: verified from Google Meet records" and the
// "Attendance Verified" recap), and that they arrive as soon as Google's data is settled instead of at the
// scheduled end. Discord is stubbed at fetch, so nothing leaves the machine.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
isolateExternalServices();

import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { processBooking } from '../Utils/MeetAttendanceScheduler.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `verified-${RUN}.test.invalid`;
const PREFIX = `__verified_${RUN}_`;
const SID = `sid@${D}`;
const MIN = 60 * 1000;
let seq = 0;

const ABSENT_URL = 'https://discord.test/absent';
const DURATION_URL = 'https://discord.test/duration';
const sidProfile = { email: SID, displayName: 'Siddhartha', firstName: `sid${RUN}`, lastName: 'b', aliases: [], tracked: true, active: true, googleUserId: 'users/11' };

// Discord stub: records every post as { url, content }.
let posts = [];
const realFetch = globalThis.fetch;
function stubDiscord() {
  posts = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://discord.test/')) {
      posts.push({ url: String(url), content: JSON.parse(init.body).content });
      return { ok: true, status: 204, headers: new Map(), text: async () => '' };
    }
    return realFetch(url, init);
  };
}
const toAbsent = () => posts.filter((p) => p.url === ABSENT_URL).map((p) => p.content);
const toDuration = () => posts.filter((p) => p.url === DURATION_URL).map((p) => p.content);

async function booking({ startOffset, durationMin = 30 }) {
  const start = Date.now() + startOffset;
  const doc = {
    bookingId: `${PREFIX}${++seq}`,
    clientName: 'Jess',
    clientEmail: `c${seq}@${D}`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + durationMin * MIN),
    googleMeetCode: 'abc-defg-hij',
    calendlyHost: { name: 'Siddhartha', email: SID },
    bookingCreatedAt: new Date(),
  };
  await CampaignBookingModel.create(doc);
  return { doc, start };
}
const session = (startMs, endMs) => ({ startTime: new Date(startMs), endTime: endMs ? new Date(endMs) : null });
const person = (displayName, userId, sessions) => ({
  name: `p/${displayName}`,
  displayName,
  kind: 'signedin',
  userId,
  earliestStartTime: sessions[0]?.startTime ?? null,
  latestEndTime: sessions[sessions.length - 1]?.endTime ?? null,
  sessions,
});
// `conferenceEndedMsAgo` null means the conference is still running.
const fakeGoogle = (participants, conferenceEndedMsAgo) => ({
  resolveMeetCode: async () => 'abc-defg-hij',
  findConferenceRecords: async () => [
    { name: 'conferenceRecords/x', endTime: conferenceEndedMsAgo == null ? null : new Date(Date.now() - conferenceEndedMsAgo) },
  ],
  listParticipants: async () => participants,
  registry: [sidProfile],
  resolveEmail: async () => null,
});

const filter = { bookingId: { $regex: `^${PREFIX}` } };
const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };
async function cleanup() {
  await Promise.all([CampaignBookingModel.deleteMany(filter), BdaAttendanceModel.deleteMany(filter), BdaProfileModel.deleteMany({ email: domainRe })]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([BdaAttendanceModel.init(), CampaignBookingModel.init()]);
});
after(async () => {
  globalThis.fetch = realFetch;
  await cleanup();
  await disconnectTestDb();
});
beforeEach(async () => {
  await cleanup();
  await BdaProfileModel.create({ email: SID, displayName: 'Siddhartha', firstName: sidProfile.firstName, tracked: true });
  process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL = ABSENT_URL;
  process.env.DISCORD_BDA_DURATION_WEBHOOK_URL = DURATION_URL;
  stubDiscord();
});

describe('verified absent', () => {
  it('posts "BDA Absent: verified from Google Meet records" with who was in the call, once, before the scheduled end', async () => {
    // Started 20 min ago, scheduled for 30: the slot is NOT over. The call ended 3 min ago with only the client in it.
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    const google = fakeGoogle([person('jesse valentino', 'users/99', [session(start + MIN, start + 17 * MIN)])], 3 * MIN);

    await processBooking(doc, new Date(), google);
    const absent = toAbsent();
    assert.equal(absent.length, 1, 'posted without waiting for the scheduled end');
    assert.match(absent[0], /^🚫 \*\*BDA Absent: verified from Google Meet records\*\*\n\*\*BDA:\*\* Siddhartha \(/);
    assert.match(absent[0], /\*\*Client:\*\* Jess\n/);
    assert.match(absent[0], /\*\*Who was in the call:\*\* jesse valentino\n/);
    assert.match(absent[0], /never joined/);
    assert.ok(!absent[0].includes('—'), 'no em dash');

    // The row stays open until the slot ends (a rejoin could still come), so later passes must not repeat it.
    await processBooking(doc, new Date(), google);
    await processBooking(doc, new Date(), google);
    assert.equal(toAbsent().length, 1, 'once per booking');
  });

  it('says nothing while the conference is still running, because the BDA could still join', async () => {
    const { doc, start } = await booking({ startOffset: -10 * MIN });
    await processBooking(doc, new Date(), fakeGoogle([person('jesse valentino', 'users/99', [session(start + MIN, null)])], null));
    assert.deepEqual(toAbsent(), []);
  });

  it('does not call a BDA absent when a button or the extension already had them present in time', async () => {
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    await BdaAttendanceModel.create({
      attendanceId: `a_${PREFIX}${seq}`,
      bookingId: doc.bookingId,
      bdaEmail: SID,
      bdaName: 'Siddhartha',
      status: 'unmarked',
      source: 'scheduler',
      verdict: 'present',
      verdictAt: new Date(),
      markedAt: new Date(),
      meetingScheduledStart: new Date(start),
    });
    await processBooking(doc, new Date(), fakeGoogle([person('jesse valentino', 'users/99', [session(start + MIN, start + 17 * MIN)])], 3 * MIN));
    assert.deepEqual(toAbsent(), []);
  });
});

describe('verified recap and duration', () => {
  it('posts the recap as soon as the BDA has been out for 2 minutes, not at the scheduled end', async () => {
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    // BDA joined 20 s early and left 10 minutes ago; the client is still in the call.
    const google = fakeGoogle(
      [person('Siddhartha', 'users/11', [session(start - 20 * 1000, start + 10 * MIN)]), person('jesse valentino', 'users/99', [session(start, null)])],
      null
    );
    await processBooking(doc, new Date(), google);
    const recap = toDuration();
    assert.equal(recap.length, 1);
    assert.match(recap[0], /^📋 \*\*Attendance Verified: Google Meet records\*\*\n/);
    assert.match(recap[0], /\*\*Duration \(total\):\*\* 10 min\n/);
    assert.match(recap[0], /\*\*In call when BDA joined:\*\* nobody|\*\*In call when BDA joined:\*\* /);
    assert.deepEqual(toAbsent(), [], 'on time, so no absent message');

    await processBooking(doc, new Date(), google);
    assert.equal(toDuration().length, 1, 'same numbers, no second post');
  });

  it('waits while the BDA is still in the call', async () => {
    const { doc, start } = await booking({ startOffset: -10 * MIN });
    await processBooking(doc, new Date(), fakeGoogle([person('Siddhartha', 'users/11', [session(start, null)])], null));
    assert.deepEqual(toDuration(), []);
  });

  it('waits out the 2 minute settle gap, so a quick rejoin does not produce a premature recap', async () => {
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    // Left 30 seconds ago.
    await processBooking(doc, new Date(), fakeGoogle([person('Siddhartha', 'users/11', [session(start, Date.now() - 30 * 1000)])], null));
    assert.deepEqual(toDuration(), []);
  });

  it('sends an update when the BDA rejoins after the first recap and the total moves by a minute or more', async () => {
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    const first = fakeGoogle([person('Siddhartha', 'users/11', [session(start, start + 5 * MIN)])], null);
    await processBooking(doc, new Date(), first);
    assert.equal(toDuration().length, 1);

    // Rejoined for 6 more minutes, ended 3 minutes ago.
    const second = fakeGoogle([person('Siddhartha', 'users/11', [session(start, start + 5 * MIN), session(start + 7 * MIN, start + 13 * MIN)])], null);
    await processBooking(doc, new Date(), second);
    const all = toDuration();
    assert.equal(all.length, 2);
    assert.match(all[1], /^🔄 \*\*Attendance Verified \(updated\): Google Meet records\*\*\n/);
    assert.match(all[1], /\*\*Duration \(total\):\*\* 11 min\n/);
  });
});

describe('joined late', () => {
  it('confirms from Google that a join after the Mark Present window counts as absent, once', async () => {
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    const google = fakeGoogle([person('Siddhartha', 'users/11', [session(start + 4 * MIN, start + 10 * MIN)])], null);
    await processBooking(doc, new Date(), google);
    const absent = toAbsent();
    assert.equal(absent.length, 1);
    assert.match(absent[0], /^🚫 \*\*BDA Absent: verified from Google Meet records\*\*\n/);
    assert.match(absent[0], /after the Mark Present window closed/);
    assert.match(absent[0], /\*\*Joined At:\*\* /);
    await processBooking(doc, new Date(), google);
    assert.equal(toAbsent().length, 1);
  });

  it('is silent for a join inside the window', async () => {
    const { doc, start } = await booking({ startOffset: -20 * MIN });
    await processBooking(doc, new Date(), fakeGoogle([person('Siddhartha', 'users/11', [session(start + 30 * 1000, start + 10 * MIN)])], null));
    assert.deepEqual(toAbsent(), []);
  });
});

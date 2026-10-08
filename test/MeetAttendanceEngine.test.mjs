import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();

import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { describeMeetCredentials, processBooking } from '../Utils/MeetAttendanceScheduler.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';

// processBooking with Google replaced by fakes: shows the row is keyed on the assigned BDA, the first join becomes a
// google_meet signal only for a stable-ID match, and finalizing never writes status 'absent'.

const RUN = Math.random().toString(36).slice(2, 8);
const D = `meeteng-${RUN}.test.invalid`;
const PREFIX = `__meeteng_${RUN}_`;
const SID = `sid@${D}`;
const KAL = `kal@${D}`;
const MIN = 60 * 1000;
let seq = 0;

const sidProfile = { email: SID, displayName: 'Siddhartha', firstName: `sid${RUN}`, lastName: 'b', aliases: [], tracked: true, active: true, googleUserId: 'users/11' };
const kalProfile = { email: KAL, displayName: 'Kalpataru', firstName: `kal${RUN}`, lastName: 's', aliases: [`kal${RUN} s`], tracked: true, active: true, googleUserId: 'users/22' };
const registry = [sidProfile, kalProfile];

async function booking({ startOffset, extra = {} }) {
  const start = Date.now() + startOffset;
  const doc = {
    bookingId: `${PREFIX}${++seq}`,
    clientName: 'Test Client',
    clientEmail: `c${seq}@${D}`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + 30 * MIN),
    googleMeetCode: 'abc-defg-hij',
    calendlyHost: { name: 'Sid', email: SID },
    bookingCreatedAt: new Date(),
    ...extra,
  };
  await CampaignBookingModel.create(doc);
  return { doc, start };
}

const session = (startMs, endMs) => ({ startTime: new Date(startMs), endTime: endMs ? new Date(endMs) : null });
function person(displayName, userId, sessions) {
  return {
    name: `p/${displayName}`,
    displayName,
    kind: 'signedin',
    userId,
    earliestStartTime: sessions[0]?.startTime ?? null,
    latestEndTime: sessions[sessions.length - 1]?.endTime ?? null,
    sessions,
  };
}
const fakeGoogle = (participants, ended = true) => ({
  resolveMeetCode: async () => 'abc-defg-hij',
  findConferenceRecords: async () => [{ name: 'conferenceRecords/x', endTime: ended ? new Date() : null }],
  listParticipants: async () => participants,
  registry,
  resolveEmail: async () => null,
});

const rowOf = (bookingId, email) => BdaAttendanceModel.findOne({ bookingId, bdaEmail: email }).lean();
const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };
const filter = { bookingId: { $regex: `^${PREFIX}` } };
async function cleanup() {
  await Promise.all([CampaignBookingModel.deleteMany(filter), BdaAttendanceModel.deleteMany(filter), BdaProfileModel.deleteMany({ email: domainRe })]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([BdaAttendanceModel.init(), CampaignBookingModel.init()]);
});
after(async () => {
  await cleanup();
  await disconnectTestDb();
});
beforeEach(async () => {
  await cleanup();
  // recordPresentSignal checks the live registry for the reporting BDA's display name only.
  await BdaProfileModel.create([
    { email: SID, displayName: 'Siddhartha', firstName: sidProfile.firstName, tracked: true },
    { email: KAL, displayName: 'Kalpataru', firstName: kalProfile.firstName, tracked: true },
  ]);
});

describe('MeetAttendanceScheduler.processBooking', () => {
  it('keys the row on the assigned BDA and reports the real first join as a google_meet signal', async () => {
    const { doc, start } = await booking({
      startOffset: -60 * MIN,
      extra: { attendanceAssignee: { email: KAL, name: 'Kalpataru', setBy: 'admin', setAt: new Date() } },
    });
    const join = start + 20 * 1000;
    const google = fakeGoogle([person('Kalpataru S', 'users/22', [session(join, start + 25 * MIN)]), person('A Client', 'users/99', [session(start + MIN, start + 25 * MIN)])]);
    await processBooking(doc, new Date(), google);

    assert.equal(await rowOf(doc.bookingId, SID), null, 'the Calendly host is not the assigned BDA');
    const row = await rowOf(doc.bookingId, KAL);
    assert.equal(row.matchedBy, 'stable_id');
    assert.equal(row.source, 'meet_api');
    assert.equal(new Date(row.firstJoinedAt).getTime(), join);
    assert.equal(row.signals.length, 1);
    assert.equal(row.signals[0].kind, 'google_meet');
    assert.equal(new Date(row.signals[0].eventAt).getTime(), join, 'the real join time, not the poll time');
    assert.equal(new Date(row.markedPresentAt).getTime(), join);
    assert.equal(row.bdaName, 'Kalpataru');
  });

  it('does not report a signal for a name-only match, but still fills in the times', async () => {
    const { doc, start } = await booking({ startOffset: -60 * MIN });
    const google = fakeGoogle([person(`${sidProfile.firstName} b`, null, [session(start + 30 * 1000, start + 20 * MIN)])]);
    await processBooking(doc, new Date(), google);
    const row = await rowOf(doc.bookingId, SID);
    assert.equal(row.matchedBy, 'name');
    assert.equal(new Date(row.firstJoinedAt).getTime(), start + 30 * 1000);
    assert.deepEqual(row.signals, []);
    assert.equal(row.markedPresentAt, null);
  });

  it('a late first join is stored as a signal but does not count toward the window', async () => {
    const { doc, start } = await booking({ startOffset: -60 * MIN });
    const google = fakeGoogle([person('Siddhartha', 'users/11', [session(start + 2 * MIN, start + 25 * MIN)])]);
    await processBooking(doc, new Date(), google);
    const row = await rowOf(doc.bookingId, SID);
    assert.equal(row.signals.length, 1);
    assert.equal(row.markedPresentAt, null);
    assert.notEqual(row.status, 'absent');
    assert.equal(row.verdict, null, 'the scheduler never writes a verdict');
  });

  it('finalizing keeps exact times and duration and never writes status absent', async () => {
    const { doc, start } = await booking({ startOffset: -60 * MIN });
    const out = start + 25 * MIN;
    const google = fakeGoogle([person('Siddhartha', 'users/11', [session(start + 5 * MIN, out)])]);
    await processBooking(doc, new Date(), google);
    const row = await rowOf(doc.bookingId, SID);
    assert.ok(row.meetApiFinalizedAt);
    assert.equal(new Date(row.leftAt).getTime(), out);
    assert.equal(row.durationMs, 20 * MIN);
    assert.equal(row.lateByMs, 5 * MIN);
    assert.notEqual(row.status, 'absent');
    assert.equal(row.verdict, null);
  });

  it('a meeting that ran without the BDA leaves an unmarked row with who was there, never an absent status', async () => {
    const { doc, start } = await booking({ startOffset: -60 * MIN });
    const google = fakeGoogle([person('A Client', 'users/99', [session(start + MIN, start + 20 * MIN)])]);
    await processBooking(doc, new Date(), google);
    const row = await rowOf(doc.bookingId, SID);
    assert.equal(row.status, 'unmarked');
    assert.equal(row.verdict, null);
    assert.deepEqual(row.signals, []);
    assert.deepEqual(row.participantsAtJoin.map((p) => p.displayName), ['A Client']);
    assert.ok(row.meetApiFinalizedAt);
  });

  it('does nothing for a booking nobody is assigned to', async () => {
    const { doc, start } = await booking({ startOffset: -60 * MIN, extra: { calendlyHost: null } });
    await processBooking(doc, new Date(), fakeGoogle([person('Siddhartha', 'users/11', [session(start, start + MIN)])]));
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId: doc.bookingId }), 0);
  });
});

describe('describeMeetCredentials', () => {
  it('returns one of json, file, split or MISSING and never a secret', () => {
    assert.match(describeMeetCredentials(), /^(json|file|split|MISSING)$/);
  });
});

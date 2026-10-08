import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { findBdaParticipant } from '../Utils/MeetAttendanceScheduler.js';

isolateExternalServices();

// Participant lists below are synthetic but follow the real shapes and name variants from plan 2.8
// (Meet display names "siddhartha b" and "Kalpataru S", the Cyrillic Calendly bot, Fireflies, FLASHFIRE).
// No network: the Directory lookup is injected.

const RUN = Math.random().toString(36).slice(2, 8);
const D = `meetmatch-${RUN}.test.invalid`;
const SID = `siddhartha@${D}`;
const KAL = `kalpataru@${D}`;
const HOST = `host@${D}`;
const CYRILLIC_BOT = 'Calendly Nоtеtаkеr';

const sidProfile = { email: SID, displayName: 'Siddhartha', firstName: 'siddhartha', lastName: 'basaveni', aliases: ['siddhartha b', 'basaveni siddhartha'], tracked: true, active: true, googleUserId: null };
const kalProfile = { email: KAL, displayName: 'Kalpataru', firstName: 'kalpataru', lastName: 'samal', aliases: ['kalpataru s', 'kalpataru samal'], tracked: true, active: true, googleUserId: null };

const person = (displayName, userId = null, kind = 'signedin') => ({ displayName, userId, kind, sessions: [] });
const directory = (map) => async ({ userId }) => map[userId] ?? null;
const noDirectory = async () => null;

const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };
const cleanup = async () => {
  await BdaProfileModel.deleteMany({ email: domainRe });
  invalidateRegistryCache();
};

before(async () => {
  await connectTestDb();
  await BdaProfileModel.init();
});
after(async () => {
  await cleanup();
  await disconnectTestDb();
});
beforeEach(cleanup);

const find = (args) => findBdaParticipant({ hostEmail: HOST, registry: [sidProfile, kalProfile], resolveEmail: noDirectory, ...args });

describe('findBdaParticipant: stable IDs', () => {
  it('matches the Directory email first and reports a stable match', async () => {
    const participants = [person('A Client', 'users/9'), person('siddhartha b', 'users/1')];
    const hit = await find({ participants, assignedEmail: SID, resolveEmail: directory({ 'users/1': SID }) });
    assert.equal(hit.participant, participants[1]);
    assert.equal(hit.via, 'email');
    assert.equal(hit.matchedBy, 'stable_id');
  });

  it('learns the Google user ID on the first Directory match, and only then', async () => {
    await BdaProfileModel.create({ email: SID, displayName: 'Siddhartha', firstName: 'siddhartha', tracked: true });
    const participants = [person('siddhartha b', 'users/1')];
    const registry = [{ ...sidProfile, googleUserId: null }];
    await findBdaParticipant({ participants, hostEmail: HOST, assignedEmail: SID, registry, resolveEmail: directory({ 'users/1': SID }) });
    assert.equal((await BdaProfileModel.findOne({ email: SID }).lean()).googleUserId, 'users/1');
    // A later Directory answer for a different ID does not overwrite it.
    await findBdaParticipant({
      participants: [person('x', 'users/2')], hostEmail: HOST, assignedEmail: SID, registry, resolveEmail: directory({ 'users/2': SID }),
    });
    assert.equal((await BdaProfileModel.findOne({ email: SID }).lean()).googleUserId, 'users/1');
  });

  it('falls back to the stored Google user ID when Directory fails', async () => {
    const participants = [person('Someone Else', 'users/9'), person('totally different name', 'users/222')];
    const hit = await find({ participants, assignedEmail: KAL, registry: [sidProfile, { ...kalProfile, googleUserId: 'users/222' }] });
    assert.equal(hit.participant, participants[1]);
    assert.equal(hit.via, 'google');
    assert.equal(hit.matchedBy, 'stable_id');
  });
});

describe('findBdaParticipant: names', () => {
  it('matches an alias and flags it as a name match that cannot decide a verdict', async () => {
    const participants = [person('Hemanth Dasu', 'users/9'), person('siddhartha b')];
    const hit = await find({ participants, assignedEmail: SID });
    assert.equal(hit.participant, participants[1]);
    assert.equal(hit.via, 'alias');
    assert.equal(hit.matchedBy, 'name');
  });

  it('matches "Kalpataru S" to Kalpataru', async () => {
    const hit = await find({ participants: [person('Kalpataru S')], assignedEmail: KAL });
    assert.equal(hit.matchedBy, 'name');
  });

  it('does not credit Kalpataru when the only match is a client named Siddhartha', async () => {
    const hit = await find({ participants: [person('Siddhartha Mehta')], assignedEmail: KAL });
    assert.equal(hit, null);
  });

  it('refuses to guess when a client shares the assigned BDA first name', async () => {
    const hit = await find({ participants: [person('siddhartha b'), person('Siddhartha Mehta')], assignedEmail: SID });
    assert.equal(hit, null);
  });

  it('never matches the Cyrillic Calendly bot, Fireflies, or the shared FLASHFIRE account', async () => {
    const participants = [person(CYRILLIC_BOT), person('Fireflies.ai Notetaker Hemanth Dasu'), person('FLASHFIRE')];
    assert.equal(await find({ participants, assignedEmail: SID }), null);
    assert.equal(await find({ participants, assignedEmail: KAL }), null);
  });

  it('skips a person Directory tied to a different registry BDA', async () => {
    // Kalpataru's Google account shows the display name "siddhartha b"; Directory knows better.
    const participants = [person('siddhartha b', 'users/5')];
    const hit = await find({ participants, assignedEmail: SID, resolveEmail: directory({ 'users/5': KAL }) });
    assert.equal(hit, null);
  });

  it('still allows a name match for a participant whose Directory email is unknown to the registry', async () => {
    const participants = [person('siddhartha b', 'users/5')];
    const hit = await find({ participants, assignedEmail: SID, resolveEmail: directory({ 'users/5': `alias.mail@${D}` }) });
    assert.equal(hit.matchedBy, 'name');
  });

  it('near-miss spellings are unknown', async () => {
    assert.equal(await find({ participants: [person('Kalpataruu'), person('Siddharthan Rao')], assignedEmail: KAL }), null);
  });

  it('keeps the old exact-name rule when the assigned person is not in the registry', async () => {
    const participants = [person('Some Host'), person('Other Person')];
    const hit = await find({ participants, assignedEmail: HOST, expectedNames: ['some  host'] });
    assert.equal(hit.participant, participants[0]);
    assert.equal(hit.matchedBy, 'name');
    assert.equal(await find({ participants: [person(CYRILLIC_BOT)], assignedEmail: HOST, expectedNames: ['Calendly Notetaker'] }), null);
  });
});

describe('audit replay: both BDAs recognised in every meeting where they joined (plan 2.8 step 4)', () => {
  // Each meeting: who was in the Meet, which BDA was assigned, and whether that BDA really joined.
  const meetings = [
    { assigned: SID, joined: true, participants: [person('siddhartha b', 'users/1'), person('Priya Nair', 'users/50'), person(CYRILLIC_BOT)] },
    { assigned: SID, joined: true, participants: [person('Basaveni siddhartha'), person('Arun K'), person('FLASHFIRE')] },
    { assigned: KAL, joined: true, participants: [person('Kalpataru S', 'users/2'), person('Fireflies.ai Notetaker Hemanth Dasu'), person('Hemanth Dasu')] },
    { assigned: KAL, joined: true, participants: [person('Kalpataru Samal'), person('Siddhartha Mehta')] },
    { assigned: KAL, joined: false, participants: [person('Siddhartha Mehta'), person(CYRILLIC_BOT)] },
    { assigned: SID, joined: false, participants: [person('Kalpataru S', 'users/2'), person('Hemanth Dasu'), person('FLASHFIRE')] },
  ];

  it('finds the assigned BDA in every meeting they joined and in none where they did not', async () => {
    const results = [];
    for (const m of meetings) {
      const hit = await find({ participants: m.participants, assignedEmail: m.assigned, resolveEmail: directory({ 'users/1': SID, 'users/2': KAL }) });
      results.push(Boolean(hit));
    }
    assert.deepEqual(results, meetings.map((m) => m.joined));
  });

  it('uses a stable ID wherever the participant was signed in', async () => {
    const resolveEmail = directory({ 'users/1': SID, 'users/2': KAL });
    const signedIn = await find({ participants: meetings[0].participants, assignedEmail: SID, resolveEmail });
    assert.equal(signedIn.matchedBy, 'stable_id');
    const anonymous = await find({ participants: meetings[1].participants, assignedEmail: SID, resolveEmail });
    assert.equal(anonymous.matchedBy, 'name');
  });
});

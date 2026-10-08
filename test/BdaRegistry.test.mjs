import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  connectTestDb,
  disconnectTestDb,
  isolateExternalServices,
} from './helpers/testDb.mjs';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { BdaUnknownNameModel } from '../Schema_Models/BdaUnknownName.js';
import {
  getTrackedBdas,
  getBdaProfile,
  isTrackedBda,
  isOnLeave,
  invalidateRegistryCache,
  learnGoogleUserId,
  learnZoomUserId,
  logUnknownName,
  getRecentUnknownNames,
} from '../Utils/BdaRegistry.js';

isolateExternalServices();

// Test data lives under a unique domain so parallel test files sharing the throwaway database never collide.
// The suffix is random per run because other agents run the whole suite in parallel against the same database.
const RUN = Math.random().toString(36).slice(2, 8);
const D = `registry-${RUN}.test.invalid`;
const TRACKED = `tracked@${D}`;
const UNTRACKED = `untracked@${D}`;
const LEFT = `left@${D}`;
const NAME_PREFIX = `zzreg${RUN} `;

async function cleanup() {
  await BdaProfileModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } });
  await BdaUnknownNameModel.deleteMany({ key: { $regex: `^zzreg${RUN}` } });
  invalidateRegistryCache();
}

const profile = (email, extra = {}) => ({
  email,
  displayName: email.split('@')[0],
  firstName: email.split('@')[0],
  lastName: 'test',
  ...extra,
});

before(async () => {
  await connectTestDb();
  await BdaProfileModel.init();
  await BdaUnknownNameModel.init();
});
after(async () => {
  await cleanup();
  await disconnectTestDb();
});
beforeEach(async () => {
  await cleanup();
  await BdaProfileModel.create([
    profile(TRACKED, { tracked: true, active: true, leaveDays: ['2026-10-12'] }),
    profile(UNTRACKED, { tracked: false, active: true }),
    profile(LEFT, { tracked: true, active: false }),
  ]);
});

describe('BdaProfile model', () => {
  it('lowercases the email and defaults to untracked so a new profile is never fined by accident', async () => {
    const p = await BdaProfileModel.create(profile(`MiXed@${D}`));
    assert.equal(p.email, `mixed@${D}`);
    assert.equal(p.tracked, false);
    assert.equal(p.active, true);
    assert.deepEqual(p.leaveDays, []);
  });

  it('enforces a unique email', async () => {
    await assert.rejects(BdaProfileModel.create(profile(TRACKED)), /E11000|duplicate/i);
  });

  it('rejects malformed leave days', async () => {
    await assert.rejects(
      BdaProfileModel.create(profile(`bad@${D}`, { leaveDays: ['12-10-2026'] })),
      /YYYY-MM-DD/
    );
  });
});

describe('registry lookups', () => {
  it('getTrackedBdas returns only active and tracked profiles', async () => {
    const emails = (await getTrackedBdas()).map((p) => p.email).filter((e) => e.endsWith(D));
    assert.deepEqual(emails, [TRACKED]);
  });

  it('getBdaProfile finds any profile case-insensitively, else null', async () => {
    assert.equal((await getBdaProfile(` ${UNTRACKED.toUpperCase()} `)).email, UNTRACKED);
    assert.equal(await getBdaProfile(`nobody@${D}`), null);
    assert.equal(await getBdaProfile(''), null);
    assert.equal(await getBdaProfile(null), null);
  });

  it('isTrackedBda is true only for active and tracked (a CRM role of bda is not enough)', async () => {
    assert.equal(await isTrackedBda(TRACKED), true);
    assert.equal(await isTrackedBda(UNTRACKED), false);
    assert.equal(await isTrackedBda(LEFT), false);
    assert.equal(await isTrackedBda(`pranjal@${D}`), false);
  });

  it('isOnLeave checks the IST date string', async () => {
    assert.equal(await isOnLeave(TRACKED, '2026-10-12'), true);
    assert.equal(await isOnLeave(TRACKED, '2026-10-13'), false);
    assert.equal(await isOnLeave(`nobody@${D}`, '2026-10-12'), false);
  });

  it('caches for 60 s and invalidateRegistryCache forces a fresh read', async () => {
    assert.equal(await isTrackedBda(UNTRACKED), false);
    // Direct write bypasses the cache on purpose.
    await BdaProfileModel.updateOne({ email: UNTRACKED }, { $set: { tracked: true } });
    assert.equal(await isTrackedBda(UNTRACKED), false, 'still served from cache');
    invalidateRegistryCache();
    assert.equal(await isTrackedBda(UNTRACKED), true);
  });
});

describe('learning stable IDs', () => {
  it('learnGoogleUserId fills an empty field and nothing else', async () => {
    assert.equal(await learnGoogleUserId(TRACKED, 'users/123'), true);
    assert.equal((await getBdaProfile(TRACKED)).googleUserId, 'users/123');
  });

  it('never overwrites an ID that is already stored', async () => {
    await learnGoogleUserId(TRACKED, 'users/123');
    assert.equal(await learnGoogleUserId(TRACKED, 'users/999'), false);
    assert.equal((await getBdaProfile(TRACKED)).googleUserId, 'users/123');
  });

  it('does nothing when the profile does not exist, and creates no profile', async () => {
    assert.equal(await learnGoogleUserId(`ghost@${D}`, 'users/1'), false);
    assert.equal(await BdaProfileModel.countDocuments({ email: `ghost@${D}` }), 0);
  });

  it('ignores blank input', async () => {
    assert.equal(await learnGoogleUserId(TRACKED, '  '), false);
    assert.equal(await learnZoomUserId('', 'z1'), false);
  });

  it('learnZoomUserId works the same way', async () => {
    assert.equal(await learnZoomUserId(TRACKED, 'zoom-abc'), true);
    assert.equal(await learnZoomUserId(TRACKED, 'zoom-other'), false);
    assert.equal((await getBdaProfile(TRACKED)).zoomUserId, 'zoom-abc');
  });
});

describe('unknown names', () => {
  it('logs a name once per distinct ref and counts by ref, not by poll', async () => {
    const name = `${NAME_PREFIX}Pat Q`;
    await logUnknownName({ name, source: 'google_meet', ref: 'booking-1' });
    await logUnknownName({ name, source: 'google_meet', ref: 'booking-1' }); // same meeting polled again
    await logUnknownName({ name, source: 'google_meet', ref: 'booking-2' });
    const row = (await getRecentUnknownNames(500)).find((r) => r.name === name);
    assert.equal(row.count, 2);
    assert.equal(row.source, 'google_meet');
    assert.ok(row.lastSeenAt instanceof Date);
  });

  it('folds look-alike spellings into one row', async () => {
    await logUnknownName({ name: `ZZreg${RUN} Pat`, ref: 'a' });
    await logUnknownName({ name: `zzreg${RUN}   pat`, ref: 'b' });
    assert.equal(await BdaUnknownNameModel.countDocuments({ key: `zzreg${RUN} pat` }), 1);
  });

  it('skips bots, the shared account and blanks: they are known, not unknown', async () => {
    assert.equal(await logUnknownName({ name: 'Calendly Nоtеtаkеr', ref: 'a' }), false);
    assert.equal(await logUnknownName({ name: 'Fireflies.ai Notetaker Zed', ref: 'a' }), false);
    assert.equal(await logUnknownName({ name: 'FLASHFIRE', ref: 'a' }), false);
    assert.equal(await logUnknownName({ name: '   ', ref: 'a' }), false);
  });

  it('returns the newest rows first, capped by the limit', async () => {
    for (const n of ['one', 'two', 'three']) {
      await logUnknownName({ name: `${NAME_PREFIX}${n}`, ref: n });
      await new Promise((r) => setTimeout(r, 5));
    }
    const rows = await getRecentUnknownNames(2);
    assert.equal(rows.length, 2);
    const mine = await BdaUnknownNameModel.find({ key: { $regex: `^zzreg${RUN}` } }).sort({ lastSeenAt: -1 }).lean();
    assert.equal(mine[0].name, `${NAME_PREFIX}three`);
  });
});

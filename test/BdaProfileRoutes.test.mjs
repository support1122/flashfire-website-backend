import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { BdaUnknownNameModel } from '../Schema_Models/BdaUnknownName.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { registerBdaProfileRoutes } from '../Routes/bdaProfileRoutes.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { isTrackedBda, invalidateRegistryCache, logUnknownName } from '../Utils/BdaRegistry.js';

isolateExternalServices();

// Random per run: other agents run the whole suite in parallel against the same throwaway database.
const RUN = Math.random().toString(36).slice(2, 8);
const D = `routes-${RUN}.test.invalid`;
const ADMIN = `admin@${D}`; // role admin
const FLAGGED = `flagged@${D}`; // role bda, isAdmin true (the two admin accounts in production look like this)
const BDA = `plainbda@${D}`; // role bda, not admin
const GONE = `gone@${D}`; // admin who was deactivated
const PROFILE = `siddhartha@${D}`;
const OTHER = `kalpataru@${D}`;
const NAME_PREFIX = `zzroute${RUN} `;
// Aliases and names are run-specific: the conflict check looks at every profile in the shared database.
const SID_ALIAS = `sidalias ${RUN}`;
const KAL_ALIAS = `kalalias ${RUN}`;
const KAL_FIRST = `kalfirst${RUN}`;
const KAL_LAST = `kallast${RUN}`;

let server;
let base;

const tokenFor = (email) => jwt.sign({ role: 'crm_user', email }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { email, body, raw } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(email ? { Authorization: `Bearer ${tokenFor(email)}` } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return { status: res.status, body: await res.json() };
}

const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };
async function cleanup() {
  await BdaProfileModel.deleteMany({ email: domainRe });
  await CrmUserModel.deleteMany({ email: domainRe });
  await BdaUnknownNameModel.deleteMany({ key: { $regex: `^zzroute${RUN}` } });
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([BdaProfileModel.init(), CrmUserModel.init(), BdaUnknownNameModel.init()]);
  const app = express();
  app.use(express.json());
  registerBdaProfileRoutes(app);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});
beforeEach(async () => {
  await cleanup();
  await CrmUserModel.create([
    { email: ADMIN, name: 'Admin', role: 'admin' },
    { email: FLAGGED, name: 'Flagged', role: 'bda', isAdmin: true },
    { email: BDA, name: 'Plain BDA', role: 'bda' },
    { email: GONE, name: 'Gone', role: 'admin', isActive: false },
  ]);
  await BdaProfileModel.create([
    { email: PROFILE, displayName: 'Siddhartha', firstName: 'siddhartha', lastName: 'basaveni', aliases: [SID_ALIAS], tracked: true },
    { email: OTHER, displayName: 'Kalpataru', firstName: KAL_FIRST, lastName: KAL_LAST, aliases: [KAL_ALIAS], tracked: true },
  ]);
});

describe('isCrmAdmin', () => {
  it('is true for role admin and for isAdmin true even with role bda', async () => {
    assert.equal(await isCrmAdmin({ email: ADMIN }), true);
    assert.equal(await isCrmAdmin({ email: FLAGGED }), true);
  });

  it('is false for a plain BDA, a deactivated admin, an unknown or missing user', async () => {
    assert.equal(await isCrmAdmin({ email: BDA }), false);
    assert.equal(await isCrmAdmin({ email: GONE }), false);
    assert.equal(await isCrmAdmin({ email: `nobody@${D}` }), false);
    assert.equal(await isCrmAdmin({}), false);
    assert.equal(await isCrmAdmin(null), false);
  });

  it('reads the database each call, so a token claiming admin is not trusted', async () => {
    // The payload says admin; the database says bda.
    assert.equal(await isCrmAdmin({ email: BDA, role: 'admin', isAdmin: true, bdaRole: 'admin' }), false);
    await CrmUserModel.updateOne({ email: BDA }, { $set: { isAdmin: true } });
    assert.equal(await isCrmAdmin({ email: BDA }), true);
  });

  it('is case-insensitive on the email', async () => {
    assert.equal(await isCrmAdmin({ email: ADMIN.toUpperCase() }), true);
  });
});

describe('GET /api/crm/admin/bda-profiles', () => {
  it('returns profiles and unknownNames for an admin', async () => {
    await logUnknownName({ name: `${NAME_PREFIX}Mystery Person`, source: 'google_meet', ref: 'b1' });
    const { status, body } = await call('GET', '/api/crm/admin/bda-profiles', { email: ADMIN });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    const mine = body.profiles.filter((p) => p.email.endsWith(D)).map((p) => p.email).sort();
    assert.deepEqual(mine, [OTHER, PROFILE].sort());
    assert.equal('__v' in body.profiles[0], false);
    const unknown = body.unknownNames.find((n) => n.name === `${NAME_PREFIX}Mystery Person`);
    assert.deepEqual(Object.keys(unknown).sort(), ['count', 'lastSeenAt', 'name', 'source']);
    assert.equal(unknown.source, 'google_meet');
    assert.ok(body.unknownNames.length <= 20);
  });

  it('allows an admin flagged with isAdmin even though the CRM role is bda', async () => {
    const { status } = await call('GET', '/api/crm/admin/bda-profiles', { email: FLAGGED });
    assert.equal(status, 200);
  });

  it('answers 403 forbidden to a non-admin BDA in the contract error shape', async () => {
    const { status, body } = await call('GET', '/api/crm/admin/bda-profiles', { email: BDA });
    assert.equal(status, 403);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'forbidden');
    assert.equal(typeof body.error.message, 'string');
  });

  it('answers 403 to a deactivated admin and 401 without a token', async () => {
    assert.equal((await call('GET', '/api/crm/admin/bda-profiles', { email: GONE })).status, 403);
    assert.equal((await call('GET', '/api/crm/admin/bda-profiles')).status, 401);
  });
});

describe('PUT /api/crm/admin/bda-profiles/:email', () => {
  const put = (email, body, as = ADMIN) => call('PUT', `/api/crm/admin/bda-profiles/${encodeURIComponent(email)}`, { email: as, body });

  it('updates every editable field and returns the profile', async () => {
    const { status, body } = await put(PROFILE, {
      aliases: [SID_ALIAS, ' sid basaveni ', SID_ALIAS.toUpperCase()],
      discordUserId: '123456789012345678',
      leaveDays: ['2026-10-14', '2026-10-12', '2026-10-12'],
      tracked: false,
      active: true,
    });
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.deepEqual(body.profile.aliases, [SID_ALIAS, 'sid basaveni'], 'trimmed and de-duplicated after folding');
    assert.deepEqual(body.profile.leaveDays, ['2026-10-12', '2026-10-14'], 'sorted and unique');
    assert.equal(body.profile.discordUserId, '123456789012345678');
    assert.equal(body.profile.tracked, false);
    const stored = await BdaProfileModel.findOne({ email: PROFILE }).lean();
    assert.equal(stored.tracked, false);
  });

  it('works on a partial update and leaves other fields alone', async () => {
    const { status, body } = await put(PROFILE, { leaveDays: ['2026-11-01'] });
    assert.equal(status, 200);
    assert.deepEqual(body.profile.aliases, [SID_ALIAS]);
    assert.equal(body.profile.tracked, true);
  });

  it('clears the Discord ID with null', async () => {
    await put(PROFILE, { discordUserId: '123456789012345678' });
    const { body } = await put(PROFILE, { discordUserId: null });
    assert.equal(body.profile.discordUserId, null);
  });

  it('invalidates the registry cache so a tracked flip is seen at once', async () => {
    assert.equal(await isTrackedBda(PROFILE), true); // warms the cache
    const { status } = await put(PROFILE, { tracked: false });
    assert.equal(status, 200);
    assert.equal(await isTrackedBda(PROFILE), false);
  });

  it('is case-insensitive on the email in the path', async () => {
    assert.equal((await put(PROFILE.toUpperCase(), { tracked: true })).status, 200);
  });

  it('answers 403 to a non-admin and changes nothing', async () => {
    const { status, body } = await put(PROFILE, { tracked: false }, BDA);
    assert.equal(status, 403);
    assert.equal(body.error.code, 'forbidden');
    assert.equal((await BdaProfileModel.findOne({ email: PROFILE }).lean()).tracked, true);
  });

  it('answers 404 profile_not_found for an unknown email', async () => {
    const { status, body } = await put(`nobody@${D}`, { tracked: true });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'profile_not_found');
  });

  const invalid = [
    ['leaveDays with a wrong format', { leaveDays: ['12-10-2026'] }, 'invalid_leave_days'],
    ['leaveDays with an impossible date', { leaveDays: ['2026-02-30'] }, 'invalid_leave_days'],
    ['leaveDays that is not an array', { leaveDays: '2026-10-12' }, 'invalid_leave_days'],
    ['leaveDays with a non-string', { leaveDays: [20261012] }, 'invalid_leave_days'],
    ['aliases that is not an array', { aliases: 'sid' }, 'invalid_aliases'],
    ['aliases with a non-string', { aliases: [5] }, 'invalid_aliases'],
    ['aliases with a blank entry', { aliases: ['   '] }, 'invalid_aliases'],
    ['aliases with punctuation only', { aliases: ['...'] }, 'invalid_aliases'],
    ['an alias that is too long', { aliases: ['a'.repeat(81)] }, 'invalid_aliases'],
    ['too many aliases', { aliases: Array.from({ length: 21 }, (_, i) => `alias ${i}`) }, 'invalid_aliases'],
    ['discordUserId that is not digits', { discordUserId: 'abc' }, 'invalid_discord_user_id'],
    ['discordUserId that is a number', { discordUserId: 123456789012345678 }, 'invalid_discord_user_id'],
    ['tracked as a string', { tracked: 'yes' }, 'invalid_tracked'],
    ['active as a number', { active: 1 }, 'invalid_active'],
    ['a field that is not editable', { email: `x@${D}` }, 'unknown_field'],
    ['an attempt to set googleUserId by hand', { googleUserId: 'users/1' }, 'unknown_field'],
    ['an empty object', {}, 'empty_update'],
  ];
  for (const [label, payload, code] of invalid) {
    it(`rejects ${label} with 422 ${code}`, async () => {
      const { status, body } = await put(PROFILE, payload);
      assert.equal(status, 422);
      assert.equal(body.success, false);
      assert.equal(body.error.code, code);
      const stored = await BdaProfileModel.findOne({ email: PROFILE }).lean();
      assert.deepEqual(stored.leaveDays, [], 'nothing was written');
    });
  }

  it('rejects a body that is not an object with 400 invalid_body', async () => {
    const arr = await put(PROFILE, [1, 2]);
    assert.equal(arr.status, 400);
    assert.equal(arr.body.error.code, 'invalid_body');
  });

  it('rejects an alias that belongs to another BDA with 409 alias_conflict', async () => {
    const byAlias = await put(PROFILE, { aliases: [KAL_ALIAS.toUpperCase()] });
    assert.equal(byAlias.status, 409);
    assert.equal(byAlias.body.error.code, 'alias_conflict');
    const byFirstName = await put(PROFILE, { aliases: [KAL_FIRST] });
    assert.equal(byFirstName.status, 409);
    const byFullName = await put(PROFILE, { aliases: [`${KAL_LAST} ${KAL_FIRST}`] });
    assert.equal(byFullName.status, 409);
    assert.deepEqual((await BdaProfileModel.findOne({ email: PROFILE }).lean()).aliases, [SID_ALIAS]);
  });

  it('lets a profile keep an alias it already owns', async () => {
    const r = await put(PROFILE, { aliases: [SID_ALIAS, `sidextra ${RUN}`] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
});

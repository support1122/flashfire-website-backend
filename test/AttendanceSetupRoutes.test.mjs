// The one-call setup routes. They can write to the live database, so the tests pin the safety rules first:
// admin only, dry run by default, a write needs the database name echoed back, everything is repeatable.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { connectTestDb, disconnectTestDb, isolateExternalServices, TEST_DB_NAME } from './helpers/testDb.mjs';
isolateExternalServices();

import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { AttendanceSetupRunModel } from '../Schema_Models/AttendanceSetupRun.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { SEED_PROFILES } from '../Utils/BdaSeed.js';
import { registerAttendanceSetupRoutes } from '../Routes/attendanceSetupRoutes.js';

const SEED_EMAILS = SEED_PROFILES.map((s) => s.email);
const BASE = '/api/crm/admin/attendance/setup';
let server;
let baseUrl;

const adminToken = () => jwt.sign({ role: 'crm_admin', email: 'admin@setup.test', name: 'Admin' }, getCrmJwtSecret(), { expiresIn: '1h' });
const extensionToken = () => jwt.sign({ role: 'bda_extension', email: 'bda@setup.test' }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { token = adminToken(), body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const seededCount = () => BdaProfileModel.countDocuments({ email: { $in: SEED_EMAILS } });
const wipe = async () => {
  await BdaProfileModel.deleteMany({ email: { $in: SEED_EMAILS } });
  await AttendanceSetupRunModel.deleteMany({ byEmail: 'admin@setup.test' });
  invalidateRegistryCache();
};

before(async () => {
  await connectTestDb();
  await wipe();
  const app = express();
  app.use(express.json());
  registerAttendanceSetupRoutes(app);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await wipe();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});
beforeEach(wipe);

describe('who may call it', () => {
  it('rejects a request with no token (401) and a non-admin token (403)', async () => {
    for (const [method, path] of [['GET', '/status'], ['POST', '/seed-profiles'], ['GET', '/call-link-audit'], ['POST', '/relink-calls'], ['POST', '/run']]) {
      const none = await call(method, `${BASE}${path}`, { token: null });
      assert.equal(none.status, 401, `${method} ${path} without a token`);
      assert.equal(none.body.success, false);
      const wrong = await call(method, `${BASE}${path}`, { token: extensionToken() });
      assert.equal(wrong.status, 403, `${method} ${path} with an extension token`);
    }
    assert.equal(await seededCount(), 0);
  });
});

describe('seed-profiles', () => {
  it('is a dry run by default: shows the plan and writes nothing', async () => {
    const r = await call('POST', `${BASE}/seed-profiles`, { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'dry-run');
    assert.equal(r.body.database, TEST_DB_NAME);
    assert.deepEqual(r.body.plan.map((p) => [p.email, p.action]), SEED_EMAILS.map((e) => [e, 'create']));
    assert.equal(await seededCount(), 0, 'nothing written');
    assert.equal(await AttendanceSetupRunModel.countDocuments({ byEmail: 'admin@setup.test' }), 0, 'a dry run is not logged');
  });

  it('refuses to write without the database name, and says which database it would write to', async () => {
    const noConfirm = await call('POST', `${BASE}/seed-profiles`, { body: { apply: true } });
    assert.equal(noConfirm.status, 409);
    assert.equal(noConfirm.body.error.code, 'confirmation_required');
    assert.equal(noConfirm.body.database, TEST_DB_NAME);
    assert.ok(noConfirm.body.error.message.includes(TEST_DB_NAME));
    const wrongDb = await call('POST', `${BASE}/seed-profiles`, { body: { apply: true, confirmDatabase: 'production' } });
    assert.equal(wrongDb.status, 409);
    assert.equal(await seededCount(), 0, 'still nothing written');
  });

  it('apply creates both BDAs as tracked, once; repeating changes nothing', async () => {
    const first = await call('POST', `${BASE}/seed-profiles`, { body: { apply: true, confirmDatabase: TEST_DB_NAME } });
    assert.equal(first.status, 200);
    assert.equal(first.body.mode, 'applied');
    assert.deepEqual(first.body.results.map((r) => r.action), ['created', 'created']);
    const profiles = await BdaProfileModel.find({ email: { $in: SEED_EMAILS } }).lean();
    assert.equal(profiles.length, 2);
    assert.ok(profiles.every((p) => p.tracked && p.active));
    assert.ok(profiles.find((p) => p.email === 'siddhartha@flashfirehq.com').aliases.includes('siddhartha b'));

    const second = await call('POST', `${BASE}/seed-profiles`, { body: { apply: true, confirmDatabase: TEST_DB_NAME } });
    assert.deepEqual(second.body.results.map((r) => r.action), ['unchanged', 'unchanged']);
    assert.equal(await seededCount(), 2, 'no duplicates');
    assert.equal(await AttendanceSetupRunModel.countDocuments({ byEmail: 'admin@setup.test', action: 'seed-profiles' }), 2, 'each write is logged with who ran it');
  });

  it('never overwrites what an admin changed afterwards', async () => {
    await call('POST', `${BASE}/seed-profiles`, { body: { apply: true, confirmDatabase: TEST_DB_NAME } });
    await BdaProfileModel.updateOne(
      { email: 'kalpataru@flashfirehq.com' },
      { $set: { tracked: false, discordUserId: '123456789', googleUserId: 'users/22' }, $pull: { aliases: 'kalpataru s' } }
    );
    const plan = await call('POST', `${BASE}/seed-profiles`, { body: {} });
    const kal = plan.body.plan.find((p) => p.email === 'kalpataru@flashfirehq.com');
    assert.equal(kal.action, 'update');
    assert.deepEqual(kal.addAliases, ['kalpataru s'], 'only the missing alias would be added');
    assert.equal(kal.tracked, false, 'the plan reports the admin choice');

    await call('POST', `${BASE}/seed-profiles`, { body: { apply: true, confirmDatabase: TEST_DB_NAME } });
    const after = await BdaProfileModel.findOne({ email: 'kalpataru@flashfirehq.com' }).lean();
    assert.equal(after.tracked, false, 'tracked stays off');
    assert.equal(after.discordUserId, '123456789');
    assert.equal(after.googleUserId, 'users/22');
    assert.ok(after.aliases.includes('kalpataru s'), 'the missing alias came back');
  });
});

describe('status', () => {
  it('flags an empty registry as the reason no alert fires, and clears once seeded', async () => {
    const before = await call('GET', `${BASE}/status`);
    assert.equal(before.status, 200);
    assert.equal(before.body.database, TEST_DB_NAME);
    // The shared test database can hold tracked profiles from other suites, so check the seed BDAs, not the total.
    assert.ok(!SEED_EMAILS.some((e) => before.body.registry.trackedEmails.includes(e)));
    if (before.body.registry.tracked === 0) {
      assert.equal(before.body.ready, false);
      assert.ok(before.body.problems.some((p) => /No tracked BDAs/.test(p)), before.body.problems.join(' | '));
    }

    await call('POST', `${BASE}/seed-profiles`, { body: { apply: true, confirmDatabase: TEST_DB_NAME } });
    const afterSeed = await call('GET', `${BASE}/status`);
    assert.ok(SEED_EMAILS.every((e) => afterSeed.body.registry.trackedEmails.includes(e)));
    assert.ok(!afterSeed.body.problems.some((p) => /No tracked BDAs/.test(p)));
    assert.equal(afterSeed.body.lastSetupRuns[0].action, 'seed-profiles');
  });

  it('reports configuration as booleans only and never leaks a secret value', async () => {
    process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL = 'https://discord.test/very-secret-token-123';
    try {
      const r = await call('GET', `${BASE}/status`);
      assert.equal(r.body.discordWebhooksConfigured.absent, true);
      assert.equal(r.body.discordWebhooksConfigured.attendance, false);
      assert.ok(!JSON.stringify(r.body).includes('very-secret-token-123'), 'no webhook value in the response');
      assert.ok(['json', 'file', 'split', 'MISSING'].some((m) => String(r.body.googleMeet.credentials).startsWith(m)));
      assert.ok(Array.isArray(r.body.syncHealth) && r.body.syncHealth.every((s) => 'healthy' in s && 'limitMs' in s));
    } finally {
      delete process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL;
    }
  });
});

describe('call-link-audit', () => {
  it('is read-only and validates days', async () => {
    const ok = await call('GET', `${BASE}/call-link-audit?days=30`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.audit.days, 30);
    assert.equal(typeof ok.body.audit.noShows, 'number');
    for (const bad of ['0', '91', 'abc', '1.5']) {
      const r = await call('GET', `${BASE}/call-link-audit?days=${bad}`);
      assert.equal(r.status, 422, `days=${bad}`);
      assert.equal(r.body.error.code, 'invalid_days');
    }
  });
});

describe('relink-calls', () => {
  it('dry run reports what it would change and writes nothing', async () => {
    const r = await call('POST', `${BASE}/relink-calls`, { body: { fixBookingKeys: true } });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'dry-run');
    assert.equal(r.body.stats.mode, 'DRY RUN');
    assert.equal(r.body.stats.bookingKeysFixed, 0);
  });

  it('apply is refused without the database name', async () => {
    const r = await call('POST', `${BASE}/relink-calls`, { body: { apply: true } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'confirmation_required');
  });
});

describe('run (everything in order)', () => {
  it('dry run touches nothing and returns every step plus the status', async () => {
    const r = await call('POST', `${BASE}/run`, { body: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'dry-run');
    assert.deepEqual(Object.keys(r.body.steps), ['seedProfiles', 'callLinkAudit', 'relinkCalls']);
    assert.ok(Object.values(r.body.steps).every((s) => s.ok));
    assert.equal(r.body.steps.seedProfiles.mode, 'dry-run');
    assert.ok(r.body.status && typeof r.body.status.ready === 'boolean');
    assert.equal(await seededCount(), 0);
  });

  it('apply needs the database name first, then seeds and ends with the registry ready', async () => {
    const refused = await call('POST', `${BASE}/run`, { body: { apply: true } });
    assert.equal(refused.status, 409);
    assert.equal(await seededCount(), 0, 'a refused run writes nothing at all');

    const r = await call('POST', `${BASE}/run`, { body: { apply: true, confirmDatabase: TEST_DB_NAME } });
    assert.ok([200, 207].includes(r.status));
    assert.equal(r.body.mode, 'applied');
    assert.equal(r.body.steps.seedProfiles.mode, 'applied');
    assert.ok(SEED_EMAILS.every((e) => r.body.status.registry.trackedEmails.includes(e)));
    assert.ok(!r.body.status.problems.some((p) => /No tracked BDAs/.test(p)));
    assert.equal(await AttendanceSetupRunModel.countDocuments({ byEmail: 'admin@setup.test', action: 'run' }), 1);
  });
});

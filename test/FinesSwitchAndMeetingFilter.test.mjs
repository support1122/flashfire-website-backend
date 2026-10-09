// The CRM fines switch (no env var), Meeting Info's BDA filter, and Calendly summaries reaching Meeting Info.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();
delete process.env.DEDUCTIONS_MODE;
delete process.env.DEDUCTIONS_LIVE_FROM;

import { getCrmJwtSecret, requireCrmPermission, requireCrmUser } from '../Middlewares/CrmAuth.js';
import { AppSettingModel } from '../Schema_Models/AppSetting.js';
import { CalendlyRecapModel } from '../Schema_Models/CalendlyRecap.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { getMeetingLinks } from '../Controllers/CampaignBookingController.js';
import { registerDeductionRoutes } from '../Routes/deductionRoutes.js';
import { getDeductionsMode, getLiveFrom, setDbDeductionSettings } from '../Utils/deductionPolicy.js';
import { refreshDeductionSettings } from '../Utils/DeductionSettings.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `fs-${RUN}.test.invalid`;
const PREFIX = `__fs_${RUN}_`;
const ADMIN = `admin@${D}`;
const BDA = `bda@${D}`;
const SID = `sid@${D}`;
const KAL = `kal@${D}`;
const MIN = 60 * 1000;

let server;
let base;
let seq = 0;
const token = (email, permissions = []) => jwt.sign({ role: 'crm_user', email, name: email.split('@')[0], permissions }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { as, body, permissions } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(as, permissions)}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mkBooking({ host, extra = {} }) {
  const bookingId = `${PREFIX}${++seq}`;
  const start = new Date('2026-09-15T10:00:00Z');
  await CampaignBookingModel.create({
    bookingId,
    clientName: `Client ${seq}`,
    clientEmail: `${bookingId}@${D}`,
    bookingStatus: 'completed',
    utmSource: 'direct',
    scheduledEventStartTime: start,
    scheduledEventEndTime: new Date(start.getTime() + 30 * MIN),
    calendlyHost: host ? { name: host.split('@')[0], email: host } : undefined,
    bookingCreatedAt: new Date(),
    ...extra,
  });
  return bookingId;
}

async function cleanup() {
  await Promise.all([
    CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } }),
    CalendlyRecapModel.deleteMany({ messageId: { $regex: `^${PREFIX}` } }),
    CrmUserModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } }),
    AppSettingModel.deleteMany({ key: 'deductions' }),
  ]);
  setDbDeductionSettings({});
}

before(async () => {
  await connectTestDb();
  const app = express();
  app.use(express.json());
  app.get('/api/meeting-links', requireCrmUser, requireCrmPermission('meeting_links'), getMeetingLinks);
  registerDeductionRoutes(app);
  await new Promise((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanup();
  await new Promise((r) => server.close(r));
  await disconnectTestDb();
});

beforeEach(async () => {
  await cleanup();
  await CrmUserModel.create({ email: ADMIN, name: 'Admin', role: 'admin', isActive: true, permissions: [] });
  await CrmUserModel.create({ email: BDA, name: 'Bda', role: 'bda', isActive: true, permissions: [] });
});

describe('fines switch (stored in the database, no env var)', () => {
  it('an admin turns fines live; it starts now, and the getters see it', async () => {
    assert.equal(getDeductionsMode(), 'off');
    const before = Date.now();
    const r = await call('PUT', '/api/crm/admin/deductions/settings', { as: ADMIN, body: { mode: 'live' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.settings.mode, 'live');
    assert.equal(r.body.settings.source, 'crm');
    assert.ok(new Date(r.body.settings.liveFrom).getTime() >= before - 1000);
    assert.equal(getDeductionsMode(), 'live');
    assert.ok(getLiveFrom() instanceof Date);

    // Another instance (fresh cache) picks it up from the database.
    setDbDeductionSettings({});
    assert.equal(getDeductionsMode(), 'off');
    await refreshDeductionSettings();
    assert.equal(getDeductionsMode(), 'live');
  });

  it('refuses a start in the past (it would fine earlier meetings), bad modes, and non-admins', async () => {
    const past = await call('PUT', '/api/crm/admin/deductions/settings', { as: ADMIN, body: { mode: 'live', liveFrom: '2026-01-01T00:00:00Z' } });
    assert.equal(past.status, 422);
    assert.equal(past.body.error.code, 'live_from_in_past');
    assert.equal((await call('PUT', '/api/crm/admin/deductions/settings', { as: ADMIN, body: { mode: 'on' } })).body.error.code, 'invalid_mode');
    assert.equal((await call('PUT', '/api/crm/admin/deductions/settings', { as: BDA, body: { mode: 'live' } })).status, 403);
    assert.equal(getDeductionsMode(), 'off');
  });

  it('an env var wins and makes the switch read-only', async () => {
    process.env.DEDUCTIONS_MODE = 'shadow';
    try {
      const r = await call('PUT', '/api/crm/admin/deductions/settings', { as: ADMIN, body: { mode: 'live' } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'env_override');
      assert.equal((await call('GET', '/api/crm/admin/deductions/settings', { as: ADMIN })).body.settings.source, 'env');
    } finally {
      delete process.env.DEDUCTIONS_MODE;
    }
  });

  it('turning off clears the start time', async () => {
    await call('PUT', '/api/crm/admin/deductions/settings', { as: ADMIN, body: { mode: 'live' } });
    const off = await call('PUT', '/api/crm/admin/deductions/settings', { as: ADMIN, body: { mode: 'off' } });
    assert.equal(off.body.settings.mode, 'off');
    assert.equal(off.body.settings.liveFrom, null);
  });
});

describe('Meeting Info: BDA filter and Calendly summaries', () => {
  const q = '/api/meeting-links?fromDate=2026-09-15&toDate=2026-09-15&limit=100';

  it('filters by the ASSIGNED BDA (reassignment beats the Calendly host)', async () => {
    const sid1 = await mkBooking({ host: SID });
    const kal1 = await mkBooking({ host: KAL });
    const coveredBySid = await mkBooking({ host: KAL, extra: { attendanceAssignee: { email: SID, name: 'Sid' } } });
    const all = await call('GET', q, { as: ADMIN, permissions: ['meeting_links'] });
    const ids = (r) => r.body.data.map((x) => x.bookingId).filter((id) => id.startsWith(PREFIX)).sort();
    assert.deepEqual(ids(all), [sid1, kal1, coveredBySid].sort());
    const sid = await call('GET', `${q}&bdaEmail=${encodeURIComponent(SID)}`, { as: ADMIN, permissions: ['meeting_links'] });
    assert.deepEqual(ids(sid), [sid1, coveredBySid].sort());
    const kal = await call('GET', `${q}&bdaEmail=${encodeURIComponent(KAL)}`, { as: ADMIN, permissions: ['meeting_links'] });
    assert.deepEqual(ids(kal), [kal1]);
  });

  it('rows carry the stored Calendly summary (it used to be hardcoded to null)', async () => {
    const bookingId = await mkBooking({ host: SID });
    await CalendlyRecapModel.create({
      messageId: `${PREFIX}m1`,
      sentAt: new Date('2026-09-15T10:40:00Z'),
      plainBody: 'x',
      summary: 'Client wants help with data roles.',
      recapUrl: 'https://calendly.com/app/notetaker/recaps/abc',
      bookingId,
      matchStatus: 'matched',
    });
    const r = await call('GET', `${q}&bdaEmail=${encodeURIComponent(SID)}`, { as: ADMIN, permissions: ['meeting_links'] });
    const row = r.body.data.find((x) => x.bookingId === bookingId);
    assert.equal(row.transcript.url, 'https://calendly.com/app/notetaker/recaps/abc');
    assert.match(row.transcript.summaryPreview, /data roles/);
    assert.equal(row.transcript.bookingId, bookingId);
  });
});

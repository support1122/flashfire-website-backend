// BDAs may only mark a lead Completed / No Show / Paid / Ignored, and Ignored needs a reason.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();

import { attachCrmUserOptional, getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { updateBookingStatus } from '../Controllers/CampaignBookingController.js';
import {
  BDA_SETTABLE_STATUSES,
  IGNORE_NOTE_MAX_LENGTH,
  IGNORE_REASONS,
  checkBdaStatusAllowed,
  formatIgnoreReason,
  parseIgnoreReason,
} from '../Utils/bdaStatusRules.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `bsr-${RUN}.test.invalid`;
const PREFIX = `__bsr_${RUN}_`;
const ADMIN = `admin@${D}`;
const BDA = `bda@${D}`;
const ANALYSIS_ADMIN = `analysis@${D}`; // signs in with a crm_admin token, has no CrmUser row
const MIN = 60 * 1000;

let server;
let base;
let seq = 0;

const crmUserToken = (email) =>
  jwt.sign({ role: 'crm_user', email, name: email.split('@')[0], permissions: [] }, getCrmJwtSecret(), { expiresIn: '1h' });
const crmAdminToken = (email) => jwt.sign({ role: 'crm_admin', email, name: 'Analysis' }, getCrmJwtSecret(), { expiresIn: '1h' });

async function setStatus(bookingId, body, token) {
  const res = await fetch(`${base}/api/campaign-bookings/${bookingId}/status`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mkBooking(extra = {}) {
  const bookingId = `${PREFIX}${++seq}`;
  const start = new Date(Date.now() - 2 * 60 * MIN); // meeting was two hours ago
  await CampaignBookingModel.create({
    bookingId,
    clientName: `Client ${seq}`,
    clientEmail: `${bookingId}@${D}`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: start,
    scheduledEventEndTime: new Date(start.getTime() + 30 * MIN),
    bookingCreatedAt: new Date(),
    ...extra,
  });
  return bookingId;
}

async function cleanup() {
  await Promise.all([
    CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } }),
    CrmUserModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } }),
  ]);
}

describe('bdaStatusRules (pure)', () => {
  it('lets a BDA set only the four outcome statuses', () => {
    assert.deepEqual(BDA_SETTABLE_STATUSES, ['completed', 'no-show', 'paid', 'ignored']);
    for (const s of BDA_SETTABLE_STATUSES) assert.equal(checkBdaStatusAllowed({ status: s, statusSource: 'bda' }).ok, true);
    for (const s of ['scheduled', 'rescheduled', 'canceled', 'not-scheduled']) {
      assert.equal(checkBdaStatusAllowed({ status: s, statusSource: 'bda' }).ok, false, s);
    }
  });

  it('never restricts admins or automations', () => {
    for (const source of ['admin', 'system', 'calendly', 'microservice']) {
      assert.equal(checkBdaStatusAllowed({ status: 'canceled', statusSource: source }).ok, true, source);
    }
  });

  it('requires a reason only when asked to', () => {
    assert.equal(parseIgnoreReason(undefined, { required: true }).ok, false);
    assert.equal(parseIgnoreReason('', { required: true }).ok, false);
    assert.deepEqual(parseIgnoreReason(undefined, { required: false }), { ok: true, value: null });
  });

  it('rejects unknown codes, non-objects, non-string notes and long notes', () => {
    assert.equal(parseIgnoreReason({ code: 'nope' }, { required: true }).ok, false);
    assert.equal(parseIgnoreReason('duplicate', { required: true }).ok, false);
    assert.equal(parseIgnoreReason(['duplicate'], { required: true }).ok, false);
    assert.equal(parseIgnoreReason({ code: 'duplicate', note: 42 }, { required: true }).ok, false);
    const long = 'x'.repeat(IGNORE_NOTE_MAX_LENGTH + 1);
    assert.equal(parseIgnoreReason({ code: 'duplicate', note: long }, { required: true }).ok, false);
  });

  it('"Other" needs a written note; whitespace does not count', () => {
    assert.equal(parseIgnoreReason({ code: 'other' }, { required: true }).ok, false);
    assert.equal(parseIgnoreReason({ code: 'other', note: '   ' }, { required: true }).ok, false);
    const r = parseIgnoreReason({ code: 'other', note: '  moved to a competitor ' }, { required: true });
    assert.deepEqual(r, { ok: true, value: { code: 'other', label: 'Other', note: 'moved to a competitor' } });
  });

  it('takes the label from the server list, not the request', () => {
    const r = parseIgnoreReason({ code: 'duplicate', label: 'HACKED' }, { required: true });
    assert.equal(r.value.label, IGNORE_REASONS.find((x) => x.code === 'duplicate').label);
    assert.equal(r.value.note, null);
  });

  it('formats the history line', () => {
    assert.equal(formatIgnoreReason(null), null);
    assert.equal(formatIgnoreReason({ label: 'Duplicate lead', note: null }), 'Duplicate lead');
    assert.equal(formatIgnoreReason({ label: 'Other', note: 'booked twice' }), 'Other: booked twice');
  });
});

describe('PUT /api/campaign-bookings/:id/status', () => {
  before(async () => {
    await connectTestDb();
    const app = express();
    app.use(express.json());
    app.put('/api/campaign-bookings/:bookingId/status', attachCrmUserOptional, updateBookingStatus);
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

  for (const status of ['scheduled', 'rescheduled', 'canceled', 'not-scheduled']) {
    it(`403s a BDA setting ${status} and leaves the booking alone`, async () => {
      const id = await mkBooking({ bookingStatus: 'no-show' });
      const r = await setStatus(id, { status, source: 'admin' }, crmUserToken(BDA)); // body source is ignored
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'STATUS_NOT_ALLOWED_FOR_BDA');
      const b = await CampaignBookingModel.findOne({ bookingId: id }).lean();
      assert.equal(b.bookingStatus, 'no-show');
    });
  }

  it('400s a BDA marking Ignored without a reason', async () => {
    const id = await mkBooking();
    const r = await setStatus(id, { status: 'ignored' }, crmUserToken(BDA));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'IGNORE_REASON_INVALID');
    const b = await CampaignBookingModel.findOne({ bookingId: id }).lean();
    assert.equal(b.bookingStatus, 'scheduled');
  });

  it('stores the reason on the booking and in status history', async () => {
    const id = await mkBooking();
    const r = await setStatus(
      id,
      { status: 'ignored', ignoreReason: { code: 'duplicate', note: 'booked twice' } },
      crmUserToken(BDA),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = await CampaignBookingModel.findOne({ bookingId: id }).lean();
    assert.equal(b.bookingStatus, 'ignored');
    assert.equal(b.statusChangeSource, 'bda');
    assert.equal(b.ignoreReason.code, 'duplicate');
    assert.equal(b.ignoreReason.label, 'Duplicate lead');
    assert.equal(b.ignoreReason.note, 'booked twice');
    assert.equal(b.ignoreReason.setByEmail, BDA);
    const last = b.statusHistory.at(-1);
    assert.equal(last.status, 'ignored');
    assert.equal(last.reason, 'Duplicate lead: booked twice');
  });

  it('clears the live reason when the lead leaves Ignored, keeps it in history', async () => {
    const id = await mkBooking();
    await setStatus(id, { status: 'ignored', ignoreReason: { code: 'spam' } }, crmUserToken(BDA));
    const r = await setStatus(id, { status: 'no-show' }, crmUserToken(BDA));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = await CampaignBookingModel.findOne({ bookingId: id }).lean();
    assert.equal(b.bookingStatus, 'no-show');
    assert.equal(b.ignoreReason, null);
    assert.ok(b.statusHistory.some((h) => h.status === 'ignored' && h.reason === 'Spam or fake lead'));
  });

  it('admins keep every status and may ignore without a reason', async () => {
    const id = await mkBooking();
    const r1 = await setStatus(id, { status: 'ignored' }, crmUserToken(ADMIN));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    const r2 = await setStatus(id, { status: 'canceled' }, crmUserToken(ADMIN));
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
  });

  it('treats a crm_admin token as an admin even without a CrmUser row', async () => {
    const id = await mkBooking();
    const r = await setStatus(id, { status: 'canceled' }, crmAdminToken(ANALYSIS_ADMIN));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = await CampaignBookingModel.findOne({ bookingId: id }).lean();
    assert.equal(b.statusChangeSource, 'admin');
  });

  it('treats a role "bda" account with isAdmin: true as an admin', async () => {
    const flagged = `flagged@${D}`;
    await CrmUserModel.create({ email: flagged, name: 'Flagged', role: 'bda', isAdmin: true, isActive: true, permissions: [] });
    const id = await mkBooking();
    const r = await setStatus(id, { status: 'canceled' }, crmUserToken(flagged));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('still rejects a bad reason from an admin who sends one', async () => {
    const id = await mkBooking();
    const r = await setStatus(id, { status: 'ignored', ignoreReason: { code: 'nope' } }, crmUserToken(ADMIN));
    assert.equal(r.status, 400);
  });
});

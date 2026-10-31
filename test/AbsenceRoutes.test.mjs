// Mark-absent routes against the throwaway test database: a BDA reports, an admin decides, the fine appears.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
isolateExternalServices();
process.env.DEDUCTIONS_MODE = 'live';
process.env.DEDUCTIONS_LIVE_FROM = '2026-01-01T00:00:00Z';

import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { SalesLeadAllocationModel } from '../Schema_Models/SalesLeadAllocation.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { BdaAbsenceReportModel } from '../Schema_Models/BdaAbsenceReport.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { istDate } from '../Utils/BdaAssignment.js';
import { registerAbsenceRoutes } from '../Routes/absenceRoutes.js';
import { registerSalesAllocationRoutes } from '../Routes/salesAllocationRoutes.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

const BDA = 'absent-bda@test.local';
const OTHER = 'absent-other@test.local';
const ADMIN = 'absent-admin@test.local';
const BASE = '/api/crm/absences';
let server;
let baseUrl;

const sign = (role, email) => jwt.sign({ role, email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });
const bdaToken = (email = BDA) => sign('crm_user', email);
const adminToken = () => sign('crm_admin', ADMIN);

async function call(method, path, { token = adminToken(), body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const HOUR = 3600 * 1000;
let seq = 0;
async function makeAllocation(over = {}) {
  seq += 1;
  return SalesLeadAllocationModel.create({
    allocationId: `alloc_abs_${Date.now()}_${seq}`,
    clientName: `Client ${seq}`,
    phone: '+15550000000',
    timezone: 'America/Chicago',
    callAt: new Date(Date.now() - 2 * HOUR),
    bdaEmail: BDA,
    bdaName: 'Absent Bda',
    ...over,
  });
}

const wipe = async () => {
  await BdaProfileModel.deleteMany({ email: { $in: [BDA, OTHER] } });
  await CrmUserModel.deleteMany({ email: ADMIN });
  await SalesLeadAllocationModel.deleteMany({ allocationId: /^alloc_abs_/ });
  await BdaDeductionModel.deleteMany({ bdaEmail: { $in: [BDA, OTHER] } });
  await BdaAbsenceReportModel.deleteMany({ bdaEmail: { $in: [BDA, OTHER] } });
  await CallLogModel.deleteMany({ callId: /^abs_call_/ });
  await CampaignBookingModel.deleteMany({ bookingId: /^abs_bk_/ });
  invalidateRegistryCache();
};

before(async () => {
  await connectTestDb();
  await wipe();
  const app = express();
  app.use(express.json());
  registerAbsenceRoutes(app);
  registerSalesAllocationRoutes(app);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await wipe();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});
beforeEach(async () => {
  await wipe();
  for (const [email, name] of [[BDA, 'Absent Bda'], [OTHER, 'Other Bda']]) {
    await BdaProfileModel.create({ email, displayName: name, firstName: name.split(' ')[0].toLowerCase(), tracked: true, active: true, trackedSince: new Date('2026-01-02') });
  }
  invalidateRegistryCache();
});

describe('who may call it', () => {
  it('needs a token', async () => {
    const r = await call('GET', `${BASE}?`, { token: null });
    assert.equal(r.status, 401);
  });
  it('only an admin can approve, reject or mark someone else absent', async () => {
    const a = await makeAllocation();
    const asBda = await call('POST', BASE, { token: bdaToken(OTHER), body: { kind: 'allocation', refId: a.allocationId, reason: 'they missed it' } });
    assert.equal(asBda.status, 403, 'a BDA cannot report another BDA');
    const mk = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'I missed this one' } });
    assert.equal(mk.status, 201);
    const id = mk.body.report.reportId;
    assert.equal((await call('POST', `${BASE}/${id}/approve`, { token: bdaToken() })).status, 403);
    assert.equal((await call('POST', `${BASE}/${id}/reject`, { token: bdaToken(), body: { reason: 'nope nope' } })).status, 403);
  });
});

describe('BDA reports a missed call', () => {
  it('creates a pending report and no fine until an admin approves', async () => {
    const a = await makeAllocation();
    const mk = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'My phone died' } });
    assert.equal(mk.status, 201);
    assert.equal(mk.body.report.status, 'pending');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0, 'nothing fined yet');
    assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: a.allocationId }).lean()).status, 'scheduled');

    const approve = await call('POST', `${BASE}/${mk.body.report.reportId}/approve`, { body: {} });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.report.status, 'approved');
    const fines = await BdaDeductionModel.find({ bdaEmail: BDA }).lean();
    assert.equal(fines.length, 1);
    assert.equal(fines[0].rule, 'missed_meeting');
    assert.equal(fines[0].status, 'active');
    assert.equal(fines[0].amountInr, 500);
    assert.equal(fines[0].evidence.manualAbsent.kind, 'allocation');
    assert.equal(fines[0].evidence.manualAbsent.reason, 'My phone died');
    assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: a.allocationId }).lean()).status, 'absent');
  });

  it('a rejected report leaves the call and the fines untouched', async () => {
    const a = await makeAllocation();
    const mk = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'Honestly not sure' } });
    const rej = await call('POST', `${BASE}/${mk.body.report.reportId}/reject`, { body: { reason: 'Logs show you called' } });
    assert.equal(rej.status, 200);
    assert.equal(rej.body.report.status, 'rejected');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0);
    assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: a.allocationId }).lean()).status, 'scheduled');
    // After a rejection the BDA may report again.
    const again = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'Adding more detail' } });
    assert.equal(again.status, 201);
  });

  it('refuses a second open report, a deciding twice and an unfinished call', async () => {
    const a = await makeAllocation();
    const body = { kind: 'allocation', refId: a.allocationId, reason: 'My phone died' };
    const first = await call('POST', BASE, { token: bdaToken(), body });
    assert.equal(first.status, 201);
    assert.equal((await call('POST', BASE, { token: bdaToken(), body })).body.error.code, 'already_reported');
    const id = first.body.report.reportId;
    assert.equal((await call('POST', `${BASE}/${id}/approve`, { body: {} })).status, 200);
    assert.equal((await call('POST', `${BASE}/${id}/approve`, { body: {} })).body.error.code, 'not_pending');
    assert.equal((await call('POST', `${BASE}/${id}/reject`, { body: { reason: 'changed my mind' } })).body.error.code, 'not_pending');
    const future = await makeAllocation({ callAt: new Date(Date.now() + HOUR) });
    const early = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: future.allocationId, reason: 'too early to say' } });
    assert.equal(early.body.error.code, 'call_not_over');
  });

  it('refuses a report for a call that already carries a fine, even a waived one', async () => {
    const a = await makeAllocation();
    await BdaDeductionModel.create({ bookingId: a.allocationId, bdaEmail: BDA, rule: 'missed_meeting', month: '2026-10', amountInr: 500, status: 'waived' });
    const r = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'I missed this one' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'already_fined');
    assert.equal(await BdaAbsenceReportModel.countDocuments({ bdaEmail: BDA }), 0, 'no report is queued');
  });

  it('nobody can mark or report a call on an approved leave day, by any route', async () => {
    const a = await makeAllocation();
    const day = istDate(new Date(a.callAt).getTime());
    await BdaProfileModel.updateOne({ email: BDA }, { $set: { leaveDays: [day] } });
    invalidateRegistryCache();
    const body = { kind: 'allocation', refId: a.allocationId, reason: 'marked by mistake' };

    const admin = await call('POST', BASE, { body });
    assert.equal(admin.status, 409);
    assert.equal(admin.body.error.code, 'on_leave');
    const own = await call('POST', BASE, { token: bdaToken(), body });
    assert.equal(own.body.error.code, 'on_leave', 'a BDA cannot report a leave day either');
    const batch = await call('POST', `${BASE}/batch`, { body: { items: [{ kind: 'allocation', refId: a.allocationId }], reason: 'marked by mistake' } });
    assert.equal(batch.body.results[0].error.code, 'on_leave');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0, 'no fine was written');
    assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: a.allocationId }).lean()).status, 'scheduled', 'the call was not closed');

    const list = await call('GET', `${BASE}/candidates?kind=allocation`);
    assert.equal(list.body.candidates.find((c) => c.refId === a.allocationId)?.blockedReason, 'leave', 'a leave day is listed but cannot be picked');

    // The engine refuses it too, so a future route that skips the checks above is still safe.
    const { createManualMiss } = await import('../Utils/DeductionEngine.js');
    const direct = await createManualMiss({ kind: 'allocation', refId: a.allocationId, bdaEmail: BDA, startMs: new Date(a.callAt).getTime(), actor: { email: ADMIN }, reason: 'direct call' });
    assert.equal(direct.code, 'on_leave');

    // Take the leave away and the same call can be marked again.
    await BdaProfileModel.updateOne({ email: BDA }, { $set: { leaveDays: [] } });
    invalidateRegistryCache();
    assert.equal((await call('POST', BASE, { body })).status, 201);
  });

  it('a BDA can withdraw their own pending report, not someone else\'s', async () => {
    const a = await makeAllocation();
    const mk = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'My phone died' } });
    const id = mk.body.report.reportId;
    assert.equal((await call('POST', `${BASE}/${id}/cancel`, { token: bdaToken(OTHER) })).status, 404);
    assert.equal((await call('POST', `${BASE}/${id}/cancel`, { token: bdaToken() })).body.report.status, 'cancelled');
  });

  it('approval fails cleanly when the BDA already closed the call', async () => {
    const a = await makeAllocation();
    const mk = await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'My phone died' } });
    await SalesLeadAllocationModel.updateOne({ allocationId: a.allocationId }, { $set: { status: 'completed' } });
    const approve = await call('POST', `${BASE}/${mk.body.report.reportId}/approve`, { body: {} });
    assert.equal(approve.status, 409);
    assert.equal(approve.body.error.code, 'not_scheduled');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0);
  });
});

describe('admin marks a call absent', () => {
  it('writes the fine at once and records an approved report', async () => {
    const a = await makeAllocation();
    const r = await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: 'Never called the client' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.report.status, 'approved');
    assert.equal(r.body.report.raisedBy, 'admin');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA, status: 'active' }), 1);
    assert.equal((await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: 'Never called the client' } })).status, 409);
  });

  it('settles a BDA report that is already waiting for the same call', async () => {
    const a = await makeAllocation();
    await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'My phone died' } });
    const r = await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: 'Confirmed by the logs' } });
    assert.equal(r.status, 201);
    assert.equal(await BdaAbsenceReportModel.countDocuments({ refId: a.allocationId }), 1, 'one report, not two');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 1);
  });

  it('charges the flat rate: the 6th miss still costs 500 (tiers apply only before the flat-rate date)', async () => {
    for (let i = 0; i < 6; i += 1) {
      const a = await makeAllocation({ callAt: new Date(Date.now() - (i + 2) * HOUR) });
      assert.equal((await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: `miss number ${i + 1}` } })).status, 201);
    }
    const rows = await BdaDeductionModel.find({ bdaEmail: BDA, status: 'active' }).sort({ 'evidence.scheduledStart': 1 }).lean();
    assert.deepEqual(rows.map((r) => r.amountInr), [500, 500, 500, 500, 500, 500]);
  });

  it('puts the call back to scheduled when fines are off', async () => {
    const a = await makeAllocation();
    process.env.DEDUCTIONS_MODE = 'off';
    try {
      const r = await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: 'Never called the client' } });
      assert.equal(r.status, 409);
      assert.equal(r.body.error.code, 'fines_off');
    } finally {
      process.env.DEDUCTIONS_MODE = 'live';
    }
    assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: a.allocationId }).lean()).status, 'scheduled');
    assert.equal(await BdaAbsenceReportModel.countDocuments({ refId: a.allocationId }), 0);
  });

  it('refuses an unknown call, and a BDA with no reason; an admin needs none', async () => {
    assert.equal((await call('POST', BASE, { body: { kind: 'allocation', refId: 'nope', reason: 'does not exist' } })).status, 404);
    const a = await makeAllocation();
    assert.equal((await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: '' } })).body.error.code, 'reason_required');
    const marked = await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: '' } });
    assert.equal(marked.status, 201, 'an admin can mark with no reason');
    assert.equal(marked.body.report.reason, 'Marked absent by an admin');
  });
});

describe('lists and candidates', () => {
  it('lists canceled and already-fined Calendly meetings with a reason instead of hiding them', async () => {
    const mk = (bookingId, over = {}) =>
      CampaignBookingModel.create({
        bookingId,
        clientName: bookingId,
        clientEmail: `${bookingId}@x.test`,
        scheduledEventStartTime: new Date(Date.now() - 3 * HOUR),
        bookingStatus: 'scheduled',
        utmSource: 'direct',
        scheduledEventEndTime: new Date(Date.now() - 2.5 * HOUR),
        bookingCreatedAt: new Date(),
        attendanceAssignee: { email: BDA },
        ...over,
      });
    await mk('abs_bk_open');
    await mk('abs_bk_cx', { bookingStatus: 'canceled' });
    await mk('abs_bk_fined');
    await BdaDeductionModel.create({ bdaEmail: BDA, bookingId: 'abs_bk_fined', rule: 'missed_meeting', amountInr: 500, status: 'active', month: istDate(Date.now()).slice(0, 7) });
    const list = await call('GET', `${BASE}/candidates?kind=booking`);
    const by = Object.fromEntries(list.body.candidates.filter((c) => c.refId.startsWith('abs_bk_')).map((c) => [c.refId, c.blockedReason]));
    assert.deepEqual(by, { abs_bk_open: null, abs_bk_cx: 'canceled', abs_bk_fined: 'fined' });
  });

  it('a BDA sees only their own reports; an admin sees all and a pending count', async () => {
    const a = await makeAllocation();
    const b = await makeAllocation({ bdaEmail: OTHER, bdaName: 'Other Bda' });
    await call('POST', BASE, { token: bdaToken(), body: { kind: 'allocation', refId: a.allocationId, reason: 'My phone died' } });
    await call('POST', BASE, { token: bdaToken(OTHER), body: { kind: 'allocation', refId: b.allocationId, reason: 'Wrong number given' } });
    const mine = await call('GET', BASE, { token: bdaToken() });
    assert.equal(mine.body.reports.length, 1);
    assert.equal(mine.body.reports[0].bdaEmail, BDA);
    assert.equal(mine.body.pendingCount, undefined);
    assert.equal((await call('GET', `${BASE}?bdaEmail=${OTHER}`, { token: bdaToken() })).status, 403);
    const all = await call('GET', BASE);
    assert.equal(all.body.reports.length, 2);
    assert.equal(all.body.pendingCount, 2);
    assert.equal((await call('GET', `${BASE}?status=pending&bdaEmail=${OTHER}`)).body.reports.length, 1);
  });

  it('candidates are past or same-day scheduled calls, scoped to the caller; fined ones are flagged', async () => {
    const past = await makeAllocation();
    const soon = await makeAllocation({ callAt: new Date(Date.now() + 30 * 1000) }); // still ahead, an admin may mark it in advance
    await makeAllocation({ callAt: new Date(Date.now() + 3 * 24 * HOUR) }); // beyond today, only with a date range
    await makeAllocation({ status: 'completed' });
    const fined = await makeAllocation();
    await call('POST', BASE, { body: { kind: 'allocation', refId: fined.allocationId, reason: 'Never called the client' } });
    await makeAllocation({ bdaEmail: OTHER, bdaName: 'Other Bda' });

    const mine = await call('GET', `${BASE}/candidates?kind=allocation`, { token: bdaToken() });
    assert.deepEqual(mine.body.candidates.filter((c) => !c.blockedReason).map((c) => c.refId), [past.allocationId]);
    assert.equal(mine.body.candidates.some((c) => c.refId === fined.allocationId), false, 'marking closes an allocation call, so it leaves the scheduled list');
    const admin = await call('GET', `${BASE}/candidates?kind=allocation`);
    assert.equal(admin.body.candidates.filter((c) => !c.blockedReason).length, 3, 'both BDAs plus the call about to start, minus completed and days ahead');
    assert.ok(admin.body.candidates.every((c) => !c.blockedReason));
    assert.deepEqual(admin.body.candidates.filter((c) => c.upcoming).map((c) => c.refId), [soon.allocationId]);
    assert.ok(mine.body.candidates.every((c) => c.upcoming === false));
    assert.equal((await call('GET', `${BASE}/candidates?kind=allocation&bdaEmail=${OTHER}`, { token: bdaToken() })).status, 403);
    assert.equal((await call('GET', `${BASE}/candidates?kind=nope`)).status, 422);
  });
});

describe('marking a call that has not happened yet (admin only)', () => {
  it('an admin can mark a call later today or up to a week ahead, a BDA cannot, and a month ahead is refused', async () => {
    const later = await makeAllocation({ callAt: new Date(Date.now() + 2 * HOUR) });
    const mark = (a, token) => call('POST', BASE, { token, body: { kind: 'allocation', refId: a.allocationId, reason: 'Said they cannot attend' } });
    assert.equal((await mark(later, bdaToken())).body.error.code, 'call_not_over');
    const done = await mark(later);
    assert.equal(done.status, 201);
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA, status: 'active' }), 1);

    const week = await makeAllocation({ callAt: new Date(Date.now() + 6 * 24 * HOUR) });
    assert.equal((await mark(week)).status, 201);
    const month = await makeAllocation({ callAt: new Date(Date.now() + 30 * 24 * HOUR) });
    const far = await mark(month);
    assert.equal(far.status, 409);
    assert.equal(far.body.error.code, 'too_far_ahead');
    assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: month.allocationId }).lean()).status, 'scheduled');
  });

  it('the picker shows an admin upcoming calls inside a date range, flagged, and a BDA never sees them', async () => {
    const tomorrow = await makeAllocation({ callAt: new Date(Date.now() + 26 * HOUR) });
    const day = (ms) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 10);
    const range = `from=${day(Date.now())}&to=${day(Date.now() + 2 * 24 * HOUR)}`;
    const admin = await call('GET', `${BASE}/candidates?kind=allocation&${range}`);
    const hit = admin.body.candidates.find((c) => c.refId === tomorrow.allocationId);
    assert.equal(hit?.upcoming, true);
    const bda = await call('GET', `${BASE}/candidates?kind=allocation&${range}`, { token: bdaToken() });
    assert.equal(bda.body.candidates.some((c) => c.refId === tomorrow.allocationId), false);
  });
});

describe('several calls at once', () => {
  const BATCH = `${BASE}/batch`;

  it('an admin marks many calls absent: one fine each, tiers in call order', async () => {
    const newer = await makeAllocation({ callAt: new Date(Date.now() - 2 * HOUR) });
    const older = await makeAllocation({ callAt: new Date(Date.now() - 5 * HOUR) });
    const r = await call('POST', BATCH, { body: { items: [{ kind: 'allocation', refId: newer.allocationId }, { kind: 'allocation', refId: older.allocationId }], reason: 'Never called the clients' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.succeeded, 2);
    assert.equal(r.body.failed, 0);
    assert.deepEqual(r.body.results.map((x) => x.refId), [older.allocationId, newer.allocationId], 'oldest first');
    const fines = await BdaDeductionModel.find({ bdaEmail: BDA }).lean();
    assert.equal(fines.length, 2);
    for (const a of [newer, older]) assert.equal((await SalesLeadAllocationModel.findOne({ allocationId: a.allocationId }).lean()).status, 'absent');
  });

  it('one bad call does not block the others, and says why', async () => {
    const good = await makeAllocation();
    const done = await makeAllocation();
    await call('POST', BASE, { body: { kind: 'allocation', refId: done.allocationId, reason: 'Already handled earlier' } });
    const future = await makeAllocation({ callAt: new Date(Date.now() + 30 * 24 * HOUR) }); // an hour ahead is now allowed for an admin
    const r = await call('POST', BATCH, { body: { items: [{ kind: 'allocation', refId: done.allocationId }, { kind: 'allocation', refId: future.allocationId }, { kind: 'allocation', refId: good.allocationId }, { kind: 'allocation', refId: 'nope' }], reason: 'Missed all of these' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.succeeded, 1);
    assert.equal(r.body.failed, 3);
    const byRef = Object.fromEntries(r.body.results.map((x) => [x.refId, x]));
    assert.equal(byRef[good.allocationId].ok, true);
    assert.equal(byRef[done.allocationId].error.code, 'not_scheduled');
    assert.equal(byRef[future.allocationId].error.code, 'too_far_ahead');
    assert.equal(byRef.nope.error.code, 'call_not_found');
  });

  it('a BDA files pending reports for their own calls only, and no fine exists yet', async () => {
    const mine1 = await makeAllocation();
    const mine2 = await makeAllocation();
    const theirs = await makeAllocation({ bdaEmail: OTHER, bdaName: 'Other Bda' });
    const r = await call('POST', BATCH, { token: bdaToken(), body: { items: [mine1, mine2, theirs].map((a) => ({ kind: 'allocation', refId: a.allocationId })), reason: 'My phone was off' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.succeeded, 2);
    assert.equal(r.body.results.find((x) => x.refId === theirs.allocationId).error.code, 'forbidden');
    assert.equal(await BdaAbsenceReportModel.countDocuments({ bdaEmail: BDA, status: 'pending' }), 2);
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0);
  });

  it('validates the request and ignores duplicates', async () => {
    const a = await makeAllocation();
    assert.equal((await call('POST', BATCH, { body: { items: [], reason: 'Some reason' } })).body.error.code, 'no_items');
    assert.equal((await call('POST', BATCH, { token: bdaToken(), body: { items: [{ kind: 'allocation', refId: a.allocationId }] } })).body.error.code, 'reason_required', 'a BDA needs a reason');
    const b = await makeAllocation();
    assert.equal((await call('POST', BATCH, { body: { items: [{ kind: 'allocation', refId: b.allocationId }] } })).body.succeeded, 1, 'an admin does not');
    const many = Array.from({ length: 51 }, (_, i) => ({ kind: 'allocation', refId: `x${i}` }));
    assert.equal((await call('POST', BATCH, { body: { items: many, reason: 'Some reason' } })).body.error.code, 'too_many_items');
    const dup = await call('POST', BATCH, { body: { items: [{ kind: 'allocation', refId: a.allocationId }, { kind: 'allocation', refId: a.allocationId }], reason: 'Some reason' } });
    assert.equal(dup.body.results.length, 1);
    assert.equal(dup.body.succeeded, 1);
    assert.equal((await call('POST', BATCH, { token: null, body: {} })).status, 401);
  });
});

describe('candidates date range', () => {
  const istDay = (ms) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 10);

  it('narrows by from and to (IST days), stays inside the 30 day window and rejects bad dates', async () => {
    const recent = await makeAllocation({ callAt: new Date(Date.now() - 2 * HOUR) });
    const threeDays = await makeAllocation({ callAt: new Date(Date.now() - 72 * HOUR) });
    const twentyDays = await makeAllocation({ callAt: new Date(Date.now() - 20 * 24 * HOUR) });
    const refs = async (qs) => (await call('GET', `${BASE}/candidates?kind=allocation${qs}`)).body.candidates.map((c) => c.refId).sort();

    const today = istDay(Date.now());
    assert.deepEqual(await refs(''), [recent.allocationId, threeDays.allocationId, twentyDays.allocationId].sort());
    assert.deepEqual(await refs(`&from=${istDay(Date.now() - 4 * 24 * HOUR)}`), [recent.allocationId, threeDays.allocationId].sort());
    assert.deepEqual(await refs(`&from=${istDay(Date.now() - 25 * 24 * HOUR)}&to=${istDay(Date.now() - 10 * 24 * HOUR)}`), [twentyDays.allocationId]);
    assert.deepEqual(await refs(`&to=${istDay(Date.now() - 10 * 24 * HOUR)}`), [twentyDays.allocationId]);
    assert.deepEqual(await refs(`&from=2020-01-01&to=2020-01-31`), [], 'older than 30 days stays out');
    assert.deepEqual(await refs(`&from=${today}&to=${today}`).then((r) => r.includes(threeDays.allocationId)), false);
    assert.equal((await call('GET', `${BASE}/candidates?kind=allocation&from=soon`)).body.error.code, 'invalid_date');
    assert.equal((await call('GET', `${BASE}/candidates?kind=allocation&to=2026-02-31`)).body.error.code, 'invalid_date');
  });
});

describe('did the BDA call the client', () => {
  const PHONE = '+1 415 555 0188';
  const KEY = '4155550188';

  it('the allocation list and the absence picker show what the Zoom call log says', async () => {
    const called = await makeAllocation({ phone: PHONE, clientName: 'Called Client', callAt: new Date(Date.now() - 3 * HOUR), createdAt: new Date(Date.now() - 10 * HOUR) });
    const silent = await makeAllocation({ phone: '+1 415 555 0199', clientName: 'Silent Client', callAt: new Date(Date.now() - 3 * HOUR) });
    await CallLogModel.create({
      callId: `abs_call_${Date.now()}`, direction: 'outbound', salesEmail: BDA, leadNumber: PHONE, leadNumberNormalized: KEY,
      startedAt: new Date(Date.now() - 3 * HOUR - 4 * 60000), durationSec: 75, callResult: 'connected',
    });

    const list = await call('GET', '/api/crm/sales-allocations?scope=past');
    assert.equal(list.status, 200);
    const byId = Object.fromEntries(list.body.allocations.map((a) => [a.allocationId, a]));
    assert.equal(byId[called.allocationId].callCheck.verdict, 'called_in_time');
    assert.equal(byId[called.allocationId].callCheck.firstCallOffsetMin, -4);
    assert.equal(byId[silent.allocationId].callCheck.verdict, 'not_called');

    const mine = await call('GET', '/api/crm/sales-allocations?scope=past', { token: bdaToken() });
    assert.equal(mine.body.allocations.find((a) => a.allocationId === silent.allocationId).callCheck.verdict, 'not_called');

    const picker = await call('GET', `${BASE}/candidates?kind=allocation`);
    const cand = Object.fromEntries(picker.body.candidates.map((c) => [c.refId, c]));
    assert.equal(cand[called.allocationId].callCheck.verdict, 'called_in_time');
    assert.equal(cand[silent.allocationId].callCheck.verdict, 'not_called');
  });
});

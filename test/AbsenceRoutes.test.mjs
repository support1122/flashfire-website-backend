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
import { registerAbsenceRoutes } from '../Routes/absenceRoutes.js';

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
  invalidateRegistryCache();
};

before(async () => {
  await connectTestDb();
  await wipe();
  const app = express();
  app.use(express.json());
  registerAbsenceRoutes(app);
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

  it('uses the monthly tiers: the 6th miss costs 1000', async () => {
    for (let i = 0; i < 6; i += 1) {
      const a = await makeAllocation({ callAt: new Date(Date.now() - (i + 2) * HOUR) });
      assert.equal((await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: `miss number ${i + 1}` } })).status, 201);
    }
    const rows = await BdaDeductionModel.find({ bdaEmail: BDA, status: 'active' }).sort({ 'evidence.scheduledStart': 1 }).lean();
    assert.deepEqual(rows.map((r) => r.amountInr), [500, 500, 500, 500, 500, 1000]);
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

  it('refuses an unknown call and a missing reason', async () => {
    assert.equal((await call('POST', BASE, { body: { kind: 'allocation', refId: 'nope', reason: 'does not exist' } })).status, 404);
    const a = await makeAllocation();
    assert.equal((await call('POST', BASE, { body: { kind: 'allocation', refId: a.allocationId, reason: '' } })).body.error.code, 'reason_required');
  });
});

describe('lists and candidates', () => {
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

  it('candidates are past, scheduled, unfined calls, scoped to the caller', async () => {
    const past = await makeAllocation();
    await makeAllocation({ callAt: new Date(Date.now() + HOUR) }); // future
    await makeAllocation({ status: 'completed' });
    const fined = await makeAllocation();
    await call('POST', BASE, { body: { kind: 'allocation', refId: fined.allocationId, reason: 'Never called the client' } });
    await makeAllocation({ bdaEmail: OTHER, bdaName: 'Other Bda' });

    const mine = await call('GET', `${BASE}/candidates?kind=allocation`, { token: bdaToken() });
    assert.deepEqual(mine.body.candidates.map((c) => c.refId), [past.allocationId]);
    const admin = await call('GET', `${BASE}/candidates?kind=allocation`);
    assert.equal(admin.body.candidates.length, 2, 'both BDAs, minus fined, completed and future');
    assert.equal((await call('GET', `${BASE}/candidates?kind=allocation&bdaEmail=${OTHER}`, { token: bdaToken() })).status, 403);
    assert.equal((await call('GET', `${BASE}/candidates?kind=nope`)).status, 422);
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
    const future = await makeAllocation({ callAt: new Date(Date.now() + HOUR) });
    const r = await call('POST', BATCH, { body: { items: [{ kind: 'allocation', refId: done.allocationId }, { kind: 'allocation', refId: future.allocationId }, { kind: 'allocation', refId: good.allocationId }, { kind: 'allocation', refId: 'nope' }], reason: 'Missed all of these' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.succeeded, 1);
    assert.equal(r.body.failed, 3);
    const byRef = Object.fromEntries(r.body.results.map((x) => [x.refId, x]));
    assert.equal(byRef[good.allocationId].ok, true);
    assert.equal(byRef[done.allocationId].error.code, 'not_scheduled');
    assert.equal(byRef[future.allocationId].error.code, 'call_not_over');
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
    assert.equal((await call('POST', BATCH, { body: { items: [{ kind: 'allocation', refId: a.allocationId }] } })).body.error.code, 'reason_required');
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

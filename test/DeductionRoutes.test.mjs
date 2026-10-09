import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import '../Utils/DiscordConnect.js'; // load dotenv before isolateExternalServices() clears the webhook variables
import '../Utils/attendanceDiscord.js';
import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { PayrollModel } from '../Schema_Models/Payroll.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { registerDeductionRoutes } from '../Routes/deductionRoutes.js';

isolateExternalServices();
for (const k of ['DISCORD_BDA_DEDUCTIONS_WEBHOOK_URL', 'DISCORD_BDA_ADMIN_WEBHOOK_URL', 'DISCORD_BDA_ABSENT_WEBHOOK_URL', 'DISCORD_BDA_ATTENDANCE_WEBHOOK_URL']) {
  process.env[k] = '';
}
delete process.env.DEDUCTIONS_MODE;
delete process.env.DEDUCTIONS_LIVE_FROM;

// Random per run: other suites share this throwaway database.
const RUN = Math.random().toString(36).slice(2, 8);
const PFX = `dr${RUN}`;
const D = `dr-${RUN}.test.invalid`;
const domainRe = { $regex: `@${D.replace(/\./g, '\\.')}$` };
const ADMIN = `admin@${D}`; // role admin
const FLAGGED = `flagged@${D}`; // role bda, isAdmin true: the shape of the two real admin accounts
const SID = `sid@${D}`; // plain BDA
const KAL = `kal@${D}`; // plain BDA
// A month nobody else uses: admins list every BDA's rows for a month, and the shared database holds other suites' rows.
const MONTH = `${3000 + (parseInt(RUN, 36) % 6000)}-06`;
const NAME_KEY = `zzdr${RUN}`;

let server;
let base;

const userToken = (email, extra = {}) =>
  jwt.sign({ role: 'crm_user', email, name: email.split('@')[0], bdaRole: 'bda', permissions: [], ...extra }, getCrmJwtSecret(), { expiresIn: '1h' });
const adminGateToken = (extra = {}) => jwt.sign({ role: 'crm_admin', email: ADMIN, name: 'Gate Admin', ...extra }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
const row = (over = {}) => {
  seq += 1;
  return {
    deductionId: `${PFX}-ded-${seq}`,
    bookingId: `${PFX}-bk-${seq}`,
    bdaEmail: SID,
    rule: 'missed_meeting',
    month: MONTH,
    amountInr: 500,
    tierIndex: 1,
    status: 'active',
    evidence: { scheduledStart: new Date(Date.UTC(2026, 9, seq, 10)), clientName: `Client ${seq}`, bookingStatus: 'scheduled', callSummary: null },
    ...over,
  };
};

async function cleanup() {
  const byId = { deductionId: { $regex: `^${PFX}-` } };
  await Promise.all([
    BdaDeductionModel.deleteMany(byId),
    BdaDeductionModel.deleteMany({ bookingId: { $regex: `^${PFX}-` } }),
    BdaAttendanceModel.deleteMany({ bookingId: { $regex: `^${PFX}-` } }),
    CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PFX}-` } }),
    CrmUserModel.deleteMany({ email: domainRe }),
    BdaProfileModel.deleteMany({ email: domainRe }),
    PayrollModel.deleteMany({ employeeName: { $regex: `^${NAME_KEY}` } }),
  ]);
  invalidateRegistryCache();
}

before(async () => {
  await connectTestDb();
  await Promise.all([
    BdaDeductionModel.init(), BdaAttendanceModel.init(), CampaignBookingModel.init(), CrmUserModel.init(),
    BdaProfileModel.init(), PayrollModel.init(),
  ]);
  const app = express();
  app.use(express.json());
  registerDeductionRoutes(app);
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  delete process.env.DEDUCTIONS_MODE;
  delete process.env.DEDUCTIONS_LIVE_FROM;
  await cleanup();
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});
beforeEach(async () => {
  await cleanup();
  delete process.env.DEDUCTIONS_MODE;
  delete process.env.DEDUCTIONS_LIVE_FROM;
  await CrmUserModel.create([
    { email: ADMIN, name: 'Admin', role: 'admin' },
    { email: FLAGGED, name: 'Flagged', role: 'bda', isAdmin: true },
    { email: SID, name: 'Sid', role: 'bda' },
    { email: KAL, name: 'Kal', role: 'bda' },
  ]);
});

describe('isCrmAdmin on these routes', () => {
  it('a user with role bda and isAdmin true passes the admin check, a plain BDA does not', async () => {
    assert.equal(await isCrmAdmin({ email: FLAGGED }), true);
    assert.equal(await isCrmAdmin({ email: SID }), false);
    const target = row();
    await BdaDeductionModel.create(target);
    // Token says bdaRole 'bda' (as the real accounts do); the database says isAdmin.
    const ok = await call('POST', `/api/crm/deductions/${target.deductionId}/waive`, {
      token: userToken(FLAGGED, { bdaRole: 'bda' }), body: { reason: 'Admin by flag, not by role' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.deduction.status, 'waived');
    assert.equal(ok.body.deduction.waivedBy, FLAGGED);
  });
});

describe('GET /api/crm/deductions', () => {
  it('needs a token', async () => {
    const res = await call('GET', `/api/crm/deductions?month=${MONTH}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.success, false);
    assert.equal(res.body.error.code, 'unauthorized');
  });

  it('a BDA sees only their own rows, an admin sees everyone, and the response matches the contract', async () => {
    await BdaDeductionModel.create([row(), row({ rule: 'no_show_not_called', amountInr: 100, tierIndex: null }), row({ bdaEmail: KAL })]);

    const mine = await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: userToken(SID) });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.success, true);
    assert.equal(mine.body.month, MONTH);
    assert.equal(mine.body.mode, 'off');
    assert.equal(mine.body.rows.length, 2);
    assert.ok(mine.body.rows.every((r) => r.bdaEmail === SID));
    assert.equal(mine.body.totals.activeAmountInr, 600);
    assert.deepEqual(mine.body.totals.byRule.missed_meeting, { count: 1, amountInr: 500 });
    assert.deepEqual(mine.body.totals.byRule.status_not_updated, { count: 0, amountInr: 0 });

    const first = mine.body.rows.find((r) => r.rule === 'missed_meeting');
    assert.deepEqual(Object.keys(first).sort(), [
      'amountInr', 'bdaEmail', 'bdaName', 'bookingId', 'clientName', 'createdAt', 'deductionId', 'evidence', 'month',
      'reviewReason', 'reviewedAt', 'reviewedBy', 'reviewedByName', 'rule', 'status', 'tierIndex', 'voidReason',
      'voidedAt', 'waivedAt', 'waivedBy', 'waivedByName', 'waiverReason',
    ]);
    assert.equal(first.clientName.startsWith('Client'), true);
    assert.equal(typeof first.evidence.scheduledStart, 'string');
    assert.deepEqual(first.evidence.callSummary, {});
    assert.equal(first.bdaName, 'sid', 'falls back to the email name when no registry profile exists');

    const all = await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: userToken(ADMIN) });
    assert.equal(all.body.rows.length, 3);
    const only = await call('GET', `/api/crm/deductions?month=${MONTH}&bdaEmail=${KAL}`, { token: userToken(ADMIN) });
    assert.deepEqual(only.body.rows.map((r) => r.bdaEmail), [KAL]);
  });

  it('a BDA cannot read another BDA by passing bdaEmail', async () => {
    await BdaDeductionModel.create(row({ bdaEmail: KAL }));
    const res = await call('GET', `/api/crm/deductions?month=${MONTH}&bdaEmail=${KAL}`, { token: userToken(SID) });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
    const own = await call('GET', `/api/crm/deductions?month=${MONTH}&bdaEmail=${SID.toUpperCase()}`, { token: userToken(SID) });
    assert.equal(own.status, 200);
  });

  it('shadow rows are invisible to the BDA and visible to admins; mode shows what the server is running', async () => {
    process.env.DEDUCTIONS_MODE = 'shadow';
    await BdaDeductionModel.create([row({ status: 'shadow' }), row({ status: 'shadow', rule: 'status_not_updated', amountInr: 50, tierIndex: null })]);
    const bda = await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: userToken(SID) });
    assert.equal(bda.body.mode, 'shadow');
    assert.deepEqual(bda.body.rows, []);
    assert.equal(bda.body.totals.activeAmountInr, 0);
    const admin = await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: userToken(ADMIN) });
    assert.equal(admin.body.rows.length, 2);
    assert.ok(admin.body.rows.every((r) => r.status === 'shadow'));
    assert.equal(admin.body.totals.activeAmountInr, 0, 'shadow never counts');
  });

  it('needs_review is returned to the BDA with its status but never counted; waived and voided are shown too', async () => {
    await BdaDeductionModel.create([
      row(), row({ status: 'needs_review', tierIndex: null }), row({ status: 'waived', waiverReason: 'ok', tierIndex: null }),
      row({ status: 'voided', voidReason: 'late_evidence', tierIndex: null }),
    ]);
    const res = await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: userToken(SID) });
    assert.deepEqual(res.body.rows.map((r) => r.status).sort(), ['active', 'needs_review', 'voided', 'waived']);
    assert.equal(res.body.totals.activeAmountInr, 500);
  });

  it('works with the admin-gate token, and validates the month', async () => {
    await BdaDeductionModel.create([row(), row({ bdaEmail: KAL })]);
    const gate = await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: adminGateToken() });
    assert.equal(gate.status, 200);
    assert.equal(gate.body.rows.length, 2);
    const bad = await call('GET', '/api/crm/deductions?month=oct', { token: adminGateToken() });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'invalid_month');
    const dflt = await call('GET', '/api/crm/deductions', { token: adminGateToken() });
    assert.match(dflt.body.month, /^\d{4}-\d{2}$/);
  });

  it('rejects tokens that are neither crm_user nor crm_admin', async () => {
    const t = jwt.sign({ role: 'bda_extension', email: SID }, getCrmJwtSecret(), { expiresIn: '1h' });
    assert.equal((await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: t })).status, 403);
    assert.equal((await call('GET', `/api/crm/deductions?month=${MONTH}`, { token: 'garbage' })).status, 401);
  });
});

describe('POST waive and activate', () => {
  it('a BDA cannot waive, even their own deduction', async () => {
    const target = row();
    await BdaDeductionModel.create(target);
    const res = await call('POST', `/api/crm/deductions/${target.deductionId}/waive`, { token: userToken(SID), body: { reason: 'I was ill, please waive' } });
    assert.equal(res.status, 403);
    assert.equal((await BdaDeductionModel.findOne({ deductionId: target.deductionId }).lean()).status, 'active');
  });

  it('an admin waives with a reason: stores who, when and why, re-prices, never deletes', async () => {
    const rows = [row(), row(), row()].map((r, i) => ({ ...r, tierIndex: i + 1 }));
    await BdaDeductionModel.create(rows);
    const res = await call('POST', `/api/crm/deductions/${rows[0].deductionId}/waive`, { token: userToken(ADMIN), body: { reason: '  Client rescheduled by phone  ' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.deduction.status, 'waived');
    assert.equal(res.body.deduction.waiverReason, 'Client rescheduled by phone');
    assert.equal(res.body.deduction.waivedBy, ADMIN);
    assert.equal(res.body.deduction.waivedByName, 'admin');
    assert.ok(res.body.deduction.waivedAt);
    const left = await BdaDeductionModel.find({ bdaEmail: SID, status: 'active' }).sort({ 'evidence.scheduledStart': 1 }).lean();
    assert.deepEqual(left.map((r) => r.tierIndex), [1, 2]);
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: SID }), 3);
  });

  it('answers 422 reason_required when the reason is missing or too short, 422 reason_too_long past 500 characters', async () => {
    const target = row();
    await BdaDeductionModel.create(target);
    const path = `/api/crm/deductions/${target.deductionId}/waive`;
    for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'abcd' }, { reason: 42 }]) {
      const res = await call('POST', path, { token: userToken(ADMIN), body });
      assert.equal(res.status, 422);
      assert.equal(res.body.error.code, 'reason_required');
    }
    const long = await call('POST', path, { token: userToken(ADMIN), body: { reason: 'x'.repeat(501) } });
    assert.equal(long.status, 422);
    assert.equal(long.body.error.code, 'reason_too_long');
    assert.equal((await call('POST', path, { token: userToken(ADMIN), body: { reason: 'x'.repeat(500) } })).status, 200);
  });

  it('409 already_resolved for a waived or voided row, 404 for an unknown id', async () => {
    const waived = row({ status: 'waived' });
    const voided = row({ status: 'voided' });
    await BdaDeductionModel.create([waived, voided]);
    for (const t of [waived, voided]) {
      const res = await call('POST', `/api/crm/deductions/${t.deductionId}/waive`, { token: userToken(ADMIN), body: { reason: 'second time' } });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'already_resolved');
    }
    const missing = await call('POST', '/api/crm/deductions/nope/waive', { token: userToken(ADMIN), body: { reason: 'does not exist' } });
    assert.equal(missing.status, 404);
  });

  it('the admin-gate token can waive and is recorded by its name', async () => {
    const target = row();
    await BdaDeductionModel.create(target);
    const res = await call('POST', `/api/crm/deductions/${target.deductionId}/waive`, { token: adminGateToken(), body: { reason: 'From the admin analysis page' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.deduction.waivedByName, 'Gate Admin');
    assert.equal(res.body.deduction.waivedBy, ADMIN);
  });

  it('activate turns a needs_review row active and re-prices; action waive waives it', async () => {
    const active = row({ tierIndex: 1 });
    const review = row({ status: 'needs_review', tierIndex: null });
    const review2 = row({ status: 'needs_review', tierIndex: null });
    await BdaDeductionModel.create([active, review, review2]);

    const res = await call('POST', `/api/crm/deductions/${review.deductionId}/activate`, {
      token: userToken(ADMIN), body: { reason: 'Verified in Google records', action: 'activate' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deduction.status, 'active');
    assert.equal(res.body.deduction.tierIndex, 2);
    assert.equal(res.body.deduction.reviewedBy, ADMIN);
    assert.equal(res.body.deduction.reviewReason, 'Verified in Google records');

    const waived = await call('POST', `/api/crm/deductions/${review2.deductionId}/activate`, {
      token: userToken(ADMIN), body: { reason: 'Data was wrong, not a miss', action: 'waive' },
    });
    assert.equal(waived.body.deduction.status, 'waived');

    const again = await call('POST', `/api/crm/deductions/${review.deductionId}/activate`, { token: userToken(ADMIN), body: { reason: 'Already active' } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'not_under_review');
    const bad = await call('POST', `/api/crm/deductions/${review.deductionId}/activate`, { token: userToken(ADMIN), body: { reason: 'Odd action', action: 'delete' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.error.code, 'invalid_action');
    const bda = await call('POST', `/api/crm/deductions/${review.deductionId}/activate`, { token: userToken(SID), body: { reason: 'Let me activate it' } });
    assert.equal(bda.status, 403);
  });
});

describe('GET /api/crm/deductions/summary', () => {
  it('is admin only and returns per-BDA active totals with the rule split', async () => {
    await BdaProfileModel.create({ email: SID, displayName: 'Sid', firstName: 'sid', lastName: 'x', tracked: true });
    invalidateRegistryCache();
    await BdaDeductionModel.create([
      row({ tierIndex: 1 }), row({ tierIndex: 2 }),
      row({ rule: 'no_show_not_called', amountInr: 100, tierIndex: null }),
      row({ status: 'shadow' }), row({ status: 'waived' }), row({ status: 'needs_review' }),
      row({ bdaEmail: KAL, rule: 'status_not_updated', amountInr: 50, tierIndex: null }),
    ]);
    const denied = await call('GET', `/api/crm/deductions/summary?month=${MONTH}`, { token: userToken(SID) });
    assert.equal(denied.status, 403);

    const res = await call('GET', `/api/crm/deductions/summary?month=${MONTH}`, { token: userToken(ADMIN) });
    assert.equal(res.status, 200);
    assert.equal(res.body.month, MONTH);
    const mine = res.body.perBda.find((p) => p.bdaEmail === SID);
    assert.equal(mine.name, 'Sid');
    assert.equal(mine.activeAmountInr, 1100);
    assert.equal(mine.count, 3);
    assert.deepEqual(mine.byRule.missed_meeting, { count: 2, amountInr: 1000 });
    const kal = res.body.perBda.find((p) => p.bdaEmail === KAL);
    assert.equal(kal.activeAmountInr, 50);

    const gate = await call('GET', `/api/crm/deductions/summary?month=${MONTH}`, { token: adminGateToken() });
    assert.equal(gate.status, 200);
    assert.equal((await call('GET', '/api/crm/deductions/summary?month=bad', { token: adminGateToken() })).status, 422);
  });
});

describe('POST /api/crm/admin/attendance/:bookingId/convert-to-miss', () => {
  const START = '2026-10-05T10:00:00Z';
  async function flagged(key) {
    const bookingId = `${PFX}-${key}`;
    await CampaignBookingModel.create({
      bookingId, utmSource: 'test', clientName: `Client ${key}`, clientEmail: `${key}.${RUN}@${D}`,
      scheduledEventStartTime: new Date(START), bookingStatus: 'scheduled', calendlyHost: { email: SID, name: 'Sid' },
    });
    await CampaignBookingModel.updateOne({ bookingId }, { $set: { statusHistory: [] } });
    await BdaAttendanceModel.create({
      bdaName: 'Sid', bdaEmail: SID, bookingId, status: 'present', source: 'manual', meetingScheduledStart: new Date(START),
      verdict: 'present', integrityFlag: 'marked_never_joined',
    });
    return bookingId;
  }

  it('admin only, needs a reason and a bdaEmail', async () => {
    const id = await flagged('cv-auth');
    process.env.DEDUCTIONS_MODE = 'shadow';
    const path = `/api/crm/admin/attendance/${id}/convert-to-miss`;
    assert.equal((await call('POST', path, { token: userToken(SID), body: { reason: 'Please fine me', bdaEmail: SID } })).status, 403);
    assert.equal((await call('POST', path, { token: userToken(ADMIN), body: { bdaEmail: SID } })).body.error.code, 'reason_required');
    assert.equal((await call('POST', path, { token: userToken(ADMIN), body: { reason: 'No bda given' } })).body.error.code, 'bda_email_required');
  });

  it('converts in shadow mode to a shadow row, and refuses in mode off', async () => {
    const id = await flagged('cv-mode');
    const path = `/api/crm/admin/attendance/${id}/convert-to-miss`;
    const off = await call('POST', path, { token: userToken(ADMIN), body: { reason: 'Never joined per Google', bdaEmail: SID } });
    assert.equal(off.status, 409);
    assert.equal(off.body.error.code, 'deductions_off');

    process.env.DEDUCTIONS_MODE = 'shadow';
    const res = await call('POST', path, { token: adminGateToken(), body: { reason: 'Never joined per Google', bdaEmail: SID } });
    assert.equal(res.status, 200);
    assert.equal(res.body.deduction.status, 'shadow');
    assert.equal(res.body.deduction.rule, 'missed_meeting');
    assert.equal(res.body.deduction.evidence.convertedFromFlag.reason, 'Never joined per Google');
    const again = await call('POST', path, { token: userToken(ADMIN), body: { reason: 'Convert it again', bdaEmail: SID } });
    assert.equal(again.status, 409);
  });

  it('live with a go-live date writes an active, counted row', async () => {
    const id = await flagged('cv-live');
    process.env.DEDUCTIONS_MODE = 'live';
    process.env.DEDUCTIONS_LIVE_FROM = '2026-10-01';
    const res = await call('POST', `/api/crm/admin/attendance/${id}/convert-to-miss`, { token: userToken(ADMIN), body: { reason: 'Never joined per Google', bdaEmail: SID } });
    assert.equal(res.status, 200);
    assert.equal(res.body.deduction.status, 'active');
    assert.equal(res.body.deduction.amountInr, 500);
    assert.equal(res.body.deduction.tierIndex, 1);
  });
});

describe('POST /api/payroll/pull-deductions', () => {
  async function seed() {
    await BdaProfileModel.create([
      { email: SID, displayName: 'Sid', firstName: NAME_KEY, lastName: 'basaveni', tracked: true },
      { email: KAL, displayName: 'Kal', firstName: `${NAME_KEY}kal`, lastName: 'other', tracked: true },
    ]);
    invalidateRegistryCache();
    await BdaDeductionModel.create([
      row({ tierIndex: 1 }), row({ tierIndex: 2 }),
      row({ rule: 'no_show_not_called', amountInr: 100, tierIndex: null }),
      row({ status: 'shadow' }), row({ status: 'waived' }), row({ status: 'voided' }), row({ status: 'needs_review', tierIndex: null }),
      row({ bdaEmail: KAL }),
      row({ month: `${MONTH.slice(0, 4)}-05` }),
    ]);
    return PayrollModel.create({ month: MONTH, employeeName: `${NAME_KEY} Basaveni`, teamName: 'BDA', monthlySalary: 30000, deduction: 250 });
  }
  const payrollToken = () => userToken(SID, { permissions: ['payroll'] });

  it('is a dry run unless apply is true: it returns the numbers and writes nothing', async () => {
    const rec = await seed();
    for (const body of [{ payrollId: String(rec._id) }, { payrollId: String(rec._id), apply: false }, { payrollId: String(rec._id), apply: 'true' }]) {
      const res = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body });
      assert.equal(res.status, 200);
      assert.equal(res.body.dryRun, true);
      assert.equal(res.body.applied, false);
      assert.equal(res.body.deduction, 1100, 'only active rows count: 500 + 500 + 100');
      assert.equal(res.body.previousDeduction, 250);
      assert.equal(res.body.bdaEmail, SID);
      assert.equal(res.body.underReview, 1);
      assert.equal(res.body.breakdown.items.length, 3);
      assert.deepEqual(res.body.breakdown.byRule.missed_meeting, { count: 2, amountInr: 1000 });
    }
    const stored = await PayrollModel.findById(rec._id).lean();
    assert.equal(stored.deduction, 250, 'nothing written');
    assert.equal(stored.deductionBreakdown, null);
  });

  it('apply true pre-fills deduction, stores the breakdown, and the admin can still edit the number', async () => {
    const rec = await seed();
    const res = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { payrollId: String(rec._id), apply: true, overwrite: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.dryRun, false);
    assert.equal(res.body.applied, true);
    const stored = await PayrollModel.findById(rec._id);
    assert.equal(stored.deduction, 1100);
    assert.equal(stored.deductionBreakdown.totalInr, 1100);
    assert.equal(stored.deductionBreakdown.bdaEmail, SID);
    assert.equal(stored.deductionBreakdown.items.length, 3);
    assert.equal(stored.deductionBreakdown.pulledBy, SID);
    // The manual edit path (updatePayroll) just sets the number; the breakdown stays as the record of the pull.
    stored.deduction = 900;
    await stored.save();
    assert.equal((await PayrollModel.findById(rec._id).lean()).deduction, 900);
  });

  it('an explicit bdaEmail wins over the name, and the admin-gate token is accepted', async () => {
    const rec = await seed();
    const res = await call('POST', '/api/payroll/pull-deductions', { token: adminGateToken(), body: { payrollId: String(rec._id), bdaEmail: KAL } });
    assert.equal(res.status, 200);
    assert.equal(res.body.bdaEmail, KAL);
    assert.equal(res.body.deduction, 500);
  });

  it('apply refuses to replace a hand-typed deduction without overwrite, and refuses a paid record', async () => {
    const rec = await seed();
    const body = { payrollId: String(rec._id), apply: true };
    const blocked = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error.code, 'deduction_already_set');
    assert.equal((await PayrollModel.findById(rec._id).lean()).deduction, 250, 'nothing written');
    await PayrollModel.updateOne({ _id: rec._id }, { $set: { isPaid: true } });
    const paid = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { ...body, overwrite: true } });
    assert.equal(paid.status, 409);
    assert.equal(paid.body.error.code, 'payroll_already_paid');
  });

  it('a first-name-only payroll match and an email outside the registry are refused', async () => {
    await seed();
    const firstOnly = await PayrollModel.create({ month: MONTH, employeeName: NAME_KEY, teamName: 'BDA' });
    const weak = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { payrollId: String(firstOnly._id) } });
    assert.equal(weak.status, 422);
    assert.equal(weak.body.error.code, 'bda_not_resolved');
    const outside = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { payrollId: String(firstOnly._id), bdaEmail: 'someone.else@example.com' } });
    assert.equal(outside.status, 422);
    assert.equal(outside.body.error.code, 'bda_not_in_registry');
  });

  it('refuses a name that matches no BDA, a bad id, a missing record, and callers without the payroll permission', async () => {
    const stranger = await PayrollModel.create({ month: MONTH, employeeName: `${NAME_KEY}zz Nobody`, teamName: 'Ops' });
    const unresolved = await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { payrollId: String(stranger._id) } });
    assert.equal(unresolved.status, 422);
    assert.equal(unresolved.body.error.code, 'bda_not_resolved');
    assert.equal((await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { payrollId: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/payroll/pull-deductions', { token: payrollToken(), body: { payrollId: '64b7f0c2a1b2c3d4e5f60718' } })).status, 404);
    const noPerm = await call('POST', '/api/payroll/pull-deductions', { token: userToken(SID), body: { payrollId: String(stranger._id) } });
    assert.equal(noPerm.status, 403);
    assert.equal(noPerm.body.error.code, 'forbidden');
    assert.equal((await call('POST', '/api/payroll/pull-deductions', { body: {} })).status, 401);
  });
});

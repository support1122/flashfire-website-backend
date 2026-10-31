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
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { BdaAbsenceReportModel } from '../Schema_Models/BdaAbsenceReport.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { registerAbsenceRoutes } from '../Routes/absenceRoutes.js';
import { attendanceShowsPresent } from '../Utils/DeductionEngine.js';

// The 19 Oct sweep fined 41 meetings the attendance record showed Siddhartha in. A manual mark must now stop on that,
// unless an admin overrides on purpose, and a throwaway reason is refused.

const RUN = Math.random().toString(36).slice(2, 8);
const BDA = `guard-bda-${RUN}@test.local`;
const ADMIN = `guard-admin-${RUN}@test.local`;
const PREFIX = `__guard_${RUN}_`;
const BASE = '/api/crm/absences';
const HOUR = 3600 * 1000;
let server;
let baseUrl;
let seq = 0;

const sign = (role, email) => jwt.sign({ role, email, name: email.split('@')[0] }, getCrmJwtSecret(), { expiresIn: '1h' });
async function call(method, path, { token = sign('crm_admin', ADMIN), body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/** A meeting that already happened, hosted by BDA, with an attendance row of the given shape (or none). */
async function meeting(attendance) {
  seq += 1;
  const bookingId = `${PREFIX}${seq}`;
  const start = Date.now() - 3 * HOUR;
  await CampaignBookingModel.create({
    bookingId,
    clientName: `Client ${seq}`,
    clientEmail: `${bookingId}@test.local`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + 30 * 60 * 1000),
    bookingCreatedAt: new Date(),
    calendlyHost: { email: BDA, name: 'Guard Bda' },
  });
  if (attendance) {
    await BdaAttendanceModel.create({ bookingId, bdaEmail: BDA, bdaName: 'Guard Bda', meetingScheduledStart: new Date(start), ...attendance });
  }
  return bookingId;
}
const mark = (bookingId, extra = {}) => call('POST', BASE, { body: { kind: 'booking', refId: bookingId, reason: 'Did not join and did not call the client', ...extra } });
const PRESENT = () => ({ status: 'present', verdict: 'present', source: 'meet_api', firstJoinedAt: new Date(Date.now() - 3 * HOUR + 60 * 1000), durationMs: 24 * 60 * 1000, signals: [{ kind: 'google_meet', eventAt: new Date() }], joinDevice: 'pc' });

const wipe = async () => {
  await Promise.all([
    BdaDeductionModel.deleteMany({ bdaEmail: BDA }),
    BdaAbsenceReportModel.deleteMany({ bdaEmail: BDA }),
    BdaAttendanceModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } }),
    CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } }),
    BdaProfileModel.deleteMany({ email: BDA }),
    CrmUserModel.deleteMany({ email: ADMIN }),
  ]);
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
  await BdaProfileModel.create({ email: BDA, displayName: 'Guard Bda', firstName: 'guard', tracked: true, active: true, trackedSince: new Date('2026-01-02') });
  invalidateRegistryCache();
});

describe('attendanceShowsPresent', () => {
  it('is null for no row and for an absent, signal-less row, and set for any join, signal or present verdict', () => {
    assert.equal(attendanceShowsPresent(null), null);
    assert.equal(attendanceShowsPresent({ status: 'unmarked', verdict: 'absent', signals: [] }), null);
    assert.equal(attendanceShowsPresent({ status: 'unmarked', verdict: 'absent', signals: [{ kind: 'google_meet' }] })?.signals[0], 'google_meet');
    assert.ok(attendanceShowsPresent({ status: 'present', verdict: 'present' }));
    assert.ok(attendanceShowsPresent({ status: 'unmarked', firstJoinedAt: new Date() }));
    assert.ok(attendanceShowsPresent({ status: 'manual', verdict: null }));
    assert.equal(attendanceShowsPresent({ status: 'present', durationMs: 24 * 60 * 1000 }).minutes, 24);
  });
});

describe('manual mark against the attendance record', () => {
  it('an admin mark goes through even when the BDA joined, and the fine keeps what the record showed', async () => {
    const id = await meeting(PRESENT());
    const r = await mark(id);
    assert.equal(r.status, 201);
    const d = await BdaDeductionModel.findOne({ bookingId: id }).lean();
    assert.equal(d.evidence.manualAbsent.forced, true);
    assert.equal(d.evidence.manualAbsent.attendance.minutes, 24);
    assert.equal(d.evidence.manualAbsent.attendance.joinDevice, 'pc');
  });

  it('fines a meeting with no attendance row, and one with an absent row and no signals', async () => {
    const none = await meeting(null);
    const absent = await meeting({ status: 'unmarked', verdict: 'absent', source: 'meet_api', signals: [] });
    assert.equal((await mark(none)).status, 201);
    assert.equal((await mark(absent)).status, 201);
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA, status: 'active' }), 2);
    const d = await BdaDeductionModel.findOne({ bookingId: none }).lean();
    assert.equal(d.evidence.manualAbsent.forced, false);
    assert.equal(d.evidence.manualAbsent.attendance, null);
  });

  it('a batch marks every meeting for an admin, joined or not', async () => {
    const joined = await meeting(PRESENT());
    const missed = await meeting(null);
    const items = [joined, missed].map((refId) => ({ kind: 'booking', refId }));
    const res = await call('POST', `${BASE}/batch`, { body: { items, reason: 'Did not join and did not call the client' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.results.map((x) => x.ok), [true, true]);
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 2);
  });

  it('an admin needs no reason: blank gets a default and short text is kept as typed', async () => {
    const [a, b, c] = [await meeting(null), await meeting(null), await meeting(null)];
    assert.equal((await call('POST', BASE, { body: { kind: 'booking', refId: a } })).status, 201, 'no reason at all');
    assert.equal((await call('POST', BASE, { body: { kind: 'booking', refId: b, reason: 'Yeah -' } })).status, 201, 'a short reason');
    const batch = await call('POST', `${BASE}/batch`, { body: { items: [{ kind: 'booking', refId: c }] } });
    assert.equal(batch.body.succeeded, 1, 'a batch with no reason');
    const reasons = Object.fromEntries((await BdaDeductionModel.find({ bdaEmail: BDA }).lean()).map((d) => [d.bookingId, d.evidence.manualAbsent.reason]));
    assert.equal(reasons[a], 'Marked absent by an admin');
    assert.equal(reasons[b], 'Yeah -');
    assert.equal(reasons[c], 'Marked absent by an admin');
    const long = await call('POST', BASE, { body: { kind: 'booking', refId: await meeting(null), reason: 'x'.repeat(501) } });
    assert.equal(long.status, 422, 'still capped at 500 characters');
  });

  it('a BDA still has to give a real reason', async () => {
    const id = await meeting(null);
    for (const reason of ['Yeah -', 'ok', '??????????', undefined]) {
      const single = await call('POST', BASE, { token: sign('crm_user', BDA), body: { kind: 'booking', refId: id, reason } });
      assert.equal(single.status, 422, String(reason));
    }
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0);
  });

  it('an admin can mark a meeting from before fines went live or before the BDA was tracked', async () => {
    await BdaProfileModel.updateOne({ email: BDA }, { $set: { trackedSince: new Date(Date.now() + 24 * HOUR) } });
    invalidateRegistryCache();
    const id = await meeting(null);
    const r = await mark(id);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA, status: 'active' }), 1);
  });

  it('a BDA cannot force: approving their own report stops on attendance until an admin forces it', async () => {
    const id = await meeting(PRESENT());
    const filed = await call('POST', BASE, { token: sign('crm_user', BDA), body: { kind: 'booking', refId: id, reason: 'I could not take this call', force: true } });
    assert.equal(filed.status, 201, 'a BDA report is only queued');
    const reportId = filed.body.report.reportId;
    const refused = await call('POST', `${BASE}/${reportId}/approve`, { body: {} });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'attendance_present');
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA }), 0);
    const ok = await call('POST', `${BASE}/${reportId}/approve`, { body: { force: true } });
    assert.equal(ok.status, 200);
    assert.equal(await BdaDeductionModel.countDocuments({ bdaEmail: BDA, status: 'active' }), 1);
  });
});

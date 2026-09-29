import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { getCrmJwtSecret, requireBdaExtension } from '../Middlewares/CrmAuth.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import {
  getMyMeetings,
  markAbsent,
  warnAbsent,
  reportJoin,
  reportLeave,
} from '../Controllers/BdaAttendanceController.js';
import { pollForAbsentBDAs } from '../Utils/BdaAbsentScheduler.js';

// Every BDA's extension receives every meeting. These tests pin the rule that
// absence (reminders, warn, absent marks) belongs only to the assigned BDA, and
// that one BDA's row never hides another BDA's attendance.

const MONGO_URI = process.env.MONGO_URI;
const PREFIX = '__test_bdaassign_';
const HOST = 'host.bda@flashfirehq.com';
const OTHER = 'other.bda@flashfirehq.com';

// The absent-poller posts to Discord; keep tests off the network.
delete process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL;
delete process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL;
delete process.env.DISCORD_BDA_DURATION_WEBHOOK_URL;
// The poller now asks the Meet API before alerting; keep that off the network too.
process.env.MEET_API_ATTENDANCE_ENABLED = 'false';

let server;
let baseUrl;

function tokenFor(email) {
  return jwt.sign({ role: 'bda_extension', email, name: email.split('@')[0] }, getCrmJwtSecret(), {
    expiresIn: '1h',
  });
}

async function call(method, path, email, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(email)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function seedBooking(overrides = {}) {
  const bookingId = `${PREFIX}${Math.random().toString(36).slice(2)}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName: 'Test Client',
    clientEmail: `${bookingId}@example.com`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    // Started 6 minutes ago: inside every reminder/absent window.
    scheduledEventStartTime: new Date(Date.now() - 6 * 60 * 1000),
    scheduledEventEndTime: new Date(Date.now() + 24 * 60 * 1000),
    googleMeetCode: 'abc-defg-hij',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    calendlyHost: { name: 'Host BDA', email: HOST },
    bookingCreatedAt: new Date(),
    ...overrides,
  });
  return bookingId;
}

async function cleanupAll() {
  const re = { $regex: `^${PREFIX}` };
  await CampaignBookingModel.deleteMany({ bookingId: re });
  await BdaAttendanceModel.deleteMany({ bookingId: re });
}

before(async () => {
  assert.ok(MONGO_URI, 'MONGO_URI must point at a test database');
  await mongoose.connect(MONGO_URI);
  await cleanupAll();

  const app = express();
  app.use(express.json());
  app.get('/my-meetings', requireBdaExtension, getMyMeetings);
  app.post('/mark-absent', requireBdaExtension, markAbsent);
  app.post('/warn-absent', requireBdaExtension, warnAbsent);
  app.post('/report-join', requireBdaExtension, reportJoin);
  app.post('/report-leave', requireBdaExtension, reportLeave);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(cleanupAll);

after(async () => {
  await cleanupAll();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

function findMeeting(body, bookingId) {
  return [...body.upcoming, ...body.previous].find((m) => m.bookingId === bookingId);
}

describe('mark-absent', () => {
  it('skips a BDA the meeting is not assigned to and writes no row', async () => {
    const bookingId = await seedBooking();
    const r = await call('POST', '/mark-absent', OTHER, { bookingId, reason: 'x' });
    assert.equal(r.status, 200);
    assert.equal(r.body.skipped, true);
    assert.equal(r.body.reason, 'not_assigned');
    assert.equal(await BdaAttendanceModel.countDocuments({ bookingId }), 0);
  });

  it('marks the assigned Calendly host absent', async () => {
    const bookingId = await seedBooking();
    const r = await call('POST', '/mark-absent', HOST, { bookingId, reason: 'x' });
    assert.equal(r.body.success, true);
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.equal(row.status, 'absent');
  });

  it('accepts a CRM claim as assignment', async () => {
    const bookingId = await seedBooking({ calendlyHost: null, claimedBy: { email: OTHER, name: 'Other' } });
    await call('POST', '/mark-absent', OTHER, { bookingId });
    assert.equal((await BdaAttendanceModel.findOne({ bookingId, bdaEmail: OTHER }).lean()).status, 'absent');
  });

  it("upgrades the poller's unmarked row but never overwrites present", async () => {
    const bookingId = await seedBooking();
    await pollForAbsentBDAs();
    assert.equal((await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean()).status, 'unmarked');
    await call('POST', '/mark-absent', HOST, { bookingId });
    assert.equal((await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean()).status, 'absent');

    const joined = await seedBooking();
    await call('POST', '/report-join', HOST, { bookingId: joined, meetLink: 'https://meet.google.com/abc-defg-hij' });
    await call('POST', '/mark-absent', HOST, { bookingId: joined });
    assert.equal((await BdaAttendanceModel.findOne({ bookingId: joined, bdaEmail: HOST }).lean()).status, 'present');
  });
});

describe('warn-absent', () => {
  it('skips cleanly instead of failing with 502', async () => {
    const bookingId = await seedBooking();
    const mine = await call('POST', '/warn-absent', HOST, { bookingId });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.skipped, true);
    const notMine = await call('POST', '/warn-absent', OTHER, { bookingId });
    assert.equal(notMine.status, 200);
    assert.equal(notMine.body.reason, 'not_assigned');
  });
});

describe('my-meetings', () => {
  it("returns only the requester's own attendance and flags assignment", async () => {
    const bookingId = await seedBooking();
    // A colleague's absent row used to surface as this booking's attendance and
    // made the host's extension stop tracking the meeting.
    await BdaAttendanceModel.create({
      bookingId,
      bdaEmail: OTHER,
      bdaName: 'Other',
      status: 'absent',
      source: 'manual',
      meetingScheduledStart: new Date(),
    });

    const host = findMeeting((await call('GET', '/my-meetings', HOST)).body, bookingId);
    assert.equal(host.assignedToMe, true);
    assert.equal(host.attendance, null);

    const other = findMeeting((await call('GET', '/my-meetings', OTHER)).body, bookingId);
    assert.equal(other.assignedToMe, false);
    assert.equal(other.attendance.status, 'absent');
  });

  it('hides an unmarked row so Mark Present and auto-join stay available', async () => {
    const bookingId = await seedBooking();
    await pollForAbsentBDAs();
    const host = findMeeting((await call('GET', '/my-meetings', HOST)).body, bookingId);
    assert.equal(host.attendance, null);
  });
});

describe('absent poller', () => {
  it('treats the Calendly host as assigned (no false "NO BDA ASSIGNED")', async () => {
    const bookingId = await seedBooking();
    await pollForAbsentBDAs();
    const rows = await BdaAttendanceModel.find({ bookingId }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].bdaEmail, HOST);
    assert.match(rows[0].notes, /No response/);
  });

  it('still flags a truly unassigned meeting', async () => {
    const bookingId = await seedBooking({ calendlyHost: null });
    await pollForAbsentBDAs();
    const row = await BdaAttendanceModel.findOne({ bookingId }).lean();
    assert.equal(row.bdaEmail, 'unassigned');
  });

  it('a later real join flips the host row to present', async () => {
    const bookingId = await seedBooking();
    await pollForAbsentBDAs();
    await call('POST', '/report-join', HOST, { bookingId, meetLink: 'https://meet.google.com/abc-defg-hij' });
    const rows = await BdaAttendanceModel.find({ bookingId }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'present');
  });
});

describe('time spent and join time', () => {
  const MEET = 'https://meet.google.com/abc-defg-hij';

  it('adds every rejoin segment to the total', async () => {
    const bookingId = await seedBooking();
    const t0 = Date.now() - 30 * 60 * 1000;
    await call('POST', '/report-join', HOST, { bookingId, meetLink: MEET, joinedAt: new Date(t0).toISOString() });
    await call('POST', '/report-leave', HOST, { bookingId, leftAt: new Date(t0 + 10 * 60e3).toISOString(), durationMs: 10 * 60e3 });
    await call('POST', '/report-join', HOST, { bookingId, meetLink: MEET, joinedAt: new Date(t0 + 12 * 60e3).toISOString() });
    await call('POST', '/report-leave', HOST, { bookingId, leftAt: new Date(t0 + 20 * 60e3).toISOString(), durationMs: 8 * 60e3 });
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.equal(row.durationMs, 18 * 60e3);
    assert.equal(new Date(row.firstJoinedAt).getTime(), t0);
  });

  it("moves a fast client clock's join time onto server time", async () => {
    const bookingId = await seedBooking();
    const skew = 2 * 60 * 1000; // client PC runs 2 minutes fast
    const realJoin = Date.now() - 60 * 1000;
    await call('POST', '/report-join', HOST, {
      bookingId,
      meetLink: MEET,
      joinedAt: new Date(realJoin + skew).toISOString(),
      clientNow: new Date(Date.now() + skew).toISOString(),
    });
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.ok(Math.abs(new Date(row.firstJoinedAt).getTime() - realJoin) < 3000);
  });

  it('keeps the client time when no clientNow is sent (older builds)', async () => {
    const bookingId = await seedBooking();
    const joinedAt = new Date(Date.now() - 90 * 1000).toISOString();
    await call('POST', '/report-join', HOST, { bookingId, meetLink: MEET, joinedAt });
    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: HOST }).lean();
    assert.equal(new Date(row.firstJoinedAt).toISOString(), joinedAt);
  });
});

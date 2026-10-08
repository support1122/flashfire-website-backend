// Regression: BDAs were logged in but saw no upcoming meetings.
// getMyMeetings used one query, oldest first, limit 100, over [now - 7 d, now + 14 d]. Once the past week held
// 100 bookings, the limit was spent on past meetings and every upcoming one was cut off.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
isolateExternalServices();

import { getCrmJwtSecret, requireBdaExtension } from '../Middlewares/CrmAuth.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getMyMeetings } from '../Controllers/BdaAttendanceController.js';

const RUN = Math.random().toString(36).slice(2, 8);
const PREFIX = `__test_mymeetings_${RUN}_`;
const HOST = `host.${RUN}@mymeetings.test`;
let server;
let baseUrl;

const token = () => jwt.sign({ role: 'bda_extension', email: HOST, name: 'Host' }, getCrmJwtSecret(), { expiresIn: '1h' });

function booking(id, startMs) {
  return {
    bookingId: `${PREFIX}${id}`,
    clientName: `Client ${id}`,
    clientEmail: `${PREFIX}${id}@example.com`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(startMs),
    scheduledEventEndTime: new Date(startMs + 30 * 60_000),
    googleMeetCode: 'abc-defg-hij',
    googleMeetUrl: 'https://meet.google.com/abc-defg-hij',
    calendlyHost: { name: 'Host', email: HOST },
    bookingCreatedAt: new Date(),
  };
}

before(async () => {
  await connectTestDb();
  const now = Date.now();
  // 105 meetings spread across the past 6.5 days (more than the old limit of 100) ...
  const past = Array.from({ length: 105 }, (_, i) => booking(`past${i}`, now - (i + 1) * 90 * 60_000));
  // ... and 3 upcoming ones, the ones that used to vanish.
  const upcoming = [1, 2, 3].map((n) => booking(`soon${n}`, now + n * 60 * 60_000));
  await CampaignBookingModel.insertMany([...past, ...upcoming]);

  const app = express();
  app.use(express.json());
  app.get('/my-meetings', requireBdaExtension, getMyMeetings);
  await new Promise((resolve) => (server = app.listen(0, resolve)));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } });
  await new Promise((resolve) => server.close(resolve));
  await disconnectTestDb();
});

describe('getMyMeetings with a busy past week', () => {
  it('still returns every upcoming meeting', async () => {
    const res = await fetch(`${baseUrl}/my-meetings`, { headers: { Authorization: `Bearer ${token()}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const ours = body.upcoming.filter((m) => m.bookingId.startsWith(PREFIX));
    assert.deepEqual(ours.map((m) => m.bookingId), [`${PREFIX}soon1`, `${PREFIX}soon2`, `${PREFIX}soon3`], 'soonest first');
  });

  it('returns the NEWEST past meetings first, not the oldest', async () => {
    const res = await fetch(`${baseUrl}/my-meetings`, { headers: { Authorization: `Bearer ${token()}` } });
    const body = await res.json();
    const ours = body.previous.filter((m) => m.bookingId.startsWith(PREFIX));
    assert.equal(ours[0].bookingId, `${PREFIX}past0`, 'the most recent past meeting leads');
    const starts = ours.map((m) => new Date(m.scheduledStart).getTime());
    assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'newest first');
  });
});

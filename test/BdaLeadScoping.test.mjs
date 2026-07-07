import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { getCrmJwtSecret, requireCrmUser, requireCrmAnyPermission } from '../Middlewares/CrmAuth.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getLeadsPaginated, getLeadsIds, getLeadsAnalytics } from '../Controllers/CampaignBookingController.js';

const MONGO_URI = process.env.MONGO_URI;
const BOOKING_ID_PREFIX = '__test_bdascope_';

let app;
let server;
let baseUrl;

function signToken({ email, bdaRole }) {
  return jwt.sign({ role: 'crm_user', permissions: ['leads'], email, bdaRole }, getCrmJwtSecret(), { expiresIn: '1h' });
}

async function seedBooking(overrides = {}) {
  const bookingId = `${BOOKING_ID_PREFIX}${Math.random().toString(36).slice(2)}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName: 'Test Client',
    clientEmail: `${bookingId}@example.com`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
    bookingCreatedAt: new Date(),
    ...overrides,
  });
  return bookingId;
}

async function cleanupAll() {
  await CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${BOOKING_ID_PREFIX}` } });
}

before(async () => {
  await mongoose.connect(MONGO_URI);
  await cleanupAll();

  app = express();
  app.use(express.json());
  app.get('/api/leads/paginated', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads']), getLeadsPaginated);
  app.get('/api/leads/ids', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads']), getLeadsIds);
  app.get('/api/leads/analytics', requireCrmUser, requireCrmAnyPermission(['leads', 'meta_leads', 'lead_analytics']), getLeadsAnalytics);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanupAll();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

describe('BDA lead visibility scoping', () => {
  it('a BDA only sees leads assigned to their own calendlyHost.email in the paginated list', async () => {
    const siddharthaBooking = await seedBooking({ calendlyHost: { email: 'siddhartha@flashfirehq.com', name: 'Siddhartha', matchedCrmUser: true } });
    const kalpataruBooking = await seedBooking({ calendlyHost: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru', matchedCrmUser: true } });

    const token = signToken({ email: 'siddhartha@flashfirehq.com', bdaRole: 'bda' });
    const res = await fetch(`${baseUrl}/api/leads/paginated?limit=200`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    const ids = body.data.map((l) => l.bookingId);

    assert.ok(ids.includes(siddharthaBooking), 'Siddhartha should see his own lead');
    assert.ok(!ids.includes(kalpataruBooking), 'Siddhartha should NOT see Kalpataru\'s lead');
  });

  it('an admin sees leads from every BDA in the paginated list', async () => {
    const siddharthaBooking = await seedBooking({ calendlyHost: { email: 'siddhartha@flashfirehq.com', name: 'Siddhartha', matchedCrmUser: true } });
    const kalpataruBooking = await seedBooking({ calendlyHost: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru', matchedCrmUser: true } });

    const adminToken = signToken({ email: 'admin@flashfirehq.com', bdaRole: 'admin' });
    const res = await fetch(`${baseUrl}/api/leads/paginated?limit=200`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const body = await res.json();
    const ids = body.data.map((l) => l.bookingId);

    assert.ok(ids.includes(siddharthaBooking), 'Admin should see Siddhartha\'s lead');
    assert.ok(ids.includes(kalpataruBooking), 'Admin should see Kalpataru\'s lead');
  });

  it('leads with no calendlyHost at all remain visible to every BDA', async () => {
    const unassignedBooking = await seedBooking({});

    const siddharthaToken = signToken({ email: 'siddhartha@flashfirehq.com', bdaRole: 'bda' });
    const kalpataruToken = signToken({ email: 'kalpataru@flashfirehq.com', bdaRole: 'bda' });

    const resA = await fetch(`${baseUrl}/api/leads/paginated?limit=200`, { headers: { Authorization: `Bearer ${siddharthaToken}` } });
    const bodyA = await resA.json();
    assert.ok(bodyA.data.map((l) => l.bookingId).includes(unassignedBooking), 'Unassigned lead visible to Siddhartha');

    const resB = await fetch(`${baseUrl}/api/leads/paginated?limit=200`, { headers: { Authorization: `Bearer ${kalpataruToken}` } });
    const bodyB = await resB.json();
    assert.ok(bodyB.data.map((l) => l.bookingId).includes(unassignedBooking), 'Unassigned lead also visible to Kalpataru');
  });

  it('leads with calendlyHost.matchedCrmUser: false and no email (the Mongoose-default broken shape) still count as unassigned, visible to all', async () => {
    const brokenShapeBooking = await seedBooking({ calendlyHost: { matchedCrmUser: false } });

    const token = signToken({ email: 'siddhartha@flashfirehq.com', bdaRole: 'bda' });
    const res = await fetch(`${baseUrl}/api/leads/paginated?limit=200`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    assert.ok(body.data.map((l) => l.bookingId).includes(brokenShapeBooking), 'Broken-shape calendlyHost (no email) should be treated as unassigned, not silently hidden');
  });

  it('getLeadsIds applies the same BDA scope as the paginated list', async () => {
    const siddharthaBooking = await seedBooking({ calendlyHost: { email: 'siddhartha@flashfirehq.com', name: 'Siddhartha', matchedCrmUser: true } });
    const kalpataruBooking = await seedBooking({ calendlyHost: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru', matchedCrmUser: true } });

    const token = signToken({ email: 'kalpataru@flashfirehq.com', bdaRole: 'bda' });
    const res = await fetch(`${baseUrl}/api/leads/ids?limit=5000`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();

    assert.ok(body.data.bookingIds.includes(kalpataruBooking), 'Kalpataru should see his own lead id');
    assert.ok(!body.data.bookingIds.includes(siddharthaBooking), 'Kalpataru should not see Siddhartha\'s lead id');
  });

  it('getLeadsAnalytics counts only reflect the requesting BDA\'s own leads (relative to baseline, since unassigned production leads are legitimately included for everyone)', async () => {
    const token = signToken({ email: 'siddhartha@flashfirehq.com', bdaRole: 'bda' });

    const before = await (await fetch(`${baseUrl}/api/leads/analytics`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const baselineTotal = before.data.funnel.total;

    await seedBooking({ calendlyHost: { email: 'siddhartha@flashfirehq.com', name: 'Siddhartha', matchedCrmUser: true }, bookingStatus: 'not-scheduled' });
    await seedBooking({ calendlyHost: { email: 'siddhartha@flashfirehq.com', name: 'Siddhartha', matchedCrmUser: true }, bookingStatus: 'not-scheduled' });
    await seedBooking({ calendlyHost: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru', matchedCrmUser: true }, bookingStatus: 'not-scheduled' });

    const after = await (await fetch(`${baseUrl}/api/leads/analytics`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const afterTotal = after.data.funnel.total;

    assert.equal(afterTotal - baselineTotal, 2, 'adding 2 of Siddhartha\'s leads + 1 of Kalpataru\'s should only raise Siddhartha\'s own count by 2');
  });

  it('a BDA cannot bypass scoping by passing a different bdaEmail query param', async () => {
    const token = signToken({ email: 'siddhartha@flashfirehq.com', bdaRole: 'bda' });
    const before = await (await fetch(`${baseUrl}/api/leads/analytics?bdaEmail=kalpataru@flashfirehq.com`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const baselineTotal = before.data.funnel.total;

    await seedBooking({ calendlyHost: { email: 'kalpataru@flashfirehq.com', name: 'Kalpataru', matchedCrmUser: true }, bookingStatus: 'not-scheduled' });

    const after = await (await fetch(`${baseUrl}/api/leads/analytics?bdaEmail=kalpataru@flashfirehq.com`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const afterTotal = after.data.funnel.total;

    assert.equal(afterTotal, baselineTotal, 'Siddhartha must not see Kalpataru\'s newly added lead even via a bdaEmail query param override attempt');
  });
});

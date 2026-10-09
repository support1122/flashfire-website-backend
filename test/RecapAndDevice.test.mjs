// Calendly Notetaker recap ingestion (Apps Script -> backend) and join-device detection (mobile vs PC).
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';

isolateExternalServices();

import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { CalendlyRecapModel } from '../Schema_Models/CalendlyRecap.js';
import { IntegrationKeyModel } from '../Schema_Models/IntegrationKey.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { registerCalendlyRecapRoutes } from '../Routes/calendlyRecapRoutes.js';
import { classifyJoinDevice } from '../Utils/JoinDevice.js';
import { inviteeNameFromSubject, parseRecapEmail, recapUrlFrom } from '../Utils/CalendlyRecapParser.js';
import { decideMatch, scoreCandidates } from '../Utils/CalendlyRecapMatcher.js';
import { getAttendanceRowFields } from '../Utils/attendanceRowFields.js';

const RUN = Math.random().toString(36).slice(2, 8);
const D = `rc-${RUN}.test.invalid`;
const PREFIX = `__rc_${RUN}_`;
const SID = `sid@${D}`;
const ADMIN = `admin@${D}`;
const MIN = 60 * 1000;
const SECRET = 'x'.repeat(16) + RUN.padEnd(16, 'y');

let server;
let base;
let seq = 0;

const crmToken = (email, permissions = ['meeting_links']) =>
  jwt.sign({ role: 'crm_user', email, name: email.split('@')[0], permissions }, getCrmJwtSecret(), { expiresIn: '1h' });

async function call(method, path, { token, body, secret } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(secret ? { 'X-Recap-Secret': secret } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mkBooking({ start, clientName, clientEmail, host = SID }) {
  const bookingId = `${PREFIX}${++seq}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName,
    clientEmail: clientEmail || `${bookingId}@${D}`,
    bookingStatus: 'completed',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(start),
    scheduledEventEndTime: new Date(start + 30 * MIN),
    calendlyHost: { name: 'Sid', email: host },
    bookingCreatedAt: new Date(),
  });
  return bookingId;
}

const recapBody = (over = {}) => ({
  messageId: `${PREFIX}msg-${++seq}`,
  threadId: 't1',
  account: SID,
  from: 'Calendly <notifications@calendly.com>',
  subject: 'Meeting summary: Flashfire Consultation with Priya Raman',
  sentAt: new Date().toISOString(),
  plainBody:
    'Summary\nPriya wants help applying to data roles in Canada. Discussed pricing.\n\nAction items\n- Send plan details\n\nAsk Notetaker\nAsk anything about this meeting',
  links: ['https://calendly.com/app/notetaker/recaps/abc123', 'https://calendly.com/unsubscribe'],
  ...over,
});

async function cleanup() {
  await Promise.all([
    CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } }),
    CalendlyRecapModel.deleteMany({ messageId: { $regex: `^${PREFIX}` } }),
    CrmUserModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } }),
  ]);
}

before(async () => {
  process.env.CALENDLY_RECAP_INGEST_SECRET = SECRET;
  await connectTestDb();
  await Promise.all([CalendlyRecapModel.init(), CampaignBookingModel.init()]);
  const app = express();
  app.use(express.json());
  registerCalendlyRecapRoutes(app);
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
});

// ---------------------------------------------------------------------------------------------------------
describe('join device (mobile vs PC)', () => {
  const start = Date.parse('2026-10-08T11:00:00Z');
  const session = [{ startTime: new Date(start), endTime: new Date(start + 20 * MIN) }];
  const beat = (offMin, tabs = []) => ({ at: new Date(start + offMin * MIN), meetTabs: tabs });

  it('dial-in when Google lists the BDA as a phone participant', () => {
    assert.equal(classifyJoinDevice({ row: { sessions: session, googleParticipantKind: 'phone' }, meetCode: 'abc-defg-hij' }).device, 'phone_dial_in');
  });

  it('pc when the extension reported the join, or a heartbeat had this call\'s tab in call', () => {
    assert.equal(classifyJoinDevice({ row: { sessions: session, signals: [{ kind: 'extension_join' }] }, meetCode: 'abc-defg-hij' }).device, 'pc');
    const logs = [beat(5, [{ code: 'abc-defg-hij', inCall: true }])];
    assert.equal(classifyJoinDevice({ row: { sessions: session }, meetCode: 'abc-defg-hij', logs }).device, 'pc');
  });

  it('mobile when Google saw the BDA, the extension was running, but no tab was in this call', () => {
    const logs = [beat(3), beat(4, [{ code: 'other-room-xyz', inCall: true }]), beat(10, [{ code: 'abc-defg-hij', inCall: false }])];
    const r = classifyJoinDevice({ row: { sessions: session }, meetCode: 'abc-defg-hij', logs });
    assert.equal(r.device, 'mobile');
    assert.equal(r.reason, 'extension_running_but_not_in_call');
  });

  it('unknown (not mobile) when the extension sent nothing during the call', () => {
    const logs = [beat(-120), beat(200)]; // alive hours away from the call says nothing about it
    assert.equal(classifyJoinDevice({ row: { sessions: session }, meetCode: 'abc-defg-hij', logs }).device, 'unknown');
  });

  it('null when nobody saw the BDA join', () => {
    assert.equal(classifyJoinDevice({ row: { sessions: [] }, meetCode: 'abc-defg-hij', logs: [beat(1)] }).device, null);
    assert.equal(classifyJoinDevice({ row: null, meetCode: 'abc-defg-hij' }).device, null);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('recap parsing and matching (pure)', () => {
  it('reads the invitee from common subject shapes', () => {
    assert.deepEqual(inviteeNameFromSubject('Meeting summary: Flashfire Consultation with Priya Raman'), ['Priya Raman']);
    assert.deepEqual(inviteeNameFromSubject('Your notes from 30 Minute Meeting with José Núñez on Oct 8'), ['José Núñez']);
    assert.deepEqual(inviteeNameFromSubject('Notes: meeting between Kalpataru S and Arun K'), ['Kalpataru S', 'Arun K']);
    assert.equal(inviteeNameFromSubject('Weekly digest'), null);
  });

  it('keeps the summary up to "Ask Notetaker" and finds the recap link, not the unsubscribe link', () => {
    const p = parseRecapEmail(recapBody());
    assert.match(p.summary, /data roles in Canada/);
    assert.doesNotMatch(p.summary, /Ask anything/);
    assert.equal(p.sections['action items'], '- Send plan details');
    assert.equal(p.recapUrl, 'https://calendly.com/app/notetaker/recaps/abc123');
    assert.equal(recapUrlFrom(['https://calendly.com/unsubscribe?x=1'], ''), null);
  });

  it('links only when one booking clearly wins; a tie is ambiguous, weak evidence is unmatched', () => {
    const sentAtMs = Date.parse('2026-10-08T11:40:00Z');
    const mk = (id, name, email) => ({
      bookingId: id,
      clientName: name,
      clientEmail: email,
      scheduledEventStartTime: new Date('2026-10-08T11:00:00Z'),
      scheduledEventEndTime: new Date('2026-10-08T11:30:00Z'),
      calendlyHost: { email: SID },
    });
    const parsed = parseRecapEmail(recapBody());
    const recap = { ...parsed, plainBody: recapBody().plainBody, account: SID, sentAtMs };
    const clear = decideMatch(scoreCandidates([mk('a', 'Priya Raman', 'priya@x.com'), mk('b', 'Rahul Verma', 'r@x.com')], recap));
    assert.equal(clear.status, 'matched');
    assert.equal(clear.best.booking.bookingId, 'a');
    const tie = decideMatch(scoreCandidates([mk('a', 'Priya Raman', 'p1@x.com'), mk('b', 'Priya Raman', 'p2@x.com')], recap));
    assert.equal(tie.status, 'ambiguous');
    const none = decideMatch(scoreCandidates([mk('b', 'Rahul Verma', 'r@x.com')], { ...recap, account: 'someone@else.com' }));
    assert.equal(none.status, 'unmatched');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('POST /api/integrations/calendly-recap', () => {
  it('rejects a missing or wrong secret with 401 and stores nothing', async () => {
    const body = recapBody();
    assert.equal((await call('POST', '/api/integrations/calendly-recap', { body })).status, 401);
    assert.equal((await call('POST', '/api/integrations/calendly-recap', { body, secret: 'wrong' })).status, 401);
    assert.equal(await CalendlyRecapModel.countDocuments({ messageId: body.messageId }), 0);
  });

  it('without the env var, the first 32+ character key is enrolled (hash only) and is then the only key accepted', async () => {
    const saved = process.env.CALENDLY_RECAP_INGEST_SECRET;
    delete process.env.CALENDLY_RECAP_INGEST_SECRET;
    await IntegrationKeyModel.deleteMany({ name: 'calendly_recap_ingest' });
    try {
      const keyA = `A${RUN}`.padEnd(40, 'a');
      const keyB = `B${RUN}`.padEnd(40, 'b');
      assert.equal((await call('POST', '/api/integrations/calendly-recap', { body: recapBody(), secret: 'too-short' })).status, 401);
      assert.equal(await IntegrationKeyModel.countDocuments({ name: 'calendly_recap_ingest' }), 0, 'a short key never enrolls');
      const first = await call('POST', '/api/integrations/calendly-recap', { body: recapBody(), secret: keyA });
      assert.equal(first.status, 201);
      const doc = await IntegrationKeyModel.findOne({ name: 'calendly_recap_ingest' }).lean();
      assert.ok(doc && doc.keyHash.length === 64 && !doc.keyHash.includes(keyA), 'only a SHA-256 hash is stored');
      assert.equal((await call('POST', '/api/integrations/calendly-recap', { body: recapBody(), secret: keyB })).status, 401);
      assert.equal((await call('POST', '/api/integrations/calendly-recap', { body: recapBody(), secret: keyA })).status, 201);
    } finally {
      await IntegrationKeyModel.deleteMany({ name: 'calendly_recap_ingest' });
      process.env.CALENDLY_RECAP_INGEST_SECRET = saved;
    }
  });

  it('validates the body (422)', async () => {
    const r = await call('POST', '/api/integrations/calendly-recap', { body: recapBody({ plainBody: '' }), secret: SECRET });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'invalid_recap');
  });

  it('saves, links to the right booking, and is idempotent on messageId', async () => {
    const now = Date.now();
    const bookingId = await mkBooking({ start: now - 45 * MIN, clientName: 'Priya Raman' });
    await mkBooking({ start: now - 50 * MIN, clientName: 'Rahul Verma' });
    const body = recapBody({ sentAt: new Date(now - 5 * MIN).toISOString() });
    const first = await call('POST', '/api/integrations/calendly-recap', { body, secret: SECRET });
    assert.equal(first.status, 201);
    assert.equal(first.body.matchStatus, 'matched');
    assert.equal(first.body.bookingId, bookingId);
    const again = await call('POST', '/api/integrations/calendly-recap', { body, secret: SECRET });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(await CalendlyRecapModel.countDocuments({ messageId: body.messageId }), 1);

    // The CRM sees it on the meeting row and can read the whole summary.
    const fields = await getAttendanceRowFields([{ bookingId, bookingStatus: 'completed', calendlyHost: { email: SID } }], { email: ADMIN, isAdmin: true }, { DeductionModel: null });
    assert.equal(fields.get(bookingId).transcript.url, 'https://calendly.com/app/notetaker/recaps/abc123');
    assert.match(fields.get(bookingId).transcript.summaryPreview, /data roles/);
    const read = await call('GET', `/api/crm/bookings/${bookingId}/recap`, { token: crmToken(SID) });
    assert.equal(read.status, 200);
    assert.match(read.body.recaps[0].summary, /data roles in Canada/);
  });

  it('a BDA without Meeting Info access reads only their own meetings\' summaries; an admin reads all', async () => {
    const now = Date.now();
    const mine = await mkBooking({ start: now - 45 * MIN, clientName: 'Priya Raman' });
    const theirs = await mkBooking({ start: now - 45 * MIN, clientName: 'Other Client', host: `kal@${D}` });
    await CalendlyRecapModel.create([
      { messageId: `${PREFIX}own`, sentAt: new Date(), plainBody: 'x', summary: 'mine', bookingId: mine, matchStatus: 'matched' },
      { messageId: `${PREFIX}other`, sentAt: new Date(), plainBody: 'x', summary: 'theirs', bookingId: theirs, matchStatus: 'matched' },
    ]);
    await CrmUserModel.create({ email: SID, name: 'Sid', role: 'bda', isActive: true, permissions: ['claim_leads'] });
    const own = await call('GET', `/api/crm/bookings/${mine}/recap`, { token: crmToken(SID, ['claim_leads']) });
    assert.equal(own.status, 200);
    assert.equal(own.body.recaps[0].summary, 'mine');
    const other = await call('GET', `/api/crm/bookings/${theirs}/recap`, { token: crmToken(SID, ['claim_leads']) });
    assert.equal(other.status, 403);
    const admin = await call('GET', `/api/crm/bookings/${theirs}/recap`, { token: crmToken(ADMIN, ['claim_leads']) });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.recaps[0].summary, 'theirs');
  });

  it('stores an unmatched recap for an admin, who can link it by hand', async () => {
    const now = Date.now();
    const bookingId = await mkBooking({ start: now - 45 * MIN, clientName: 'Someone Else Entirely', host: `kal@${D}` });
    const body = recapBody({ subject: 'Meeting summary', account: 'unknown@inbox.test', sentAt: new Date(now - 5 * MIN).toISOString() });
    const r = await call('POST', '/api/integrations/calendly-recap', { body, secret: SECRET });
    assert.equal(r.status, 201);
    assert.equal(r.body.bookingId, null);
    const list = await call('GET', '/api/crm/admin/calendly-recaps', { token: crmToken(ADMIN, []) });
    assert.equal(list.status, 200);
    assert.ok(list.body.recaps.some((x) => x.messageId === body.messageId));
    const noAdmin = await call('POST', `/api/crm/admin/calendly-recaps/${body.messageId}/link`, { token: crmToken(SID), body: { bookingId } });
    assert.equal(noAdmin.status, 403);
    const linked = await call('POST', `/api/crm/admin/calendly-recaps/${body.messageId}/link`, { token: crmToken(ADMIN, []), body: { bookingId } });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.recap.bookingId, bookingId);
    assert.equal(linked.body.recap.matchStatus, 'manual');
  });
});

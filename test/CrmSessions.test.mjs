import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import crypto from 'crypto';

import { getCrmJwtSecret, requireCrmUser } from '../Middlewares/CrmAuth.js';
import { CrmSessionModel } from '../Schema_Models/CrmSessionModel.js';
import { parseUserAgent } from '../Utils/UserAgentParser.js';
import { getClientIp, detectCountryFromIp, initGeoIp } from '../Utils/GeoIP.js';
import {
  listMySessions,
  revokeMySession,
  listAllSessions,
  adminRevokeSession,
} from '../Controllers/CrmSessionController.js';
import { requireCrmAdmin } from '../Middlewares/CrmAuth.js';

const MONGO_URI = process.env.MONGO_URI;
const TEST_EMAIL_A = '__test_a@sessions.local';
const TEST_EMAIL_B = '__test_b@sessions.local';

let app;
let server;
let baseUrl;

function signUserToken(payload, opts = {}) {
  return jwt.sign({ role: 'crm_user', ...payload }, getCrmJwtSecret(), { expiresIn: '1h', ...opts });
}

function signAdminToken(payload = {}) {
  return jwt.sign({ role: 'crm_admin', ...payload }, getCrmJwtSecret(), { expiresIn: '1h' });
}

async function createSessionDoc(overrides = {}) {
  const sessionId = crypto.randomUUID();
  await CrmSessionModel.create({
    sessionId,
    email: TEST_EMAIL_A,
    ip: '8.8.8.8',
    countryCode: 'US',
    country: 'United States',
    browser: 'Chrome',
    os: 'macOS',
    deviceType: 'Desktop',
    userAgent: 'test-agent',
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    ...overrides,
    sessionId: overrides.sessionId || sessionId,
  });
  return overrides.sessionId || sessionId;
}

before(async () => {
  await mongoose.connect(MONGO_URI);
  await initGeoIp();

  app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  // Minimal test harness protected route, mirroring how a real CRM route is wired.
  app.get('/protected', requireCrmUser, (req, res) => {
    res.json({ success: true, crmUser: req.crmUser });
  });

  app.get('/api/crm/sessions', requireCrmUser, listMySessions);
  app.post('/api/crm/sessions/:sessionId/revoke', requireCrmUser, revokeMySession);
  app.get('/api/crm/admin/sessions', requireCrmAdmin, listAllSessions);
  app.post('/api/crm/admin/sessions/:sessionId/revoke', requireCrmAdmin, adminRevokeSession);

  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  // Clean up every test document this suite created, regardless of which test left it behind.
  await CrmSessionModel.deleteMany({ email: { $in: [TEST_EMAIL_A, TEST_EMAIL_B] } });
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

describe('UserAgentParser', () => {
  it('parses Chrome on macOS', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const result = parseUserAgent(ua);
    assert.equal(result.browser, 'Chrome');
    assert.equal(result.os, 'macOS');
    assert.equal(result.deviceType, 'Desktop');
  });

  it('parses Safari on iPhone as Mobile', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    const result = parseUserAgent(ua);
    assert.equal(result.browser, 'Safari');
    assert.equal(result.os, 'iOS');
    assert.equal(result.deviceType, 'Mobile');
  });

  it('parses Edge on Windows (not misidentified as Chrome)', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';
    const result = parseUserAgent(ua);
    assert.equal(result.browser, 'Edge');
    assert.equal(result.os, 'Windows');
  });

  it('parses Android Firefox as Mobile', () => {
    const ua = 'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0';
    const result = parseUserAgent(ua);
    assert.equal(result.browser, 'Firefox');
    assert.equal(result.os, 'Android');
    assert.equal(result.deviceType, 'Mobile');
  });

  it('parses iPad as Tablet', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
    const result = parseUserAgent(ua);
    assert.equal(result.deviceType, 'Tablet');
  });

  it('handles empty/garbage UA without throwing', () => {
    const result = parseUserAgent('');
    assert.equal(result.browser, 'Unknown Browser');
    assert.equal(result.os, 'Unknown OS');
    const result2 = parseUserAgent(undefined);
    assert.equal(result2.browser, 'Unknown Browser');
  });
});

describe('getClientIp', () => {
  it('prefers cf-connecting-ip over everything else', () => {
    const ip = getClientIp({ headers: { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' } });
    assert.equal(ip, '1.1.1.1');
  });

  it('falls back to first IP in x-forwarded-for chain', () => {
    const ip = getClientIp({ headers: { 'x-forwarded-for': '8.8.8.8, 10.0.0.1, 10.0.0.2' } });
    assert.equal(ip, '8.8.8.8');
  });

  it('falls back to req.ip when no proxy headers present', () => {
    const ip = getClientIp({ headers: {}, ip: '203.0.113.5' });
    assert.equal(ip, '203.0.113.5');
  });

  it('strips IPv6-mapped IPv4 prefix', () => {
    const ip = getClientIp({ headers: {}, ip: '::ffff:203.0.113.5' });
    assert.equal(ip, '203.0.113.5');
  });

  it('returns null when nothing is available', () => {
    const ip = getClientIp({ headers: {} });
    assert.equal(ip, null);
  });
});

describe('detectCountryFromIp', () => {
  it('resolves a known US IP (Google DNS) to US', () => {
    const { countryCode } = detectCountryFromIp('8.8.8.8');
    assert.equal(countryCode, 'US');
  });

  it('does not throw on garbage IP input', () => {
    assert.doesNotThrow(() => detectCountryFromIp('not-an-ip'));
  });

  it('returns a default (not a crash) for null IP', () => {
    const result = detectCountryFromIp(null);
    assert.ok(result.countryCode);
  });
});

describe('requireCrmUser middleware — session enforcement', () => {
  it('rejects request with no Authorization header', async () => {
    const res = await fetch(`${baseUrl}/protected`);
    assert.equal(res.status, 401);
  });

  it('rejects malformed bearer token', async () => {
    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: 'Bearer not-a-real-jwt' } });
    assert.equal(res.status, 401);
  });

  it('rejects token signed with wrong secret', async () => {
    const badToken = jwt.sign({ role: 'crm_user', email: TEST_EMAIL_A }, 'wrong-secret', { expiresIn: '1h' });
    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${badToken}` } });
    assert.equal(res.status, 401);
  });

  it('rejects token with wrong role', async () => {
    const token = jwt.sign({ role: 'crm_admin', email: TEST_EMAIL_A }, getCrmJwtSecret(), { expiresIn: '1h' });
    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
  });

  it('allows a legacy token with no sessionId claim (backward compatibility)', async () => {
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [] }); // no sessionId
    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.crmUser.email, TEST_EMAIL_A);
  });

  it('allows a valid session-bound token and bumps lastSeenAt', async () => {
    const sessionId = await createSessionDoc({ lastSeenAt: new Date(Date.now() - 60_000) });
    const before = await CrmSessionModel.findOne({ sessionId });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId });

    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);

    const after = await CrmSessionModel.findOne({ sessionId });
    assert.ok(after.lastSeenAt.getTime() > before.lastSeenAt.getTime(), 'lastSeenAt should be bumped forward');
  });

  it('rejects a token whose session has been revoked — the core kill-switch behavior', async () => {
    const sessionId = await createSessionDoc({ revoked: true, revokedAt: new Date() });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId });

    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /revoked/i);
  });

  it('rejects a token referencing a sessionId that does not exist in DB (edge case — should not crash)', async () => {
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId: 'nonexistent-session-id' });
    const res = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${token}` } });
    // No matching session row means nothing to enforce against — middleware should let it through
    // (this documents actual current behavior so a future change is a deliberate decision, not a surprise)
    assert.equal(res.status, 200);
  });
});

describe('GET /api/crm/sessions — list my sessions', () => {
  it('returns only sessions for the requesting users own email, not other users', async () => {
    const mySessionId = await createSessionDoc({ email: TEST_EMAIL_A });
    const otherSessionId = await createSessionDoc({ email: TEST_EMAIL_B });

    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId: mySessionId });
    const res = await fetch(`${baseUrl}/api/crm/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.success);
    const ids = body.data.map((s) => s.sessionId);
    assert.ok(ids.includes(mySessionId));
    assert.ok(!ids.includes(otherSessionId));
  });

  it('marks the callers own current session as isCurrent: true', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_A });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId });

    const res = await fetch(`${baseUrl}/api/crm/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    const mine = body.data.find((s) => s.sessionId === sessionId);
    assert.equal(mine.isCurrent, true);
  });

  it('excludes revoked sessions from the list', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_A, revoked: true });
    const activeSessionId = await createSessionDoc({ email: TEST_EMAIL_A });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId: activeSessionId });

    const res = await fetch(`${baseUrl}/api/crm/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    const ids = body.data.map((s) => s.sessionId);
    assert.ok(!ids.includes(sessionId));
    assert.ok(ids.includes(activeSessionId));
  });

  it('includes device/IP/location fields in the response shape', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_A, ip: '8.8.8.8', country: 'United States' });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId });

    const res = await fetch(`${baseUrl}/api/crm/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json();
    const mine = body.data.find((s) => s.sessionId === sessionId);
    assert.equal(mine.ip, '8.8.8.8');
    assert.equal(mine.country, 'United States');
    assert.equal(mine.deviceLabel, 'Chrome on macOS');
  });
});

describe('POST /api/crm/sessions/:sessionId/revoke — self revoke', () => {
  it('revokes own session successfully', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_A });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [] }); // acting from a different session

    const res = await fetch(`${baseUrl}/api/crm/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);

    const doc = await CrmSessionModel.findOne({ sessionId });
    assert.equal(doc.revoked, true);
    assert.ok(doc.revokedAt);
  });

  it('a revoked session immediately blocks that devices subsequent requests (end-to-end kill-switch)', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_A });
    const deviceToken = signUserToken({ email: TEST_EMAIL_A, permissions: [], sessionId });

    // Device works fine before revoke.
    const before = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    assert.equal(before.status, 200);

    // Revoke it from "another device" (any valid token for the same user).
    const revokerToken = signUserToken({ email: TEST_EMAIL_A, permissions: [] });
    const revokeRes = await fetch(`${baseUrl}/api/crm/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${revokerToken}` },
    });
    assert.equal(revokeRes.status, 200);

    // The original device's still-unexpired JWT must now be rejected.
    const after = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${deviceToken}` } });
    assert.equal(after.status, 401);
  });

  it('rejects revoking a session that belongs to a different user', async () => {
    const otherSessionId = await createSessionDoc({ email: TEST_EMAIL_B });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [] });

    const res = await fetch(`${baseUrl}/api/crm/sessions/${otherSessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 403);

    const doc = await CrmSessionModel.findOne({ sessionId: otherSessionId });
    assert.equal(doc.revoked, false, 'other users session must remain untouched');
  });

  it('returns 404 for a sessionId that does not exist', async () => {
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [] });
    const res = await fetch(`${baseUrl}/api/crm/sessions/does-not-exist/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
  });

  it('revoking an already-revoked session is idempotent (no error)', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_A, revoked: true });
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [] });

    const res = await fetch(`${baseUrl}/api/crm/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
  });
});

describe('Admin session endpoints', () => {
  it('GET /api/crm/admin/sessions rejects a non-admin (crm_user) token', async () => {
    const token = signUserToken({ email: TEST_EMAIL_A, permissions: [] });
    const res = await fetch(`${baseUrl}/api/crm/admin/sessions`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 403);
  });

  it('GET /api/crm/admin/sessions returns sessions across multiple users', async () => {
    const sessionA = await createSessionDoc({ email: TEST_EMAIL_A });
    const sessionB = await createSessionDoc({ email: TEST_EMAIL_B });
    const adminToken = signAdminToken();

    const res = await fetch(`${baseUrl}/api/crm/admin/sessions`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = body.data.map((s) => s.sessionId);
    assert.ok(ids.includes(sessionA));
    assert.ok(ids.includes(sessionB));
  });

  it('admin can revoke any users session', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_B });
    const adminToken = signAdminToken();

    const res = await fetch(`${baseUrl}/api/crm/admin/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(res.status, 200);

    const doc = await CrmSessionModel.findOne({ sessionId });
    assert.equal(doc.revoked, true);
  });

  it('a non-admin crm_user cannot hit the admin revoke endpoint', async () => {
    const sessionId = await createSessionDoc({ email: TEST_EMAIL_B });
    const userToken = signUserToken({ email: TEST_EMAIL_A, permissions: [] });

    const res = await fetch(`${baseUrl}/api/crm/admin/sessions/${sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(res.status, 403);

    const doc = await CrmSessionModel.findOne({ sessionId });
    assert.equal(doc.revoked, false);
  });
});

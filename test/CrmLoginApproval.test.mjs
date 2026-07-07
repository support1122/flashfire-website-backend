import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import { getCrmJwtSecret, requireCrmUser, requireCrmAdmin } from '../Middlewares/CrmAuth.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { CrmSessionModel } from '../Schema_Models/CrmSessionModel.js';
import { CrmLoginApprovalModel } from '../Schema_Models/CrmLoginApprovalModel.js';
import { CrmTrustedDeviceModel } from '../Schema_Models/CrmTrustedDeviceModel.js';
import { computeDeviceKey } from '../Utils/DeviceKey.js';
import { requestCrmOtp, verifyCrmOtp, getLoginApprovalStatus } from '../Controllers/CrmAuthController.js';
import { listPendingLoginApprovals, approveLoginApproval, denyLoginApproval } from '../Controllers/CrmLoginApprovalController.js';
import { adminRevokeSession } from '../Controllers/CrmSessionController.js';
import { setOtp, getOtp } from '../Utils/CrmOtpCache.js';
import crypto from 'crypto';

const MONGO_URI = process.env.MONGO_URI;
const TEST_BDA_EMAIL = '__test_bda@loginflow.local';
const TEST_ADMIN_EMAIL = '__test_admin@loginflow.local';

let app;
let server;
let baseUrl;

function signAdminToken() {
  return jwt.sign({ role: 'crm_admin', email: TEST_ADMIN_EMAIL }, getCrmJwtSecret(), { expiresIn: '1h' });
}

// Mirrors the real OTP hash the controller expects, so we can seed a "correct" OTP
// without going through SendGrid.
function otpHash(email, otp) {
  const secret = process.env.CRM_OTP_HASH_SECRET || getCrmJwtSecret();
  const value = `${email}|${String(otp).trim()}|${secret}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}

function seedOtp(email, otp) {
  setOtp(email, {
    otpHash: otpHash(email, otp),
    expiresAtMs: Date.now() + 5 * 60 * 1000,
    attemptsLeft: 5,
  });
}

const CHROME_MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FIREFOX_WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

async function cleanupAll() {
  await CrmUserModel.deleteMany({ email: { $in: [TEST_BDA_EMAIL, TEST_ADMIN_EMAIL] } });
  await CrmSessionModel.deleteMany({ email: { $in: [TEST_BDA_EMAIL, TEST_ADMIN_EMAIL] } });
  await CrmLoginApprovalModel.deleteMany({ email: { $in: [TEST_BDA_EMAIL, TEST_ADMIN_EMAIL] } });
  await CrmTrustedDeviceModel.deleteMany({ email: { $in: [TEST_BDA_EMAIL, TEST_ADMIN_EMAIL] } });
}

before(async () => {
  await mongoose.connect(MONGO_URI);
  await cleanupAll();

  app = express();
  app.set('trust proxy', true);
  app.use(express.json());

  app.post('/api/crm/auth/request-otp', requestCrmOtp);
  app.post('/api/crm/auth/verify-otp', verifyCrmOtp);
  app.get('/api/crm/auth/login-approval/:approvalId/status', getLoginApprovalStatus);
  app.get('/protected', requireCrmUser, (req, res) => res.json({ success: true, crmUser: req.crmUser }));

  app.get('/api/crm/admin/login-approvals', requireCrmAdmin, listPendingLoginApprovals);
  app.post('/api/crm/admin/login-approvals/:approvalId/approve', requireCrmAdmin, approveLoginApproval);
  app.post('/api/crm/admin/login-approvals/:approvalId/deny', requireCrmAdmin, denyLoginApproval);
  app.post('/api/crm/admin/sessions/:sessionId/revoke', requireCrmAdmin, adminRevokeSession);

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await cleanupAll();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
});

beforeEach(async () => {
  // Fresh BDA user + clean approval/trusted-device state before every test.
  await CrmLoginApprovalModel.deleteMany({ email: TEST_BDA_EMAIL });
  await CrmTrustedDeviceModel.deleteMany({ email: TEST_BDA_EMAIL });
  await CrmSessionModel.deleteMany({ email: TEST_BDA_EMAIL });
  await CrmUserModel.findOneAndUpdate(
    { email: TEST_BDA_EMAIL },
    { email: TEST_BDA_EMAIL, name: 'Test BDA', role: 'bda', isActive: true, permissions: [] },
    { upsert: true }
  );
});

describe('verifyCrmOtp — BDA new-device gate', () => {
  it('a BDA logging in from a brand-new device gets pendingApproval, not a token', async () => {
    seedOtp(TEST_BDA_EMAIL, '111111');
    const res = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '111111' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.pendingApproval, true);
    assert.ok(body.approvalId);
    assert.equal(body.token, undefined);
  });

  it('creates a pending CrmLoginApproval document with correct device/IP metadata', async () => {
    seedOtp(TEST_BDA_EMAIL, '222222');
    const res = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CHROME_MAC_UA,
        'X-Forwarded-For': '8.8.8.8',
      },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '222222' }),
    });
    const body = await res.json();
    const doc = await CrmLoginApprovalModel.findOne({ sessionId: body.approvalId });
    assert.ok(doc);
    assert.equal(doc.status, 'pending');
    assert.equal(doc.email, TEST_BDA_EMAIL);
    assert.equal(doc.browser, 'Chrome');
    assert.equal(doc.os, 'macOS');
    assert.equal(doc.ip, '8.8.8.8');
    assert.equal(doc.country, 'United States');
  });

  it('GET login-approval status returns "pending" while awaiting admin action', async () => {
    seedOtp(TEST_BDA_EMAIL, '333333');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '333333' }),
    });
    const { approvalId } = await verifyRes.json();

    const statusRes = await fetch(`${baseUrl}/api/crm/auth/login-approval/${approvalId}/status`);
    const statusBody = await statusRes.json();
    assert.equal(statusBody.status, 'pending');
  });

  it('GET login-approval status for an unknown approvalId returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/crm/auth/login-approval/does-not-exist/status`);
    assert.equal(res.status, 404);
  });
});

describe('Admin approves a login', () => {
  it('non-admin cannot list pending login approvals', async () => {
    const userToken = jwt.sign({ role: 'crm_user', email: TEST_BDA_EMAIL }, getCrmJwtSecret(), { expiresIn: '1h' });
    const res = await fetch(`${baseUrl}/api/crm/admin/login-approvals`, { headers: { Authorization: `Bearer ${userToken}` } });
    assert.equal(res.status, 403);
  });

  it('admin sees the pending request in the list with device details', async () => {
    seedOtp(TEST_BDA_EMAIL, '444444');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '444444' }),
    });
    const { approvalId } = await verifyRes.json();

    const adminToken = signAdminToken();
    const listRes = await fetch(`${baseUrl}/api/crm/admin/login-approvals`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const listBody = await listRes.json();
    const found = listBody.data.find((a) => a.approvalId === approvalId);
    assert.ok(found);
    assert.equal(found.email, TEST_BDA_EMAIL);
    assert.equal(found.deviceLabel, 'Chrome on macOS');
  });

  it('approving issues a token retrievable via the polling endpoint, and the BDA becomes fully logged in', async () => {
    seedOtp(TEST_BDA_EMAIL, '555555');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '555555' }),
    });
    const { approvalId } = await verifyRes.json();

    const adminToken = signAdminToken();
    const approveRes = await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(approveRes.status, 200);

    // BDA's browser polls and should now receive a real, usable token.
    const pollRes = await fetch(`${baseUrl}/api/crm/auth/login-approval/${approvalId}/status`);
    const pollBody = await pollRes.json();
    assert.equal(pollBody.status, 'approved');
    assert.ok(pollBody.token);
    assert.equal(pollBody.user.email, TEST_BDA_EMAIL);

    // Prove the issued token actually authenticates against a protected route.
    const protectedRes = await fetch(`${baseUrl}/protected`, { headers: { Authorization: `Bearer ${pollBody.token}` } });
    assert.equal(protectedRes.status, 200);
  });

  it('the issued token is single-use over the polling endpoint (second poll does not leak it again)', async () => {
    seedOtp(TEST_BDA_EMAIL, '666666');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '666666' }),
    });
    const { approvalId } = await verifyRes.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const firstPoll = await (await fetch(`${baseUrl}/api/crm/auth/login-approval/${approvalId}/status`)).json();
    assert.ok(firstPoll.token);

    const secondPoll = await (await fetch(`${baseUrl}/api/crm/auth/login-approval/${approvalId}/status`)).json();
    assert.equal(secondPoll.status, 'approved');
    assert.equal(secondPoll.token, undefined);
  });

  it('approving a login marks that device as trusted for future logins', async () => {
    seedOtp(TEST_BDA_EMAIL, '777777');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '1.2.3.4' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '777777' }),
    });
    const { approvalId } = await verifyRes.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const expectedDeviceKey = computeDeviceKey(CHROME_MAC_UA, '1.2.3.4');
    const trusted = await CrmTrustedDeviceModel.findOne({ email: TEST_BDA_EMAIL, deviceKey: expectedDeviceKey });
    assert.ok(trusted, 'device should now be marked trusted');
  });

  it('a second login from the now-trusted device skips approval entirely and returns a token directly', async () => {
    // First login + approval, to establish trust.
    seedOtp(TEST_BDA_EMAIL, '888881');
    const firstVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '5.6.7.8' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '888881' }),
    });
    const { approvalId } = await firstVerify.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    // Second login, same device+IP.
    seedOtp(TEST_BDA_EMAIL, '888882');
    const secondVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '5.6.7.8' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '888882' }),
    });
    const secondBody = await secondVerify.json();
    assert.equal(secondBody.pendingApproval, undefined);
    assert.ok(secondBody.token, 'trusted device should get a token immediately, no approval needed');
  });

  it('a login from a different device (different browser) still requires fresh approval, even after another device was trusted', async () => {
    seedOtp(TEST_BDA_EMAIL, '999991');
    const firstVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '9.9.9.9' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '999991' }),
    });
    const { approvalId } = await firstVerify.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    // Different browser entirely (Firefox vs Chrome) from the same IP.
    seedOtp(TEST_BDA_EMAIL, '999992');
    const secondVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': FIREFOX_WIN_UA, 'X-Forwarded-For': '9.9.9.9' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '999992' }),
    });
    const secondBody = await secondVerify.json();
    assert.equal(secondBody.pendingApproval, true, 'a genuinely different browser must re-trigger approval');
  });
});

describe('Admin denies a login', () => {
  it('denying sets status to denied and the polling BDA sees "denied"', async () => {
    seedOtp(TEST_BDA_EMAIL, '121212');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '121212' }),
    });
    const { approvalId } = await verifyRes.json();
    const adminToken = signAdminToken();

    const denyRes = await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/deny`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(denyRes.status, 200);

    const pollBody = await (await fetch(`${baseUrl}/api/crm/auth/login-approval/${approvalId}/status`)).json();
    assert.equal(pollBody.status, 'denied');
    assert.equal(pollBody.token, undefined);
  });

  it('a denied device is NOT marked trusted — a later login attempt is gated again', async () => {
    seedOtp(TEST_BDA_EMAIL, '131313');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '4.4.4.4' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '131313' }),
    });
    const { approvalId } = await verifyRes.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/deny`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const deviceKey = computeDeviceKey(CHROME_MAC_UA, '4.4.4.4');
    const trusted = await CrmTrustedDeviceModel.findOne({ email: TEST_BDA_EMAIL, deviceKey });
    assert.equal(trusted, null);

    seedOtp(TEST_BDA_EMAIL, '141414');
    const secondVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '4.4.4.4' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '141414' }),
    });
    const secondBody = await secondVerify.json();
    assert.equal(secondBody.pendingApproval, true, 'denied device must be re-gated on next attempt');
  });
});

describe('Double-action safety', () => {
  it('approving an already-approved request returns a conflict, not a duplicate token', async () => {
    seedOtp(TEST_BDA_EMAIL, '151515');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '151515' }),
    });
    const { approvalId } = await verifyRes.json();
    const adminToken = signAdminToken();

    const first = await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(first.status, 200);

    const second = await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(second.status, 409);
  });

  it('denying an already-approved request is rejected (cannot flip a decision)', async () => {
    seedOtp(TEST_BDA_EMAIL, '161616');
    const verifyRes = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '161616' }),
    });
    const { approvalId } = await verifyRes.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const denyAttempt = await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/deny`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(denyAttempt.status, 409);
  });

  it('approving a nonexistent approvalId returns 404', async () => {
    const adminToken = signAdminToken();
    const res = await fetch(`${baseUrl}/api/crm/admin/login-approvals/does-not-exist/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(res.status, 404);
  });
});

describe('Admin role bypasses the approval gate entirely', () => {
  it('a user with role "admin" logging in from a new device gets a token directly, no approval needed', async () => {
    await CrmUserModel.findOneAndUpdate(
      { email: TEST_ADMIN_EMAIL },
      { email: TEST_ADMIN_EMAIL, name: 'Test Admin User', role: 'admin', isActive: true, permissions: [] },
      { upsert: true }
    );
    seedOtp(TEST_ADMIN_EMAIL, '171717');
    const res = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA },
      body: JSON.stringify({ email: TEST_ADMIN_EMAIL, otp: '171717' }),
    });
    const body = await res.json();
    assert.equal(body.pendingApproval, undefined);
    assert.ok(body.token, 'admin-role users must never be gated by device approval');
  });
});

describe('Revoking a session also un-trusts the device', () => {
  it('after an admin revokes a BDA session, the same device must go through approval again on next login', async () => {
    // First login + approval — establishes trust.
    seedOtp(TEST_BDA_EMAIL, '818181');
    const firstVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '6.6.6.6' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '818181' }),
    });
    const { approvalId } = await firstVerify.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalId}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const deviceKey = computeDeviceKey(CHROME_MAC_UA, '6.6.6.6');
    const trustedBefore = await CrmTrustedDeviceModel.findOne({ email: TEST_BDA_EMAIL, deviceKey });
    assert.ok(trustedBefore, 'sanity check: device should be trusted after approval');

    // Confirm the session created by approval carries the same deviceKey.
    const session = await CrmSessionModel.findOne({ email: TEST_BDA_EMAIL }).sort({ createdAt: -1 });
    assert.equal(session.deviceKey, deviceKey);

    // Admin revokes that session.
    const revokeRes = await fetch(`${baseUrl}/api/crm/admin/sessions/${session.sessionId}/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(revokeRes.status, 200);

    // Trust should now be gone.
    const trustedAfter = await CrmTrustedDeviceModel.findOne({ email: TEST_BDA_EMAIL, deviceKey });
    assert.equal(trustedAfter, null, 'revoking the session must remove device trust');

    // Logging in again from the exact same device must be gated again, not instant.
    seedOtp(TEST_BDA_EMAIL, '818182');
    const secondVerify = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '6.6.6.6' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '818182' }),
    });
    const secondBody = await secondVerify.json();
    assert.equal(secondBody.pendingApproval, true, 'device must require fresh approval after its trust was revoked');
  });

  it('revoking one session does not untrust a different device for the same BDA', async () => {
    // Device A: login + approve.
    seedOtp(TEST_BDA_EMAIL, '919191');
    const verifyA = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC_UA, 'X-Forwarded-For': '7.7.7.7' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '919191' }),
    });
    const { approvalId: approvalA } = await verifyA.json();
    const adminToken = signAdminToken();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalA}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    // Device B (different browser): login + approve.
    seedOtp(TEST_BDA_EMAIL, '929292');
    const verifyB = await fetch(`${baseUrl}/api/crm/auth/verify-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': FIREFOX_WIN_UA, 'X-Forwarded-For': '7.7.7.7' },
      body: JSON.stringify({ email: TEST_BDA_EMAIL, otp: '929292' }),
    });
    const { approvalId: approvalB } = await verifyB.json();
    await fetch(`${baseUrl}/api/crm/admin/login-approvals/${approvalB}/approve`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const deviceKeyA = computeDeviceKey(CHROME_MAC_UA, '7.7.7.7');
    const deviceKeyB = computeDeviceKey(FIREFOX_WIN_UA, '7.7.7.7');

    const sessionA = await CrmSessionModel.findOne({ email: TEST_BDA_EMAIL, deviceKey: deviceKeyA });
    await fetch(`${baseUrl}/api/crm/admin/sessions/${sessionA.sessionId}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });

    const trustedA = await CrmTrustedDeviceModel.findOne({ email: TEST_BDA_EMAIL, deviceKey: deviceKeyA });
    const trustedB = await CrmTrustedDeviceModel.findOne({ email: TEST_BDA_EMAIL, deviceKey: deviceKeyB });
    assert.equal(trustedA, null, 'revoked device should be untrusted');
    assert.ok(trustedB, 'the other, unrevoked device should remain trusted');
  });
});

/**
 * Smoke test for the live Stripe capture webhook. Run it right after adding the
 * endpoint in the Stripe dashboard to prove the whole chain works: the URL is
 * reachable, the signing secret matches, the raw body survives the middleware,
 * and the row lands in Mongo.
 *
 *   node scripts/verify-stripe-capture.mjs
 *   node scripts/verify-stripe-capture.mjs --url https://api.flashfirejobs.com/api/webhooks/stripe/capture
 *   node scripts/verify-stripe-capture.mjs --keep      # leave the test rows in the DB
 *   node scripts/verify-stripe-capture.mjs --no-db     # HTTP checks only
 *
 * Needs STRIPE_CAPTURE_WEBHOOK_SECRET (or STRIPE_WEBHOOK_SECRET) — the signing
 * secret Stripe showed you when you created the endpoint. Reads it from the
 * environment, else from this backend's .env.
 *
 * Set MONGODB_URI too (or leave it in .env) and it also verifies the DB side:
 * the document exists, the payload is stored whole, and a redelivery bumped
 * deliveryCount instead of inserting twice.
 *
 * It posts SYNTHETIC events with ids like evt_verify_<timestamp>. They are real
 * rows in the capture log, so unless you pass --keep it deletes the ones it
 * created, and only those. It never touches anything Stripe sent you.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://api.flashfirejobs.com/api/webhooks/stripe/capture';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

/** Env first, then this backend's .env (values there are sometimes quoted). */
function fromEnvFile(key) {
  if (process.env[key]) return process.env[key].trim().replace(/^["']|["']$/g, '');
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith(`${key}=`) && !l.startsWith('#'));
  return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
}

const URL_UNDER_TEST = argValue('--url') || process.env.STRIPE_CAPTURE_URL || DEFAULT_URL;
const SECRET = fromEnvFile('STRIPE_CAPTURE_WEBHOOK_SECRET') || fromEnvFile('STRIPE_WEBHOOK_SECRET');
// --no-db: HTTP checks only. Use it when pointing at a staging URL whose
// database is not the one this .env names, so nothing is read or deleted there.
const NO_DB = process.argv.includes('--no-db');
const MONGODB_URI = NO_DB ? '' : fromEnvFile('MONGODB_URI');
const KEEP = process.argv.includes('--keep');

if (!SECRET) {
  console.error('No signing secret. Set STRIPE_CAPTURE_WEBHOOK_SECRET (or STRIPE_WEBHOOK_SECRET).');
  process.exit(1);
}

/** The same t=…,v1=… scheme Stripe uses. */
function sign(rawBody, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const RUN_ID = Date.now();
const EVENT_ID = `evt_verify_${RUN_ID}`;
const createdEventIds = [EVENT_ID];

/** Shaped like a real Checkout completion, with an obviously synthetic id. */
function buildEvent(id = EVENT_ID) {
  return {
    id,
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    type: 'checkout.session.completed',
    request: { id: `req_verify_${RUN_ID}`, idempotency_key: null },
    data: {
      object: {
        id: `cs_verify_${RUN_ID}`,
        object: 'checkout.session',
        amount_total: 59900,
        amount_subtotal: 59900,
        currency: 'usd',
        customer: `cus_verify_${RUN_ID}`,
        customer_details: {
          email: 'webhook-verify@flashfirejobs.com',
          name: 'Webhook Verification',
          phone: null,
          address: { country: 'US' },
        },
        mode: 'payment',
        payment_intent: `pi_verify_${RUN_ID}`,
        payment_status: 'paid',
        status: 'complete',
        total_details: { amount_discount: 0 },
        metadata: { source: 'verify-stripe-capture.mjs', plan: 'Executive' },
      },
    },
  };
}

async function post(rawBody, signature) {
  const headers = { 'content-type': 'application/json' };
  if (signature) headers['stripe-signature'] = signature;
  const res = await fetch(URL_UNDER_TEST, { method: 'POST', headers, body: rawBody });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep the text */ }
  return { status: res.status, json, text };
}

// ── checks ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

console.log(`Verifying ${URL_UNDER_TEST}`);
console.log(`Signing secret: ${SECRET.slice(0, 9)}… (${SECRET.length} chars)\n`);

// 1. A properly signed delivery must be accepted and marked verified. This is
//    the one that proves the secret matches AND the raw body reached the
//    handler — an express.raw mount-order problem fails exactly here.
{
  const raw = JSON.stringify(buildEvent());
  const r = await post(raw, sign(raw));
  check('signed delivery accepted (200)', r.status === 200, `got ${r.status}: ${r.text.slice(0, 200)}`);
  check('reported as verified', r.json?.verified === true, JSON.stringify(r.json));
  check('reported as stored', r.json?.stored === true, JSON.stringify(r.json));
  check('event type echoed back', r.json?.type === 'checkout.session.completed', JSON.stringify(r.json));
}

// 2. Same event id again. Stripe retries on any non-2xx and on its own
//    schedule, so this must not create a second row.
{
  const raw = JSON.stringify(buildEvent());
  const r = await post(raw, sign(raw));
  check('redelivery of the same event id accepted', r.status === 200, `got ${r.status}: ${r.text.slice(0, 200)}`);
}

// 3. Wrong secret. Must be rejected, but still stored — seeing what hits the
//    URL is the point of this endpoint.
{
  const id = `evt_verify_badsig_${RUN_ID}`;
  createdEventIds.push(id);
  const raw = JSON.stringify(buildEvent(id));
  const r = await post(raw, sign(raw, 'whsec_deliberately_wrong_secret'));
  check('wrong signing secret rejected (400)', r.status === 400, `got ${r.status}: ${r.text.slice(0, 200)}`);
  check('rejected delivery still captured', r.json?.stored === true, JSON.stringify(r.json));
  check('rejected delivery marked unverified', r.json?.verified === false, JSON.stringify(r.json));
}

// 4. No signature header at all — a random POST to a public URL.
{
  const id = `evt_verify_nosig_${RUN_ID}`;
  createdEventIds.push(id);
  const raw = JSON.stringify(buildEvent(id));
  const r = await post(raw, null);
  check('unsigned request rejected (400)', r.status === 400, `got ${r.status}: ${r.text.slice(0, 200)}`);
  check('unsigned request marked unverified', r.json?.verified === false, JSON.stringify(r.json));
}

// 5. A correctly signed body from an hour ago. Replaying a captured request
//    must not work.
{
  const id = `evt_verify_replay_${RUN_ID}`;
  createdEventIds.push(id);
  const raw = JSON.stringify(buildEvent(id));
  const stale = Math.floor(Date.now() / 1000) - 3600;
  const r = await post(raw, sign(raw, SECRET, stale));
  check('replayed old signature rejected (400)', r.status === 400, `got ${r.status}: ${r.text.slice(0, 200)}`);
}

// 6. The DB side, when we can reach Mongo. Everything above only proves the
//    endpoint answered; this proves it actually saved.
let mongoose = null;
if (!MONGODB_URI) {
  console.log(`\n  SKIP  database checks (${NO_DB ? '--no-db' : 'no MONGODB_URI'}) — HTTP responses only`);
} else {
  console.log('');
  try {
    mongoose = (await import('mongoose')).default;
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
    const { StripeWebhookEventModel } = await import('../Schema_Models/StripeWebhookEvent.js');

    const row = await StripeWebhookEventModel.findOne({ eventId: EVENT_ID }).lean();
    check('row written to the capture log', !!row, `no document with eventId ${EVENT_ID}`);

    if (row) {
      check('stored as verified', row.verified === true, `verified=${row.verified} error=${row.signatureError}`);
      check('full payload kept', row.payload?.data?.object?.id === `cs_verify_${RUN_ID}`, 'payload missing or truncated');
      check('amount flattened for the list view', row.amountTotal === 59900, `amountTotal=${row.amountTotal}`);
      check('customer email extracted', row.customerEmail === 'webhook-verify@flashfirejobs.com', `customerEmail=${row.customerEmail}`);
      check('metadata kept', row.metadata?.plan === 'Executive', JSON.stringify(row.metadata));
      check('redelivery counted, not duplicated', row.deliveryCount === 2, `deliveryCount=${row.deliveryCount}`);
      const copies = await StripeWebhookEventModel.countDocuments({ eventId: EVENT_ID });
      check('exactly one row for the event id', copies === 1, `found ${copies} rows`);
    }

    const badSig = await StripeWebhookEventModel.findOne({ eventId: `evt_verify_badsig_${RUN_ID}` }).lean();
    check('unverified delivery persisted too', !!badSig && badSig.verified === false, 'missing, or not flagged unverified');

    if (!KEEP) {
      const { deletedCount } = await StripeWebhookEventModel.deleteMany({ eventId: { $in: createdEventIds } });
      console.log(`\n  cleaned up ${deletedCount} synthetic row(s). Pass --keep to leave them.`);
    } else {
      console.log(`\n  --keep: left ${createdEventIds.length} synthetic row(s) in the log.`);
    }
  } catch (err) {
    check('database checks', false, err?.message || String(err));
  } finally {
    if (mongoose?.connection?.readyState) await mongoose.disconnect().catch(() => {});
  }
}

console.log(`\n${failed === 0 ? 'All good' : 'PROBLEMS FOUND'} — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`
Where to look:
  400 on the signed delivery      the secret in STRIPE_CAPTURE_WEBHOOK_SECRET is not
                                  the one Stripe generated for THIS endpoint
  "raw body unavailable"          express.raw is no longer mounted ahead of
                                  express.json for /api/webhooks/stripe in index.js
  404 / HTML response             the backend on that host has not been redeployed
  200 but no row in Mongo         the backend is pointed at a different database
                                  than MONGODB_URI here`);
}
process.exit(failed === 0 ? 0 : 1);

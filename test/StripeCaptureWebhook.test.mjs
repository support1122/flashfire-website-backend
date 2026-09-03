// Stripe capture webhook — signature verification, field extraction, and the
// handler's persist behaviour.
//
// Runs offline: the model's statics are swapped for an in-memory store, so no
// Mongo connection is needed.

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.STRIPE_CAPTURE_WEBHOOK_SECRET = 'whsec_test_secret';

const { StripeWebhookEventModel } = await import('../Schema_Models/StripeWebhookEvent.js');
const {
  captureStripeWebhook,
  verifyStripeSignature,
  summariseStripeEvent,
} = await import('../Controllers/StripeCaptureWebhookController.js');

const SECRET = 'whsec_test_secret';

function sign(rawBody, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// ── in-memory model ───────────────────────────────────────────────────────
let store = [];
const orig = {};

before(() => {
  orig.findOneAndUpdate = StripeWebhookEventModel.findOneAndUpdate;
  orig.create = StripeWebhookEventModel.create;

  StripeWebhookEventModel.findOneAndUpdate = async (filter, update) => {
    const existing = store.find((d) => d.eventId === filter.eventId);
    if (existing) {
      Object.assign(existing, update.$set || {});
      for (const [k, v] of Object.entries(update.$inc || {})) existing[k] = (existing[k] || 0) + v;
      return existing;
    }
    const doc = { ...(update.$setOnInsert || {}), ...(update.$set || {}), deliveryCount: 1 };
    store.push(doc);
    return doc;
  };
  StripeWebhookEventModel.create = async (doc) => {
    store.push({ ...doc });
    return doc;
  };
});

after(() => {
  StripeWebhookEventModel.findOneAndUpdate = orig.findOneAndUpdate;
  StripeWebhookEventModel.create = orig.create;
});

beforeEach(() => { store = []; });

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function reqFor(event, { secret = SECRET, timestamp, signature } = {}) {
  const raw = typeof event === 'string' ? event : JSON.stringify(event);
  return {
    body: Buffer.from(raw, 'utf8'),
    headers: {
      'stripe-signature': signature === null ? undefined : (signature ?? sign(raw, secret, timestamp)),
      'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)',
      'content-type': 'application/json',
    },
  };
}

const CHECKOUT_EVENT = {
  id: 'evt_test_1',
  object: 'event',
  api_version: '2024-06-20',
  created: Math.floor(Date.now() / 1000),
  livemode: false,
  type: 'checkout.session.completed',
  request: { id: 'req_abc', idempotency_key: null },
  data: {
    object: {
      id: 'cs_test_a1',
      object: 'checkout.session',
      amount_total: 59900,
      amount_subtotal: 59900,
      currency: 'usd',
      customer: 'cus_123',
      customer_details: { email: 'Client@Example.com', name: 'Test Client', phone: '+15551234567' },
      mode: 'payment',
      payment_intent: 'pi_test_1',
      payment_link: 'plink_exec',
      payment_status: 'paid',
      status: 'complete',
      total_details: { amount_discount: 0 },
      metadata: { plan: 'Executive' },
    },
  },
};

// ── signature verification ────────────────────────────────────────────────

test('a correctly signed body verifies', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  assert.deepEqual(verifyStripeSignature(raw, sign(raw), SECRET), { ok: true, error: null });
});

test('a tampered body does not verify', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  const header = sign(raw);
  const tampered = raw.replace('59900', '100');
  const result = verifyStripeSignature(tampered, header, SECRET);
  assert.equal(result.ok, false);
  assert.match(result.error, /mismatch/);
});

test('the wrong signing secret does not verify', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  const result = verifyStripeSignature(raw, sign(raw, 'whsec_someone_elses'), SECRET);
  assert.equal(result.ok, false);
});

test('a replayed delivery outside the tolerance window is rejected', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  const old = Math.floor(Date.now() / 1000) - 3600;
  const result = verifyStripeSignature(raw, sign(raw, SECRET, old), SECRET);
  assert.equal(result.ok, false);
  assert.match(result.error, /too old/);
});

test('a missing, malformed or unsigned header is rejected without throwing', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  assert.equal(verifyStripeSignature(raw, null, SECRET).ok, false);
  assert.equal(verifyStripeSignature(raw, 'garbage', SECRET).ok, false);
  assert.equal(verifyStripeSignature(raw, 't=123', SECRET).ok, false);
  // Odd-length hex truncates on Buffer.from; timingSafeEqual throws on a length
  // mismatch, so the length guard has to come first.
  assert.equal(verifyStripeSignature(raw, 't=123,v1=abc', SECRET).ok, false);
});

test('verification with no configured secret fails closed', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  const result = verifyStripeSignature(raw, sign(raw), '');
  assert.equal(result.ok, false);
  assert.match(result.error, /no signing secret/);
});

test('one of several v1 signatures matching is enough (secret rotation)', () => {
  const raw = JSON.stringify(CHECKOUT_EVENT);
  const t = Math.floor(Date.now() / 1000);
  const good = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`, 'utf8').digest('hex');
  const stale = crypto.createHmac('sha256', 'whsec_old').update(`${t}.${raw}`, 'utf8').digest('hex');
  assert.equal(verifyStripeSignature(raw, `t=${t},v1=${stale},v1=${good}`, SECRET).ok, true);
});

// ── field extraction ──────────────────────────────────────────────────────

test('a checkout session yields the fields the list view needs', () => {
  const s = summariseStripeEvent(CHECKOUT_EVENT);
  assert.equal(s.objectType, 'checkout.session');
  assert.equal(s.objectId, 'cs_test_a1');
  assert.equal(s.checkoutSessionId, 'cs_test_a1');
  assert.equal(s.amountTotal, 59900, 'kept in minor units, exactly as Stripe sends it');
  assert.equal(s.currency, 'USD');
  assert.equal(s.customerEmail, 'Client@Example.com');
  assert.equal(s.customerName, 'Test Client');
  assert.equal(s.customerId, 'cus_123');
  assert.equal(s.paymentIntentId, 'pi_test_1');
  assert.equal(s.paymentLinkId, 'plink_exec');
  assert.equal(s.paymentStatus, 'paid');
  assert.deepEqual(s.metadata, { plan: 'Executive' });
});

test('an invoice yields the amount paid and its own id', () => {
  const s = summariseStripeEvent({
    type: 'invoice.paid',
    data: { object: {
      id: 'in_test_1', object: 'invoice', amount_paid: 34900, subtotal: 34900,
      currency: 'usd', customer_email: 'a@b.com', customer_name: 'A B',
      subscription: 'sub_1', status: 'paid',
    } },
  });
  assert.equal(s.invoiceId, 'in_test_1');
  assert.equal(s.amountTotal, 34900);
  assert.equal(s.subscriptionId, 'sub_1');
  assert.equal(s.customerEmail, 'a@b.com');
});

test('a charge yields billing details and links back to its invoice', () => {
  const s = summariseStripeEvent({
    type: 'charge.succeeded',
    data: { object: {
      id: 'ch_1', object: 'charge', amount: 11900, currency: 'usd',
      billing_details: { email: 'c@d.com', name: 'C D' },
      invoice: 'in_9', payment_intent: 'pi_9', description: 'Prime plan',
    } },
  });
  assert.equal(s.objectId, 'ch_1');
  assert.equal(s.amountTotal, 11900);
  assert.equal(s.invoiceId, 'in_9');
  assert.equal(s.paymentIntentId, 'pi_9');
  assert.equal(s.description, 'Prime plan');
  assert.equal(s.customerEmail, 'c@d.com');
});

test('an expanded object is reduced to its id, not stored as an object', () => {
  const s = summariseStripeEvent({
    type: 'charge.succeeded',
    data: { object: { id: 'ch_2', object: 'charge', customer: { id: 'cus_9', object: 'customer' }, invoice: { id: 'in_9' } } },
  });
  assert.equal(s.customerId, 'cus_9');
  assert.equal(s.invoiceId, 'in_9');
});

test('an event with nothing recognisable yields nulls rather than throwing', () => {
  const s = summariseStripeEvent({ type: 'ping', data: { object: {} } });
  assert.equal(s.objectId, null);
  assert.equal(s.amountTotal, null);
  assert.equal(s.customerEmail, null);
  assert.equal(s.metadata, null, 'an empty metadata bag is stored as null, not {}');
});

// ── the endpoint ──────────────────────────────────────────────────────────

test('a signed delivery is stored whole and answered 200', async () => {
  const res = fakeRes();
  await captureStripeWebhook(reqFor(CHECKOUT_EVENT), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { received: true, stored: true, verified: true, type: 'checkout.session.completed' });
  assert.equal(store.length, 1);

  const row = store[0];
  assert.equal(row.eventId, 'evt_test_1');
  assert.equal(row.type, 'checkout.session.completed');
  assert.equal(row.verified, true);
  assert.equal(row.signatureError, null);
  assert.equal(row.livemode, false);
  assert.equal(row.apiVersion, '2024-06-20');
  assert.ok(row.stripeCreatedAt instanceof Date);
  assert.deepEqual(row.payload, CHECKOUT_EVENT, 'the complete event is kept verbatim');
  assert.deepEqual(row.request, { id: 'req_abc', idempotency_key: null });
  assert.equal(row.headers['user-agent'], 'Stripe/1.0 (+https://stripe.com/docs/webhooks)');
  assert.equal(row.amountTotal, 59900, 'flattened alongside the payload');
});

test('an unverified delivery is still stored, and answered 400 so Stripe shows it', async () => {
  const res = fakeRes();
  await captureStripeWebhook(reqFor(CHECKOUT_EVENT, { secret: 'whsec_wrong' }), res);

  assert.equal(res.statusCode, 400, 'a bad signature must be visible in the Stripe dashboard');
  assert.equal(res.body.stored, true);
  assert.equal(res.body.verified, false);
  assert.equal(store.length, 1, 'seeing what hits the URL is the point of this endpoint');
  assert.equal(store[0].verified, false);
  assert.match(store[0].signatureError, /mismatch/);
});

test('a redelivery updates the same row instead of inserting a second', async () => {
  await captureStripeWebhook(reqFor(CHECKOUT_EVENT), fakeRes());
  await captureStripeWebhook(reqFor(CHECKOUT_EVENT), fakeRes());
  await captureStripeWebhook(reqFor(CHECKOUT_EVENT), fakeRes());

  assert.equal(store.length, 1);
  assert.equal(store[0].deliveryCount, 3);
});

test('a body with no event id is still captured', async () => {
  // Correctly signed, so it verifies — it just is not shaped like an event.
  const res = fakeRes();
  await captureStripeWebhook(reqFor({ hello: 'world' }), res);
  assert.equal(store.length, 1);
  assert.equal(store[0].eventId, null, 'goes down the create path, not the upsert');
  assert.equal(store[0].verified, true);
  assert.deepEqual(store[0].payload, { hello: 'world' });
});

test('two unidentifiable bodies both land, they do not collide on a null id', async () => {
  await captureStripeWebhook(reqFor({ hello: 'one' }), fakeRes());
  await captureStripeWebhook(reqFor({ hello: 'two' }), fakeRes());
  assert.equal(store.length, 2);
});

test('unparseable JSON is recorded rather than crashing the endpoint', async () => {
  const res = fakeRes();
  await captureStripeWebhook(reqFor('{not json'), res);
  assert.equal(res.statusCode, 400, 'a body we cannot read must not be acknowledged as fine');
  assert.equal(store.length, 1);
  assert.equal(store[0].payload, null);
  assert.ok(store[0].parseError, 'the parse failure is its own field, not folded into signatureError');
  assert.equal(store[0].signatureError, null, 'the signature itself was valid');
  assert.equal(store[0].rawBody, '{not json', 'the bytes are the only evidence left');
});

test('a persist failure is reported rather than silently acknowledged', async () => {
  const saved = StripeWebhookEventModel.findOneAndUpdate;
  StripeWebhookEventModel.findOneAndUpdate = async () => { throw new Error('mongo down'); };
  try {
    const res = fakeRes();
    await captureStripeWebhook(reqFor(CHECKOUT_EVENT), res);
    assert.equal(res.statusCode, 500, 'Stripe must retry a delivery we failed to store');
    assert.equal(res.body.received, false);
  } finally {
    StripeWebhookEventModel.findOneAndUpdate = saved;
  }
});

test('a duplicate-key race is not treated as a failure', async () => {
  const saved = StripeWebhookEventModel.findOneAndUpdate;
  StripeWebhookEventModel.findOneAndUpdate = async () => {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  };
  try {
    const res = fakeRes();
    await captureStripeWebhook(reqFor(CHECKOUT_EVENT), res);
    assert.equal(res.statusCode, 200, 'two concurrent deliveries of one event is normal Stripe behaviour');
  } finally {
    StripeWebhookEventModel.findOneAndUpdate = saved;
  }
});

test('a parsed (non-raw) body is captured but never counted as verified', async () => {
  // If the express.raw mount ever stops covering this path, re-serialising the
  // object might reproduce the original bytes by luck. That is not a signature
  // check, so it must fail closed and say why.
  const res = fakeRes();
  await captureStripeWebhook(
    { body: CHECKOUT_EVENT, headers: { 'stripe-signature': sign(JSON.stringify(CHECKOUT_EVENT)) } },
    res,
  );
  assert.equal(store.length, 1);
  assert.equal(store[0].verified, false);
  assert.match(store[0].signatureError, /raw body unavailable/);
  assert.equal(store[0].eventId, 'evt_test_1', 'the delivery is still captured in full');
  assert.equal(res.statusCode, 400);
});

// ── mount-order contract ──────────────────────────────────────────────────
// The endpoint only works because index.js mounts express.raw on the
// /api/webhooks/stripe PREFIX, which also covers /capture beneath it. That is
// an easy thing to break by reordering middleware, and the failure is silent
// (every delivery lands unverified). Prove it over a real HTTP request.

test('express.raw on the /api/webhooks/stripe prefix reaches /capture', async () => {
  const { default: express } = await import('express');
  const app = express();

  // Same order as index.js.
  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.post('/api/webhooks/stripe/capture', captureStripeWebhook);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  try {
    const raw = JSON.stringify(CHECKOUT_EVENT);
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/stripe/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) },
      body: raw,
    });
    const body = await res.json();

    assert.equal(res.status, 200, 'a real signed delivery must verify end to end');
    assert.equal(body.verified, true);
    assert.equal(store.length, 1);
    assert.equal(store[0].eventId, 'evt_test_1');
    assert.deepEqual(store[0].payload, CHECKOUT_EVENT);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the same handler behind express.json alone cannot verify', async () => {
  // The regression this guards: drop the raw mount and every delivery silently
  // becomes unverified rather than failing loudly at deploy time.
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  app.post('/api/webhooks/stripe/capture', captureStripeWebhook);

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();

  try {
    const raw = JSON.stringify(CHECKOUT_EVENT);
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/stripe/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(raw) },
      body: raw,
    });
    assert.equal(res.status, 400);
    assert.equal(store[0].verified, false);
    assert.match(store[0].signatureError, /raw body unavailable/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

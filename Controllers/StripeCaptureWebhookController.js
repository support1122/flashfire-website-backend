/**
 * Stripe capture webhook — records every delivery, does nothing else.
 *
 *   POST /api/webhooks/stripe/capture      the URL to paste into Stripe
 *   GET  /api/crm/stripe/webhook-events    list what we captured (CRM auth)
 *   GET  /api/crm/stripe/webhook-events/stats   event types + counts
 *   GET  /api/crm/stripe/webhook-events/:id     one event, whole payload
 *
 * Deliberately separate from handleStripeWebhook in StripeWebhookController.js:
 * that one creates Payment records and emails invoices. This one only writes to
 * the capture log, so it can be pointed at a brand-new Stripe endpoint and
 * subscribed to *every* event type without any risk of double-charging,
 * double-emailing, or acting on a payload we have not read yet.
 *
 * Add it in Stripe as its own endpoint. It gets its own signing secret, so set
 * STRIPE_CAPTURE_WEBHOOK_SECRET; it falls back to STRIPE_WEBHOOK_SECRET only so
 * a single-endpoint setup still works.
 *
 * The raw body is required for signature verification. index.js already mounts
 * express.raw({ type: 'application/json' }) on the /api/webhooks/stripe prefix,
 * which covers this sub-path too.
 */

import crypto from 'node:crypto';
import { StripeWebhookEventModel } from '../Schema_Models/StripeWebhookEvent.js';

const CAPTURE_SECRET =
  process.env.STRIPE_CAPTURE_WEBHOOK_SECRET ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  '';

/** Stripe's own replay window. Anything older is a replay, not a delivery. */
const SIGNATURE_TOLERANCE_SECONDS = Number(process.env.STRIPE_CAPTURE_TOLERANCE_SECONDS) || 300;
/** Mongo caps a document at 16MB; stop well short and record a marker instead. */
const MAX_PAYLOAD_BYTES = Number(process.env.STRIPE_CAPTURE_MAX_BYTES) || 1_000_000;

/**
 * verifyStripeSignature — the t=…,v1=… scheme, by hand.
 *
 * Done with node:crypto rather than the Stripe SDK on purpose: this needs only
 * the signing secret, so the capture endpoint keeps working even where
 * STRIPE_SECRET_KEY is not set. Stripe sends more than one v1 during a secret
 * rotation, so every one is checked.
 */
export function verifyStripeSignature(rawBody, signatureHeader, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) return { ok: false, error: 'no signing secret configured' };
  if (!signatureHeader) return { ok: false, error: 'missing stripe-signature header' };

  const parts = String(signatureHeader)
    .split(',')
    .map((p) => p.split('='))
    .filter((kv) => kv.length >= 2);

  const timestamp = parts.find(([k]) => k.trim() === 't')?.[1];
  const signatures = parts.filter(([k]) => k.trim() === 'v1').map(([, v]) => v.trim());

  if (!timestamp || !signatures.length) return { ok: false, error: 'malformed stripe-signature header' };

  const age = nowSeconds - Number(timestamp);
  if (!Number.isFinite(age)) return { ok: false, error: 'unparseable timestamp' };
  if (age > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, error: `timestamp too old (${age}s)` };

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  const matched = signatures.some((sig) => {
    // Buffer.from on odd/invalid hex silently truncates, so compare lengths
    // before timingSafeEqual — it throws on a mismatch.
    const given = Buffer.from(sig, 'hex');
    return given.length === expectedBuf.length && crypto.timingSafeEqual(given, expectedBuf);
  });

  return matched ? { ok: true, error: null } : { ok: false, error: 'signature mismatch' };
}

const str = (v) => (typeof v === 'string' && v ? v : null);
/** Stripe sends an id string or an expanded object in the same field. */
const idOf = (v) => (typeof v === 'string' ? v : str(v?.id));

/**
 * summarise — pull the handful of fields worth showing in a list, from any
 * event type. Everything here is a convenience copy; `payload` stays the truth.
 */
export function summariseStripeEvent(event) {
  const obj = event?.data?.object || {};
  const details = obj.customer_details || obj.billing_details || {};

  return {
    objectId: str(obj.id),
    objectType: str(obj.object),
    amountTotal:
      obj.amount_total ?? obj.amount_paid ?? obj.amount ?? obj.amount_received ?? null,
    amountSubtotal: obj.amount_subtotal ?? obj.subtotal ?? null,
    amountDiscount: obj.total_details?.amount_discount ?? null,
    currency: str(obj.currency)?.toUpperCase() || null,
    customerEmail:
      str(details.email) ||
      str(obj.customer_email) ||
      str(obj.receipt_email) ||
      null,
    customerName: str(details.name) || str(obj.customer_name) || null,
    customerId: idOf(obj.customer),
    paymentStatus: str(obj.payment_status),
    status: str(obj.status),
    mode: str(obj.mode),
    description: str(obj.description),
    paymentLinkId: idOf(obj.payment_link),
    // On a session the id IS the session; on other objects Stripe links back.
    checkoutSessionId: obj.object === 'checkout.session' ? str(obj.id) : idOf(obj.checkout_session),
    paymentIntentId: idOf(obj.payment_intent),
    invoiceId: obj.object === 'invoice' ? str(obj.id) : idOf(obj.invoice),
    subscriptionId: idOf(obj.subscription),
    metadata: obj.metadata && Object.keys(obj.metadata).length ? obj.metadata : null,
  };
}

/** Only the headers worth keeping. The rest is proxy noise. */
function pickHeaders(headers = {}) {
  const wanted = ['stripe-signature', 'user-agent', 'content-type', 'content-length', 'request-id'];
  const out = {};
  for (const key of wanted) {
    if (headers[key] != null) out[key] = String(headers[key]);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * POST /api/webhooks/stripe/capture
 *
 * Always records what arrived, then answers Stripe. A failed signature is still
 * written (flagged verified:false) — the whole point is to see what is hitting
 * the URL — but it answers 400 so the failure is visible in the Stripe
 * dashboard rather than silently accumulating junk.
 */
export async function captureStripeWebhook(req, res) {
  // express.raw gives a Buffer. If some future middleware order change parses
  // it first, fall back to re-serialising so we still capture something rather
  // than crashing — signature verification will fail loudly in that case.
  const isBuffer = Buffer.isBuffer(req.body);
  const rawBody = isBuffer ? req.body.toString('utf8') : JSON.stringify(req.body ?? {});
  const payloadBytes = Buffer.byteLength(rawBody, 'utf8');

  const signature = req.headers['stripe-signature'] || null;
  // A parsed body cannot be verified. Re-serialising may happen to reproduce
  // the original bytes, but key order and number formatting are not guaranteed,
  // so a "pass" there would be luck. Fail closed and name the cause.
  const check = isBuffer
    ? verifyStripeSignature(rawBody, signature, CAPTURE_SECRET)
    : { ok: false, error: 'raw body unavailable — check the express.raw mount order in index.js' };

  let event = null;
  let parseError = null;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    parseError = err?.message || 'invalid json';
  }

  const summary = event ? summariseStripeEvent(event) : {};
  const tooLarge = payloadBytes > MAX_PAYLOAD_BYTES;

  const doc = {
    eventId: str(event?.id),
    type: str(event?.type),
    apiVersion: str(event?.api_version),
    livemode: typeof event?.livemode === 'boolean' ? event.livemode : null,
    stripeCreatedAt: Number.isFinite(event?.created) ? new Date(event.created * 1000) : null,
    verified: check.ok,
    signatureError: check.ok ? null : check.error,
    parseError,
    // Only worth keeping when we could not parse it — that is the case where
    // the payload column tells you nothing and the bytes are the evidence.
    rawBody: parseError ? rawBody.slice(0, 10_000) : null,
    lastReceivedAt: new Date(),
    ...summary,
    payload: tooLarge ? null : event,
    payloadTruncated: tooLarge,
    payloadBytes,
    headers: pickHeaders(req.headers),
    request: event?.request || null,
    previousAttributes: event?.data?.previous_attributes || null,
  };

  try {
    if (doc.eventId) {
      // A redelivery of the same event must not create a second row. Record
      // that it happened again and refresh the payload — Stripe redelivers the
      // event as it stands now, and a later verified delivery should replace an
      // earlier unverified one.
      await StripeWebhookEventModel.findOneAndUpdate(
        { eventId: doc.eventId },
        { $set: doc, $inc: { deliveryCount: 1 }, $setOnInsert: { createdAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } else {
      // No event id — junk, a probe, or a body we could not parse. Still keep
      // it; "what is hitting this URL" is exactly the question being answered.
      await StripeWebhookEventModel.create({ ...doc, deliveryCount: 1 });
    }
  } catch (err) {
    // Never fail on a duplicate-key race; two concurrent deliveries of one
    // event id is a normal Stripe retry pattern.
    if (err?.code !== 11000) {
      console.error('[stripe-capture] failed to persist event:', err?.message || err);
      return res.status(500).json({ received: false, error: 'persist_failed' });
    }
  }

  // Stored either way. 400 only so a misconfiguration shows up as a failed
  // delivery in the Stripe dashboard instead of accumulating silently.
  if (!check.ok || parseError) {
    const reason = [check.ok ? null : check.error, parseError].filter(Boolean).join('; ');
    console.warn(`[stripe-capture] problem delivery stored — ${reason} (type=${doc.type || 'unknown'})`);
    return res.status(400).json({
      received: true,
      stored: true,
      verified: check.ok,
      error: reason,
    });
  }

  console.log(`[stripe-capture] ${doc.type} ${doc.eventId} stored (${payloadBytes}B)`);
  return res.status(200).json({ received: true, stored: true, verified: true, type: doc.type });
}

/**
 * GET /api/crm/stripe/webhook-events
 * Query: type, verified (true|false), email, livemode (true|false), q (free
 * text over ids and email), limit (default 50, max 200), skip.
 *
 * Payloads are omitted from the list — fetch one by id to read it in full.
 */
export async function listStripeWebhookEvents(req, res) {
  try {
    const { type, verified, email, livemode, q } = req.query || {};
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
    const skip = Math.max(parseInt(req.query?.skip, 10) || 0, 0);

    const filter = {};
    if (type) filter.type = String(type);
    if (verified === 'true' || verified === 'false') filter.verified = verified === 'true';
    if (livemode === 'true' || livemode === 'false') filter.livemode = livemode === 'true';
    if (email) filter.customerEmail = String(email).toLowerCase();
    if (q) {
      const esc = String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(esc, 'i');
      filter.$or = [
        { eventId: rx }, { objectId: rx }, { customerEmail: rx }, { customerName: rx },
        { paymentIntentId: rx }, { invoiceId: rx }, { checkoutSessionId: rx },
      ];
    }

    const [events, total] = await Promise.all([
      StripeWebhookEventModel.find(filter, { payload: 0, headers: 0, previousAttributes: 0 })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      StripeWebhookEventModel.countDocuments(filter),
    ]);

    return res.status(200).json({ success: true, total, limit, skip, events });
  } catch (error) {
    console.error('[stripe-capture] list failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /api/crm/stripe/webhook-events/stats
 * What have we actually received? Event types with counts and a date range,
 * plus how many arrived unverified. The first question to ask of the log.
 */
export async function getStripeWebhookEventStats(req, res) {
  try {
    const [byType, totals] = await Promise.all([
      StripeWebhookEventModel.aggregate([
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            firstSeen: { $min: '$createdAt' },
            lastSeen: { $max: '$createdAt' },
            unverified: { $sum: { $cond: ['$verified', 0, 1] } },
            live: { $sum: { $cond: ['$livemode', 1, 0] } },
          },
        },
        { $sort: { count: -1 } },
      ]),
      StripeWebhookEventModel.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            unverified: { $sum: { $cond: ['$verified', 0, 1] } },
            truncated: { $sum: { $cond: ['$payloadTruncated', 1, 0] } },
            firstSeen: { $min: '$createdAt' },
            lastSeen: { $max: '$createdAt' },
          },
        },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      totals: totals[0] ? { ...totals[0], _id: undefined } : { total: 0, unverified: 0, truncated: 0 },
      byType: byType.map((t) => ({ type: t._id, ...t, _id: undefined })),
    });
  } catch (error) {
    console.error('[stripe-capture] stats failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /api/crm/stripe/webhook-events/:id
 * `id` is either the Mongo _id or Stripe's evt_… id. Returns the whole payload.
 */
export async function getStripeWebhookEvent(req, res) {
  try {
    const { id } = req.params;
    const filter = /^[0-9a-fA-F]{24}$/.test(id) ? { _id: id } : { eventId: id };
    const event = await StripeWebhookEventModel.findOne(filter).lean();
    if (!event) return res.status(404).json({ success: false, error: 'not found' });
    return res.status(200).json({ success: true, event });
  } catch (error) {
    console.error('[stripe-capture] fetch failed:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
}

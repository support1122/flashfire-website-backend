import mongoose from 'mongoose';

/**
 * Every delivery to POST /api/webhooks/stripe/capture is persisted here,
 * whole and unedited.
 *
 * This is a capture log, not a business record. The point is to see exactly
 * what Stripe sends for each kind of purchase before deciding what the CRM and
 * the dashboard should do with it — which plan was bought, what the customer
 * actually paid, which fields carry that reliably. `payload` is the complete
 * event; the flattened fields beside it exist only so the list view is
 * readable without opening every document.
 *
 * Nothing downstream should treat `verified: false` rows as real. The endpoint
 * is public, so an unverified row is only ever "something posted to our URL".
 */
const StripeWebhookEventSchema = new mongoose.Schema(
  {
    /** Stripe's event id (evt_…). Unique — a redelivery bumps deliveryCount instead of inserting again. */
    // No `index: true` here; the unique+sparse index is declared below and
    // mongoose warns about the duplicate definition otherwise.
    eventId: { type: String, default: null },
    /** e.g. checkout.session.completed, invoice.paid, charge.refunded. */
    type: { type: String, default: null, index: true },
    apiVersion: { type: String, default: null },
    livemode: { type: Boolean, default: null, index: true },
    /** Stripe's own creation timestamp for the event, as a Date. */
    stripeCreatedAt: { type: Date, default: null, index: true },

    /** Did the stripe-signature header check out against the signing secret? */
    verified: { type: Boolean, default: false, index: true },
    /** Why verification failed, when it did. */
    signatureError: { type: String, default: null },
    /** Set when the body was not valid JSON. `payload` is null in that case. */
    parseError: { type: String, default: null },
    /** The body as received, kept only when it could not be parsed as JSON. */
    rawBody: { type: String, default: null },

    /** How many times Stripe has delivered this same event id to us. */
    deliveryCount: { type: Number, default: 1 },
    lastReceivedAt: { type: Date, default: Date.now },

    // ── Flattened for the list view. Derived, never authoritative. ──
    objectId: { type: String, default: null, index: true },
    objectType: { type: String, default: null },
    /** Minor units, exactly as Stripe sends them (cents). */
    amountTotal: { type: Number, default: null },
    amountSubtotal: { type: Number, default: null },
    amountDiscount: { type: Number, default: null },
    currency: { type: String, default: null },
    customerEmail: { type: String, default: null, index: true },
    customerName: { type: String, default: null },
    customerId: { type: String, default: null },
    paymentStatus: { type: String, default: null },
    status: { type: String, default: null },
    mode: { type: String, default: null },
    description: { type: String, default: null },
    paymentLinkId: { type: String, default: null },
    checkoutSessionId: { type: String, default: null },
    paymentIntentId: { type: String, default: null },
    invoiceId: { type: String, default: null },
    subscriptionId: { type: String, default: null },
    /** The metadata bag — where a plan name would live if we set one. */
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },

    /** The complete Stripe event, verbatim. */
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Set instead of `payload` when the body was too large to store. */
    payloadTruncated: { type: Boolean, default: false },
    payloadBytes: { type: Number, default: null },
    /** Request headers worth keeping (signature, user agent, Stripe's request id). */
    headers: { type: mongoose.Schema.Types.Mixed, default: null },
    /** event.request — the API call or dashboard action that caused this event. */
    request: { type: mongoose.Schema.Types.Mixed, default: null },
    /** event.data.previous_attributes, present on *.updated events. */
    previousAttributes: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

// Newest first is how the inspector reads it.
StripeWebhookEventSchema.index({ createdAt: -1 });
// Sparse: an unverified junk POST may have no event id at all, and several of
// those must not collide on null.
StripeWebhookEventSchema.index({ eventId: 1 }, { unique: true, sparse: true });

export const StripeWebhookEventModel =
  mongoose.models.StripeWebhookEvent ||
  mongoose.model('StripeWebhookEvent', StripeWebhookEventSchema);

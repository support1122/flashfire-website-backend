import dotenv from "dotenv";
dotenv.config();
import crypto from "crypto";
import mongoose from "mongoose";

// --- verify env loaded ---
const whsec = process.env.STRIPE_WEBHOOK_SECRET;
const sk = process.env.STRIPE_SECRET_KEY;
console.log("ENV check:");
console.log("  STRIPE_SECRET_KEY:   ", sk ? `${sk.slice(0, 12)}… (${sk.length} chars)` : "MISSING");
console.log("  STRIPE_WEBHOOK_SECRET:", whsec ? `${whsec.slice(0, 12)}… (${whsec.length} chars)` : "MISSING");
console.log("  DISCORD_STRIPE_WEBHOOK_URL:", process.env.DISCORD_STRIPE_WEBHOOK_URL ? "set" : "MISSING");
console.log("  DISCORD_PAYMENT_EMAIL:     ", process.env.DISCORD_PAYMENT_EMAIL ? "set" : "MISSING");
console.log("  SENDGRID_API_KEY_1:        ", process.env.SENDGRID_API_KEY_1 ? "set" : "MISSING");

if (!whsec || !sk) {
  console.error("❌ env missing, abort");
  process.exit(1);
}

// --- Phase A: signature construction + verification round-trip ---
console.log("\n━━━ Phase A: Stripe signature verify with whsec ━━━");
const Stripe = (await import("stripe")).default;
const stripe = new Stripe(sk);

// Sanity-check account
try {
  const acc = await stripe.accounts.retrieve();
  console.log(`✅ Stripe key OK → acct ${acc.id} (${acc.country}, livemode=${acc.charges_enabled})`);
} catch (e) {
  console.error("❌ Stripe key reject:", e.message);
  process.exit(1);
}

const mockEvent = {
  id: `evt_test_${Date.now()}`,
  object: "event",
  api_version: "2024-06-20",
  created: Math.floor(Date.now() / 1000),
  type: "checkout.session.completed",
  livemode: false,
  data: {
    object: {
      id: `cs_test_${Date.now()}`,
      object: "checkout.session",
      payment_status: "paid",
      amount_total: 100, // $1.00
      currency: "usd",
      customer_email: "pranjal.tripathi@flashfirehq.com",
      customer_details: {
        email: "pranjal.tripathi@flashfirehq.com",
        name: "Pranjal Tripathi",
      },
      payment_intent: `pi_test_${Date.now()}`,
      invoice: null,
      metadata: { planName: "FlashFire Plan", planSubtitle: "E2E test", test: "true" },
    },
  },
};

const rawBody = JSON.stringify(mockEvent);
const ts = Math.floor(Date.now() / 1000);
const signedPayload = `${ts}.${rawBody}`;
const v1 = crypto.createHmac("sha256", whsec).update(signedPayload, "utf8").digest("hex");
const sigHeader = `t=${ts},v1=${v1}`;
console.log("  signature header:", sigHeader.slice(0, 70), "…");

try {
  const parsed = stripe.webhooks.constructEvent(rawBody, sigHeader, whsec);
  console.log(`✅ whsec verifies signed payload → event ${parsed.type} id=${parsed.id}`);
} catch (e) {
  console.error("❌ whsec VERIFY FAIL:", e.message);
  process.exit(1);
}

// --- Phase B: invoke real handler end-to-end ---
console.log("\n━━━ Phase B: real handler end-to-end ━━━");

// Connect Mongo (handler queries PaymentModel)
console.log("  connecting Mongo…");
try {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  console.log("✅ Mongo connected");
} catch (e) {
  console.error("❌ Mongo connect fail:", e.message);
  process.exit(1);
}

const { handleStripeWebhook } = await import("../Controllers/StripeWebhookController.js");

const req = {
  headers: { "stripe-signature": sigHeader },
  body: Buffer.from(rawBody, "utf8"),
};
const res = {
  statusCode: 0,
  _json: null,
  status(code) { this.statusCode = code; return this; },
  json(obj) { this._json = obj; return this; },
};

console.log("  → invoking handleStripeWebhook…");
await handleStripeWebhook(req, res);
console.log(`  ← handler returned status=${res.statusCode}`, res._json);

await mongoose.disconnect();
console.log("\n✔ E2E done — inspect Discord channels + inbox.");
process.exit(0);

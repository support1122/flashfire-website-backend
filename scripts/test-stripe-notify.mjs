import dotenv from "dotenv";
dotenv.config();
import axios from "axios";
import { sendPaymentConfirmationEmail } from "../Utils/PaymentEmailHelper.js";

const RECIPIENTS = [
  { email: "pranjal.tripathi@flashfirehq.com", first: "Pranjal", last: "Tripathi" },
  { email: "sohith73@gmail.com", first: "Sohith", last: "Test" },
];

const PLAN = process.env.STRIPE_FALLBACK_PLAN_NAME || "FlashFire Plan";
const AMOUNT = "1.00";
const CURRENCY = "USD";

async function postDiscord(url, content, label) {
  if (!url) {
    console.log(`⚠️  [${label}] webhook URL empty, skip`);
    return;
  }
  try {
    const res = await axios.post(url, { content }, { timeout: 10000 });
    console.log(`✅ [${label}] Discord POST ${res.status}`);
  } catch (err) {
    console.error(`❌ [${label}] Discord FAIL:`, err.response?.status, err.response?.data || err.message);
  }
}

async function fireStripeChannelSummary(recipient) {
  const now = new Date();
  const txId = `pi_test_${Date.now()}`;
  const invoiceId = `in_test_${Date.now()}`;
  const lines = [
    "✅ **Stripe Payment Webhook Processed** (TEST)",
    "────────────────────────────────",
    `📦 **Source:** test.stripe.notify`,
    `📧 **Email:** ${recipient.email}`,
    `💵 **Amount:** ${CURRENCY} ${AMOUNT}`,
    `📦 **Plan/Item:** ${PLAN}`,
    `🔖 **Transaction:** ${txId}`,
    `🧾 **Invoice:** ${invoiceId}`,
    `📧 **Invoice Email:** (sending…)`,
    `🏷️ **Metadata:** {"test":true,"script":"test-stripe-notify"}`,
    `🕐 **Time (IST):** ${now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
  ].join("\n");
  await postDiscord(
    process.env.DISCORD_STRIPE_WEBHOOK_URL || process.env.DISCORD_WEB_HOOK_URL,
    lines,
    "STRIPE-CH"
  );
  return { txId, invoiceId };
}

async function run() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Stripe notify test — default plan");
  console.log(`Plan:      ${PLAN}`);
  console.log(`Amount:    ${CURRENCY} ${AMOUNT}`);
  console.log(`Recipients:`, RECIPIENTS.map(r => r.email).join(", "));
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  for (const r of RECIPIENTS) {
    console.log(`\n→ ${r.email}`);
    const { txId, invoiceId } = await fireStripeChannelSummary(r);

    // Calls PaymentEmailHelper.sendPaymentConfirmationEmail — same path prod uses.
    // That helper also posts to DISCORD_PAYMENT_EMAIL after send.
    const result = await sendPaymentConfirmationEmail({
      customerEmail: r.email,
      customerFirstName: r.first,
      customerLastName: r.last,
      amount: AMOUNT,
      currency: CURRENCY,
      planName: PLAN,
      planSubtitle: "Test notification",
      transactionId: txId,
      transactionProvider: "Stripe",
      paymentDate: new Date(),
      invoiceNumber: invoiceId,
      includePdfInvoice: true,
    });
    console.log(`  email result:`, result);
  }

  console.log("\n✔ done");
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});

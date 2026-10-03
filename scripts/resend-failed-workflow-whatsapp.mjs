/**
 * Resend WhatsApp workflow steps that are sitting in WorkflowLog as 'failed', and
 * post a summary to the same Discord channel the real-time failure alerts use.
 *
 *   node scripts/resend-failed-workflow-whatsapp.mjs --template meta__revised_134
 *   node scripts/resend-failed-workflow-whatsapp.mjs --template meta__revised_134 --apply
 *   node scripts/resend-failed-workflow-whatsapp.mjs --since 2026-10-01 --apply
 *
 * Two safety rules, because these messages make a claim about the client's state:
 *
 *   - The meta_* family says "you have not booked yet, here is the link". If the
 *     client has since booked, that is now false, so those are skipped unless the
 *     booking is still not-scheduled. --any-status overrides.
 *   - WorkflowLog often holds several rows for the same send. Resending every row
 *     would message the same person twice, so rows are deduped per phone+template.
 *
 * Parameters are rebuilt from the current builder rather than reused from the log,
 * so a send that failed because of a wrong parameter count goes out correctly now.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

dotenv.config({ quiet: true });

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const APPLY = argv.includes('--apply');
const ANY_STATUS = argv.includes('--any-status');
const TEMPLATE = flag('template');
const SINCE = flag('since');
const URI = flag('uri', process.env.MONGODB_URI);
if (!URI) { console.error('No MONGODB_URI'); process.exit(1); }

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
const { buildTemplateParameters } = await import('../Utils/TemplateParameterBuilder.js');
const { default: watiService } = await import('../Utils/WatiService.js');
const { DiscordConnect } = await import('../Utils/DiscordConnect.js');

const L = mongoose.connection.collection('workflowlogs');
const CB = mongoose.connection.collection('campaignbookings');
const ist = d => DateTime.fromJSDate(new Date(d)).setZone('Asia/Kolkata').toFormat('dd LLL HH:mm:ss');

const query = { 'step.channel': 'whatsapp', status: 'failed' };
if (TEMPLATE) query['step.templateName'] = TEMPLATE;
if (SINCE) query.updatedAt = { $gte: new Date(SINCE) };

const rows = await L.find(query).sort({ updatedAt: 1 }).toArray();

// One message per person per template, not one per log row.
const seen = new Set();
const unique = [];
for (const r of rows) {
  const phone = String(r.clientPhone ?? '').replace(/\D/g, '');
  const key = `${phone}|${r.step?.templateName}`;
  if (!phone || seen.has(key)) continue;
  seen.add(key);
  unique.push(r);
}

console.log(`Mode: ${APPLY ? 'APPLY — messages will be sent' : 'DRY RUN — nothing sent'}`);
console.log(`failed rows: ${rows.length}  |  distinct recipients: ${unique.length}\n`);

const results = { sent: 0, failed: 0, skippedBooked: 0, skippedNoPhone: 0 };
const failures = [];
const skipped = [];
let haltReason = null;

for (const log of unique) {
  const templateName = log.step?.templateName;
  const booking = await CB.findOne({ bookingId: log.bookingId });
  const name = log.clientName || booking?.clientName || 'Unknown';
  const phone = String(log.clientPhone ?? booking?.clientPhone ?? '').replace(/\D/g, '');
  const label = `${String(templateName).padEnd(20)} ${String(name).slice(0, 22).padEnd(23)} +${phone}`;

  if (!phone) { results.skippedNoPhone++; console.log(`  SKIP  ${label}  no phone`); continue; }

  // "You have not booked yet" is false once they book.
  const claimsNotBooked = /^meta/i.test(String(templateName));
  if (claimsNotBooked && !ANY_STATUS && booking && booking.bookingStatus !== 'not-scheduled') {
    results.skippedBooked++;
    skipped.push(`${name} (now ${booking.bookingStatus})`);
    console.log(`  SKIP  ${label}  booking is now "${booking.bookingStatus}", message would be wrong`);
    continue;
  }

  let parameters;
  try {
    parameters = await buildTemplateParameters(templateName, { booking: booking ?? { clientName: name }, step: log.step });
  } catch (e) {
    results.failed++;
    failures.push(`${name}: parameter build failed - ${e.message}`);
    console.log(`  FAIL  ${label}  parameter build: ${e.message}`);
    continue;
  }

  if (!APPLY) {
    results.sent++;
    console.log(`  WOULD SEND  ${label}  ${parameters.length} params`);
    continue;
  }
  if (haltReason) { console.log(`  HALTED  ${label}`); continue; }

  const res = await watiService.sendTemplateMessage({
    mobileNumber: phone,
    templateName,
    templateId: log.step?.templateId,
    parameters,
    campaignId: `workflow_resend_${log.logId}`,
  });

  if (res.success) {
    results.sent++;
    await L.updateMany(
      { bookingId: log.bookingId, 'step.templateName': templateName, status: 'failed' },
      { $set: { status: 'executed', executedAt: new Date(), error: null } }
    );
    console.log(`  SENT  ${label}`);
  } else {
    results.failed++;
    failures.push(`${name}: ${res.error}`);
    console.log(`  FAIL  ${label}  ${res.error}`);
    if (/credit|usage limit|rate limit|channel .* not found/i.test(String(res.error))) {
      haltReason = res.error;
      console.log(`\n  !! halting: "${res.error}" is account-wide, not per-message.`);
    }
  }
}

console.log('\n=== summary ===');
console.log(`${APPLY ? 'sent' : 'would send'}: ${results.sent}`);
console.log(`failed: ${results.failed}`);
console.log(`skipped, already booked: ${results.skippedBooked}`);
console.log(`skipped, no phone: ${results.skippedNoPhone}`);
if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  ${f}`); }

if (APPLY) {
  const hook = process.env.DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL;
  if (hook) {
    await DiscordConnect(hook,
      `🔁 **Resent failed WhatsApp workflow sends**${TEMPLATE ? ` · \`${TEMPLATE}\`` : ''}\n` +
      `📦 ${rows.length} failed row(s), ${unique.length} distinct recipient(s)\n` +
      `✅ Sent: ${results.sent}\n` +
      `❌ Failed: ${results.failed}\n` +
      (results.skippedBooked ? `⏭️ Skipped, already booked: ${results.skippedBooked}${skipped.length ? ` (${skipped.slice(0, 5).join(', ')})` : ''}\n` : '') +
      (haltReason ? `⛔ Halted: ${haltReason}\n` : '') +
      (failures.length ? `\n${failures.slice(0, 6).join('\n')}` : '') +
      `\n🕒 ${ist(new Date())} IST`,
      false
    );
    console.log('\nDiscord summary posted.');
  } else {
    console.log('\nDISCORD_WHATSAPP_FAILURE_WEBHOOK_URL not set — no Discord summary posted.');
  }
} else {
  console.log('\nDry run only. Re-run with --apply.');
}

await mongoose.disconnect();

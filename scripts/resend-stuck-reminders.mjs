/**
 * Resend WhatsApp reminders that failed or stalled, for meetings that have NOT
 * happened yet, and post a Discord summary.
 *
 *   node scripts/resend-stuck-reminders.mjs            # dry run
 *   node scripts/resend-stuck-reminders.mjs --apply
 *   node scripts/resend-stuck-reminders.mjs --apply --uri "mongodb+srv://..."
 *
 * Only touches records whose meetingStartISO is still in the future. A reminder for
 * a meeting that already ended is worse than no reminder, so those are reported and
 * left alone — use --include-past only if you really mean it.
 *
 * Sends through the app's own sendWhatsAppMessage, so template routing, the
 * forced-Eastern display policy and the Reschedule/Cancel button tails are identical
 * to a normal send. Stops early on a credit or rate-limit error rather than burning
 * through the whole list repeating the same failure.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

dotenv.config({ quiet: true });

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const INCLUDE_PAST = argv.includes('--include-past');
const ui = argv.indexOf('--uri');
const URI = ui >= 0 ? argv[ui + 1] : process.env.MONGODB_URI;
if (!URI) { console.error('No MONGODB_URI'); process.exit(1); }

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
const { sendWhatsAppMessage } = await import('../Utils/WhatsAppReminderScheduler.js');
const { DiscordConnect } = await import('../Utils/DiscordConnect.js');
const WA = mongoose.connection.collection('scheduledwhatsappreminders');

const now = new Date();
const et = d => DateTime.fromJSDate(new Date(d)).setZone('America/New_York').toFormat('MMM d HH:mm');

const stuck = await WA.find({
  status: { $in: ['pending', 'processing', 'failed'] },
  scheduledFor: { $lte: now },
}).sort({ meetingStartISO: 1 }).toArray();

const upcoming = stuck.filter(r => r.meetingStartISO && new Date(r.meetingStartISO) >= now);
const past = stuck.filter(r => !r.meetingStartISO || new Date(r.meetingStartISO) < now);
const targets = INCLUDE_PAST ? stuck : upcoming;

console.log(`Mode: ${APPLY ? 'APPLY — messages will be sent' : 'DRY RUN — nothing sent'}`);
console.log(`stuck: ${stuck.length}  |  meeting upcoming: ${upcoming.length}  |  meeting already over: ${past.length} (skipped)\n`);

const results = { sent: 0, failed: 0, skipped: past.length };
const failures = [];
let haltReason = null;

for (const r of targets) {
  const type = r.metadata?.isImmediateReminder ? 'immediate' : (r.metadata?.reminderType ?? '?');
  const label = `${et(r.meetingStartISO).padEnd(13)} ${String(type).padEnd(10)} ${String(r.clientName).slice(0, 24).padEnd(25)} ${r.phoneNumber}`;

  if (!APPLY) { console.log(`  WOULD SEND  ${label}`); results.sent++; continue; }
  if (haltReason) { console.log(`  HALTED      ${label}`); continue; }

  const res = await sendWhatsAppMessage(r);
  if (res.success) {
    results.sent++;
    await WA.updateOne({ _id: r._id }, {
      $set: {
        status: 'completed',
        completedAt: new Date(),
        watiResponse: res.watiResponse ?? null,
        errorMessage: null,
      },
    });
    console.log(`  SENT        ${label}`);
  } else {
    results.failed++;
    failures.push(`${r.clientName}: ${res.error}`);
    await WA.updateOne({ _id: r._id }, { $set: { errorMessage: res.error } });
    console.log(`  FAILED      ${label}  ${res.error}`);
    // Credit and rate-limit errors apply to the whole account, so the next send would
    // fail the same way. Stop instead of generating a wall of identical failures.
    if (/credit|usage limit|rate limit/i.test(String(res.error))) {
      haltReason = res.error;
      console.log(`\n  !! halting: "${res.error}" is account-wide, not per-message.`);
    }
  }
}

console.log('\n=== summary ===');
console.log(`${APPLY ? 'sent' : 'would send'}: ${results.sent}`);
console.log(`failed:    ${results.failed}`);
console.log(`skipped (meeting already over): ${results.skipped}`);
if (haltReason) console.log(`halted on: ${haltReason}`);
if (failures.length) { console.log('\nfailures:'); for (const f of failures) console.log(`  ${f}`); }

if (APPLY) {
  const hook = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  if (hook) {
    await DiscordConnect(hook,
      `🔁 Stuck WA reminder resend\n` +
      `📦 ${stuck.length} stuck • ${upcoming.length} for upcoming meetings • ${past.length} for meetings already over (skipped)\n` +
      `✅ Sent: ${results.sent}\n` +
      `❌ Failed: ${results.failed}\n` +
      (haltReason ? `⛔ Halted: ${haltReason}\n` : '') +
      (failures.length ? `\n${failures.slice(0, 8).join('\n')}` : '')
    );
    console.log('\nDiscord summary posted.');
  } else {
    console.log('\nDISCORD_REMINDER_CALL_WEBHOOK_URL not set — no Discord summary posted.');
  }
} else {
  console.log('\nDry run only. Re-run with --apply.');
}

await mongoose.disconnect();

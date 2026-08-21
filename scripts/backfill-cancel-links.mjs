/**
 * Backfill Calendly cancel links onto existing bookings and queued reminders.
 *
 * Bookings created before the webhook started capturing payload.cancel_url have no
 * calendlyCancelLink. The cancel URL is recoverable without touching Calendly: it is
 * the reschedule URL with the path segment swapped, sharing the same invitee uuid.
 *
 *   https://calendly.com/reschedulings/<uuid>  ->  https://calendly.com/cancellations/<uuid>
 *
 * Note the send path already derives this at send time, so the Cancel button works
 * even without this backfill. Storing it explicitly makes the data auditable and
 * removes the dependency on the derivation rule.
 *
 * Dry run (default):  node scripts/backfill-cancel-links.mjs
 * Apply:              node scripts/backfill-cancel-links.mjs --apply
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

dotenv.config({ quiet: true });

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const uriFlag = argv.indexOf('--uri');
const URI = uriFlag >= 0 ? argv[uriFlag + 1] : process.env.MONGODB_URI;

if (!URI) {
  console.error('No connection string. Pass --uri "mongodb+srv://..." or set MONGODB_URI in .env');
  process.exit(1);
}

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
const { calendlyCancelTail } = await import('../Utils/TemplateParameterBuilder.js');

const CB = mongoose.connection.collection('campaignbookings');
const WA = mongoose.connection.collection('scheduledwhatsappreminders');
const now = new Date();

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}\n`);

const toCancelUrl = (cancelLink, rescheduleLink) => {
  const tail = calendlyCancelTail(cancelLink, rescheduleLink);
  return tail ? `https://calendly.com/${tail}` : null;
};

// ── bookings ────────────────────────────────────────────────────────────────
const bookings = await CB.find({
  bookingStatus: 'scheduled',
  scheduledEventStartTime: { $gte: now },
}).project({ bookingId: 1, clientName: 1, calendlyRescheduleLink: 1, calendlyCancelLink: 1 }).toArray();

let bHave = 0, bDerived = 0, bNone = 0;
const bNoneList = [];
for (const b of bookings) {
  if (b.calendlyCancelLink) { bHave++; continue; }
  const url = toCancelUrl(null, b.calendlyRescheduleLink);
  if (!url) { bNone++; bNoneList.push(`${b.clientName} -> ${b.calendlyRescheduleLink || 'no reschedule link'}`); continue; }
  bDerived++;
  if (APPLY) await CB.updateOne({ _id: b._id }, { $set: { calendlyCancelLink: url } });
}
console.log(`=== upcoming scheduled bookings: ${bookings.length} ===`);
console.log(`  already had a cancel link:  ${bHave}`);
console.log(`  ${APPLY ? 'derived and stored' : 'would derive'}:        ${bDerived}`);
console.log(`  no derivable cancel link:   ${bNone}`);
for (const x of bNoneList.slice(0, 10)) console.log(`     ${x}`);

// ── queued reminders ────────────────────────────────────────────────────────
const reminders = await WA.find({
  status: 'pending',
  scheduledFor: { $gte: now },
}).toArray();

let rImmediate = 0, rHave = 0, rDerived = 0, rNone = 0;
const rNoneList = [];
for (const r of reminders) {
  const type = r.metadata?.reminderType ?? r.reminderType ?? 'immediate';
  const isImmediate = type === 'immediate' || r.metadata?.isImmediateReminder === true;
  if (isImmediate) { rImmediate++; continue; }  // immediate template has no buttons
  if (r.cancelLink) { rHave++; continue; }
  const url = toCancelUrl(null, r.rescheduleLink);
  if (!url) { rNone++; rNoneList.push(`${r.clientName} (${type}) -> ${r.rescheduleLink || 'no reschedule link'}`); continue; }
  rDerived++;
  if (APPLY) await WA.updateOne({ _id: r._id }, { $set: { cancelLink: url } });
}

console.log(`\n=== pending future reminders: ${reminders.length} ===`);
console.log(`  immediate (no buttons, skipped): ${rImmediate}`);
console.log(`  already had a cancel link:       ${rHave}`);
console.log(`  ${APPLY ? 'derived and stored' : 'would derive'}:             ${rDerived}`);
console.log(`  no derivable cancel link:        ${rNone}`);
for (const x of rNoneList.slice(0, 10)) console.log(`     ${x}`);

const willGetButton = rHave + rDerived;
const willNot = rNone;
console.log(`\n=== what clients will see ===`);
console.log(`  reminders that will carry the Cancel button (_rc): ${willGetButton}`);
console.log(`  reminders falling back to _b, Reschedule only:     ${willNot}`);

if (willGetButton) {
  const next = reminders
    .filter(r => { const t = r.metadata?.reminderType ?? 'immediate'; return t !== 'immediate'; })
    .sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
  if (next) console.log(`  next send: ${DateTime.fromJSDate(next.scheduledFor).setZone('America/New_York').toFormat('MMM d HH:mm')} ET  ${next.clientName}`);
}

console.log(APPLY ? '\nDone.' : '\nDry run only. Re-run with --apply.');
await mongoose.disconnect();

// Cancel WorkflowLog rows still status='scheduled' whose workflow.triggerAction
// no longer matches the booking's current status. Conservative — only cancels
// rows where mismatch is unambiguous (e.g. triggerAction='not-scheduled' but
// booking already scheduled/canceled/completed/paid).
// Usage:
//   node scripts/cleanup-stale-notscheduled-logs.mjs --dry
//   node scripts/cleanup-stale-notscheduled-logs.mjs            # apply
//   node scripts/cleanup-stale-notscheduled-logs.mjs --booking=booking_XXX --dry

import dotenv from 'dotenv'; dotenv.config();
import mongoose from 'mongoose';

const DRY = process.argv.includes('--dry');
const bookingArg = (process.argv.find(a => a.startsWith('--booking=')) || '').split('=')[1] || null;

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const logs = db.collection('workflowlogs');
const bookings = db.collection('campaignbookings');
const workflows = db.collection('workflows');

// triggerAction → set of bookingStatuses that make the workflow stale
// (i.e., if booking is in any of these statuses, the workflow should not fire)
const staleWhen = {
  'not-scheduled': new Set(['scheduled', 'rescheduled', 'completed', 'paid', 'canceled', 'no-show', 'ignored']),
  'cancel':        new Set(['scheduled', 'rescheduled', 'completed', 'paid', 'not-scheduled', 'no-show', 'ignored']),
  'complete':      new Set(['scheduled', 'rescheduled', 'canceled', 'not-scheduled', 'no-show', 'paid', 'ignored']),
  'no-show':       new Set(['scheduled', 'rescheduled', 'completed', 'paid', 'canceled', 'not-scheduled', 'ignored']),
};

// Build workflowId → triggerAction map
const wfMap = new Map();
const wfDocs = await workflows.find({}, { projection: { workflowId: 1, triggerAction: 1 } }).toArray();
for (const w of wfDocs) wfMap.set(w.workflowId, w.triggerAction);
console.log(`Loaded ${wfMap.size} workflows`);

// Iterate scheduled WorkflowLog rows
const logFilter = { status: 'scheduled', ...(bookingArg ? { bookingId: bookingArg } : {}) };
const cursor = logs.find(logFilter).project({ _id: 1, bookingId: 1, workflowId: 1, step: 1, scheduledFor: 1 });

const cache = new Map(); // bookingId → bookingStatus
let scanned = 0, staleFound = 0, missingWf = 0, missingBooking = 0;
const idsToCancel = [];
const sampleByBooking = new Map();

for await (const l of cursor) {
  scanned++;
  const trig = wfMap.get(l.workflowId);
  if (!trig) { missingWf++; continue; }
  const staleSet = staleWhen[trig];
  if (!staleSet) continue; // custom or unknown trigger — leave alone

  let status = cache.get(l.bookingId);
  if (status === undefined) {
    const b = await bookings.findOne({ bookingId: l.bookingId }, { projection: { bookingStatus: 1 } });
    status = b?.bookingStatus || null;
    cache.set(l.bookingId, status);
  }
  if (!status) { missingBooking++; continue; }
  if (!staleSet.has(status)) continue;

  staleFound++;
  idsToCancel.push(l._id);
  if (!sampleByBooking.has(l.bookingId)) sampleByBooking.set(l.bookingId, { status, trig, samples: [] });
  const e = sampleByBooking.get(l.bookingId);
  if (e.samples.length < 3) e.samples.push({ tpl: l.step?.templateName || l.step?.templateId, ch: l.step?.channel, when: l.scheduledFor?.toISOString?.() });
}

console.log(`\nScanned scheduled logs : ${scanned}`);
console.log(`Stale (trigger≠current): ${staleFound}`);
console.log(`Logs missing workflow  : ${missingWf}`);
console.log(`Logs missing booking   : ${missingBooking}`);
console.log(`Affected bookings      : ${sampleByBooking.size}`);

console.log('\nSample (up to 25 bookings):');
let n = 0;
for (const [bid, info] of sampleByBooking) {
  if (n++ >= 25) break;
  console.log(`  ${bid}  bookingStatus=${info.status}  workflowTrigger=${info.trig}`);
  for (const s of info.samples) console.log(`    - ${s.ch}/${s.tpl} @ ${s.when}`);
}

if (DRY) {
  console.log('\nDRY RUN — no writes. Re-run without --dry to apply.');
} else {
  const r = await logs.updateMany(
    { _id: { $in: idsToCancel } },
    { $set: { status: 'cancelled', error: 'Cleanup: workflow trigger no longer matches booking status', executedAt: null } }
  );
  console.log(`\nApplied: ${r.modifiedCount} log rows cancelled.`);
}
await mongoose.disconnect();
process.exit(0);

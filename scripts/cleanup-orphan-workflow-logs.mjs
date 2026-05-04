// Cleanup orphan/stale failed workflow logs.
// - "Booking not found" failed logs whose bookingId truly doesn't exist → mark cancelled
// - Stale "booking.save is not a function" logs (historical bug, fixed) → mark cancelled
// - Any 'scheduled' logs whose booking was deleted → mark cancelled (prevents future failures)
// Re-runnable. Read DB once.

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const DRY_RUN = process.argv.includes('--dry');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const logs = db.collection('workflowlogs');
const bookings = db.collection('campaignbookings');

async function bookingExists(bookingId) {
  return !!(await bookings.findOne({ bookingId }, { projection: { _id: 1 } }));
}

// 1. Failed "Booking not found" logs that are confirmed orphans
const bnf = await logs.find({ status: 'failed', error: 'Booking not found' }).toArray();
const orphanBnfIds = [];
for (const l of bnf) {
  if (!(await bookingExists(l.bookingId))) orphanBnfIds.push(l._id);
}

// 2. Stale "booking.save is not a function" logs (historical, fixed)
const staleSave = await logs.find({ status: 'failed', error: 'booking.save is not a function' }, { projection: { _id: 1 } }).toArray();

// 3. Currently 'scheduled' logs whose booking is gone (would orphan-fail next run)
const sched = await logs.find({ status: 'scheduled' }, { projection: { _id: 1, bookingId: 1 } }).toArray();
const schedOrphanIds = [];
for (const l of sched) {
  if (!(await bookingExists(l.bookingId))) schedOrphanIds.push(l._id);
}

console.log(`Found:`);
console.log(`  failed "Booking not found" orphans : ${orphanBnfIds.length}`);
console.log(`  stale booking.save failures        : ${staleSave.length}`);
console.log(`  scheduled w/ deleted booking       : ${schedOrphanIds.length}`);

if (DRY_RUN) {
  console.log('\nDRY RUN — no changes written. Re-run without --dry to apply.');
  await mongoose.disconnect();
  process.exit(0);
}

const now = new Date();
const r1 = await logs.updateMany(
  { _id: { $in: orphanBnfIds } },
  { $set: { status: 'cancelled', error: 'Cancelled: booking deleted (orphan cleanup)', executedAt: now } }
);
const r2 = await logs.updateMany(
  { _id: { $in: staleSave.map(d => d._id) } },
  { $set: { status: 'cancelled', error: 'Cancelled: stale failure from historical bug (cleanup)', executedAt: now } }
);
const r3 = await logs.updateMany(
  { _id: { $in: schedOrphanIds } },
  { $set: { status: 'cancelled', error: 'Cancelled: booking deleted (preemptive cleanup)', executedAt: now } }
);

console.log(`\nUpdated:`);
console.log(`  orphan BNF   : ${r1.modifiedCount}`);
console.log(`  stale save   : ${r2.modifiedCount}`);
console.log(`  sched orphan : ${r3.modifiedCount}`);

await mongoose.disconnect();
process.exit(0);

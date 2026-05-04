import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const logs = db.collection('workflowlogs');
const bookings = db.collection('campaignbookings');

console.log('='.repeat(80));
console.log('FAILED WORKFLOW LOGS DIAGNOSTIC');
console.log('='.repeat(80));

// 1. Counts by error
const byError = await logs.aggregate([
  { $match: { status: 'failed' } },
  { $group: { _id: '$error', count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]).toArray();

console.log('\n[1] Failed logs grouped by error:');
for (const r of byError) console.log(`  ${String(r.count).padStart(5)}  ${r._id}`);

const totalFailed = byError.reduce((a, b) => a + b.count, 0);
console.log(`  Total failed: ${totalFailed}`);

// 2. "Booking not found" — does the bookingId on log actually exist?
console.log('\n[2] "Booking not found" — verify bookingId mismatch:');
const bnfLogs = await logs.find(
  { status: 'failed', error: 'Booking not found' },
  { projection: { bookingId: 1, clientEmail: 1, clientName: 1, clientPhone: 1, 'step.channel': 1, 'step.templateId': 1, scheduledFor: 1 } }
).toArray();
console.log(`  Total "Booking not found" logs: ${bnfLogs.length}`);

const uniqBookingIds = [...new Set(bnfLogs.map(l => l.bookingId))];
console.log(`  Distinct bookingIds: ${uniqBookingIds.length}`);

const existingBookings = await bookings.find(
  { bookingId: { $in: uniqBookingIds } },
  { projection: { bookingId: 1 } }
).toArray();
const existingSet = new Set(existingBookings.map(b => b.bookingId));
const missing = uniqBookingIds.filter(id => !existingSet.has(id));
console.log(`  bookingIds that exist in campaignbookings: ${existingBookings.length}`);
console.log(`  bookingIds MISSING from campaignbookings: ${missing.length}`);

if (missing.length) {
  console.log('  Sample missing bookingIds (first 10):');
  for (const id of missing.slice(0, 10)) console.log(`    ${id}`);
}

// 2b. For these "Booking not found" logs, can we find a booking by clientEmail?
const sampleLogs = bnfLogs.slice(0, 15);
console.log('\n[2b] Sample failed logs — does a booking exist for the client (any bookingId)?');
for (const l of sampleLogs) {
  const byEmail = await bookings.findOne({ clientEmail: (l.clientEmail || '').toLowerCase() }, { projection: { bookingId: 1, clientPhone: 1, bookingStatus: 1 } });
  console.log(`  log.bookingId=${l.bookingId}  email=${l.clientEmail}  channel=${l.step?.channel}`);
  console.log(`    -> booking by email: ${byEmail ? `bookingId=${byEmail.bookingId} status=${byEmail.bookingStatus} phone=${byEmail.clientPhone || 'NULL'}` : 'NONE'}`);
}

// 3. "Client phone number not available" — verify booking exists & truly has no phone
console.log('\n[3] "Client phone number not available" — verify:');
const phoneLogs = await logs.find(
  { status: 'failed', error: 'Client phone number not available' },
  { projection: { bookingId: 1, clientEmail: 1, clientName: 1, clientPhone: 1 } }
).toArray();
console.log(`  Total "phone not available" logs: ${phoneLogs.length}`);
const phoneBookingIds = [...new Set(phoneLogs.map(l => l.bookingId))];
const phoneBookings = await bookings.find(
  { bookingId: { $in: phoneBookingIds } },
  { projection: { bookingId: 1, clientEmail: 1, clientPhone: 1, bookingStatus: 1 } }
).toArray();
const phoneMap = new Map(phoneBookings.map(b => [b.bookingId, b]));
let bookingMissing = 0, phoneTrulyMissing = 0, phonePresentNow = 0;
for (const l of phoneLogs) {
  const b = phoneMap.get(l.bookingId);
  if (!b) bookingMissing++;
  else if (!b.clientPhone) phoneTrulyMissing++;
  else phonePresentNow++;
}
console.log(`  log bookingId not in campaignbookings: ${bookingMissing}`);
console.log(`  booking exists, clientPhone is null/empty: ${phoneTrulyMissing}`);
console.log(`  booking exists AND now has clientPhone (data updated after failure): ${phonePresentNow}`);

console.log('\n  Sample (first 10):');
for (const l of phoneLogs.slice(0, 10)) {
  const b = phoneMap.get(l.bookingId);
  console.log(`    log.bookingId=${l.bookingId} email=${l.clientEmail}`);
  console.log(`      -> booking: ${b ? `phone=${b.clientPhone || 'NULL'} status=${b.bookingStatus}` : 'NOT FOUND'}`);
}

// 4. Cross-check: log.clientPhone vs booking.clientPhone for the failed phone logs
console.log('\n[4] log.clientPhone (snapshot at log creation) for "phone not available" logs:');
let logSnapHasPhone = 0, logSnapNoPhone = 0;
for (const l of phoneLogs) {
  if (l.clientPhone && String(l.clientPhone).trim()) logSnapHasPhone++;
  else logSnapNoPhone++;
}
console.log(`  log.clientPhone present at creation: ${logSnapHasPhone}`);
console.log(`  log.clientPhone empty at creation:   ${logSnapNoPhone}`);

// 5. Status distribution of currently-scheduled logs (sanity: are any actually pending?)
console.log('\n[5] Current status counts (all WorkflowLog):');
const byStatus = await logs.aggregate([
  { $group: { _id: '$status', count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]).toArray();
for (const r of byStatus) console.log(`  ${String(r.count).padStart(6)}  ${r._id}`);

// 6. Are there scheduled logs whose bookingId no longer exists?
console.log('\n[6] Currently-scheduled logs whose bookingId is missing in campaignbookings:');
const schedLogs = await logs.find(
  { status: 'scheduled' },
  { projection: { bookingId: 1, clientEmail: 1, scheduledFor: 1 } }
).toArray();
const schedIds = [...new Set(schedLogs.map(l => l.bookingId))];
const schedBookings = await bookings.find({ bookingId: { $in: schedIds } }, { projection: { bookingId: 1 } }).toArray();
const schedSet = new Set(schedBookings.map(b => b.bookingId));
const orphanedScheduled = schedLogs.filter(l => !schedSet.has(l.bookingId));
console.log(`  scheduled total: ${schedLogs.length}`);
console.log(`  scheduled with missing booking: ${orphanedScheduled.length}`);
if (orphanedScheduled.length) {
  console.log('  Sample (first 5):');
  for (const l of orphanedScheduled.slice(0, 5)) {
    console.log(`    bookingId=${l.bookingId} email=${l.clientEmail} scheduledFor=${l.scheduledFor?.toISOString?.()}`);
  }
}

console.log('\n' + '='.repeat(80));
console.log('DONE');
console.log('='.repeat(80));

await mongoose.disconnect();
process.exit(0);

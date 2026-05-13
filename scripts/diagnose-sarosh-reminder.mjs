// Diagnose missing BDA reminder for Sarosh Altaf meeting May 12 11:30pm IST.
// 1) Find ALL recent bookings/reminders/webhook logs for past 5 days.
// 2) Filter on clientName/email containing 'sarosh' OR meeting time near May 12 23:30 IST.
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

console.log('\n=== Recent campaignbookings (last 5 days), name contains sarosh OR meeting May 12 ===');
const bookings = await db.collection('campaignbookings').find({
  $or: [
    { clientName: /sarosh/i },
    { clientEmail: /sarosh/i },
    { bookingCreatedAt: { $gte: fiveDaysAgo } }
  ]
}).sort({ bookingCreatedAt: -1 }).limit(50).toArray();
console.log(`count: ${bookings.length}`);
for (const b of bookings) {
  const t = b.scheduledEventStartTime;
  const tIso = t?.toISOString?.() || t || '';
  // filter to may 12 or sarosh
  const isSarosh = /sarosh/i.test(b.clientName || '') || /sarosh/i.test(b.clientEmail || '');
  const isMay12 = tIso.startsWith('2026-05-12') || tIso.startsWith('2026-05-13');
  if (!isSarosh && !isMay12) continue;
  console.log(`  bookingId=${b.bookingId}  email=${b.clientEmail}  name=${b.clientName}`);
  console.log(`    phone=${b.clientPhone || 'NULL'}  status=${b.bookingStatus}`);
  console.log(`    scheduledEventStartTime=${tIso}`);
  console.log(`    rescheduledFrom=${b.rescheduledFrom?.toISOString?.() || 'null'}  rescheduledTo=${b.rescheduledTo?.toISOString?.() || 'null'}  count=${b.rescheduledCount || 0}`);
  console.log(`    bdaDiscordReminderSentAt=${b.bdaDiscordReminderSentAt?.toISOString?.() || 'null'}`);
  console.log(`    whatsappReminderSentAt=${b.whatsappReminderSentAt?.toISOString?.() || 'null'}`);
  console.log(`    bdaCallPlacedAt=${b.bdaCallPlacedAt?.toISOString?.() || 'null'}  reminderCallJobId=${b.reminderCallJobId || 'null'}`);
  console.log(`    bookingCreatedAt=${b.bookingCreatedAt?.toISOString?.()}`);
}

console.log('\n=== Recent calendlywebhooklogs (last 5 days) — sarosh filter ===');
const whAll = await db.collection('calendlywebhooklogs')
  .find({ createdAt: { $gte: fiveDaysAgo } })
  .sort({ createdAt: -1 }).limit(500).toArray();
console.log(`(total last 5d=${whAll.length})`);
const whSarosh = whAll.filter(l => {
  const s = JSON.stringify(l.payload || {});
  return /sarosh/i.test(s);
});
console.log(`sarosh matches: ${whSarosh.length}`);
for (const l of whSarosh) {
  console.log(`  ${l.createdAt?.toISOString?.()}  event=${l.eventType}`);
  const ni = l.payload?.new_invitee?.scheduled_event?.start_time;
  const oi = l.payload?.old_invitee?.scheduled_event?.start_time;
  const i  = l.payload?.invitee?.scheduled_event?.start_time;
  const em = l.payload?.invitee?.email || l.payload?.new_invitee?.email || l.payload?.old_invitee?.email;
  const nm = l.payload?.invitee?.name || l.payload?.new_invitee?.name || l.payload?.old_invitee?.name;
  console.log(`    name=${nm}  email=${em}`);
  if (ni || oi) console.log(`    old=${oi}  new=${ni}`);
  else if (i) console.log(`    start=${i}`);
}

console.log('\n=== Recent Discord meet reminders (last 5d) — sarosh filter ===');
const dAll = await db.collection('scheduleddiscordmeetreminders')
  .find({ createdAt: { $gte: fiveDaysAgo } }).sort({ scheduledFor: -1 }).toArray();
const dSar = dAll.filter(r => /sarosh/i.test(r.clientName || '') || /sarosh/i.test(r.clientEmail || ''));
console.log(`total last 5d=${dAll.length}  sarosh=${dSar.length}`);
for (const r of dSar) {
  console.log(`  reminderId=${r.reminderId}  email=${r.clientEmail}  name=${r.clientName}`);
  console.log(`    status=${r.status}  meetingStart=${r.meetingStartISO?.toISOString?.()}  scheduledFor=${r.scheduledFor?.toISOString?.()}`);
  console.log(`    source=${r.source}  attempts=${r.attempts}  err=${r.errorMessage || 'null'}`);
  console.log(`    processedAt=${r.processedAt?.toISOString?.() || 'null'}`);
}

console.log('\n=== Recent WhatsApp reminders (last 5d) — sarosh filter ===');
const wAll = await db.collection('scheduledwhatsappreminders')
  .find({ createdAt: { $gte: fiveDaysAgo } }).sort({ scheduledFor: -1 }).toArray();
const wSar = wAll.filter(r => /sarosh/i.test(r.clientName || '') || /sarosh/i.test(r.clientEmail || ''));
console.log(`total last 5d=${wAll.length}  sarosh=${wSar.length}`);
for (const r of wSar) {
  console.log(`  email=${r.clientEmail}  status=${r.status}  meetingStart=${r.meetingStartISO?.toISOString?.()}  scheduledFor=${r.scheduledFor?.toISOString?.()}`);
  console.log(`    minutesBefore=${r.minutesBefore}  phoneNumber=${r.phoneNumber}  source=${r.source}`);
  console.log(`    attempts=${r.attempts}  err=${r.errorMessage || 'null'}`);
}

console.log('\n=== Time-window: Discord reminders scheduledFor between May 12 12:00Z and May 13 12:00Z (covers IST 11:30pm) ===');
const winStart = new Date('2026-05-12T12:00:00Z');
const winEnd = new Date('2026-05-13T12:00:00Z');
const dWin = await db.collection('scheduleddiscordmeetreminders').find({
  scheduledFor: { $gte: winStart, $lte: winEnd }
}).sort({ scheduledFor: 1 }).toArray();
console.log(`count: ${dWin.length}`);
for (const r of dWin) {
  console.log(`  ${r.scheduledFor?.toISOString?.()}  status=${r.status}  email=${r.clientEmail}  name=${r.clientName}  meeting=${r.meetingStartISO?.toISOString?.()}`);
}

await mongoose.disconnect();
process.exit(0);

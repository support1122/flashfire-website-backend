/**
 * diagnose-pranav-dup.mjs
 * Pranav Rupareliya — meeting May 7 2:30 PM MDT (~May 8 2 AM IST).
 * Check booking flag state + reminder rows to find why claim didn't dedupe.
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const fmt = (d) => {
  if (!d) return null;
  const dt = DateTime.fromJSDate(new Date(d));
  return dt.isValid ? dt.setZone('Asia/Kolkata').toFormat('MMM d yyyy h:mm:ss a ZZZZ') : String(d);
};

const URI = 'https://api.calendly.com/scheduled_events/5e6c71a9-bf16-4648-a3af-f03fd84241cc';

console.log('=== BOOKINGS (Pranav) ===');
const bookings = await db.collection('campaignbookings').find({
  $or: [{ calendlyEventUri: URI }, { clientName: /pranav.*rupareliya/i }],
}).sort({ bookingCreatedAt: -1 }).toArray();
for (const b of bookings) {
  console.log({
    bookingId: b.bookingId,
    clientName: b.clientName,
    clientEmail: b.clientEmail,
    bookingStatus: b.bookingStatus,
    scheduledEventStartTime: fmt(b.scheduledEventStartTime),
    bdaDiscordReminderSentAt: fmt(b.bdaDiscordReminderSentAt),
    bdaDiscordReminderSentBy: b.bdaDiscordReminderSentBy,
    whatsappReminderSentAt: fmt(b.whatsappReminderSentAt),
    whatsappReminderSentBy: b.whatsappReminderSentBy,
    bdaCallPlacedAt: fmt(b.bdaCallPlacedAt),
    bdaCallPlacedBy: b.bdaCallPlacedBy,
    rescheduledCount: b.rescheduledCount,
  });
  console.log('---');
}

const ids = bookings.map(b => b.bookingId).filter(Boolean);
console.log('\n=== REMINDER ROWS for Pranav ===');
const rows = await db.collection('scheduleddiscordmeetreminders').find({
  $or: [
    { bookingId: { $in: ids } },
    { clientName: /pranav.*rupareliya/i },
  ],
}).sort({ scheduledFor: -1 }).limit(20).toArray();
for (const r of rows) {
  console.log({
    reminderId: r.reminderId,
    bookingId: r.bookingId,
    status: r.status,
    source: r.source,
    attempts: r.attempts,
    createdAt: fmt(r.createdAt),
    updatedAt: fmt(r.updatedAt),
    scheduledFor: fmt(r.scheduledFor),
    meetingStartISO: fmt(r.meetingStartISO),
    completedAt: fmt(r.completedAt),
    deliveryDriftMs: r.deliveryDriftMs,
    errorMessage: r.errorMessage,
    formatHint: r.precomputedClientTime ? 'NEW (Time Client/India + NOT CLAIMED)' : 'OLD (single Time)',
  });
  console.log('---');
}

await mongoose.disconnect();

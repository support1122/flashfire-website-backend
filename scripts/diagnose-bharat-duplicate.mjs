/**
 * diagnose-bharat-duplicate.mjs
 * Why Bharat got TWO Discord BDA reminders for the same meeting yesterday.
 * Looks for multiple ScheduledDiscordMeetReminder rows pointing at the same booking/meeting.
 *
 * Run: node scripts/diagnose-bharat-duplicate.mjs
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
  return dt.isValid ? dt.setZone('Asia/Kolkata').toFormat('MMM d yyyy h:mm a ZZZZ') : String(d);
};

// Calendly URI from screenshot
const URI = 'https://api.calendly.com/scheduled_events/d517b641-1036-448b-b2fb-136a7d561390';

const bookings = await db.collection('campaignbookings').find({
  $or: [
    { calendlyEventUri: URI },
    { clientName: /bharat/i },
  ],
}).sort({ bookingCreatedAt: -1 }).limit(10).toArray();

console.log('=== BHARAT BOOKINGS ===');
for (const b of bookings) {
  console.log({
    bookingId: b.bookingId,
    clientName: b.clientName,
    clientEmail: b.clientEmail,
    bookingStatus: b.bookingStatus,
    scheduledEventStartTime: fmt(b.scheduledEventStartTime),
    calendlyEventUri: b.calendlyEventUri,
  });
}

const ids = bookings.map(b => b.bookingId).filter(Boolean);
const emails = [...new Set(bookings.map(b => (b.clientEmail || '').toLowerCase().trim()).filter(Boolean))];

console.log('\n=== DISCORD REMINDER ROWS for those bookings ===');
const rows = await db.collection('scheduleddiscordmeetreminders').find({
  $or: [
    ids.length ? { bookingId: { $in: ids } } : null,
    emails.length ? { clientEmail: { $in: emails } } : null,
    { clientName: /bharat/i },
  ].filter(Boolean),
}).sort({ scheduledFor: -1 }).limit(20).toArray();

for (const r of rows) {
  console.log({
    reminderId: r.reminderId,
    bookingId: r.bookingId,
    clientName: r.clientName,
    status: r.status,
    source: r.source,
    attempts: r.attempts,
    createdAt: fmt(r.createdAt),
    scheduledFor: fmt(r.scheduledFor),
    meetingStartISO: fmt(r.meetingStartISO),
    completedAt: fmt(r.completedAt),
    deliveryDriftMs: r.deliveryDriftMs,
    formatHint: r.precomputedClientTime ? 'NEW (Time Client/India + NOT CLAIMED)' : 'OLD (single Time line)',
  });
  console.log('---');
}

console.log('\n=== Group by meetingStartISO (look for duplicates) ===');
const groups = {};
for (const r of rows) {
  const k = r.meetingStartISO ? new Date(r.meetingStartISO).toISOString() : 'null';
  groups[k] = groups[k] || [];
  groups[k].push(r);
}
for (const [k, list] of Object.entries(groups)) {
  if (list.length > 1) {
    console.log(`MEETING ${k} has ${list.length} reminder rows:`);
    for (const r of list) {
      console.log(`  - ${r.reminderId}  status=${r.status}  source=${r.source}  idScheme=${r.reminderId.startsWith('discord_meet_') ? 'main-backend' : (r.reminderId.startsWith('discord_') ? 'microservice' : 'other')}`);
    }
  }
}

await mongoose.disconnect();

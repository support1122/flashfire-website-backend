/**
 * diagnose-jaskaran-workflow.mjs
 * Jaskaran Singh received 'not-scheduled' WA workflow on May 9 2026 ~11PM
 * despite having a confirmed booking for May 11 12:30pm PDT.
 * Calendly event: c1c5c1ba-cb18-4b37-b7db-d38a50428ae6
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

const EVENT_UUID = 'c1c5c1ba-cb18-4b37-b7db-d38a50428ae6';
const EVENT_URI = `https://api.calendly.com/scheduled_events/${EVENT_UUID}`;

console.log('=== BOOKINGS (Jaskaran Singh) ===');
const bookings = await db.collection('campaignbookings').find({
  $or: [
    { calendlyEventUri: EVENT_URI },
    { clientName: /jaskaran/i },
  ],
}).sort({ bookingCreatedAt: -1 }).toArray();

for (const b of bookings) {
  console.log({
    bookingId: b.bookingId,
    clientName: b.clientName,
    clientEmail: b.clientEmail,
    clientPhone: b.clientPhone,
    bookingStatus: b.bookingStatus,
    leadSource: b.leadSource,
    calendlyEventUri: b.calendlyEventUri,
    scheduledEventStartTime: fmt(b.scheduledEventStartTime),
    bookingCreatedAt: fmt(b.bookingCreatedAt),
    bdaDiscordReminderSentAt: fmt(b.bdaDiscordReminderSentAt),
    bdaDiscordReminderSentBy: b.bdaDiscordReminderSentBy,
  });
  console.log('---');
}

const bookingIds = bookings.map(b => b.bookingId).filter(Boolean);
const clientEmails = [...new Set(bookings.map(b => b.clientEmail).filter(Boolean))];
const clientPhones = [...new Set(bookings.map(b => b.clientPhone).filter(Boolean))];

console.log('\n=== WORKFLOW LOGS (Jaskaran) ===');
const wfLogs = await db.collection('workflowlogs').find({
  $or: [
    { bookingId: { $in: bookingIds } },
    { clientEmail: { $in: clientEmails } },
    { clientName: /jaskaran/i },
  ],
}).sort({ scheduledFor: -1 }).limit(30).toArray();

for (const l of wfLogs) {
  console.log({
    logId: l.logId,
    bookingId: l.bookingId,
    clientName: l.clientName,
    triggerAction: l.triggerAction,
    workflowId: l.workflowId,
    workflowName: l.workflowName,
    channel: l.step?.channel,
    templateId: l.step?.templateId,
    templateName: l.step?.templateName,
    daysAfter: l.step?.daysAfter,
    status: l.status,
    scheduledFor: fmt(l.scheduledFor),
    executedAt: fmt(l.executedAt),
    error: l.error,
  });
  console.log('---');
}

// Also check if there's a meta lead / duplicate booking by phone
if (clientPhones.length > 0) {
  console.log('\n=== ALL BOOKINGS WITH SAME PHONE ===');
  const phoneBookings = await db.collection('campaignbookings').find({
    clientPhone: { $in: clientPhones },
  }).sort({ bookingCreatedAt: -1 }).toArray();
  for (const b of phoneBookings) {
    console.log({
      bookingId: b.bookingId,
      clientName: b.clientName,
      bookingStatus: b.bookingStatus,
      leadSource: b.leadSource,
      scheduledEventStartTime: fmt(b.scheduledEventStartTime),
      bookingCreatedAt: fmt(b.bookingCreatedAt),
    });
    console.log('---');
  }
}

// Check bulk trigger - did someone press "Send to All Not-Scheduled" around May 9 11PM IST?
// That's May 9 ~17:30 UTC
const bulkWindow = {
  $gte: new Date('2026-05-09T15:00:00Z'),
  $lte: new Date('2026-05-09T20:00:00Z'),
};
console.log('\n=== WORKFLOW LOGS created ~May 9 17-20 UTC (bulk trigger window) for not-scheduled ===');
const bulkLogs = await db.collection('workflowlogs').find({
  triggerAction: 'not-scheduled',
  scheduledFor: bulkWindow,
}).sort({ scheduledFor: 1 }).limit(10).toArray();
for (const l of bulkLogs) {
  console.log({
    logId: l.logId,
    bookingId: l.bookingId,
    clientName: l.clientName,
    status: l.status,
    scheduledFor: fmt(l.scheduledFor),
  });
  console.log('---');
}
console.log(`Total in bulk window: ${bulkLogs.length}`);

await mongoose.disconnect();

/**
 * diagnose-bharat-may4.mjs
 * Find every Discord reminder row whose meeting was at 2026-05-04T15:00:00Z (Bharat 11AM EDT / 8:30PM IST).
 * Run: node scripts/diagnose-bharat-may4.mjs
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

const targetStart = new Date('2026-05-04T15:00:00.000Z');
const targetSchedFrom = new Date('2026-05-04T14:50:00.000Z');
const targetSchedTo   = new Date('2026-05-04T15:05:00.000Z');

console.log('Searching reminders within +/- 5 min of', targetStart.toISOString());

const rows = await db.collection('scheduleddiscordmeetreminders').find({
  $or: [
    { meetingStartISO: { $gte: new Date(targetStart.getTime() - 60_000), $lte: new Date(targetStart.getTime() + 60_000) } },
    { meetingStartISO: targetStart.toISOString() },
    { scheduledFor: { $gte: targetSchedFrom, $lte: targetSchedTo } },
  ],
}).sort({ createdAt: 1 }).toArray();

console.log(`Found ${rows.length} matching rows:\n`);
for (const r of rows) {
  console.log({
    _id: r._id,
    reminderId: r.reminderId,
    bookingId: r.bookingId,
    clientName: r.clientName,
    clientEmail: r.clientEmail,
    status: r.status,
    source: r.source,
    attempts: r.attempts,
    createdAt: fmt(r.createdAt),
    updatedAt: fmt(r.updatedAt),
    scheduledFor: fmt(r.scheduledFor),
    meetingStartISO: fmt(r.meetingStartISO),
    completedAt: fmt(r.completedAt),
    deliveryDriftMs: r.deliveryDriftMs,
    precomputedClientTime: r.precomputedClientTime,
    precomputedIndiaTime: r.precomputedIndiaTime,
    inviteeTimezone: r.inviteeTimezone,
    formatHint: r.precomputedClientTime
      ? 'has precomputed (microservice OR main DiscordMeetReminderScheduler)'
      : 'no precomputed (main UnifiedScheduler path)',
  });
  console.log('---');
}

await mongoose.disconnect();

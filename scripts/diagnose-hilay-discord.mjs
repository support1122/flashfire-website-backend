/**
 * diagnose-hilay-discord.mjs
 * Why Hilay Movaliya didn't get the 5-min Discord BDA reminder.
 * Adds createdAt + raw status fields to confirm setTimeout-overflow theory.
 *
 * Run: node scripts/diagnose-hilay-discord.mjs
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

const NAME_RE = /hilay|movaliya|movliya/i;
const EMAIL_RE = /hilaymovliya85|movaliya/i;

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const fmt = (d) => {
  if (!d) return null;
  const dt = DateTime.fromJSDate(new Date(d));
  return dt.isValid ? dt.setZone('Asia/Kolkata').toFormat('MMM d yyyy h:mm a ZZZZ') : String(d);
};

const bookings = await db.collection('campaignbookings').find({
  $or: [{ clientName: NAME_RE }, { clientEmail: EMAIL_RE }],
}).sort({ bookingCreatedAt: -1 }).limit(5).toArray();

const ids = bookings.map(b => b.bookingId);
const emails = [...new Set(bookings.map(b => (b.clientEmail || '').toLowerCase().trim()).filter(Boolean))];

console.log('=== DISCORD REMINDER ROWS (Hilay) — focus on the May-5 booking ===\n');
const rows = await db.collection('scheduleddiscordmeetreminders')
  .find({ $or: [{ bookingId: { $in: ids } }, { clientEmail: { $in: emails } }] })
  .sort({ scheduledFor: -1 })
  .toArray();

for (const r of rows) {
  const ageAtFireMs = (r.deliveryDriftMs != null) ? r.deliveryDriftMs : null;
  const overflowSuspect = ageAtFireMs != null && ageAtFireMs < -2_000_000_000;
  console.log({
    reminderId: r.reminderId,
    bookingId: r.bookingId,
    status: r.status,
    attempts: r.attempts,
    source: r.source,
    createdAt: fmt(r.createdAt),
    updatedAt: fmt(r.updatedAt),
    scheduledFor: fmt(r.scheduledFor),
    meetingStartISO: fmt(r.meetingStartISO),
    processedAt: fmt(r.processedAt),
    completedAt: fmt(r.completedAt),
    deliveryDriftMs: r.deliveryDriftMs,
    deliveryDriftReadable: r.deliveryDriftMs != null
      ? `${(r.deliveryDriftMs / 86_400_000).toFixed(2)} days (negative = fired BEFORE scheduledFor)`
      : null,
    overflowSuspect,
    errorMessage: r.errorMessage,
  });
  console.log('---');
}

console.log('\n=== Anomaly summary ===');
const completedNoTimestamp = rows.filter(r => r.status === 'completed' && !r.completedAt);
console.log({
  totalRows: rows.length,
  completedRowsWithoutCompletedAt: completedNoTimestamp.length,
  rowsWithLargeNegativeDrift: rows.filter(r => (r.deliveryDriftMs ?? 0) < -2_000_000_000).length,
  note: 'completed without completedAt timestamp = Microservice DiscordReminderHandler path (does not stamp completedAt). Large negative drift (>~24.8d) = Node setTimeout int32 overflow → timer fired immediately at row creation instead of at scheduledFor.',
});

await mongoose.disconnect();

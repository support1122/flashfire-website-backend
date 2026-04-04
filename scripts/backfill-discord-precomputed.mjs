import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime, IANAZone } from 'luxon';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

function formatMeetingWallTime(meetingStart, inviteeTimezone) {
  if (!meetingStart) return null;
  const instant = meetingStart instanceof Date
    ? DateTime.fromJSDate(meetingStart, { zone: 'utc' })
    : DateTime.fromISO(String(meetingStart), { zone: 'utc' });
  if (!instant.isValid) return null;
  const zone =
    inviteeTimezone && typeof inviteeTimezone === 'string' && IANAZone.isValidZone(inviteeTimezone.trim())
      ? inviteeTimezone.trim()
      : 'Asia/Kolkata';
  return instant.setZone(zone).toFormat('ff');
}

const pending = await db.collection('scheduleddiscordmeetreminders').find({
  status: { $in: ['pending', 'scheduled'] },
  scheduledFor: { $gte: new Date() }
}).toArray();

console.log(`Found ${pending.length} pending Discord reminders`);
let fixed = 0;

for (const r of pending) {
  if (r.precomputedClientTime && r.precomputedIndiaTime) continue; // already has them
  
  const meetingStart = r.meetingStartISO instanceof Date
    ? r.meetingStartISO
    : (r.meetingStartISO ? new Date(r.meetingStartISO) : null);
  
  if (!meetingStart || isNaN(meetingStart.getTime())) {
    // Use scheduledFor + 5min as fallback
    const sf = r.scheduledFor ? new Date(new Date(r.scheduledFor).getTime() + 5 * 60 * 1000) : null;
    if (!sf) { console.log(`  SKIP ${r.clientName}: no meetingStartISO and no scheduledFor`); continue; }
    const clientTime = formatMeetingWallTime(sf, r.inviteeTimezone);
    const indiaTime = formatMeetingWallTime(sf, 'Asia/Kolkata');
    await db.collection('scheduleddiscordmeetreminders').updateOne(
      { _id: r._id },
      { $set: { precomputedClientTime: clientTime, precomputedIndiaTime: indiaTime } }
    );
    console.log(`  FIXED (from scheduledFor) ${r.clientName}: client="${clientTime}" india="${indiaTime}"`);
  } else {
    const clientTime = formatMeetingWallTime(meetingStart, r.inviteeTimezone);
    const indiaTime = formatMeetingWallTime(meetingStart, 'Asia/Kolkata');
    await db.collection('scheduleddiscordmeetreminders').updateOne(
      { _id: r._id },
      { $set: { precomputedClientTime: clientTime, precomputedIndiaTime: indiaTime } }
    );
    console.log(`  FIXED ${r.clientName}: client="${clientTime}" india="${indiaTime}"`);
  }
  fixed++;
}

console.log(`\nTotal backfilled: ${fixed}`);
await mongoose.disconnect();

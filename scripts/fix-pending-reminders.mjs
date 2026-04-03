import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const now = new Date();
let fixedCount = 0;

// 1. Fix records with meetingDate = "undefined"
const undefinedDateRecords = await db.collection('scheduledwhatsappreminders').find({
  meetingDate: 'undefined',
  status: { $in: ['pending', 'scheduled'] }
}).toArray();

console.log(`Found ${undefinedDateRecords.length} records with meetingDate="undefined"`);

for (const r of undefinedDateRecords) {
  if (!r.meetingStartISO) { console.log(`  SKIP ${r._id}: no meetingStartISO`); continue; }
  
  // Determine timezone - if IST, use Asia/Calcutta
  const tz = (r.timezone === 'IST' || r.inviteeTimezone === 'Asia/Calcutta' || r.inviteeTimezone === 'Asia/Kolkata')
    ? 'Asia/Calcutta'
    : (r.inviteeTimezone && r.inviteeTimezone !== 'undefined' ? r.inviteeTimezone : 'Asia/Calcutta');
  
  const startDT = DateTime.fromJSDate(new Date(r.meetingStartISO)).setZone(tz);
  const newDate = startDT.toFormat('EEEE MMM d, yyyy');
  
  const updateObj = { meetingDate: newDate };
  if (!r.inviteeTimezone || r.inviteeTimezone === 'undefined') {
    updateObj.inviteeTimezone = tz;
  }
  
  await db.collection('scheduledwhatsappreminders').updateOne(
    { _id: r._id },
    { $set: updateObj }
  );
  
  console.log(`  FIXED ${r.clientName} | ${r.reminderType}: meetingDate="${newDate}" inviteeTimezone="${tz}"`);
  fixedCount++;
}

// 2. Fix timezone "GMT+5:30" → "IST" for pending reminders
const gmtPlusRecords = await db.collection('scheduledwhatsappreminders').find({
  timezone: 'GMT+5:30',
  status: { $in: ['pending', 'scheduled'] }
}).toArray();

console.log(`\nFound ${gmtPlusRecords.length} records with timezone="GMT+5:30"`);

for (const r of gmtPlusRecords) {
  await db.collection('scheduledwhatsappreminders').updateOne(
    { _id: r._id },
    { $set: { timezone: 'IST', ...((!r.inviteeTimezone || r.inviteeTimezone === 'undefined') ? { inviteeTimezone: 'Asia/Calcutta' } : {}) } }
  );
  console.log(`  FIXED ${r.clientName} | ${r.reminderType}: timezone GMT+5:30 → IST`);
  fixedCount++;
}

// 3. Show any remaining issues
const remaining = await db.collection('scheduledwhatsappreminders').find({
  status: { $in: ['pending', 'scheduled'] },
  scheduledFor: { $gte: now },
  $or: [
    { meetingDate: 'undefined' },
    { meetingDate: null },
    { timezone: 'GMT+5:30' },
    { meetingTime: 'Unknown' },
    { meetingTime: null },
    { meetingTime: '' }
  ]
}).toArray();

console.log(`\nRemaining issues: ${remaining.length}`);
remaining.forEach(r => console.log(`  ${r.clientName} | ${r.reminderType} | date="${r.meetingDate}" time="${r.meetingTime}" tz="${r.timezone}"`));

console.log(`\nTotal fixed: ${fixedCount}`);
await mongoose.disconnect();

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

// Check what Sohith's records look like exactly
const sohith = await db.collection('scheduledwhatsappreminders').find({
  clientName: /sohith/i,
  status: { $in: ['pending', 'scheduled'] }
}).toArray();

console.log('Sohith records count:', sohith.length);
if (sohith[0]) {
  console.log('First record meetingDate:', JSON.stringify(sohith[0].meetingDate), typeof sohith[0].meetingDate);
  console.log('First record inviteeTimezone:', JSON.stringify(sohith[0].inviteeTimezone), typeof sohith[0].inviteeTimezone);
}

// Try to find by regex or existence
const undefinedStr = await db.collection('scheduledwhatsappreminders').countDocuments({
  clientName: /sohith/i, meetingDate: 'undefined'
});
const undefinedNull = await db.collection('scheduledwhatsappreminders').countDocuments({
  clientName: /sohith/i, meetingDate: null
});
const undefinedExist = await db.collection('scheduledwhatsappreminders').countDocuments({
  clientName: /sohith/i, meetingDate: { $exists: false }
});
console.log('By string "undefined":', undefinedStr);
console.log('By null:', undefinedNull);
console.log('By $exists false:', undefinedExist);

// Fix: find all pending Sohith records with bad meetingDate and fix them
const badRecords = await db.collection('scheduledwhatsappreminders').find({
  clientName: /sohith/i,
  status: { $in: ['pending', 'scheduled'] },
  scheduledFor: { $gte: new Date() }
}).toArray();

console.log('\nFuture pending Sohith records:');
for (const r of badRecords) {
  const needsFix = !r.meetingDate || r.meetingDate === 'undefined';
  console.log(`  ${r.clientName} | date="${r.meetingDate}" | type=${typeof r.meetingDate} | needsFix=${needsFix}`);
  if (needsFix && r.meetingStartISO) {
    const tz = 'Asia/Calcutta';
    const startDT = DateTime.fromJSDate(new Date(r.meetingStartISO)).setZone(tz);
    const newDate = startDT.toFormat('EEEE MMM d, yyyy');
    await db.collection('scheduledwhatsappreminders').updateOne(
      { _id: r._id },
      { $set: { meetingDate: newDate, inviteeTimezone: tz } }
    );
    console.log(`    → FIXED: meetingDate="${newDate}"`);
  }
}

// Also fix Pranjal
const pranjal = await db.collection('scheduledwhatsappreminders').find({
  clientName: /pranjal/i,
  status: { $in: ['pending', 'scheduled'] },
  scheduledFor: { $gte: new Date() }
}).toArray();

console.log('\nFuture pending Pranjal records:');
for (const r of pranjal) {
  const needsFix = !r.meetingDate || r.meetingDate === 'undefined';
  console.log(`  ${r.clientName} | date="${r.meetingDate}" | needsFix=${needsFix}`);
  if (needsFix && r.meetingStartISO) {
    const tz = 'Asia/Calcutta';
    const startDT = DateTime.fromJSDate(new Date(r.meetingStartISO)).setZone(tz);
    const newDate = startDT.toFormat('EEEE MMM d, yyyy');
    await db.collection('scheduledwhatsappreminders').updateOne(
      { _id: r._id },
      { $set: { meetingDate: newDate, inviteeTimezone: tz } }
    );
    console.log(`    → FIXED: meetingDate="${newDate}"`);
  }
}

await mongoose.disconnect();

import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const now = new Date();
console.log('Checking pending WA reminders as of:', now.toISOString(), '\n');

// Find all pending future reminders
const pending = await db.collection('scheduledwhatsappreminders').find({
  status: { $in: ['pending', 'scheduled'] },
  scheduledFor: { $gte: now }
}).sort({ scheduledFor: 1 }).toArray();

console.log(`Total pending: ${pending.length}\n`);

const problems = [];
for (const r of pending) {
  const hasUnknownTime = !r.meetingTime || r.meetingTime === 'Unknown' || 
    String(r.meetingTime).startsWith('Unknown') || r.meetingTime === 'undefined' || r.meetingTime === 'null';
  const hasUnknownDate = !r.meetingDate || r.meetingDate === 'undefined' || 
    r.meetingDate === 'null' || r.meetingDate === 'Unknown';
  const hasBadTimezone = !r.timezone || r.timezone === 'null' || r.timezone === 'undefined';
  
  if (hasUnknownTime || hasUnknownDate) {
    problems.push({ r, hasUnknownTime, hasUnknownDate, hasBadTimezone });
    console.log(`⚠️  PROBLEM: ${r.clientName} | ${r.reminderType} | scheduledFor: ${r.scheduledFor}`);
    console.log(`   meetingDate: "${r.meetingDate}" | meetingTime: "${r.meetingTime}" | timezone: "${r.timezone}"`);
    console.log(`   inviteeTimezone: "${r.inviteeTimezone}" | meetingStartISO: "${r.meetingStartISO}"`);
    console.log('');
  }
}

if (problems.length === 0) {
  console.log('✅ No problems found in pending reminders!');
} else {
  console.log(`\nTotal problems: ${problems.length}`);
}

// Also show all pending reminders for overview
console.log('\n=== ALL PENDING REMINDERS ===');
for (const r of pending) {
  const tz = r.inviteeTimezone || 'America/New_York';
  const sf = DateTime.fromJSDate(new Date(r.scheduledFor)).setZone('Asia/Calcutta');
  console.log(`${r.clientName} | ${r.reminderType} | fires: ${sf.toFormat('MMM d h:mma')} IST | time: "${r.meetingTime}" ${r.timezone || ''}`);
}

await mongoose.disconnect();

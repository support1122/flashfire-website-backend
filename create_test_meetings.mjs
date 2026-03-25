// Create 5 test meetings for today at different hours
// Client: sohith for all, BDA: sohith@flashfirehq.com

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
const { CampaignBookingModel } = await import('./Schema_Models/CampaignBooking.js');

const now = new Date();
const BDA_EMAIL = 'sohith@flashfirehq.com';
const BDA_NAME = 'sohith';

// Create 5 test meetings spaced 1 hour apart starting from now + 5 minutes
const meetings = [
  { offset: 5, label: 'Test 1' },      // 5 min from now (join this one to test)
  { offset: 65, label: 'Test 2' },     // ~1 hour from now
  { offset: 125, label: 'Test 3' },    // ~2 hours from now
  { offset: 185, label: 'Test 4' },    // ~3 hours from now
  { offset: 245, label: 'Test 5' },    // ~4 hours from now
];

console.log('\n=== Creating 5 Test Meetings ===\n');

for (const m of meetings) {
  const startTime = new Date(now.getTime() + m.offset * 60 * 1000);
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000); // 30 min duration

  const booking = await CampaignBookingModel.create({
    bookingId: `test_meeting_${m.label.replace(/\s/g, '_').toLowerCase()}_${Date.now()}`,
    utmSource: 'test',
    clientName: `sohith - ${m.label}`,
    clientEmail: 'sohith.test@example.com',
    bookingStatus: 'scheduled',
    scheduledEventStartTime: startTime,
    scheduledEventEndTime: endTime,
    googleMeetUrl: '',
    googleMeetCode: '',
    claimedBy: {
      email: BDA_EMAIL,
      name: BDA_NAME,
      claimedAt: new Date(),
    },
  });

  const timeStr = startTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true });
  console.log(`  ${m.label}: ${booking.bookingId}`);
  console.log(`    Start: ${timeStr} IST`);
  console.log(`    Client: sohith - ${m.label}`);
  console.log(`    BDA: ${BDA_EMAIL}\n`);
}

console.log('=== All 5 test meetings created! ===');
console.log('The first meeting starts in ~5 minutes. Join any Google Meet to test auto-detection.\n');

await mongoose.disconnect();

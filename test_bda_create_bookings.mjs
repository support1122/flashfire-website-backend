import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI);
const { CampaignBookingModel } = await import('./Schema_Models/CampaignBooking.js');

const now = new Date();
const meetStart = new Date(now.getTime() - 5 * 60 * 1000);
const meetEnd = new Date(meetStart.getTime() + 30 * 60 * 1000);

const testBooking = await CampaignBookingModel.create({
  bookingId: 'test_bda_att_' + Date.now(),
  utmSource: 'test',
  clientName: 'Test Client - BDA Attendance',
  clientEmail: 'testclient@example.com',
  bookingStatus: 'scheduled',
  scheduledEventStartTime: meetStart,
  scheduledEventEndTime: meetEnd,
  googleMeetUrl: 'https://meet.google.com/abc-test-xyz',
  googleMeetCode: 'abc-test-xyz',
  claimedBy: { email: 'testbda@flashfirejobs.com', name: 'Test BDA User', claimedAt: new Date() }
});
console.log('PAST_BOOKING=' + testBooking.bookingId);

const futureStart = new Date(now.getTime() + 15 * 60 * 1000);
const futureEnd = new Date(futureStart.getTime() + 30 * 60 * 1000);
const futureBooking = await CampaignBookingModel.create({
  bookingId: 'test_bda_future_' + Date.now(),
  utmSource: 'test',
  clientName: 'Future Meeting Client',
  clientEmail: 'futureclient@example.com',
  bookingStatus: 'scheduled',
  scheduledEventStartTime: futureStart,
  scheduledEventEndTime: futureEnd,
  googleMeetUrl: 'https://meet.google.com/def-test-uvw',
  googleMeetCode: 'def-test-uvw',
  claimedBy: { email: 'testbda@flashfirejobs.com', name: 'Test BDA User', claimedAt: new Date() }
});
console.log('FUTURE_BOOKING=' + futureBooking.bookingId);

await mongoose.disconnect();

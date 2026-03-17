#!/usr/bin/env node
/**
 * Create a test meeting in DB for testing BDA extension.
 * Automatically sets time to 5 minutes from now.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const { CampaignBookingModel } = await import('./Schema_Models/CampaignBooking.js');

// 5 minutes from now
const meetStart = new Date(Date.now() + 5 * 60 * 1000);
const meetEnd = new Date(meetStart.getTime() + 30 * 60 * 1000);

const testBooking = await CampaignBookingModel.create({
  bookingId: 'test_extension_' + Date.now(),
  utmSource: 'test',
  clientName: 'test',
  clientEmail: 'test@example.com',
  bookingStatus: 'scheduled',
  scheduledEventStartTime: meetStart,
  scheduledEventEndTime: meetEnd,
  googleMeetUrl: 'https://meet.google.com/test-extension-xyz',
  googleMeetCode: 'test-extension-xyz',
  leadSource: 'manual',
  claimedBy: {
    email: 'testbda@flashfirejobs.com',
    name: 'Test BDA User',
    claimedAt: new Date()
  }
});

console.log('Created test meeting for extension testing:');
console.log('  bookingId:', testBooking.bookingId);
console.log('  clientName:', testBooking.clientName);
console.log('  scheduledEventStartTime:', testBooking.scheduledEventStartTime);
console.log('  scheduledEventEndTime:', testBooking.scheduledEventEndTime);

await mongoose.disconnect();
console.log('Done.');

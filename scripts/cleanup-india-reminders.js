/**
 * One-time cleanup script: Remove Discord meet reminders for India (+91) number bookings.
 *
 * Usage: node scripts/cleanup-india-reminders.js
 *
 * What it does:
 * 1. Finds all CampaignBookings with +91 phone numbers
 * 2. Cancels any pending Discord meet reminders for those bookings
 * 3. Logs what was cleaned up
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

async function cleanup() {
  if (!MONGO_URI) {
    console.error('❌ No MONGODB_URI or MONGO_URI found in env');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // Find all bookings with India phone numbers
  const indiaBookings = await CampaignBookingModel.find({
    clientPhone: { $regex: /^\+91/ },
    bookingStatus: { $in: ['scheduled', 'not-scheduled'] },
  }).select('bookingId clientName clientPhone clientEmail scheduledEventStartTime');

  console.log(`\n📋 Found ${indiaBookings.length} India number bookings (scheduled/not-scheduled):\n`);

  let cancelledCount = 0;

  for (const booking of indiaBookings) {
    const meetingTime = booking.scheduledEventStartTime
      ? new Date(booking.scheduledEventStartTime).toISOString()
      : 'N/A';

    console.log(`  👤 ${booking.clientName} | ${booking.clientPhone} | ${booking.bookingId} | Meeting: ${meetingTime}`);

    // Find and cancel pending Discord meet reminders for this booking
    const result = await ScheduledDiscordMeetReminderModel.updateMany(
      {
        bookingId: booking.bookingId,
        status: { $in: ['pending', 'processing'] },
      },
      {
        $set: {
          status: 'cancelled',
          errorMessage: 'Cancelled: India number - no reminders needed',
        },
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`    ✅ Cancelled ${result.modifiedCount} Discord reminder(s)`);
      cancelledCount += result.modifiedCount;
    }
  }

  // Also find any orphaned Discord reminders linked to India numbers by email
  const indiaEmails = indiaBookings.map(b => b.clientEmail).filter(Boolean);
  if (indiaEmails.length > 0) {
    const orphanResult = await ScheduledDiscordMeetReminderModel.updateMany(
      {
        clientEmail: { $in: indiaEmails },
        status: { $in: ['pending', 'processing'] },
      },
      {
        $set: {
          status: 'cancelled',
          errorMessage: 'Cancelled: India number - no reminders needed',
        },
      }
    );
    if (orphanResult.modifiedCount > 0) {
      console.log(`\n  ✅ Cancelled ${orphanResult.modifiedCount} additional orphaned Discord reminder(s) by email match`);
      cancelledCount += orphanResult.modifiedCount;
    }
  }

  console.log(`\n🏁 Done. Total cancelled: ${cancelledCount} Discord reminder(s) for India numbers.`);

  await mongoose.disconnect();
  process.exit(0);
}

cleanup().catch(err => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});

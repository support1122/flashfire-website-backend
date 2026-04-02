import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { scheduleAllWhatsAppReminders } from '../Utils/WhatsAppReminderScheduler.js';
import { scheduleCall } from '../Utils/CallScheduler.js';
import { scheduleDiscordMeetReminder } from '../Utils/DiscordMeetReminderScheduler.js';
import { DiscordConnect } from '../Utils/DiscordConnect.js';
import { normalizePhoneForReminders } from '../Utils/MeetingReminderUtils.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  try {
    console.log(`\n🔧 Today's WA Reminder Fix Script ${DRY_RUN ? '(DRY RUN)' : ''}`);
    console.log('='.repeat(60));

    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    // Today's range (UTC)
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

    // Also include tomorrow's early meetings (for clients in US timezones)
    const searchEnd = new Date(tomorrowStart);
    searchEnd.setUTCDate(searchEnd.getUTCDate() + 1);

    console.log(`📅 Searching meetings from ${todayStart.toISOString()} to ${searchEnd.toISOString()}\n`);

    // Find all scheduled bookings for today and tomorrow
    const bookings = await CampaignBookingModel.find({
      bookingStatus: 'scheduled',
      scheduledEventStartTime: { $gte: todayStart, $lt: searchEnd },
    }).lean();

    console.log(`📋 Found ${bookings.length} scheduled meeting(s)\n`);

    if (bookings.length === 0) {
      console.log('No meetings to process. Exiting.');
      await mongoose.disconnect();
      return;
    }

    const results = [];

    for (const booking of bookings) {
      const meetingStart = new Date(booking.scheduledEventStartTime);
      const now = new Date();
      const minutesUntil = (meetingStart.getTime() - now.getTime()) / 60000;

      // Skip meetings that already happened (> 30 min ago)
      if (minutesUntil < -30) {
        console.log(`⏭️  SKIP (past): ${booking.clientName} - meeting was ${Math.abs(Math.round(minutesUntil))}m ago`);
        continue;
      }

      const phone = booking.clientPhone ? normalizePhoneForReminders(booking.clientPhone) : null;
      const meetingIST = DateTime.fromJSDate(meetingStart).setZone('Asia/Kolkata').toFormat('dd MMM yyyy, hh:mm a');
      const meetingClient = DateTime.fromJSDate(meetingStart).setZone(booking.inviteeTimezone || 'America/New_York').toFormat('ff');

      console.log(`\n── ${booking.clientName} (${booking.clientEmail}) ──`);
      console.log(`   📞 Phone: ${phone || 'N/A'}`);
      console.log(`   🗓️  Meeting: ${meetingIST} IST (${meetingClient})`);
      console.log(`   ⏳ In: ${Math.round(minutesUntil)} min`);
      console.log(`   📎 Booking: ${booking.bookingId}`);

      // Check existing WA reminders
      const existingWA = await ScheduledWhatsAppReminderModel.find({
        bookingId: booking.bookingId,
      }).lean();

      // Check existing calls
      const existingCall = await ScheduledCallModel.findOne({
        bookingId: booking.bookingId,
      }).lean();

      // Check existing Discord reminders
      const existingDiscord = await ScheduledDiscordMeetReminderModel.findOne({
        bookingId: booking.bookingId,
      }).lean();

      const waCount = existingWA.length;
      const hasCall = !!existingCall;
      const hasDiscord = !!existingDiscord;

      console.log(`   📊 Existing: WA=${waCount}, Call=${hasCall ? '✅' : '❌'}, Discord=${hasDiscord ? '✅' : '❌'}`);

      const bookingResult = {
        clientName: booking.clientName,
        clientEmail: booking.clientEmail,
        phone,
        meetingTime: meetingIST,
        minutesUntil: Math.round(minutesUntil),
        actions: [],
      };

      // Schedule WA reminders if missing
      if (waCount === 0 && phone && !DRY_RUN) {
        try {
          const tz = booking.inviteeTimezone || 'America/New_York';
          const startDT = DateTime.fromJSDate(meetingStart).setZone(tz);
          const endDT = booking.scheduledEventEndTime
            ? DateTime.fromJSDate(new Date(booking.scheduledEventEndTime)).setZone(tz)
            : startDT.plus({ minutes: 15 });
          const fmt = (dt) => dt.minute === 0
            ? dt.toFormat('ha').toLowerCase()
            : dt.toFormat('h:mma').toLowerCase();
          const meetingTimeFormatted = `${fmt(startDT)} – ${fmt(endDT)}`;
          const meetingDateFormatted = startDT.toFormat('EEEE MMM d, yyyy');
          const tzAbbr = startDT.isValid ? startDT.toFormat('ZZZZ') : 'ET';

          const waResult = await scheduleAllWhatsAppReminders({
            phoneNumber: phone,
            meetingStartISO: booking.scheduledEventStartTime,
            meetingTime: meetingTimeFormatted,
            meetingDate: meetingDateFormatted,
            clientName: booking.clientName,
            clientEmail: booking.clientEmail,
            meetingLink: booking.calendlyMeetLink || booking.googleMeetUrl || null,
            rescheduleLink: booking.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
            source: 'manual',
            timezone: tzAbbr,
            metadata: {
              bookingId: booking.bookingId,
              inviteeTimezone: booking.inviteeTimezone,
            },
          });
          console.log(`   ✅ WA reminders scheduled!`);
          bookingResult.actions.push('wa_scheduled');
        } catch (err) {
          console.log(`   ❌ WA scheduling failed: ${err.message}`);
          bookingResult.actions.push(`wa_error: ${err.message}`);
        }
      } else if (waCount === 0 && phone && DRY_RUN) {
        console.log(`   🔍 DRY RUN: Would schedule WA reminders`);
        bookingResult.actions.push('wa_would_schedule');
      } else if (waCount === 0 && !phone) {
        console.log(`   ⚠️  No phone number — cannot schedule WA`);
        bookingResult.actions.push('wa_no_phone');
      } else {
        console.log(`   ✅ WA reminders already exist (${waCount})`);
        bookingResult.actions.push(`wa_exists(${waCount})`);
      }

      // Schedule call if missing
      if (!hasCall && phone && minutesUntil > 12 && !DRY_RUN) {
        try {
          await scheduleCall({
            phoneNumber: phone,
            meetingStartISO: booking.scheduledEventStartTime,
            meetingTime: meetingClient,
            inviteeName: booking.clientName,
            inviteeEmail: booking.clientEmail,
            source: 'manual',
            meetingLink: booking.calendlyMeetLink || null,
            rescheduleLink: booking.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
            skipWhatsAppReminders: true, // WA already handled above
            metadata: {
              bookingId: booking.bookingId,
              inviteeTimezone: booking.inviteeTimezone,
            },
          });
          console.log(`   ✅ Call reminder scheduled!`);
          bookingResult.actions.push('call_scheduled');
        } catch (err) {
          console.log(`   ❌ Call scheduling failed: ${err.message}`);
          bookingResult.actions.push(`call_error: ${err.message}`);
        }
      } else if (!hasCall && phone && minutesUntil <= 12) {
        console.log(`   ⏭️  Call skip: meeting too soon (${Math.round(minutesUntil)}m)`);
        bookingResult.actions.push('call_too_soon');
      } else if (hasCall) {
        console.log(`   ✅ Call reminder already exists`);
        bookingResult.actions.push('call_exists');
      }

      // Schedule Discord reminder if missing
      if (!hasDiscord && minutesUntil > 6 && !DRY_RUN) {
        try {
          await scheduleDiscordMeetReminder({
            bookingId: booking.bookingId,
            clientName: booking.clientName,
            clientEmail: booking.clientEmail,
            meetingStartISO: booking.scheduledEventStartTime,
            meetingLink: booking.calendlyMeetLink || null,
            inviteeTimezone: booking.inviteeTimezone,
            source: 'manual',
            metadata: {
              bookingId: booking.bookingId,
            },
          });
          console.log(`   ✅ Discord meet reminder scheduled!`);
          bookingResult.actions.push('discord_scheduled');
        } catch (err) {
          console.log(`   ❌ Discord scheduling failed: ${err.message}`);
          bookingResult.actions.push(`discord_error: ${err.message}`);
        }
      } else if (hasDiscord) {
        console.log(`   ✅ Discord reminder already exists`);
        bookingResult.actions.push('discord_exists');
      }

      results.push(bookingResult);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 SUMMARY');
    console.log('='.repeat(60));

    const fixed = results.filter(r => r.actions.some(a => a.includes('scheduled')));
    const alreadyOk = results.filter(r => r.actions.every(a => a.includes('exists')));
    const errors = results.filter(r => r.actions.some(a => a.includes('error')));

    console.log(`   Total processed: ${results.length}`);
    console.log(`   Fixed (new reminders): ${fixed.length}`);
    console.log(`   Already OK: ${alreadyOk.length}`);
    console.log(`   Errors: ${errors.length}`);

    // Send Discord summary
    if (!DRY_RUN && results.length > 0) {
      const discordWebhook = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
      if (discordWebhook) {
        const lines = [
          `🔧 **WA Reminder Fix Script — ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}**`,
          `Processed: ${results.length} | Fixed: ${fixed.length} | OK: ${alreadyOk.length} | Errors: ${errors.length}`,
          '',
        ];

        for (const r of results) {
          const status = r.actions.some(a => a.includes('scheduled')) ? '🆕' :
            r.actions.every(a => a.includes('exists')) ? '✅' : '⚠️';
          lines.push(`${status} ${r.clientName} (${r.phone || 'no phone'}) — ${r.meetingTime} — ${r.actions.join(', ')}`);
        }

        await DiscordConnect(discordWebhook, lines.join('\n'), false);
        console.log('\n📤 Discord summary sent!');
      }
    }

    console.log('\n✅ Done!');
    await mongoose.disconnect();
  } catch (err) {
    console.error('❌ Script failed:', err.message, err.stack);
    process.exit(1);
  }
}

main();

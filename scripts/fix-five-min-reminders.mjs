#!/usr/bin/env node
/**
 * Backfill / repair 5-minute-before-meeting WhatsApp + Discord (BDA) reminders
 * for existing upcoming CampaignBookings, using Calendly fields on the booking
 * (scheduledEventStartTime, inviteeTimezone, etc.).
 *
 * Usage:
 *   node scripts/fix-five-min-reminders.mjs           # apply changes
 *   node scripts/fix-five-min-reminders.mjs --dry-run # log only
 *
 * Env: MONGODB_URI (required), same as app.
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { DateTime } from 'luxon';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { normalizePhoneForReminders, buildWhatsAppReminderId } from '../Utils/MeetingReminderUtils.js';
import { scheduleWhatsAppReminder } from '../Utils/WhatsAppReminderScheduler.js';
import {
  scheduleDiscordMeetReminder,
  buildDiscordMeetReminderId,
  getDiscordMeetReminderOffsetMinutes,
} from '../Utils/DiscordMeetReminderScheduler.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FIVE_MIN_MS = 5 * 60 * 1000;
const FIVE_MIN_EPS_MIN = Number(process.env.WA_FIVE_MIN_SCHEDULE_EPS_MIN) || 0.25;
const START_SLACK_MS = 60 * 1000;

function isUnknownishMeetingTime(s) {
  if (s == null || s === '') return true;
  const t = String(s);
  return (
    t === 'Unknown' ||
    t === 'undefined' ||
    t.startsWith('Unknown')
  );
}

function buildBookingDisplayTimes(booking) {
  const meetingStartISO =
    booking.scheduledEventStartTime instanceof Date
      ? booking.scheduledEventStartTime.toISOString()
      : String(booking.scheduledEventStartTime);

  const meetingStartUTC = DateTime.fromISO(meetingStartISO, { zone: 'utc' });
  if (!meetingStartUTC.isValid) return null;

  const meetingEndISO = booking.scheduledEventEndTime
    ? booking.scheduledEventEndTime instanceof Date
      ? booking.scheduledEventEndTime.toISOString()
      : String(booking.scheduledEventEndTime)
    : null;
  const meetingEndUTC = meetingEndISO
    ? DateTime.fromISO(meetingEndISO, { zone: 'utc' })
    : meetingStartUTC.plus({ minutes: 15 });

  const inviteeTz = booking.inviteeTimezone || null;
  let displayZone = inviteeTz;
  if (!displayZone) {
    const pst = meetingStartUTC.setZone('America/Los_Angeles').offset / 60;
    displayZone = pst === -8 || pst === -7 ? 'America/Los_Angeles' : 'America/New_York';
  }

  const startInZone = meetingStartUTC.setZone(displayZone);
  const endInZone = meetingEndUTC.isValid
    ? meetingEndUTC.setZone(displayZone)
    : meetingStartUTC.plus({ minutes: 15 }).setZone(displayZone);

  const fmt = (dt) =>
    dt.minute === 0 ? dt.toFormat('ha').toLowerCase() : dt.toFormat('h:mma').toLowerCase();

  const meetingTimeFormatted = `${fmt(startInZone)} – ${fmt(endInZone)}`;
  const meetingDateFormatted = startInZone.toFormat('EEEE MMM d, yyyy');

  let tzAbbr = 'ET';
  if (inviteeTz) {
    const tz = DateTime.fromISO(meetingStartISO, { zone: inviteeTz });
    tzAbbr = tz.isValid ? tz.toFormat('ZZZZ') : 'ET';
  }

  return {
    meetingStartISO,
    meetingStartMs: meetingStartUTC.toMillis(),
    meetingTimeFormatted,
    meetingDateFormatted,
    tzAbbr,
    inviteeTz,
    meetingEndISO,
  };
}

async function registerWaTimer(reminderId, when) {
  try {
    const { getScheduler } = await import('../Utils/UnifiedScheduler.js');
    const scheduler = getScheduler();
    if (scheduler) scheduler.scheduleTimer('whatsapp', reminderId, when);
  } catch {
    /* optional */
  }
}

async function registerDiscordTimer(reminderId, when) {
  try {
    const { getScheduler } = await import('../Utils/UnifiedScheduler.js');
    const scheduler = getScheduler();
    if (scheduler) scheduler.scheduleTimer('discord', reminderId, when);
  } catch {
    /* optional */
  }
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  console.log(`\n🔧 Fix 5-min reminders (WA + Discord BDA) ${DRY_RUN ? '[DRY RUN]' : ''}\n`);

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB connected\n');

  const now = Date.now();
  const discordLeadMin = getDiscordMeetReminderOffsetMinutes();
  const minMeetingStartMs = Math.max(
    now + (5 - FIVE_MIN_EPS_MIN) * 60 * 1000,
    now + (discordLeadMin + 1) * 60 * 1000
  );
  const minMeetingStart = new Date(minMeetingStartMs);

  const bookings = await CampaignBookingModel.find({
    bookingStatus: 'scheduled',
    scheduledEventStartTime: { $gte: minMeetingStart },
  })
    .select(
      'bookingId clientName clientEmail clientPhone scheduledEventStartTime scheduledEventEndTime calendlyMeetLink googleMeetUrl calendlyRescheduleLink inviteeTimezone bookingStatus statusChangeSource'
    )
    .lean();

  console.log(
    `📋 Upcoming bookings (meeting ≥ ${minMeetingStart.toISOString()}): ${bookings.length}\n`
  );

  const stats = {
    waCreated: 0,
    waUpdated: 0,
    waSkipped: 0,
    discordCreated: 0,
    discordUpdated: 0,
    discordSkipped: 0,
    errors: [],
  };

  const defaultReschedule =
    process.env.DEFAULT_CALENDLY_RESCHEDULE_URL ||
    'https://calendly.com/flashfirejobs';

  for (const booking of bookings) {
    const display = buildBookingDisplayTimes(booking);
    if (!display) {
      stats.errors.push({ bookingId: booking.bookingId, error: 'Invalid scheduledEventStartTime' });
      continue;
    }

    const { meetingStartISO, meetingStartMs, meetingTimeFormatted, meetingDateFormatted, tzAbbr, inviteeTz, meetingEndISO } =
      display;
    const meetingStart = new Date(meetingStartMs);
    const minutesUntil = (meetingStartMs - now) / 60000;

    if (minutesUntil <= 5 - FIVE_MIN_EPS_MIN) {
      stats.waSkipped++;
      stats.discordSkipped++;
      continue;
    }

    const phone = booking.clientPhone ? normalizePhoneForReminders(booking.clientPhone) : null;
    const phoneOk = phone && /^\+?[1-9]\d{9,14}$/.test(phone);

    const sharedMeta = {
      bookingId: booking.bookingId,
      inviteeTimezone: inviteeTz,
      meetingEndISO,
      backfillAt: new Date().toISOString(),
    };

    // ─── WhatsApp 5min ───
    if (phoneOk) {
      const wa5Id = buildWhatsAppReminderId('5min', phone, meetingStartMs);
      const existingWa = await ScheduledWhatsAppReminderModel.findOne({ reminderId: wa5Id }).lean();

      if (!existingWa) {
        if (!DRY_RUN) {
          const res = await scheduleWhatsAppReminder({
            phoneNumber: phone,
            meetingStartISO,
            meetingTime: meetingTimeFormatted,
            meetingDate: meetingDateFormatted,
            clientName: booking.clientName,
            clientEmail: booking.clientEmail,
            meetingLink: booking.calendlyMeetLink || booking.googleMeetUrl || 'Not Provided',
            rescheduleLink: booking.calendlyRescheduleLink || defaultReschedule,
            source: 'manual',
            metadata: sharedMeta,
            timezone: tzAbbr,
            reminderOffsetMinutes: 5,
            reminderType: '5min',
          });
          if (res.success && !res.skipped) stats.waCreated++;
          else if (!res.success && !res.skipped) {
            stats.errors.push({ bookingId: booking.bookingId, channel: 'wa5', error: res.error });
          }
        } else {
          console.log(`[dry-run] Would create WA 5min: ${booking.clientEmail} ${wa5Id}`);
        }
      } else if (
        ['pending', 'processing'].includes(existingWa.status) &&
        (isUnknownishMeetingTime(existingWa.meetingTime) ||
          Math.abs(new Date(existingWa.meetingStartISO).getTime() - meetingStartMs) > START_SLACK_MS)
      ) {
        const newScheduledFor = new Date(meetingStartMs - FIVE_MIN_MS);
        if (newScheduledFor <= new Date()) {
          stats.waSkipped++;
        } else if (!DRY_RUN) {
          await ScheduledWhatsAppReminderModel.updateOne(
            { _id: existingWa._id },
            {
              $set: {
                meetingTime: meetingTimeFormatted,
                meetingDate: meetingDateFormatted,
                meetingStartISO: meetingStart,
                scheduledFor: newScheduledFor,
                timezone: tzAbbr,
                meetingLink: booking.calendlyMeetLink || existingWa.meetingLink || 'Not Provided',
                rescheduleLink: booking.calendlyRescheduleLink || existingWa.rescheduleLink,
                metadata: {
                  ...(existingWa.metadata || {}),
                  ...sharedMeta,
                  reminderType: '5min',
                  reminderOffsetMinutes: 5,
                },
                errorMessage: null,
              },
            }
          );
          await registerWaTimer(wa5Id, newScheduledFor);
          stats.waUpdated++;
          console.log(`✅ WA 5min repaired: ${booking.clientEmail} (${wa5Id})`);
        } else {
          console.log(`[dry-run] Would repair WA 5min: ${booking.clientEmail}`);
        }
      } else {
        stats.waSkipped++;
      }
    } else {
      stats.waSkipped++;
    }

    // ─── Discord BDA 5min (offset from env) ───
    const discordId = buildDiscordMeetReminderId(booking.bookingId || booking.clientEmail || 'unknown', meetingStartMs);
    const existingDisc = await ScheduledDiscordMeetReminderModel.findOne({ reminderId: discordId }).lean();

    if (!existingDisc) {
      if (!DRY_RUN) {
        const res = await scheduleDiscordMeetReminder({
          bookingId: booking.bookingId,
          clientName: booking.clientName,
          clientEmail: booking.clientEmail,
          meetingStartISO: meetingStart,
          meetingLink: booking.calendlyMeetLink || null,
          inviteeTimezone: inviteeTz,
          source: 'sync',
          metadata: { bookingId: booking.bookingId, backfill: true },
        });
        if (res.success && !res.existing && !res.skipped) stats.discordCreated++;
        else if (res.existing) stats.discordSkipped++;
        else if (!res.success && !res.skipped) {
          stats.errors.push({ bookingId: booking.bookingId, channel: 'discord', error: res.error });
        }
      } else {
        console.log(`[dry-run] Would create Discord BDA: ${booking.clientEmail} ${discordId}`);
      }
    } else if (
      ['pending', 'processing'].includes(existingDisc.status) &&
      Math.abs(new Date(existingDisc.meetingStartISO).getTime() - meetingStartMs) > START_SLACK_MS
    ) {
      if (!DRY_RUN) {
        const offsetMin = discordLeadMin;
        const newScheduledFor = new Date(meetingStartMs - offsetMin * 60 * 1000);
        if (newScheduledFor <= new Date()) {
          stats.discordSkipped++;
        } else {
          await ScheduledDiscordMeetReminderModel.updateOne(
            { _id: existingDisc._id },
            {
              $set: {
                meetingStartISO: meetingStart,
                scheduledFor: newScheduledFor,
                meetingLink: booking.calendlyMeetLink || existingDisc.meetingLink,
                inviteeTimezone: inviteeTz ?? existingDisc.inviteeTimezone,
                errorMessage: null,
                metadata: { ...(existingDisc.metadata || {}), bookingId: booking.bookingId, backfillRepair: true },
              },
            }
          );
          await registerDiscordTimer(discordId, newScheduledFor);
          stats.discordUpdated++;
          console.log(`✅ Discord BDA repaired: ${booking.clientEmail} (${discordId})`);
        }
      } else {
        console.log(`[dry-run] Would repair Discord: ${booking.clientEmail}`);
      }
    } else if (
      ['pending', 'processing'].includes(existingDisc.status) &&
      inviteeTz &&
      !existingDisc.inviteeTimezone
    ) {
      if (!DRY_RUN) {
        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: existingDisc._id },
          {
            $set: {
              inviteeTimezone: inviteeTz,
              metadata: { ...(existingDisc.metadata || {}), bookingId: booking.bookingId, backfillTz: true },
            },
          }
        );
        stats.discordUpdated++;
        console.log(`✅ Discord BDA inviteeTimezone set: ${booking.clientEmail} (${discordId})`);
      } else {
        console.log(`[dry-run] Would set Discord inviteeTimezone: ${booking.clientEmail}`);
      }
    } else {
      stats.discordSkipped++;
    }
  }

  console.log('\n── Summary ──');
  console.log(JSON.stringify(stats, null, 2));
  await mongoose.disconnect();
  console.log('\n✅ Done\n');
}

main().catch((e) => {
  console.error(e);
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});

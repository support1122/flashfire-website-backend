import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { DiscordConnect } from './DiscordConnect.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';

dotenv.config();

const POLL_INTERVAL_MS = 30000; // 30 seconds
const DISCORD_MEET_2MIN_WEBHOOK_URL =
  process.env.DISCORD_MEET_2MIN_WEBHOOK_URL ||
  process.env.DISCORD_MEET_WEB_HOOK_URL ||
  process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL ||
  null;

let isRunning = false;
let pollInterval = null;

/**
 * Schedule a Discord reminder 3 minutes before a meeting start time.
 * Uses DISCORD_MEET_2MIN_WEBHOOK_URL env (same webhook).
 */
export async function scheduleDiscordMeetReminder({
  bookingId = null,
  clientName,
  clientEmail = null,
  meetingStartISO,
  meetingLink = null,
  inviteeTimezone = null,
  source = 'calendly',
  metadata = {},
}) {
  try {
    if (!DISCORD_MEET_2MIN_WEBHOOK_URL) {
      console.warn(
        '[DiscordMeetReminder] DISCORD_MEET_2MIN_WEBHOOK_URL (or fallback) not configured. Skipping scheduling.'
      );
      return { success: false, error: 'Discord webhook URL not configured' };
    }

    if (!meetingStartISO) {
      console.warn('[DiscordMeetReminder] meetingStartISO is required');
      return { success: false, error: 'meetingStartISO is required' };
    }

    const meetingStart = new Date(meetingStartISO);
    if (Number.isNaN(meetingStart.getTime())) {
      console.warn('[DiscordMeetReminder] Invalid meetingStartISO provided', {
        meetingStartISO,
      });
      return { success: false, error: 'Invalid meetingStartISO' };
    }

    const reminderTime = new Date(meetingStart.getTime() - 3 * 60 * 1000);
    const now = new Date();

    // If reminder time is already past, skip scheduling
    if (reminderTime <= now) {
      console.warn(
        '[DiscordMeetReminder] Reminder time already in the past, skipping scheduling',
        {
          meetingStart: meetingStart.toISOString(),
          reminderTime: reminderTime.toISOString(),
        }
      );
      return { success: false, error: 'Reminder time is in the past', skipped: true };
    }

    const baseId = bookingId || clientEmail || clientName || 'unknown';
    const reminderId = `discord_meet_3min_${baseId}_${meetingStart.getTime()}`;

    // Idempotency: do not create duplicates
    const existing = await ScheduledDiscordMeetReminderModel.findOne({ reminderId });
    if (existing) {
      return {
        success: true,
        reminderId,
        existing: true,
        scheduledFor: existing.scheduledFor,
      };
    }

    const reminder = await ScheduledDiscordMeetReminderModel.create({
      reminderId,
      bookingId,
      clientName,
      clientEmail,
      meetingStartISO: meetingStart,
      scheduledFor: reminderTime,
      meetingLink,
      inviteeTimezone,
      source,
      metadata,
    });

    const minutesUntilReminder = Math.round(
      (reminderTime.getTime() - now.getTime()) / 60000
    );

    console.log('✅ [DiscordMeetReminder] Reminder scheduled', {
      reminderId,
      bookingId,
      clientName,
      clientEmail,
      scheduledFor: reminderTime.toISOString(),
      meetingStart: meetingStart.toISOString(),
      minutesUntilReminder,
    });

    return {
      success: true,
      reminderId,
      scheduledFor: reminderTime,
      minutesUntilReminder,
    };
  } catch (error) {
    console.error('❌ [DiscordMeetReminder] Error scheduling reminder', {
      error: error.message,
    });
    return { success: false, error: error.message };
  }
}

async function processDueDiscordMeetReminders() {
  try {
    if (!DISCORD_MEET_2MIN_WEBHOOK_URL) {
      return;
    }

    const now = new Date();

    const dueReminders = await ScheduledDiscordMeetReminderModel.find({
      status: 'pending',
      scheduledFor: { $lte: now },
      attempts: { $lt: 3 },
    })
      .sort({ scheduledFor: 1 })
      .limit(10);

    if (dueReminders.length === 0) {
      return;
    }

    console.log(
      `📣 [DiscordMeetReminder] Processing ${dueReminders.length} due reminder(s)...`
    );

    for (const reminder of dueReminders) {
      try {
        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: reminder._id, status: 'pending' },
          {
            status: 'processing',
            processedAt: new Date(),
            $inc: { attempts: 1 },
          }
        );

        const meetingStart = reminder.meetingStartISO;
        const meetingStartUTC = DateTime.fromJSDate(meetingStart, { zone: 'utc' });

        const meetingTimeIndia = meetingStartUTC
          .setZone('Asia/Kolkata')
          .toFormat('ff');

        const messageLines = [
          '🔥 **Hot Lead — Meeting in 2 Minutes**',
          '',
          `Client: ${reminder.clientName}`,
          `Time: ${meetingTimeIndia}`,
          `Link: ${reminder.meetingLink || 'Not provided'}`,
          '',
          "BDA team, confirm attendance by typing **\"I'm in.\"** Let's close this.",
        ];

        const content = messageLines.join('\n');

        await DiscordConnect(DISCORD_MEET_2MIN_WEBHOOK_URL, content, false);

        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: reminder._id },
          {
            status: 'completed',
            completedAt: new Date(),
            errorMessage: null,
          }
        );
      } catch (error) {
        console.error(
          '❌ [DiscordMeetReminder] Error processing reminder',
          reminder.reminderId,
          error.message
        );

        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: reminder._id },
          {
            status:
              reminder.attempts + 1 >= reminder.maxAttempts ? 'failed' : 'pending',
            errorMessage: error.message,
          }
        );
      }
    }
  } catch (error) {
    console.error(
      '❌ [DiscordMeetReminder] Error in processDueDiscordMeetReminders',
      error.message
    );
  }
}

export function startDiscordMeetReminderScheduler() {
  if (isRunning) {
    console.log('[DiscordMeetReminder] Scheduler already running');
    return;
  }

  if (!DISCORD_MEET_2MIN_WEBHOOK_URL) {
    console.warn(
      '[DiscordMeetReminder] Discord webhook URL not configured. Scheduler will not start.'
    );
    return;
  }

  isRunning = true;
  console.log(
    '🚀 [DiscordMeetReminder] Starting Discord meeting reminder scheduler...'
  );
  console.log(
    `[DiscordMeetReminder] Polling interval: ${POLL_INTERVAL_MS / 1000} seconds`
  );

  // Initial run
  processDueDiscordMeetReminders();

  pollInterval = setInterval(processDueDiscordMeetReminders, POLL_INTERVAL_MS);
}

export function stopDiscordMeetReminderScheduler() {
  if (!isRunning) return;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  isRunning = false;
  console.log('🛑 [DiscordMeetReminder] Scheduler stopped');
}

export default {
  scheduleDiscordMeetReminder,
  startDiscordMeetReminderScheduler,
  stopDiscordMeetReminderScheduler,
};


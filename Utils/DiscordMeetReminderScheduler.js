import dotenv from 'dotenv';
import { DateTime, IANAZone } from 'luxon';
import { DiscordConnect } from './DiscordConnect.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

dotenv.config();

/** Poll Mongo for due reminders. Shorter = less latency after cold start / wake. */
const POLL_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.DISCORD_MEET_REMINDER_POLL_MS) || 15000
);

const REMINDER_OFFSET_ENV = Number(process.env.DISCORD_MEET_REMINDER_OFFSET_MINUTES);
const REMINDER_OFFSET_MINUTES =
  Number.isFinite(REMINDER_OFFSET_ENV) && REMINDER_OFFSET_ENV > 0 && REMINDER_OFFSET_ENV <= 120
    ? REMINDER_OFFSET_ENV
    : 5;

/** If a row stays in "processing" (crash mid-send), reset so it can retry. */
const STUCK_PROCESSING_MS = Math.max(
  120000,
  Number(process.env.DISCORD_MEET_REMINDER_STUCK_PROCESSING_MS) || 8 * 60 * 1000
);

const DISCORD_MEET_2MIN_WEBHOOK_URL =
  process.env.DISCORD_MEET_2MIN_WEBHOOK_URL ||
  process.env.DISCORD_MEET_WEB_HOOK_URL ||
  process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL ||
  null;

let isRunning = false;
let pollInterval = null;

/**
 * Parse Calendly / API instants reliably (correct UTC instant).
 * ISO without offset is interpreted in UTC (avoids host TZ shifting the meeting).
 */
export function parseMeetingStartToDate(meetingStartISO) {
  if (meetingStartISO == null) return null;
  if (meetingStartISO instanceof Date) {
    return Number.isNaN(meetingStartISO.getTime()) ? null : meetingStartISO;
  }
  const s = String(meetingStartISO).trim();
  if (!s) return null;

  const withZone = DateTime.fromISO(s, { setZone: true });
  if (withZone.isValid) {
    return withZone.toUTC().toJSDate();
  }

  const asUtcWall = DateTime.fromISO(s, { zone: 'utc' });
  if (asUtcWall.isValid) {
    return asUtcWall.toJSDate();
  }

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/** Same id shape as sync/backfill (`discord_meet_5min_*`) for idempotency. */
export function buildDiscordMeetReminderId(baseId, meetingStartMs) {
  return `discord_meet_5min_${baseId}_${meetingStartMs}`;
}

/** Used by sync/backfill so meeting start is far enough ahead that scheduledFor is still in the future */
export function getDiscordMeetReminderOffsetMinutes() {
  return REMINDER_OFFSET_MINUTES;
}

function formatMeetingWallTime(meetingStart, inviteeTimezone) {
  const instant = DateTime.fromJSDate(meetingStart, { zone: 'utc' });
  const zone =
    inviteeTimezone && typeof inviteeTimezone === 'string' && IANAZone.isValidZone(inviteeTimezone.trim())
      ? inviteeTimezone.trim()
      : 'Asia/Kolkata';
  return instant.setZone(zone).toFormat('ff');
}

function headlineForSendTime(meetingStart) {
  const now = Date.now();
  const start = meetingStart.getTime();
  const minutesUntil = (start - now) / 60000;

  if (minutesUntil > 4.5) {
    return `🔥 **Hot Lead — Meeting in ~${Math.round(minutesUntil)} minutes**`;
  }
  if (minutesUntil > 1.5) {
    return '🔥 **Hot Lead — Meeting in a few minutes**';
  }
  if (minutesUntil > -2) {
    return '🔥 **Hot Lead — Meeting starting now**';
  }
  const late = Math.round(-minutesUntil);
  return `⚠️ **Hot Lead — Meeting reminder (late; started ~${late}m ago)**`;
}

/**
 * Schedule a Discord BDA reminder N minutes before meeting start (default 5, env override).
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

    const meetingStart = parseMeetingStartToDate(meetingStartISO);
    if (!meetingStart) {
      console.warn('[DiscordMeetReminder] Invalid meetingStartISO provided', {
        meetingStartISO,
      });
      return { success: false, error: 'Invalid meetingStartISO' };
    }

    const offsetMs = REMINDER_OFFSET_MINUTES * 60 * 1000;
    const reminderTime = new Date(meetingStart.getTime() - offsetMs);
    const now = new Date();

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
    const reminderId = buildDiscordMeetReminderId(baseId, meetingStart.getTime());

    const existing = await ScheduledDiscordMeetReminderModel.findOne({ reminderId });
    if (existing) {
      return {
        success: true,
        reminderId,
        existing: true,
        scheduledFor: existing.scheduledFor,
      };
    }

    await ScheduledDiscordMeetReminderModel.create({
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
      offsetMinutes: REMINDER_OFFSET_MINUTES,
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

async function resetStuckProcessingReminders() {
  const cutoff = new Date(Date.now() - STUCK_PROCESSING_MS);
  const result = await ScheduledDiscordMeetReminderModel.updateMany(
    {
      status: 'processing',
      processedAt: { $lt: cutoff },
    },
    {
      $set: {
        status: 'pending',
        errorMessage: 'reset: stuck in processing (retry)',
      },
    }
  );
  if (result.modifiedCount > 0) {
    console.warn('[DiscordMeetReminder] Reset stuck processing reminders', {
      modifiedCount: result.modifiedCount,
    });
  }
}

export async function processDueDiscordMeetReminders() {
  try {
    if (!DISCORD_MEET_2MIN_WEBHOOK_URL) {
      return;
    }

    await resetStuckProcessingReminders();

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

    for (const candidate of dueReminders) {
      let reminder = null;
      try {
        // Single-winner claim: in-app poller + external cron can run together; only one Discord send per DB row.
        reminder = await ScheduledDiscordMeetReminderModel.findOneAndUpdate(
          {
            _id: candidate._id,
            status: 'pending',
            scheduledFor: { $lte: now },
            attempts: { $lt: 3 },
          },
          {
            $set: { status: 'processing', processedAt: new Date() },
            $inc: { attempts: 1 },
          },
          { new: true }
        ).lean();

        if (!reminder) {
          continue;
        }

        let booking = null;
        if (reminder.bookingId) {
          booking = await CampaignBookingModel.findOne({ bookingId: reminder.bookingId }).lean();
        }
        if (!booking && reminder.clientEmail) {
          booking = await CampaignBookingModel.findOne({ clientEmail: reminder.clientEmail.toLowerCase().trim() })
            .sort({ bookingCreatedAt: -1 })
            .limit(1)
            .lean();
        }
        if (booking) {
          if (booking.bookingStatus === 'canceled') {
            await ScheduledDiscordMeetReminderModel.updateOne(
              { _id: reminder._id },
              { status: 'cancelled', errorMessage: 'Cancelled: meeting canceled' }
            );
            continue;
          }
          const bookingMeetingTime = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : null;
          const reminderMeetingTime = new Date(reminder.meetingStartISO).getTime();
          if (bookingMeetingTime !== null && Math.abs(bookingMeetingTime - reminderMeetingTime) > 60000) {
            await ScheduledDiscordMeetReminderModel.updateOne(
              { _id: reminder._id },
              { status: 'cancelled', errorMessage: 'Cancelled: meeting rescheduled' }
            );
            continue;
          }
        }

        const meetingStart = new Date(reminder.meetingStartISO);
        const meetingTimeWall = formatMeetingWallTime(
          meetingStart,
          reminder.inviteeTimezone
        );

        const headline = headlineForSendTime(meetingStart);
        const messageLines = [
          headline,
          '',
          `Client: ${reminder.clientName}`,
          `Time: ${meetingTimeWall}`,
          `Link: ${reminder.meetingLink || 'Not provided'}`,
          '',
          "BDA team, confirm attendance by typing **\"I'm in.\"** Let's close this.",
        ];

        const content = messageLines.join('\n');

        await DiscordConnect(DISCORD_MEET_2MIN_WEBHOOK_URL, content, false);

        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: reminder._id, status: 'processing' },
          {
            status: 'completed',
            completedAt: new Date(),
            errorMessage: null,
          }
        );
      } catch (error) {
        console.error(
          '❌ [DiscordMeetReminder] Error processing reminder',
          candidate.reminderId,
          error.message
        );

        if (!reminder) {
          continue;
        }

        const maxA = reminder.maxAttempts ?? 3;
        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: reminder._id, status: 'processing' },
          {
            status:
              reminder.attempts >= maxA ? 'failed' : 'pending',
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
    `[DiscordMeetReminder] Poll every ${POLL_INTERVAL_MS / 1000}s | ${REMINDER_OFFSET_MINUTES} min before meeting`
  );
  console.log(
    '[DiscordMeetReminder] Tip: set DISCORD_MEET_REMINDER_PROCESS_SECRET and ping GET /sync/process-discord-meet-reminders on a 1-min external cron so reminders survive cold sleep.'
  );

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

/**
 * Cancel Discord meeting reminders for a given meeting (by start time).
 */
export async function cancelDiscordMeetRemindersForMeeting({
  meetingStartISO,
  clientEmail = null,
  clientName = null,
}) {
  try {
    if (!meetingStartISO) {
      console.warn('[DiscordMeetReminder] cancelDiscordMeetRemindersForMeeting: meetingStartISO required');
      return { success: true, cancelledCount: 0 };
    }

    const meetingStart = parseMeetingStartToDate(meetingStartISO);
    if (!meetingStart) {
      console.warn('[DiscordMeetReminder] cancelDiscordMeetRemindersForMeeting: invalid meetingStartISO', {
        meetingStartISO,
      });
      return { success: true, cancelledCount: 0 };
    }

    const t = meetingStart.getTime();
    const startOfMinute = new Date(Math.floor(t / 60000) * 60000);
    const endOfMinute = new Date(startOfMinute.getTime() + 60 * 1000);

    const baseFilter = {
      status: { $in: ['pending', 'processing'] },
      meetingStartISO: { $gte: startOfMinute, $lt: endOfMinute },
    };

    const filter = { ...baseFilter };
    if (clientEmail) {
      const escaped = String(clientEmail).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { clientEmail: new RegExp(`^${escaped}$`, 'i') },
        { clientEmail: { $in: [null, ''] } },
      ];
    }

    let updateResult = await ScheduledDiscordMeetReminderModel.updateMany(filter, {
      $set: {
        status: 'cancelled',
        errorMessage: 'Cancelled: meeting rescheduled or canceled',
      },
    });

    let cancelledCount = updateResult.modifiedCount || 0;

    if (cancelledCount === 0 && clientName && String(clientName).trim()) {
      const nameFilter = {
        ...baseFilter,
        status: { $in: ['pending', 'processing'] },
      };
      const escapedName = String(clientName).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      nameFilter.clientName = new RegExp(`^${escapedName}$`, 'i');

      const fallbackResult = await ScheduledDiscordMeetReminderModel.updateMany(nameFilter, {
        $set: {
          status: 'cancelled',
          errorMessage: 'Cancelled: meeting rescheduled or canceled (matched by client name)',
        },
      });
      cancelledCount = fallbackResult.modifiedCount || 0;
      if (cancelledCount > 0) {
        console.log('✅ [DiscordMeetReminder] Cancelled BDA reminder(s) via clientName fallback', {
          clientName,
          meetingStartISO: meetingStart.toISOString(),
          cancelledCount,
        });
      }
    }

    if (cancelledCount > 0) {
      console.log('✅ [DiscordMeetReminder] Cancelled Discord BDA meet reminder(s)', {
        meetingStartISO: meetingStart.toISOString(),
        clientEmail: clientEmail || 'any',
        clientName: clientName || 'any',
        cancelledCount,
      });
    }

    return { success: true, cancelledCount };
  } catch (error) {
    console.error('❌ [DiscordMeetReminder] Error cancelling Discord meet reminders', {
      error: error.message,
      meetingStartISO,
    });
    return { success: false, cancelledCount: 0, error: error.message };
  }
}

export default {
  scheduleDiscordMeetReminder,
  cancelDiscordMeetRemindersForMeeting,
  startDiscordMeetReminderScheduler,
  stopDiscordMeetReminderScheduler,
  processDueDiscordMeetReminders,
  parseMeetingStartToDate,
  getDiscordMeetReminderOffsetMinutes,
  buildDiscordMeetReminderId,
};

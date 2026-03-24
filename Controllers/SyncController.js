import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import {
  scheduleDiscordMeetReminder,
  processDueDiscordMeetReminders,
  getDiscordMeetReminderOffsetMinutes,
  buildDiscordMeetReminderId,
} from '../Utils/DiscordMeetReminderScheduler.js';

/**
 * Sync Discord BDA reminders: find all upcoming meetings that don't have a
 * scheduled Discord reminder in DB and create one. Call this route periodically or once to
 * backfill (e.g. for meetings booked before Discord reminders were implemented).
 *
 * GET or POST /sync/discordbdareminders
 */
export const syncDiscordBdaReminders = async (req, res) => {
  try {
    const now = new Date();
    const leadMin = getDiscordMeetReminderOffsetMinutes();
    const minMeetingStart = new Date(now.getTime() + (leadMin + 1) * 60 * 1000);

    const bookings = await CampaignBookingModel.find({
      scheduledEventStartTime: { $gte: minMeetingStart },
      bookingStatus: { $in: ['scheduled', 'completed'] },
    })
      .select('bookingId clientName clientEmail scheduledEventStartTime calendlyMeetLink inviteeTimezone')
      .lean();

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (const booking of bookings) {
      const meetingStart = new Date(booking.scheduledEventStartTime);
      const baseId = booking.bookingId || booking.clientEmail || booking.clientName || 'unknown';
      const reminderId = buildDiscordMeetReminderId(baseId, meetingStart.getTime());

      const existing = await ScheduledDiscordMeetReminderModel.findOne({ reminderId }).lean();
      if (existing) {
        skipped += 1;
        continue;
      }

      const result = await scheduleDiscordMeetReminder({
        bookingId: booking.bookingId,
        clientName: booking.clientName,
        clientEmail: booking.clientEmail,
        meetingStartISO: meetingStart,
        meetingLink: booking.calendlyMeetLink || null,
        inviteeTimezone: booking.inviteeTimezone || null,
        source: 'sync',
        metadata: {},
      });

      if (result.success && !result.existing) {
        created += 1;
      } else if (!result.success && result.error && !result.skipped) {
        errors.push({ bookingId: booking.bookingId, error: result.error });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Discord BDA reminders sync completed',
      data: {
        totalMeetings: bookings.length,
        created,
        skipped,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (error) {
    console.error('[SyncController] syncDiscordBdaReminders error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to sync Discord BDA reminders',
      error: error.message,
    });
  }
};

/**
 * Run the same processor as the in-app poller (Mongo due → Discord).
 * Use with an external cron (e.g. every 1 min) when the host sleeps between requests.
 * Optional auth: DISCORD_MEET_REMINDER_PROCESS_SECRET as ?secret=, header x-cron-secret, or JSON body.secret.
 *
 * GET or POST /sync/process-discord-meet-reminders
 */
export const processDiscordMeetRemindersHttp = async (req, res) => {
  try {
    const secret = process.env.DISCORD_MEET_REMINDER_PROCESS_SECRET;
    if (secret) {
      const provided =
        req.query?.secret ||
        req.headers['x-cron-secret'] ||
        req.body?.secret;
      if (provided !== secret) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }
    }

    await processDueDiscordMeetReminders();
    return res.status(200).json({
      success: true,
      message: 'Processed due Discord meet reminders',
    });
  } catch (error) {
    console.error('[SyncController] processDiscordMeetRemindersHttp error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process Discord meet reminders',
      error: error.message,
    });
  }
};

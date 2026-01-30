import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { scheduleDiscordMeetReminder } from '../Utils/DiscordMeetReminderScheduler.js';

/**
 * Sync Discord BDA reminders: find all upcoming meetings that don't have a 3-min
 * Discord reminder in DB and create one. Call this route periodically or once to
 * backfill (e.g. for meetings booked before Discord reminders were implemented).
 *
 * GET or POST /sync/discordbdareminders
 */
export const syncDiscordBdaReminders = async (req, res) => {
  try {
    const now = new Date();
    const minMeetingStart = new Date(now.getTime() + 4 * 60 * 1000); // meeting at least 4 min away (so 3-min reminder is in future)

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
      const reminderId = `discord_meet_3min_${baseId}_${meetingStart.getTime()}`;

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

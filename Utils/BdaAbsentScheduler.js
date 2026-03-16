import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';

dotenv.config();

const POLL_INTERVAL_MS = 60000; // 1 minute
let isRunning = false;
let pollInterval = null;

function formatIST(date) {
  if (!date) return 'N/A';
  return DateTime.fromJSDate(new Date(date))
    .setZone('Asia/Kolkata')
    .toFormat('dd MMM yyyy, hh:mm a');
}

async function sendAbsentDiscord(message) {
  const url = process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL || null;
  if (!url) return;
  await DiscordConnect(url, message, false);
}

async function pollForAbsentBDAs() {
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Find scheduled meetings that started > 5 min ago, within last 2 hours,
    // claimed by a BDA, and not canceled/rescheduled
    const meetings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['scheduled'] },
      scheduledEventStartTime: {
        $exists: true,
        $ne: null,
        $lte: fiveMinAgo,
        $gte: twoHoursAgo,
      },
    })
      .select(
        'bookingId clientName clientEmail scheduledEventStartTime scheduledEventEndTime claimedBy'
      )
      .lean();

    if (meetings.length === 0) {
      isRunning = false;
      return;
    }

    // Get all booking IDs to check for existing attendance
    const bookingIds = meetings.map((m) => m.bookingId);
    const existingAttendance = await BdaAttendanceModel.find({
      bookingId: { $in: bookingIds },
    }).lean();

    // Set of bookingIds that have any attendance record
    const attendedBookingIds = new Set(existingAttendance.map((a) => a.bookingId));

    let absentCount = 0;

    for (const meeting of meetings) {
      // Skip if any BDA has already reported attendance for this meeting
      if (attendedBookingIds.has(meeting.bookingId)) continue;

      const bdaEmail = meeting.claimedBy?.email || 'unassigned';
      const bdaName = meeting.claimedBy?.name || 'Unassigned BDA';

      // No attendance record - mark absent
      try {
        await BdaAttendanceModel.findOneAndUpdate(
          { bookingId: meeting.bookingId, bdaEmail },
          {
            $set: {
              bdaName,
              bdaEmail,
              bookingId: meeting.bookingId,
              status: 'absent',
              source: 'scheduler',
              markedAt: now,
              meetingScheduledStart: meeting.scheduledEventStartTime,
              meetingScheduledEnd: meeting.scheduledEventEndTime || null,
              discordNotified: true,
              notes: 'Auto-detected absent by server scheduler (no response 5min after start)',
            },
            $setOnInsert: {
              attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            },
          },
          { upsert: true, new: true }
        );

        const message =
          `❌ **BDA Absent (Auto-Detected)**\n` +
          `**BDA:** ${bdaName} (${bdaEmail})\n` +
          `**Client:** ${meeting.clientName}\n` +
          `**Meeting:** ${formatIST(meeting.scheduledEventStartTime)}\n` +
          `_No response received (automatic or manual) after 5 minutes of meeting start._`;

        await sendAbsentDiscord(message);
        absentCount++;
      } catch (err) {
        // Duplicate key is expected if record was just created by extension
        if (err.code !== 11000) {
          console.error(
            `[BdaAbsentScheduler] Error marking absent for ${meeting.bookingId}:`,
            err.message
          );
        }
      }
    }

    if (absentCount > 0) {
      console.log(
        `[BdaAbsentScheduler] Marked ${absentCount} BDA(s) absent out of ${meetings.length} meetings checked`
      );
    }
  } catch (error) {
    console.error('[BdaAbsentScheduler] Poll error:', error.message);
  } finally {
    isRunning = false;
  }
}

export function startBdaAbsentScheduler() {
  if (pollInterval) {
    console.warn('[BdaAbsentScheduler] Already running');
    return;
  }

  console.log(
    `[BdaAbsentScheduler] Starting BDA absent detection scheduler (poll every ${POLL_INTERVAL_MS / 1000}s)`
  );

  // Run immediately once, then on interval
  pollForAbsentBDAs();
  pollInterval = setInterval(pollForAbsentBDAs, POLL_INTERVAL_MS);
}

export function stopBdaAbsentScheduler() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
    console.log('[BdaAbsentScheduler] Stopped');
  }
}

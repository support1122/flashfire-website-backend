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

async function sendDurationDiscord(message) {
  const url = process.env.DISCORD_BDA_DURATION_WEBHOOK_URL || process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) return;
  await DiscordConnect(url, message, false);
}

// Close stale open sessions (joinedAt > 1 hour old) — safety net for Chrome crashes, force-kills, etc.
async function closeStaleOpenSessions() {
  try {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const staleSessions = await BdaAttendanceModel.find({
      joinedAt: { $ne: null, $lte: oneHourAgo },
    });

    for (const attendance of staleSessions) {
      const leaveTime = new Date();
      const segmentMs = Math.max(0, leaveTime.getTime() - new Date(attendance.joinedAt).getTime());
      attendance.cumulativeDurationMs = (attendance.cumulativeDurationMs || 0) + segmentMs;
      attendance.durationMs = attendance.cumulativeDurationMs;
      attendance.leftAt = leaveTime;
      attendance.joinedAt = null;
      attendance.notes = (attendance.notes || '') + ' [auto-closed: stale session > 1h]';
      await attendance.save();

      const durationMin = Math.round(attendance.cumulativeDurationMs / 60000);
      const booking = await CampaignBookingModel.findOne({ bookingId: attendance.bookingId }).lean();

      const message =
        `🚪 **BDA Left Meeting** _(auto-closed)_\n` +
        `**BDA:** ${attendance.bdaName} (${attendance.bdaEmail})\n` +
        `**Client:** ${booking?.clientName || 'Unknown'}\n` +
        `**Duration (total):** ${durationMin} min\n` +
        `**Left At:** ${formatIST(leaveTime)}\n` +
        `_Session was open for >1 hour — auto-closed by server._`;

      await sendDurationDiscord(message);
      console.log(`[BdaAbsentScheduler] Auto-closed stale session for booking ${attendance.bookingId}`);
    }
  } catch (error) {
    console.error('[BdaAbsentScheduler] closeStaleOpenSessions error:', error.message);
  }
}

export async function pollForAbsentBDAs() {
  if (isRunning) return;
  isRunning = true;

  try {
    // First: close any stale open sessions (safety net)
    await closeStaleOpenSessions();

    const now = new Date();
    const oneMinAgo = new Date(now.getTime() - 60 * 1000); // 60 seconds
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Find scheduled meetings that started > 60 seconds ago, within last 2 hours,
    // claimed by a BDA, and not canceled/rescheduled
    const meetings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['scheduled'] },
      scheduledEventStartTime: {
        $exists: true,
        $ne: null,
        $lte: oneMinAgo,
        $gte: twoHoursAgo,
      },
    })
      .select(
        'bookingId clientName clientEmail clientPhone scheduledEventStartTime scheduledEventEndTime claimedBy'
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

      const isClaimed = !!(meeting.claimedBy?.email);
      const bdaEmail = meeting.claimedBy?.email || 'unassigned';
      const bdaName = meeting.claimedBy?.name || 'Unassigned';

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
              notes: isClaimed
                ? 'Auto-detected absent by server scheduler (no response 60s after start)'
                : 'Meeting not claimed by any BDA — no one joined',
            },
            $setOnInsert: {
              attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            },
          },
          { upsert: true, new: true }
        );

        const message = isClaimed
          ? `❌ **BDA Absent (Auto-Detected)**\n` +
            `**BDA:** ${bdaName} (${bdaEmail})\n` +
            `**Client:** ${meeting.clientName} (${meeting.clientEmail || ''})\n` +
            `**Meeting:** ${formatIST(meeting.scheduledEventStartTime)}\n` +
            `_No response received (automatic or manual) after 60 seconds of meeting start._`
          : `🚨 **NO BDA ASSIGNED — Meeting Started!**\n` +
            `**Client:** ${meeting.clientName} (${meeting.clientEmail || ''})\n` +
            `**Meeting:** ${formatIST(meeting.scheduledEventStartTime)}\n` +
            `**Status:** No BDA has claimed this lead\n` +
            `_Someone needs to join this meeting NOW!_`;

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

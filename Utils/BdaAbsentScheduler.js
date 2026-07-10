import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';

dotenv.config();

const POLL_INTERVAL_MS = 60000; // 1 minute

/**
 * How long after the scheduled start we wait before flagging "no response".
 *
 * Fixed at 1 minute, deliberately not env-tunable: a stray env value silently
 * delayed these alerts in production. This is a nudge, not an absence verdict.
 * At +1 minute nobody has joined yet, so the ping is accurate and still useful
 * while the meeting is young (they run ~15 min). The row it writes is "unmarked",
 * never "absent" - a later join supersedes it, and the send is skipped outright
 * if the BDA is already marked present.
 */
const ABSENT_GRACE_MINUTES = 1;
const ABSENT_GRACE_MS = ABSENT_GRACE_MINUTES * 60 * 1000;

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
    const graceCutoff = new Date(now.getTime() - ABSENT_GRACE_MS);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    // Find scheduled meetings that started more than the grace period ago, within
    // the last 2 hours, and not canceled/rescheduled.
    const meetings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['scheduled'] },
      scheduledEventStartTime: {
        $exists: true,
        $ne: null,
        $lte: graceCutoff,
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

    const bookingIds = meetings.map((m) => m.bookingId);

    // Only an actual PRESENT mark suppresses the alert. The extension writes
    // 'present' when it detects the BDA in the Meet room; a manual CRM mark writes
    // 'manual'. An 'unmarked' row (no response / bad join URL) means nobody is in
    // the meeting, so it must NOT suppress the alert.
    const presentRows = await BdaAttendanceModel.find({
      bookingId: { $in: bookingIds },
      status: { $in: ['present', 'manual'] },
    })
      .select('bookingId')
      .lean();
    const presentBookingIds = new Set(presentRows.map((a) => a.bookingId));

    // Alert once per booking, not on every 60s poll.
    const pingedRows = await BdaAttendanceModel.find({
      bookingId: { $in: bookingIds },
      discordNotified: true,
      status: { $in: ['unmarked', 'absent'] },
    })
      .select('bookingId')
      .lean();
    const alreadyPinged = new Set(pingedRows.map((a) => a.bookingId));

    let absentCount = 0;

    for (const meeting of meetings) {
      // BDA is marked present (extension or manual), nothing to alert about.
      if (presentBookingIds.has(meeting.bookingId)) continue;

      // Already pinged for this meeting and still no present mark, don't repeat.
      if (alreadyPinged.has(meeting.bookingId)) continue;

      // Re-check immediately before alerting. A join can land between the batch
      // read above and this iteration (the extension reports asynchronously), and
      // a recorded PRESENT mark must ALWAYS win over the "no response" alert.
      const lateJoin = await BdaAttendanceModel.findOne({
        bookingId: meeting.bookingId,
        status: { $in: ['present', 'manual'] },
      })
        .select('_id status firstJoinedAt')
        .lean();
      if (lateJoin) {
        console.log(
          `[BdaAbsentScheduler] Skipping ${meeting.bookingId}: BDA marked ${lateJoin.status}`
        );
        continue;
      }

      const isClaimed = !!(meeting.claimedBy?.email);
      const bdaEmail = meeting.claimedBy?.email || 'unassigned';
      const bdaName = meeting.claimedBy?.name || 'Unassigned';

      // No attendance record — record as "unmarked", NOT "absent".
      // The BDA may have attended but forgotten to mark; only an explicit
      // mark-absent action is allowed to set status: 'absent'.
      try {
        await BdaAttendanceModel.findOneAndUpdate(
          { bookingId: meeting.bookingId, bdaEmail },
          {
            $set: {
              bdaName,
              bdaEmail,
              bookingId: meeting.bookingId,
              status: 'unmarked',
              source: 'scheduler',
              markedAt: now,
              meetingScheduledStart: meeting.scheduledEventStartTime,
              meetingScheduledEnd: meeting.scheduledEventEndTime || null,
              discordNotified: true,
              notes: isClaimed
                ? `No response captured ${ABSENT_GRACE_MINUTES}m after start — BDA must confirm present or mark absent`
                : 'Meeting not claimed by any BDA — no one joined',
            },
            $setOnInsert: {
              attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            },
          },
          { upsert: true, new: true }
        );

        const message = isClaimed
          ? `⚠️ **BDA No Response (Unmarked)**\n` +
            `**BDA:** ${bdaName} (${bdaEmail})\n` +
            `**Client:** ${meeting.clientName} (${meeting.clientEmail || ''})\n` +
            `**Meeting:** ${formatIST(meeting.scheduledEventStartTime)}\n` +
            `_No response ${ABSENT_GRACE_MINUTES}m after start. Not marked absent yet — attendance will be auto-verified from Google Meet records after the meeting._`
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
            `[BdaAbsentScheduler] Error recording unmarked attendance for ${meeting.bookingId}:`,
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
    `[BdaAbsentScheduler] Starting BDA absent detection scheduler (poll every ${POLL_INTERVAL_MS / 1000}s, ` +
      `grace ${ABSENT_GRACE_MINUTES}m after scheduled start)`
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

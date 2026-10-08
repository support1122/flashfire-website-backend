import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';

dotenv.config();

const POLL_INTERVAL_MS = 60000; // 1 minute

/**
 * How long after the scheduled start we wait before raising "NO BDA ASSIGNED".
 *
 * Fixed at 1 minute, deliberately not env-tunable: a stray env value silently delayed these alerts in production.
 * This job no longer judges BDAs. Absence is decided by the verdict job (AttendanceVerdictJob.js) from signals,
 * so the old "No Response" ping and its 'unmarked' row for assigned BDAs are gone. What stays here is the safety
 * net for stale open sessions and the alert for a meeting that nobody owns.
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
      // No leave signal ever arrived, so the real leave time is unknown. Close
      // at the scheduled end (or now, if the session started after it) instead
      // of "now": closing at poll time credited a full hour or more.
      const now = new Date();
      const joinedMs = new Date(attendance.joinedAt).getTime();
      const endMs = attendance.meetingScheduledEnd ? new Date(attendance.meetingScheduledEnd).getTime() : NaN;
      const leaveTime = Number.isFinite(endMs) && endMs > joinedMs && endMs < now.getTime()
        ? new Date(endMs)
        : now;
      const segmentMs = Math.max(0, leaveTime.getTime() - new Date(attendance.joinedAt).getTime());
      attendance.cumulativeDurationMs = (attendance.cumulativeDurationMs || 0) + segmentMs;
      attendance.durationMs = attendance.cumulativeDurationMs;
      attendance.leftAt = leaveTime;
      attendance.joinedAt = null;
      attendance.notes = (attendance.notes || '') + ' [auto-closed: no leave signal > 1h; left time estimated]';
      await attendance.save();

      const durationMin = Math.round(attendance.cumulativeDurationMs / 60000);
      const booking = await CampaignBookingModel.findOne({ bookingId: attendance.bookingId }).lean();

      const message =
        `🚪 **BDA Left Meeting** _(auto-closed)_\n` +
        `**BDA:** ${attendance.bdaName} (${attendance.bdaEmail})\n` +
        `**Client:** ${booking?.clientName || 'Unknown'}\n` +
        `**Duration (total):** ${durationMin} min\n` +
        `**Left At:** ${formatIST(leaveTime)}\n` +
        `_No leave signal for >1 hour — auto-closed by server; left time is estimated._`;

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

    // Meetings that started more than the grace period ago, in the last 2 hours, that NO ONE owns: no admin
    // reassignment, no Calendly host and no CRM claim (the same order getAssignedBdaEmail uses).
    const noOne = { $in: [null, ''] };
    const meetings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['scheduled'] },
      scheduledEventStartTime: {
        $exists: true,
        $ne: null,
        $lte: graceCutoff,
        $gte: twoHoursAgo,
      },
      'attendanceAssignee.email': noOne,
      'calendlyHost.email': noOne,
      'claimedBy.email': noOne,
    })
      .select(
        'bookingId clientName clientEmail clientPhone bookingStatus scheduledEventStartTime scheduledEventEndTime claimedBy calendlyHost attendanceAssignee googleMeetCode googleMeetUrl calendlyMeetLink'
      )
      .lean();

    if (meetings.length === 0) return;

    const bookingIds = meetings.map((m) => m.bookingId);

    // Someone joined or marked present anyway (a BDA covering an unowned meeting): nothing to raise.
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

    let alertCount = 0;

    for (const meeting of meetings) {
      if (presentBookingIds.has(meeting.bookingId)) continue;
      if (alreadyPinged.has(meeting.bookingId)) continue;

      // The row marks "already alerted" and carries bdaEmail 'unassigned'. It is never anyone's attendance.
      try {
        await BdaAttendanceModel.findOneAndUpdate(
          { bookingId: meeting.bookingId, bdaEmail: 'unassigned' },
          {
            $set: {
              bdaName: 'Unassigned',
              bdaEmail: 'unassigned',
              bookingId: meeting.bookingId,
              status: 'unmarked',
              source: 'scheduler',
              markedAt: now,
              meetingScheduledStart: meeting.scheduledEventStartTime,
              meetingScheduledEnd: meeting.scheduledEventEndTime || null,
              discordNotified: true,
              notes: 'Meeting not claimed by any BDA, no one joined',
            },
            $setOnInsert: {
              attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            },
          },
          { upsert: true, new: true }
        );

        await sendAbsentDiscord(
          `🚨 **NO BDA ASSIGNED: Meeting Started!**\n` +
            `**Client:** ${meeting.clientName} (${meeting.clientEmail || ''})\n` +
            `**Meeting:** ${formatIST(meeting.scheduledEventStartTime)}\n` +
            `**Status:** No BDA has claimed this lead\n` +
            `_Someone needs to join this meeting NOW!_`
        );
        alertCount++;
      } catch (err) {
        // Duplicate key is expected if two instances raced
        if (err.code !== 11000) {
          console.error(`[BdaAbsentScheduler] Error raising unassigned alert for ${meeting.bookingId}:`, err.message);
        }
      }
    }

    if (alertCount > 0) {
      console.log(`[BdaAbsentScheduler] Raised ${alertCount} unassigned-meeting alert(s) out of ${meetings.length} checked`);
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
    `[BdaAbsentScheduler] Starting stale-session and unassigned-meeting checks (poll every ${POLL_INTERVAL_MS / 1000}s, ` +
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

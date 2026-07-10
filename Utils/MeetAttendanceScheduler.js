import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';
import {
  extractMeetCode,
  findConferenceRecords,
  hasMeetApiCredentials,
  listParticipantsWithSessions,
  mergeParticipants,
  resolveCalendlyMeetUrl,
  resolveUserEmail,
} from './MeetApiHelper.js';

dotenv.config();

// ---------------------------------------------------------------------------
// Meet-API attendance worker.
//
// Source of truth for BDA attendance: Google's own conference records, read
// server-side via the Meet REST API (see MeetApiHelper.js). The Chrome
// extension's DOM detection keeps running as a FALLBACK; wherever both wrote
// data, the API values win (they come from Google's servers, not the DOM).
//
// Per booking inside its live window we:
//   1. find the conference record for the booking's meet code,
//   2. list participants + sessions,
//   3. identify the assigned BDA (resolved email first, display name second),
//   4. upsert timing onto BdaAttendance: firstJoinedAt, lateByMs, sessions,
//      who was already in the call at the BDA's join,
//   5. once the conference has ended: authoritative durationMs, leftAt, and
//      final present/absent status.
//
// Present rule: any BDA session overlaps
//   [scheduledStart - PRESENCE_BUFFER, scheduledEnd + PRESENCE_BUFFER].
// Auto-absent ONLY when a conference actually happened (record exists),
// ended, no participant matched the BDA, and the extension fallback did not
// already prove presence. If the extension marked present but the API cannot
// identify the BDA (e.g. they joined signed-out), presence is kept.
//
// Discord notifications are intentionally NOT sent from here — the existing
// extension/scheduler flows own those and stay unchanged.
// ---------------------------------------------------------------------------

const PRESENCE_BUFFER_MS = 60 * 1000;           // ±1 min around the scheduled window
const WINDOW_LEAD_MS = 60 * 1000;               // start polling 1 min before start
const WINDOW_GRACE_MS = 30 * 60 * 1000;         // keep polling 30 min after scheduled end
const DEFAULT_MEETING_MS = 60 * 60 * 1000;      // window when scheduledEnd is missing
const MAX_SESSION_MS = 6 * 60 * 60 * 1000;      // sanity clamp per session

let isRunning = false;
let disabledLogged = false;
let credsWarned = false;

function formatIST(date) {
  if (!date) return 'N/A';
  return DateTime.fromJSDate(new Date(date))
    .setZone('Asia/Kolkata')
    .toFormat('dd MMM yyyy, hh:mm a');
}

// One summary message per booking, sent at finalization. Live join/leave
// pings still come from the extension flow — this is the authoritative recap.
async function sendVerifiedDiscord(message) {
  const url = process.env.DISCORD_BDA_DURATION_WEBHOOK_URL || process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) return;
  try {
    await DiscordConnect(url, message, false);
  } catch (e) {
    console.error('[MeetAttendance] Discord send failed:', e?.message);
  }
}

async function sendAbsentDiscord(message) {
  const url = process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL || null;
  if (!url) return;
  try {
    await DiscordConnect(url, message, false);
  } catch (e) {
    console.error('[MeetAttendance] Discord send failed:', e?.message);
  }
}

function punctualityLabel(lateByMs) {
  if (lateByMs == null) return null;
  if (lateByMs > 60 * 1000) return `${Math.round(lateByMs / 60000)} min late`;
  if (lateByMs < -60 * 1000) return `${Math.round(-lateByMs / 60000)} min early`;
  return 'on time';
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function normName(n) {
  return String(n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Match the assigned BDA among conference participants. */
async function findBdaParticipant({ participants, hostEmail, expectedNames }) {
  // 1. Email match via Directory resolution of signed-in users.
  for (const p of participants) {
    if (!p.userId) continue;
    const email = await resolveUserEmail({ hostEmail, userId: p.userId });
    p.resolvedEmail = email;
    if (email && email === hostEmail) return p;
  }
  // 2. Display-name match (covers Directory lookup failures).
  const wanted = expectedNames.map(normName).filter(Boolean);
  if (wanted.length > 0) {
    const byName = participants.find((p) => wanted.includes(normName(p.displayName)));
    if (byName) return byName;
  }
  return null;
}

function sumSessions(sessions, now) {
  let total = 0;
  for (const s of sessions) {
    if (!s.startTime) continue;
    const end = s.endTime || now; // open session counts up to "now"
    const ms = Math.min(Math.max(0, end - s.startTime), MAX_SESSION_MS);
    total += ms;
  }
  return total;
}

function overlapsWindow(sessions, windowStart, windowEnd, now) {
  return sessions.some((s) => {
    if (!s.startTime) return false;
    const end = s.endTime || now;
    return s.startTime <= windowEnd && end >= windowStart;
  });
}

/**
 * Get the booking's Meet code. Bookings created from Calendly webhooks often
 * carry only the "calendly.com/events/{id}/google_meet" join URL — the real
 * meet.google.com link is behind its 302 redirect. Resolve it once and cache
 * the code back onto the booking so every later poll is free.
 *
 * Exported: the Calendly webhook and getMyMeetings also call this so bookings
 * carry a real meet code BEFORE the meeting — the extension's tab matching
 * (and therefore live join detection at the true join moment) depends on it.
 */
export async function resolveBookingMeetCode(booking) {
  const direct = extractMeetCode(
    booking.googleMeetCode || booking.googleMeetUrl || booking.calendlyMeetLink
  );
  if (direct) return direct;

  const meetUrl = await resolveCalendlyMeetUrl(booking.calendlyMeetLink);
  const code = extractMeetCode(meetUrl);
  if (!code) return null;

  await CampaignBookingModel.updateOne(
    { bookingId: booking.bookingId },
    { $set: { googleMeetCode: code, googleMeetUrl: `https://meet.google.com/${code}` } }
  );
  console.log(`[MeetAttendance] Resolved meet code ${code} for ${booking.bookingId} via Calendly redirect`);
  return code;
}

/** Others already in the call at the BDA's first join. */
function rosterAtJoin(participants, bdaParticipant, bdaJoin) {
  if (!bdaJoin) return [];
  return participants
    .filter((p) => p !== bdaParticipant)
    .filter((p) =>
      p.sessions.some(
        (s) => s.startTime && s.startTime <= bdaJoin && (!s.endTime || s.endTime > bdaJoin)
      )
    )
    .map((p) => ({ displayName: p.displayName || 'Unknown', kind: p.kind }));
}

export async function processBooking(booking, now) {
  const scheduledStart = new Date(booking.scheduledEventStartTime);
  const scheduledEnd = booking.scheduledEventEndTime
    ? new Date(booking.scheduledEventEndTime)
    : new Date(scheduledStart.getTime() + DEFAULT_MEETING_MS);

  const hostEmail = normEmail(booking.calendlyHost?.email || booking.claimedBy?.email);
  if (!hostEmail) return; // absent scheduler already alerts unassigned meetings

  // Skip if already finalized from the API (check before the Calendly
  // redirect so finalized bookings cost nothing).
  const existing = await BdaAttendanceModel.findOne({
    bookingId: booking.bookingId,
    bdaEmail: hostEmail,
  });
  if (existing?.meetApiFinalizedAt) return;

  const meetCode = await resolveBookingMeetCode(booking);
  if (!meetCode) return;

  // One booking can span SEVERAL conference records on the same code
  // ("end call for everyone" + rejoin starts a new record) — take them all
  // and merge each person's sessions across records.
  const records = await findConferenceRecords({
    hostEmail,
    meetCode,
    scheduledStart,
    windowEnd: new Date(scheduledEnd.getTime() + WINDOW_GRACE_MS),
  });
  if (records.length === 0) return; // no conference on this code yet

  const perRecord = [];
  for (const r of records) {
    perRecord.push(
      ...(await listParticipantsWithSessions({
        hostEmail,
        conferenceRecordName: r.name,
      }))
    );
  }
  const participants = mergeParticipants(perRecord);
  if (participants.length === 0) return;

  const record = records[records.length - 1]; // latest — drives ended/reference

  const expectedNames = [
    booking.calendlyHost?.name,
    booking.claimedBy?.name,
  ].filter(Boolean);

  const bda = await findBdaParticipant({ participants, hostEmail, expectedNames });

  // Finalize only when every record has ended AND the scheduled slot is over
  // (an early "ended" mid-slot could miss a rejoin that starts a new record),
  // or unconditionally once the grace window is exhausted.
  const allEnded = records.every((r) => Boolean(r.endTime));
  const pastGrace = now.getTime() > scheduledEnd.getTime() + WINDOW_GRACE_MS;
  const finalize = (allEnded && now.getTime() > scheduledEnd.getTime()) || pastGrace;

  const windowStart = new Date(scheduledStart.getTime() - PRESENCE_BUFFER_MS);
  const windowEnd = new Date(scheduledEnd.getTime() + PRESENCE_BUFFER_MS);

  const base = {
    bdaName: booking.calendlyHost?.name || booking.claimedBy?.name || hostEmail,
    bdaEmail: hostEmail,
    bookingId: booking.bookingId,
    meetLink: booking.googleMeetUrl || booking.calendlyMeetLink || null,
    meetingScheduledStart: scheduledStart,
    meetingScheduledEnd: booking.scheduledEventEndTime || null,
    conferenceRecordName: record.name,
    meetApiSyncedAt: now,
  };

  if (bda) {
    const firstJoin = bda.earliestStartTime;
    const present = overlapsWindow(bda.sessions, windowStart, windowEnd, now);
    const durationMs = sumSessions(bda.sessions, now);

    const set = {
      ...base,
      firstJoinedAt: firstJoin,
      lateByMs: firstJoin ? firstJoin.getTime() - scheduledStart.getTime() : null,
      sessions: bda.sessions.map((s) => ({
        startTime: s.startTime,
        endTime: s.endTime,
        durationMs: s.startTime
          ? Math.min(Math.max(0, (s.endTime || now) - s.startTime), MAX_SESSION_MS)
          : 0,
      })),
      participantsAtJoin: rosterAtJoin(participants, bda, firstJoin),
      source: 'meet_api',
    };

    if (present && (!existing || !['manual', 'absent'].includes(existing.status))) {
      set.status = 'present';
    }

    if (finalize) {
      set.durationMs = durationMs;
      set.leftAt = bda.latestEndTime || null;
      set.meetApiFinalizedAt = now;
      // Never auto-absent a canceled booking — skipping a canceled meeting
      // is correct behavior, not an absence.
      if (
        !present &&
        booking.bookingStatus !== 'canceled' &&
        (!existing || !['present', 'manual'].includes(existing.status))
      ) {
        set.status = 'absent';
        set.notes = `${existing?.notes || ''} [meet_api: joined outside the ±1 min window]`.trim();
        // We post the verified-absent message below; flag the row so the
        // absent-poller treats it as already announced and never double-alerts.
        set.discordNotified = true;
      }
    }

    // status is required on insert — default to present-window verdict.
    if (!set.status && !existing) set.status = present ? 'present' : 'unmarked';

    await BdaAttendanceModel.findOneAndUpdate(
      { bookingId: booking.bookingId, bdaEmail: hostEmail },
      {
        $set: set,
        $setOnInsert: {
          attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          markedAt: now,
        },
      },
      { upsert: true, new: true }
    );

    // Authoritative recap once per booking, after the final numbers are stored.
    if (finalize) {
      const late = punctualityLabel(set.lateByMs);
      const roster = (set.participantsAtJoin || []).map((p) => p.displayName).join(', ');
      if (set.status === 'absent') {
        await sendAbsentDiscord(
          `🚫 **BDA Absent — verified from Google Meet records**\n` +
          `**BDA:** ${set.bdaName} (${hostEmail})\n` +
          `**Client:** ${booking.clientName || 'Unknown'}\n` +
          `**Meeting:** ${formatIST(scheduledStart)}\n` +
          `_BDA joined the call, but outside the allowed window (scheduled time ±1 min)._`
        );
      } else {
        await sendVerifiedDiscord(
          `📋 **Attendance Verified — Google Meet records**\n` +
          `**BDA:** ${set.bdaName} (${hostEmail})\n` +
          `**Client:** ${booking.clientName || 'Unknown'}\n` +
          `**In:** ${formatIST(firstJoin)}${late ? ` (${late})` : ''}\n` +
          `**Out:** ${formatIST(set.leftAt)}\n` +
          `**Duration (total):** ${Math.round((set.durationMs || 0) / 60000)} min\n` +
          `**In call when BDA joined:** ${roster || 'nobody (BDA was first)'}`
        );
      }
    }
    return;
  }

  // BDA not identified among participants.
  if (finalize) {
    // Canceled booking + BDA not in the call = correct behavior, not absence.
    if (booking.bookingStatus === 'canceled') return;
    // Conference happened and ended without the BDA — real absence, unless the
    // extension fallback proved presence (identity match can fail if the BDA
    // joined signed-out; the DOM detection is authoritative for "was there").
    if (existing && ['present', 'manual'].includes(existing.status)) {
      await BdaAttendanceModel.updateOne(
        { _id: existing._id },
        {
          $set: {
            conferenceRecordName: record.name,
            meetApiSyncedAt: now,
            meetApiFinalizedAt: now,
            notes: `${existing.notes || ''} [meet_api: could not identify BDA among ${participants.length} participants — extension presence kept]`.trim(),
          },
        }
      );
      return;
    }

    await BdaAttendanceModel.findOneAndUpdate(
      { bookingId: booking.bookingId, bdaEmail: hostEmail },
      {
        $set: {
          ...base,
          status: 'absent',
          source: 'meet_api',
          participantsAtJoin: participants.map((p) => ({
            displayName: p.displayName || 'Unknown',
            kind: p.kind,
          })),
          meetApiFinalizedAt: now,
          notes: `Conference happened (${participants.length} participant(s)) but the assigned BDA never joined — marked absent from Google Meet records`,
        },
        $setOnInsert: {
          attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          markedAt: now,
        },
      },
      { upsert: true, new: true }
    );

    const whoWasThere = participants.map((p) => p.displayName || 'Unknown').join(', ');
    await sendAbsentDiscord(
      `🚫 **BDA Absent — verified from Google Meet records**\n` +
      `**BDA:** ${base.bdaName} (${hostEmail})\n` +
      `**Client:** ${booking.clientName || 'Unknown'}\n` +
      `**Meeting:** ${formatIST(scheduledStart)}\n` +
      `**Who was in the call:** ${whoWasThere}\n` +
      `_The meeting ran, but the assigned BDA never joined._`
    );
  }
}

export async function pollMeetApiAttendance() {
  if (process.env.MEET_API_ATTENDANCE_ENABLED !== 'true') {
    if (!disabledLogged) {
      console.log('[MeetAttendance] Disabled (set MEET_API_ATTENDANCE_ENABLED=true after DWD setup)');
      disabledLogged = true;
    }
    return;
  }
  if (!hasMeetApiCredentials()) {
    if (!credsWarned) {
      console.warn('[MeetAttendance] No Google credentials (GOOGLE_SERVICE_ACCOUNT_KEY_FILE or GOOGLE_CLIENT_EMAIL/GOOGLE_PRIVATE_KEY) — skipping');
      credsWarned = true;
    }
    return;
  }
  if (isRunning) return;
  isRunning = true;

  try {
    const now = new Date();
    // Live window: from 1 min before start until 30 min past scheduled end
    // (bounded below by a 3 h lookback so long-dead bookings are never scanned).
    const lookback = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const lead = new Date(now.getTime() + WINDOW_LEAD_MS);

    // 'canceled' included on purpose: a Calendly reschedule/cancel can land
    // after the meeting already happened on that link — attendance still
    // counts. Canceled bookings are present-only (never auto-absent, see
    // processBooking) since not joining a canceled meeting is correct.
    const bookings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['scheduled', 'completed', 'canceled'] },
      scheduledEventStartTime: { $gte: lookback, $lte: lead },
    })
      .select(
        'bookingId clientName bookingStatus scheduledEventStartTime scheduledEventEndTime googleMeetCode googleMeetUrl calendlyMeetLink calendlyHost claimedBy'
      )
      .lean();

    for (const booking of bookings) {
      try {
        await processBooking(booking, now);
      } catch (err) {
        // 403 here means DWD scopes not authorized yet — actionable, so say so.
        const status = err?.response?.status || err?.code;
        const hint = status === 403 ? ' (DWD scopes not authorized in Admin console?)' : '';
        console.error(
          `[MeetAttendance] ${booking.bookingId} failed: ${err?.message}${hint}`
        );
      }
    }
  } catch (error) {
    console.error('[MeetAttendance] Poll error:', error.message);
  } finally {
    isRunning = false;
  }
}

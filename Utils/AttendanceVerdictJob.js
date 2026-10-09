import { DateTime } from 'luxon';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaAttendanceWarnDedupeModel } from '../Schema_Models/BdaAttendanceWarnDedupe.js';
import { BdaExtensionHeartbeatModel } from '../Schema_Models/BdaExtensionHeartbeat.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { EVENTS, emitAttendanceEvent } from './attendanceEvents.js';
import { postAbsentChannel, postAdminChannel, postAttendanceChannel } from './attendanceDiscord.js';
import { countableReason, getAssignedBdaEmail, istDate } from './BdaAssignment.js';
import { getBdaProfile, getTrackedBdas } from './BdaRegistry.js';
import { SYNC_LIMITS_MS, getAllSyncHealth, recordSyncError, recordSyncOk, syncOkBetween, wasSourceHealthy } from './SyncHealth.js';
import { WINDOW_CLOSES_AFTER_MS, VERDICT_SETTLE_MS, countedSignals, formatIstTime } from './recordPresentSignal.js';

// The server decides who was present (plan 2.2, 5.4). One job, several steps on different clocks:
//   every 15 s  verdicts for meetings whose window closed 90 s ago
//   every 60 s  "your extension is offline" warning 9 to 11 minutes before a meeting
//   every 5 min integrity check (button without a join) and sync-health alerts
//   daily 18:00 IST  meetings tomorrow whose BDA is on leave
// Every step is a function of (now, deps), so tests run it with a fake clock, poster and Meet verifier.

const VERDICT_EVERY_MS = 15 * 1000;
const HEARTBEAT_ALERT_EVERY_MS = 60 * 1000;
const SLOW_STEPS_EVERY_MS = 5 * 60 * 1000;

const VERDICT_DELAY_MS = WINDOW_CLOSES_AFTER_MS + VERDICT_SETTLE_MS; // 90 s after start
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const JOB_HEALTH_DEADLINE_MS = 5 * 60 * 1000; // plan 2.7: the job must have run by start + 5 min
const INTEGRITY_AFTER_MS = 3 * 60 * 60 * 1000;
const INTEGRITY_LOOKBACK_MS = 72 * 60 * 60 * 1000;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_ALERT_MIN_MS = 9 * 60 * 1000;
const HEARTBEAT_ALERT_MAX_MS = 11 * 60 * 1000;
const REASSIGN_POST_HOUR_IST = 18;
const WORKING_HOURS_IST = { from: 8, to: 22 };
const SYNC_REALERT_MS = 60 * 60 * 1000;

const BUTTON_KINDS = ['button_meet', 'button_crm'];
const ASSIGNED_ANYONE = [
  { 'attendanceAssignee.email': { $nin: [null, ''] } },
  { 'calendlyHost.email': { $nin: [null, ''] } },
  { 'claimedBy.email': { $nin: [null, ''] } },
];

const BOOKING_FIELDS =
  'bookingId clientName clientEmail bookingStatus statusHistory scheduledEventStartTime scheduledEventEndTime googleMeetCode googleMeetUrl calendlyMeetLink calendlyHost claimedBy attendanceAssignee';

const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

function buildDeps(deps = {}) {
  return {
    poster: postAbsentChannel,
    adminPoster: postAdminChannel,
    attendancePoster: postAttendanceChannel,
    meetVerifier: async (booking) => {
      const { syncBookingFromMeetNow } = await import('./MeetAttendanceScheduler.js');
      return syncBookingFromMeetNow(booking);
    },
    getHeartbeat: async (email) => BdaExtensionHeartbeatModel.findOne({ bdaEmail: email }).lean(),
    bookingFilter: {}, // tests narrow every query to their own bookings
    ...deps,
    registry: { getBdaProfile, ...(deps.registry || {}) },
    health: { recordSyncOk, recordSyncError, wasSourceHealthy, syncOkBetween, getAllSyncHealth, ...(deps.health || {}) },
  };
}

function withFilter(base, deps) {
  return deps.bookingFilter && Object.keys(deps.bookingFilter).length ? { $and: [base, deps.bookingFilter] } : base;
}

async function safePost(poster, message, label) {
  try {
    const ok = await poster(message);
    if (ok === false) console.warn(`[AttendanceVerdict] ${label} post did not go out (no webhook or Discord refused)`);
    return ok !== false;
  } catch (err) {
    console.error(`[AttendanceVerdict] ${label} post failed:`, err?.message || err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * Was every source this verdict rests on healthy (plan 2.7)? False tells the deduction engine to create
 * needs_review instead of active. Healthy needs both:
 *   - the verdict job ran between start + 60 s and start + 5 min (this pass is that run when it is on time)
 *   - Google's sync was no older than 10 min at verdict time, unless the BDA's extension sent a heartbeat
 */
export async function computeVerdictHealth({ startMs, nowMs, bdaEmail }, deps) {
  const jobOk =
    nowMs <= startMs + JOB_HEALTH_DEADLINE_MS ||
    (await deps.health.syncOkBetween('verdict_job', startMs + WINDOW_CLOSES_AFTER_MS, startMs + JOB_HEALTH_DEADLINE_MS));
  if (!jobOk) return false;

  const googleOk = await deps.health.wasSourceHealthy('google_meet', {
    fromMs: nowMs,
    toMs: nowMs,
    maxAgeMs: SYNC_LIMITS_MS.google_meet,
  });
  if (googleOk) return true;

  const beat = await deps.getHeartbeat(bdaEmail);
  return Boolean(beat?.lastHeartbeatAt && toMs(beat.lastHeartbeatAt) >= startMs - 5 * 60 * 1000);
}

/**
 * Write the verdict for every countable meeting whose window closed at least 90 s ago and has none yet.
 * Returns { checked, verdicts: [{ bookingId, bdaEmail, verdict }] } for the verdicts THIS call wrote.
 */
export async function runVerdictPass(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);

  const bookings = await CampaignBookingModel.find(
    withFilter(
      {
        scheduledEventStartTime: { $gte: new Date(nowMs - LOOKBACK_MS), $lte: new Date(nowMs - VERDICT_DELAY_MS) },
        $or: ASSIGNED_ANYONE,
      },
      d
    )
  )
    .select(BOOKING_FIELDS)
    .lean();
  if (bookings.length === 0) return { checked: 0, verdicts: [] };

  const judged = await BdaAttendanceModel.find({
    bookingId: { $in: bookings.map((b) => b.bookingId) },
    verdict: { $ne: null },
  })
    .select('bookingId bdaEmail')
    .lean();
  const done = new Set(judged.map((r) => `${r.bookingId}|${r.bdaEmail}`));

  const verdicts = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    if (!bdaEmail || done.has(`${booking.bookingId}|${bdaEmail}`)) continue;

    const profile = await d.registry.getBdaProfile(bdaEmail);
    // Leave days, untracked BDAs and meetings canceled before they started get no verdict and no message.
    if (!countableReason(booking, profile, nowMs).countable) continue;

    const written = await writeVerdict({ booking, bdaEmail, profile, nowMs, now: new Date(nowMs) }, d);
    if (written) verdicts.push(written);
  }
  return { checked: bookings.length, verdicts };
}

async function writeVerdict({ booking, bdaEmail, profile, nowMs, now }, d) {
  const startMs = toMs(booking.scheduledEventStartTime);

  // One live Google check per meeting, then judge from what is stored. The verifier never throws, but a fake might.
  try {
    await d.meetVerifier(booking);
  } catch (err) {
    console.warn(`[AttendanceVerdict] live Meet check failed for ${booking.bookingId}: ${err?.message}`);
  }

  const row = await BdaAttendanceModel.findOne({ bookingId: booking.bookingId, bdaEmail }).lean();
  if (row?.verdict) return null; // an overlapping pass or another instance got there first

  const counted = countedSignals(row?.signals, startMs);
  const verdict = counted.length > 0 ? 'present' : 'absent';
  const verdictSignal = counted[0]?.kind ?? null;

  const base = { bookingId: booking.bookingId, bdaEmail, verdict: null };
  const update = { $set: { verdict, verdictAt: now, verdictSignal } };
  if (!row) {
    update.$setOnInsert = {
      attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      bdaName: profile?.displayName || booking.calendlyHost?.name || bdaEmail.split('@')[0],
      // 'unmarked' keeps legacy readers from treating a verdict row as a recorded presence or absence.
      status: 'unmarked',
      source: 'scheduler',
      markedAt: now,
      meetingScheduledStart: booking.scheduledEventStartTime,
      meetingScheduledEnd: booking.scheduledEventEndTime || null,
      meetLink: booking.googleMeetUrl || booking.calendlyMeetLink || null,
      notes: 'Verdict written by the attendance verdict job',
    };
  }

  // Conditional on verdict: null so two instances can never both write (and never both post).
  let won = false;
  try {
    const res = await BdaAttendanceModel.updateOne(base, update, { upsert: !row });
    won = (res.modifiedCount ?? 0) > 0 || (res.upsertedCount ?? 0) > 0;
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
  if (!won) return null;

  const healthy = await computeVerdictHealth({ startMs, nowMs, bdaEmail }, d);

  if (verdict === 'absent') {
    const who = profile?.displayName || row?.bdaName || bdaEmail;
    // Posted at start + 90 s, the moment the verdict is written. Google's own confirmation ("verified from Google
    // Meet records") follows from MeetAttendanceScheduler once its data is settled.
    const roster = (row?.participantsAtJoin || []).map((p) => p.displayName).filter(Boolean).join(', ');
    // The fine line only appears when fines are really on, so the channel never promises a deduction that is off.
    const finesLive = String(process.env.DEDUCTIONS_MODE || '').trim().toLowerCase() === 'live';
    await safePost(
      d.poster,
      `🚫 **BDA Absent**\n` +
        `**BDA:** ${who} (${bdaEmail})\n` +
        `**Client:** ${booking.clientName || 'the client'}\n` +
        `**Meeting:** ${DateTime.fromMillis(startMs, { zone: 'Asia/Kolkata' }).toFormat('dd MMM yyyy, hh:mm a')}\n` +
        `**Not marked present by:** ${formatIstTime(startMs + WINDOW_CLOSES_AFTER_MS)}\n` +
        (roster ? `**Who was in the call:** ${roster}\n` : '') +
        `_No present signal arrived in time. Google Meet records will confirm shortly._` +
        (finesLive ? ' A fine applies per policy.' : ''),
      'absent'
    );
  }

  emitAttendanceEvent(EVENTS.VERDICT, {
    bookingId: booking.bookingId,
    bdaEmail,
    verdict,
    verdictAt: now,
    scheduledStart: new Date(startMs),
    signals: (row?.signals || []).map((s) => ({ kind: s.kind, eventAt: s.eventAt, receivedAt: s.receivedAt })),
    healthy,
  });
  return { bookingId: booking.bookingId, bdaEmail, verdict, healthy };
}

// ---------------------------------------------------------------------------
// Integrity: a button with no join behind it
// ---------------------------------------------------------------------------

/** True when something other than a button saw the BDA in the call. */
function hasJoinEvidence(row) {
  if ((row.signals || []).some((s) => s.kind === 'extension_join' || s.kind === 'google_meet')) return true;
  if (row.firstJoinedAt && (row.source === 'auto' || (row.source === 'meet_api' && row.matchedBy === 'stable_id'))) return true;
  return false;
}

/**
 * A present verdict that rests on a button, with no Google stable-ID join and no extension join three hours after
 * the meeting started, goes on the admin review list (plan 2.2). It is never fined automatically (decision D10).
 */
export async function runIntegrityCheck(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const query = {
    verdict: 'present',
    verdictSignal: { $in: BUTTON_KINDS },
    integrityFlag: null,
    'integrityResolved.at': null,
    meetingScheduledStart: { $lte: new Date(nowMs - INTEGRITY_AFTER_MS), $gte: new Date(nowMs - INTEGRITY_LOOKBACK_MS) },
  };
  // Tests narrow to their own bookings; attendance rows carry the same bookingId.
  if (d.bookingFilter?.bookingId) query.bookingId = d.bookingFilter.bookingId;
  const rows = await BdaAttendanceModel.find(query).lean();

  const flagged = [];
  for (const row of rows) {
    if (hasJoinEvidence(row)) continue;
    const res = await BdaAttendanceModel.updateOne({ _id: row._id, integrityFlag: null }, { $set: { integrityFlag: 'marked_never_joined' } });
    if ((res.modifiedCount ?? 0) === 0) continue;
    flagged.push({ bookingId: row.bookingId, bdaEmail: row.bdaEmail });
    emitAttendanceEvent(EVENTS.INTEGRITY_FLAGGED, {
      bookingId: row.bookingId,
      bdaEmail: row.bdaEmail,
      flaggedAt: new Date(nowMs),
      signal: row.verdictSignal,
    });
  }
  return { flagged };
}

// ---------------------------------------------------------------------------
// Heartbeat alert
// ---------------------------------------------------------------------------

/** 9 to 11 minutes before a countable meeting, warn once when the assigned BDA's extension has gone quiet. */
export async function runHeartbeatAlert(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const bookings = await CampaignBookingModel.find(
    withFilter(
      {
        scheduledEventStartTime: {
          $gte: new Date(nowMs + HEARTBEAT_ALERT_MIN_MS),
          $lte: new Date(nowMs + HEARTBEAT_ALERT_MAX_MS),
        },
        $or: ASSIGNED_ANYONE,
      },
      d
    )
  )
    .select(BOOKING_FIELDS)
    .lean();

  const warned = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    const profile = bdaEmail ? await d.registry.getBdaProfile(bdaEmail) : null;
    if (!bdaEmail || !countableReason(booking, profile, nowMs).countable) continue;

    const beat = await d.getHeartbeat(bdaEmail);
    if (beat?.lastHeartbeatAt && nowMs - toMs(beat.lastHeartbeatAt) <= HEARTBEAT_STALE_MS) continue;

    // Claim the warning on the attendance row (creating a placeholder if needed). Only the claimer posts.
    try {
      const res = await BdaAttendanceModel.updateOne(
        { bookingId: booking.bookingId, bdaEmail, heartbeatWarnedAt: null },
        {
          $set: { heartbeatWarnedAt: new Date(nowMs) },
          $setOnInsert: {
            attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
            bdaName: profile?.displayName || bdaEmail.split('@')[0],
            status: 'unmarked',
            source: 'scheduler',
            markedAt: new Date(nowMs),
            meetingScheduledStart: booking.scheduledEventStartTime,
            meetingScheduledEnd: booking.scheduledEventEndTime || null,
          },
        },
        { upsert: true }
      );
      if ((res.modifiedCount ?? 0) === 0 && (res.upsertedCount ?? 0) === 0) continue;
    } catch (err) {
      if (err?.code === 11000) continue; // already warned
      throw err;
    }

    const mention = profile?.discordUserId ? `<@${profile.discordUserId}>` : `**${profile?.displayName || bdaEmail}**`;
    await safePost(
      d.attendancePoster,
      `${mention} your attendance extension is offline. Open Chrome with your work profile before your ${formatIstTime(booking.scheduledEventStartTime)} meeting.`,
      'heartbeat'
    );
    warned.push({ bookingId: booking.bookingId, bdaEmail });
  }
  return { warned };
}

// ---------------------------------------------------------------------------
// Needs reassignment (leave days), daily at 18:00 IST
// ---------------------------------------------------------------------------

/** Meetings starting on `istDay` ('YYYY-MM-DD') whose assigned BDA has that day in leaveDays. */
export async function findMeetingsOnLeave({ fromMs, untilMs, deps }) {
  const d = buildDeps(deps);
  const bookings = await CampaignBookingModel.find(
    withFilter({ scheduledEventStartTime: { $gte: new Date(fromMs), $lt: new Date(untilMs) }, $or: ASSIGNED_ANYONE }, d)
  )
    .select(BOOKING_FIELDS)
    .sort({ scheduledEventStartTime: 1 })
    .limit(500)
    .lean();

  const out = [];
  for (const booking of bookings) {
    const bdaEmail = getAssignedBdaEmail(booking);
    const profile = bdaEmail ? await d.registry.getBdaProfile(bdaEmail) : null;
    if (!profile || profile.active === false || profile.tracked !== true) continue;
    const startMs = toMs(booking.scheduledEventStartTime);
    if (!(profile.leaveDays || []).includes(istDate(startMs))) continue;
    if (['canceled', 'rescheduled', 'not-scheduled'].includes(booking.bookingStatus)) continue;
    out.push({ booking, bdaEmail, profile });
  }
  return out;
}

/** Post tomorrow's leave-day meetings to the admin channel. Each meeting is announced once, even across restarts. */
export async function runNeedsReassignmentPost(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const tomorrow = DateTime.fromMillis(toMs(now), { zone: 'Asia/Kolkata' }).plus({ days: 1 }).startOf('day');
  const items = await findMeetingsOnLeave({
    fromMs: tomorrow.toMillis(),
    untilMs: tomorrow.plus({ days: 1 }).toMillis(),
    deps,
  });

  const fresh = [];
  for (const item of items) {
    try {
      await BdaAttendanceWarnDedupeModel.create({
        bookingId: `needs_reassignment:${item.booking.bookingId}`,
        bdaEmail: item.bdaEmail,
        sentAt: new Date(toMs(now)),
      });
      fresh.push(item);
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  if (fresh.length > 0) {
    const lines = fresh.map(
      (i) => `- ${formatIstTime(i.booking.scheduledEventStartTime)} ${i.booking.clientName || 'client'}: ${i.profile.displayName || i.bdaEmail} is on leave`
    );
    await safePost(
      d.adminPoster,
      `📋 **Needs a new BDA tomorrow (${tomorrow.toFormat('dd LLL')}):**\n${lines.join('\n')}\nReassign each one in the CRM before the mark window opens.`,
      'needs-reassignment'
    );
  }
  return { posted: fresh.map((i) => ({ bookingId: i.booking.bookingId, bdaEmail: i.bdaEmail })) };
}

// ---------------------------------------------------------------------------
// Sync health alerts
// ---------------------------------------------------------------------------

const alertState = new Map(); // source -> last alert ms; cleared when the source is healthy again

export function resetSyncAlertState() {
  alertState.clear();
}

function inWorkingHours(nowMs) {
  const hour = DateTime.fromMillis(nowMs, { zone: 'Asia/Kolkata' }).hour;
  return hour >= WORKING_HOURS_IST.from && hour < WORKING_HOURS_IST.to;
}

/** Tell the admins when Google or Zoom stopped syncing during working hours (limits from plan 2.7). */
export async function runSyncHealthAlert(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const rows = await d.health.getAllSyncHealth();
  const alerts = [];
  for (const source of ['google_meet', 'zoom_phone']) {
    const row = rows.find((r) => r.source === source);
    const lastOk = row?.lastOkAt ? toMs(row.lastOkAt) : null;
    const age = lastOk == null ? Infinity : nowMs - lastOk;
    const stale = age > SYNC_LIMITS_MS[source];
    if (!stale) {
      alertState.delete(source);
      continue;
    }
    if (!inWorkingHours(nowMs)) continue;
    const last = alertState.get(source);
    if (last != null && nowMs - last < SYNC_REALERT_MS) continue;
    alertState.set(source, nowMs);

    const label = source === 'google_meet' ? 'Google Meet' : 'Zoom Phone';
    const since = lastOk == null ? 'It has never synced.' : `Last good sync was ${Math.round(age / 60000)} min ago.`;
    const why = row?.lastError ? ` Last error: ${row.lastError}` : '';
    await safePost(
      d.adminPoster,
      `⚠️ **${label} sync is stale.** ${since}${why} Fines that depend on it will go to review until it recovers.`,
      'sync-health'
    );
    alerts.push(source);
  }
  return { alerts };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

let timer = null;
let ticking = false;
let lastHeartbeatRun = 0;
let lastSlowRun = 0;
let lastReassignDay = null;

/** One scheduler tick. Exported so a test can drive the whole cadence with a fake clock. */
export async function runAttendanceTick(now = new Date(), deps = {}) {
  const d = buildDeps(deps);
  const nowMs = toMs(now);
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[AttendanceVerdict] ${name} failed:`, err?.message || err);
      return null;
    }
  };

  // The verdict pass is the health signal for 'verdict_job': it counts as run even with nothing to judge.
  try {
    await runVerdictPass(now, d);
    await d.health.recordSyncOk('verdict_job');
  } catch (err) {
    console.error('[AttendanceVerdict] verdict pass failed:', err?.message || err);
    await d.health.recordSyncError('verdict_job', err);
  }

  if (nowMs - lastHeartbeatRun >= HEARTBEAT_ALERT_EVERY_MS) {
    lastHeartbeatRun = nowMs;
    await step('heartbeat alert', () => runHeartbeatAlert(now, d));
  }
  if (nowMs - lastSlowRun >= SLOW_STEPS_EVERY_MS) {
    lastSlowRun = nowMs;
    await step('integrity check', () => runIntegrityCheck(now, d));
    await step('sync health alert', () => runSyncHealthAlert(now, d));
  }
  const ist = DateTime.fromMillis(nowMs, { zone: 'Asia/Kolkata' });
  if (ist.hour >= REASSIGN_POST_HOUR_IST && lastReassignDay !== ist.toISODate()) {
    lastReassignDay = ist.toISODate();
    await step('needs-reassignment post', () => runNeedsReassignmentPost(now, d));
  }
}

export function startAttendanceVerdictJob() {
  if (timer) {
    console.warn('[AttendanceVerdict] already running');
    return;
  }
  console.log(`[AttendanceVerdict] starting (verdicts every ${VERDICT_EVERY_MS / 1000}s)`);
  // The job only judges BDAs who are in the registry with tracked: true. An empty registry means NO absent alert
  // will ever fire, which looks exactly like "alerts stopped working", so say it loudly at startup and tell the
  // admin channel once. Fix: node scripts/seed-bda-profiles.js --apply
  getTrackedBdas()
    .then((tracked) => {
      if (tracked.length > 0) {
        console.log(`[AttendanceVerdict] judging ${tracked.length} tracked BDA(s)`);
        return null;
      }
      console.warn('[AttendanceVerdict] NO tracked BDAs in the registry: no verdicts or absent alerts until it is seeded');
      return postAdminChannel(
        '⚠️ **Attendance alerts are OFF**: the BDA registry has no tracked BDAs, so nobody is judged and no absent alert will fire. ' +
          'Run `node scripts/seed-bda-profiles.js --apply` (or set `tracked` on the BDA registry page).'
      );
    })
    .catch((err) => console.warn('[AttendanceVerdict] could not read the registry at startup:', err?.message || err));
  const tick = async () => {
    if (ticking) return; // a slow Google check must not stack passes
    ticking = true;
    try {
      await runAttendanceTick(new Date());
    } catch (err) {
      console.error('[AttendanceVerdict] tick failed:', err?.message || err);
    } finally {
      ticking = false;
    }
  };
  tick();
  timer = setInterval(tick, VERDICT_EVERY_MS);
}

export function stopAttendanceVerdictJob() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[AttendanceVerdict] stopped');
  }
}

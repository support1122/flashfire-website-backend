import { DateTime } from 'luxon';
import { getBdaProfile } from './BdaRegistry.js';

// Which BDA a meeting belongs to, and whether it counts (plan 2.1). Every selector and endpoint calls these
// helpers so the order never drifts.

const normEmail = (e) => String(e ?? '').trim().toLowerCase();

// A meeting in one of these states at its scheduled start was never going to happen.
const DEAD_STATUSES = new Set(['canceled', 'rescheduled', 'not-scheduled']);

/**
 * The assigned BDA's lowercase email, or null. Order (plan 2.1):
 * 1. attendanceAssignee.email, set by an admin for leave cover or swaps
 * 2. calendlyHost.email, the Calendly round-robin host
 * 3. claimedBy.email, a manual CRM claim
 */
export function getAssignedBdaEmail(booking) {
  for (const raw of [booking?.attendanceAssignee?.email, booking?.calendlyHost?.email, booking?.claimedBy?.email]) {
    const email = normEmail(raw);
    if (email) return email;
  }
  return null;
}

/** True when `email` is the one assigned BDA. A colleague who merely joined is not assigned. */
export function isBookingAssignedTo(booking, email) {
  const me = normEmail(email);
  if (!me) return false;
  return getAssignedBdaEmail(booking) === me;
}

/**
 * The booking's status at its scheduled start, read from statusHistory because a client can cancel after the
 * meeting time (plan 2.1). Without history the current status is all we know.
 */
export function statusAtStart(booking, startMs) {
  const history = (Array.isArray(booking?.statusHistory) ? booking.statusHistory : [])
    .map((h) => ({ status: h?.status, previousStatus: h?.previousStatus, at: new Date(h?.changedAt).getTime() }))
    .filter((h) => h.status && Number.isFinite(h.at))
    .sort((a, b) => a.at - b.at);

  if (history.length === 0) return booking?.bookingStatus ?? null;

  let atStart = null;
  for (const h of history) {
    if (h.at > startMs) break;
    atStart = h.status;
  }
  if (atStart) return atStart;

  // Every recorded change happened after the start, so the status before the first one applied at start.
  // The history only records the new status, so when the previous one is not stored we assume the default.
  return history[0].previousStatus || 'scheduled';
}

/** IST calendar date ('YYYY-MM-DD') of an instant, the key leaveDays uses. */
export function istDate(ms) {
  return DateTime.fromMillis(ms, { zone: 'Asia/Kolkata' }).toFormat('yyyy-LL-dd');
}

/**
 * Pure core of isCountableBooking. `profile` is the assigned BDA's registry document (or null).
 * Returns { countable, reason } so callers can show why a meeting was skipped.
 */
export function countableReason(booking, profile, nowMs = Date.now()) {
  const email = getAssignedBdaEmail(booking);
  if (!email) return { countable: false, reason: 'unassigned' };

  const startMs = booking?.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : NaN;
  if (!Number.isFinite(startMs)) return { countable: false, reason: 'no_start_time' };

  if (!profile || profile.active === false || profile.tracked !== true) {
    return { countable: false, reason: 'not_tracked' };
  }
  if ((profile.leaveDays || []).includes(istDate(startMs))) return { countable: false, reason: 'on_leave' };

  // A start in the future has no history yet, so the live status stands in for it.
  const status = startMs > nowMs ? booking?.bookingStatus : statusAtStart(booking, startMs);
  if (DEAD_STATUSES.has(status)) return { countable: false, reason: `status_${status}` };

  return { countable: true, reason: null };
}

/**
 * True when the meeting started after tracking began for this BDA. Judging earlier meetings would call every meeting
 * the old system recorded (no signals) absent. Uses trackedSince, else createdAt; no profile date means no limit.
 */
export function isAfterGoLive(profile, startMs) {
  const from = profile?.trackedSince || profile?.createdAt;
  if (!from) return true;
  return startMs >= new Date(from).getTime();
}

/**
 * Plan 2.1: is this meeting countable for its assigned BDA? Async because the BDA comes from the registry.
 * `now` is a Date or epoch ms. Pass { profile } to skip the registry lookup when judging many meetings.
 */
export async function isCountableBooking(booking, now = Date.now(), { profile } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const email = getAssignedBdaEmail(booking);
  const resolved = profile !== undefined ? profile : email ? await getBdaProfile(email) : null;
  return countableReason(booking, resolved, nowMs).countable;
}

import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getAssignedBdaEmail, istDate } from './BdaAssignment.js';
import { getBdaProfile } from './BdaRegistry.js';
import { WINDOW_OPENS_BEFORE_MS } from './recordPresentSignal.js';

// Hand one Calendly meeting to another tracked BDA (leave cover, swaps). The single route and the batch route both
// call this, so every rule lives in one place. It never throws for a refusal: it returns { ok: false, status, code,
// message } so a batch can report each meeting on its own.

const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const DEAD_STATUSES = ['canceled', 'rescheduled', 'not-scheduled'];
export const LOCKED_MESSAGE = 'The mark window has opened, so this meeting can no longer be reassigned';

/**
 * Meetings other than `bookingId` that start at the same instant, keyed `${email}|${startMs}` so the caller can check
 * "is the new BDA already in a meeting then". One query for any number of starts, so a batch is not N+1.
 */
export async function loadTakenSlots(startMsList, { exclude = [] } = {}, deps = {}) {
  const starts = [...new Set(startMsList.filter(Number.isFinite))];
  const taken = new Map();
  if (starts.length === 0) return taken;
  const rows = await (deps.Booking ?? CampaignBookingModel)
    .find({
      scheduledEventStartTime: { $in: starts.map((ms) => new Date(ms)) },
      bookingStatus: { $nin: DEAD_STATUSES },
      bookingId: { $nin: exclude },
    })
    .select('bookingId clientName scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
    .lean();
  for (const b of rows) {
    const email = getAssignedBdaEmail(b);
    if (email) taken.set(`${email}|${new Date(b.scheduledEventStartTime).getTime()}`, b.clientName || 'another meeting');
  }
  return taken;
}

/**
 * @param {{ bookingId: string, email: string|null, actor?: { email?: string|null }, now?: Date, taken?: Map }} input
 *   email null hands the meeting back to its Calendly host. `taken` is optional, from loadTakenSlots.
 * @returns {Promise<{ ok: true, assignedBdaEmail: string|null, attendanceAssignee: object, warnings: string[] }
 *   | { ok: false, status: number, code: string, message: string }>}
 */
export async function reassignBooking({ bookingId, email, actor = {}, now = new Date(), taken = null }, deps = {}) {
  const Booking = deps.Booking ?? CampaignBookingModel;
  const Attendance = deps.Attendance ?? BdaAttendanceModel;
  const lookup = deps.getBdaProfile ?? getBdaProfile;
  const no = (status, code, message) => ({ ok: false, status, code, message });

  const clearing = email === null || email === '';
  const target = clearing ? null : normEmail(email);
  if (!clearing && !target) return no(400, 'invalid_body', 'Send { "email": "<tracked BDA email>" }, or null to hand the meeting back');

  const booking = await Booking.findOne({ bookingId })
    .select('bookingId scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
    .lean();
  if (!booking) return no(404, 'booking_not_found', 'Booking not found');

  const startMs = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : NaN;
  if (!Number.isFinite(startMs)) return no(422, 'no_start_time', 'This booking has no scheduled start time');
  if (now.getTime() >= startMs - WINDOW_OPENS_BEFORE_MS) return no(409, 'window_open', LOCKED_MESSAGE);

  let profile = null;
  const warnings = [];
  if (!clearing) {
    profile = await lookup(target);
    if (!profile || profile.active === false || profile.tracked !== true) {
      return no(422, 'not_tracked_bda', 'The new assignee must be an active, tracked BDA');
    }
    // Handing a meeting to someone who is off that day would just move the problem.
    const day = istDate(startMs);
    if ((profile.leaveDays || []).includes(day)) {
      return no(409, 'target_on_leave', `${profile.displayName || target} is on approved leave on ${day}`);
    }
    const slots = taken ?? (await loadTakenSlots([startMs], { exclude: [bookingId] }, deps));
    const clash = slots.get(`${target}|${startMs}`);
    // A warning, not a refusal: two short calls can be taken back to back, but the admin should know.
    if (clash) warnings.push(`double_booked:${clash}`);
  }

  const previousEmail = getAssignedBdaEmail(booking);
  if (!clearing && previousEmail === target) return no(409, 'already_assigned', 'This meeting is already assigned to that BDA');
  const entry = { email: target, name: profile?.displayName || null, previousEmail, setBy: actor.email || null, setAt: now };
  // The filter repeats the window rule so a click that races the window opening cannot slip through.
  // findOneAndUpdate skips the booking's save hooks, so the history entry is pushed here.
  const updated = await Booking.findOneAndUpdate(
    { bookingId, scheduledEventStartTime: { $gt: new Date(now.getTime() + WINDOW_OPENS_BEFORE_MS) } },
    {
      $set: {
        'attendanceAssignee.email': target,
        'attendanceAssignee.name': entry.name,
        'attendanceAssignee.setBy': entry.setBy,
        'attendanceAssignee.setAt': now,
      },
      $push: { attendanceAssigneeHistory: entry },
    },
    { new: true }
  )
    .select('bookingId attendanceAssignee calendlyHost claimedBy')
    .lean();
  if (!updated) return no(409, 'window_open', LOCKED_MESSAGE);

  // A "your extension is offline" placeholder left for the old assignee would read as a missed meeting. Remove only that.
  if (previousEmail && previousEmail !== target) {
    await Attendance.deleteMany({
      bookingId,
      bdaEmail: previousEmail,
      source: 'scheduler',
      status: 'unmarked',
      verdict: null,
      'signals.0': { $exists: false },
    });
  }

  return { ok: true, assignedBdaEmail: getAssignedBdaEmail(updated), attendanceAssignee: updated.attendanceAssignee, warnings, previousEmail };
}

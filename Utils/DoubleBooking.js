// Double-booked BDAs: two of their meetings at the same time.
//
// Found in production on 2026-10-08: Siddhartha had Jess and Nishath both at 00:30 IST. He was in Nishath's call
// (Google: 00:28 to 00:54), so Jess was a certain "absent". Nothing warned anyone beforehand, and the absent alert
// did not say why. This module answers both: which meetings overlap, and whether the BDA was in the other one.
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { countableReason, getAssignedBdaEmail } from './BdaAssignment.js';
import { getBdaProfile } from './BdaRegistry.js';

const DEFAULT_MS = 30 * 60 * 1000;
const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const startOf = (b) => toMs(b.scheduledEventStartTime);
const endOf = (b) => (b.scheduledEventEndTime ? toMs(b.scheduledEventEndTime) : startOf(b) + DEFAULT_MS);

/** Two meetings overlap when one starts before the other ends. Back-to-back (10:00-10:30, 10:30-11:00) does not. */
export const overlaps = (a, b) => startOf(a) < endOf(b) && startOf(b) < endOf(a);

/**
 * The BDA's other countable meetings that overlap `booking`, each with whether the BDA was in it.
 * @returns {Promise<Array<{ bookingId, clientName, startMs, endMs, attended: boolean, joinedAt: Date|null }>>}
 */
export async function findOverlappingMeetings(booking, bdaEmail, { nowMs = Date.now(), getProfile = getBdaProfile } = {}) {
  const email = String(bdaEmail || getAssignedBdaEmail(booking) || '').toLowerCase();
  if (!email || !booking?.scheduledEventStartTime) return [];
  const from = new Date(startOf(booking) - 3 * 60 * 60 * 1000);
  const to = new Date(endOf(booking));
  const others = await CampaignBookingModel.find({
    bookingId: { $ne: booking.bookingId },
    scheduledEventStartTime: { $gte: from, $lt: to },
    $or: [{ 'attendanceAssignee.email': email }, { 'calendlyHost.email': email }, { 'claimedBy.email': email }],
  })
    .select('bookingId clientName bookingStatus statusHistory scheduledEventStartTime scheduledEventEndTime calendlyHost claimedBy attendanceAssignee')
    .lean();

  const profile = await getProfile(email);
  const clashing = others.filter(
    (o) => getAssignedBdaEmail(o) === email && overlaps(o, booking) && countableReason(o, profile, nowMs).countable
  );
  if (clashing.length === 0) return [];

  const rows = await BdaAttendanceModel.find({ bookingId: { $in: clashing.map((o) => o.bookingId) }, bdaEmail: email })
    .select('bookingId firstJoinedAt joinedAt signals')
    .lean();
  return clashing.map((o) => {
    const row = rows.find((r) => r.bookingId === o.bookingId);
    const joinedAt = row?.firstJoinedAt || row?.joinedAt || null;
    const attended = Boolean(joinedAt || (row?.signals || []).some((s) => s.kind === 'extension_join' || s.kind === 'google_meet'));
    return { bookingId: o.bookingId, clientName: o.clientName || 'another client', startMs: startOf(o), endMs: endOf(o), attended, joinedAt };
  });
}

/** One line for an absent alert, or '' when the BDA was not double-booked. */
export function doubleBookedLine(overlapping, fmtTime) {
  if (!overlapping?.length) return '';
  const inOne = overlapping.find((o) => o.attended);
  if (inOne) {
    return `**Double-booked:** was in another meeting at the same time, ${inOne.clientName}${inOne.joinedAt ? ` (joined ${fmtTime(inOne.joinedAt)})` : ''}. Consider reassigning or waiving.\n`;
  }
  return `**Double-booked:** also had ${overlapping.map((o) => o.clientName).join(', ')} at the same time.\n`;
}

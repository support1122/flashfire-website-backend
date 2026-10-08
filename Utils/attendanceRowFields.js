import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { getAssignedBdaEmail } from './BdaAssignment.js';

// The attendance fields every meeting row carries on GET /api/meeting-links and GET /api/leads/paginated
// (api-contracts.md, "Per-meeting fields"). Two queries per page whatever the page size: one for attendance rows,
// one for deductions. Unknown values are null and the keys are always present, so the CRM renders without guards.

const STUCK_AFTER_MS = 24 * 60 * 60 * 1000;

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** The deduction model is built by another module; until it exists a missing import just means "no deductions". */
async function loadDeductionModel() {
  try {
    const mod = await import('../Schema_Models/BdaDeduction.js');
    return mod.BdaDeductionModel || null;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    console.error('[attendanceRowFields] deduction model unavailable:', err?.message);
    return null;
  }
}

/** Shape one attendance row for the CRM. `row` may be null when the assigned BDA has no row yet. */
export function shapeAttendance(row) {
  const resolved = Boolean(row?.integrityResolved?.at);
  return {
    verdict: row?.verdict ?? null,
    verdictAt: iso(row?.verdictAt),
    markedPresentAt: iso(row?.markedPresentAt),
    signals: (row?.signals || []).map((s) => ({ kind: s.kind, eventAt: iso(s.eventAt) })),
    inAt: iso(row?.firstJoinedAt || row?.joinedAt),
    outAt: iso(row?.leftAt),
    timeSpentMs: row ? row.durationMs ?? row.cumulativeDurationMs ?? 0 : 0,
    sessions: (row?.sessions || []).map((s) => ({ joinedAt: iso(s.startTime), leftAt: iso(s.endTime) })),
    verified: Boolean(row && (row.source === 'meet_api' || row.meetApiFinalizedAt)),
    matchedBy: row?.matchedBy ?? null,
    // A flag an admin already closed (dismissed or converted) no longer shows on the row.
    integrityFlag: resolved ? null : row?.integrityFlag ?? null,
  };
}

/** Who set the current status and when, from the booking's own history. */
export function shapeStatusUpdate(booking, nowMs) {
  const status = booking.bookingStatus ?? null;
  const history = Array.isArray(booking.statusHistory) ? booking.statusHistory : [];
  let entry = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.status === status) {
      entry = history[i];
      break;
    }
  }
  const startMs = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : NaN;
  return {
    status,
    updatedBy: entry?.changedByName || entry?.changedByEmail || booking.statusChangedByName || booking.statusChangedBy || null,
    updatedAt: iso(entry?.changedAt || booking.statusChangedAt),
    stuck: status === 'scheduled' && Number.isFinite(startMs) && nowMs >= startMs + STUCK_AFTER_MS,
  };
}

/**
 * @param {Array} bookings lean booking docs; needs bookingId, bookingStatus, statusHistory,
 *   statusChangedAt/statusChangedBy/statusChangedByName, scheduledEventStartTime and the assignment fields
 * @param {{ email?: string, isAdmin?: boolean }} viewer admins see every deduction, a BDA only their own non-shadow ones
 * @param {{ now?: number, DeductionModel?: object|null }} [opts]
 * @returns {Promise<Map<string, { attendance, statusUpdate, deductions, transcript }>>}
 */
export async function getAttendanceRowFields(bookings, viewer = {}, opts = {}) {
  const out = new Map();
  const list = (bookings || []).filter((b) => b?.bookingId);
  if (list.length === 0) return out;

  const nowMs = opts.now ?? Date.now();
  const ids = list.map((b) => b.bookingId);
  const viewerEmail = String(viewer?.email ?? '').trim().toLowerCase();

  const rows = await BdaAttendanceModel.find({ bookingId: { $in: ids } }).lean();
  const rowByKey = new Map(rows.map((r) => [`${r.bookingId}|${r.bdaEmail}`, r]));

  const Deduction = opts.DeductionModel !== undefined ? opts.DeductionModel : await loadDeductionModel();
  const byBooking = new Map();
  if (Deduction) {
    const query = { bookingId: { $in: ids } };
    if (!viewer?.isAdmin) {
      // No email means we cannot tell whose rows these are, so show none rather than everyone's.
      query.bdaEmail = viewerEmail || '__none__';
      query.status = { $ne: 'shadow' };
    }
    const found = await Deduction.find(query).select('deductionId bookingId bdaEmail rule amountInr status waiverReason').lean();
    for (const d of found) {
      if (!byBooking.has(d.bookingId)) byBooking.set(d.bookingId, []);
      byBooking.get(d.bookingId).push({
        deductionId: d.deductionId,
        rule: d.rule,
        amountInr: d.amountInr,
        status: d.status,
        waiverReason: d.waiverReason ?? null,
      });
    }
  }

  for (const b of list) {
    const assigned = getAssignedBdaEmail(b);
    // Only the assigned BDA's row decides the meeting. A colleague who covered has their own row, shown nowhere here.
    const attendance = assigned ? shapeAttendance(rowByKey.get(`${b.bookingId}|${assigned}`) || null) : null;
    out.set(b.bookingId, {
      attendance,
      statusUpdate: shapeStatusUpdate(b, nowMs),
      deductions: byBooking.get(b.bookingId) || [],
      transcript: null,
    });
  }
  return out;
}

/** Same, but a failure here must never take down the page it decorates. */
export async function getAttendanceRowFieldsSafe(bookings, viewer, opts) {
  try {
    return await getAttendanceRowFields(bookings, viewer, opts);
  } catch (err) {
    console.error('[attendanceRowFields] attendance fields unavailable:', err?.message);
    return new Map();
  }
}

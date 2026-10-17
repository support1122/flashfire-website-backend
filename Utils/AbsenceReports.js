import { SalesLeadAllocationModel } from '../Schema_Models/SalesLeadAllocation.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getAssignedBdaEmail } from './BdaAssignment.js';
import { createManualMiss } from './DeductionEngine.js';
import { ABSENCE_KINDS } from '../Schema_Models/BdaAbsenceReport.js';

// Logic behind "mark a call absent": which calls qualify, and how an absence becomes a fine. The routes stay thin
// and the database pieces are injectable, so the rules can be tested without a database.

export const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// A meeting in one of these states never happened, so nobody can be absent from it.
const DEAD_BOOKING_STATUSES = new Set(['canceled', 'rescheduled', 'not-scheduled']);

const norm = (e) => String(e ?? '').trim().toLowerCase();
const toMs = (d) => {
  const t = d == null ? NaN : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

/** 5 to 500 characters, trimmed. Returns { reason } or { error: { status, code, message } }. */
export function cleanReason(raw) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 5) return { error: { status: 422, code: 'reason_required', message: 'A reason of 5 to 500 characters is required' } };
  if (reason.length > 500) return { error: { status: 422, code: 'reason_too_long', message: 'The reason can be at most 500 characters' } };
  return { reason };
}

/** Validate the create body. Returns { value: { kind, refId, reason } } or { error: { status, code, message } }. */
export function validateReportInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const kind = String(b.kind ?? '').trim();
  if (!ABSENCE_KINDS.includes(kind)) {
    return { error: { status: 422, code: 'invalid_kind', message: 'kind must be allocation or booking' } };
  }
  const refId = String(b.refId ?? '').trim();
  if (!refId || refId.length > 200) {
    return { error: { status: 422, code: 'invalid_ref', message: 'refId is required' } };
  }
  const checked = cleanReason(b.reason);
  if (checked.error) return checked;
  return { value: { kind, refId, reason: checked.reason } };
}

/**
 * Can this call be marked absent right now? Pure. `call` is { kind, startMs, state } where state is the allocation
 * status or the booking status. Returns { ok: true } or { ok: false, status, code, message }.
 */
export function checkEligible(call, nowMs = Date.now()) {
  const no = (status, code, message) => ({ ok: false, status, code, message });
  if (!Number.isFinite(call.startMs)) return no(422, 'no_start_time', 'This call has no start time');
  if (call.startMs > nowMs) return no(409, 'call_not_over', 'The call has not started yet');
  if (nowMs - call.startMs > LOOKBACK_MS) return no(409, 'too_old', 'Only calls from the last 30 days can be marked absent');
  if (call.kind === 'allocation' && call.state !== 'scheduled') {
    return no(409, 'not_scheduled', `This call is already ${call.state}, so it cannot be marked absent`);
  }
  if (call.kind === 'booking' && DEAD_BOOKING_STATUSES.has(call.state)) {
    return no(409, 'meeting_did_not_happen', `This meeting is ${call.state}, so nobody can be absent from it`);
  }
  return { ok: true };
}

/** Load one call as { kind, refId, bdaEmail, clientName, startMs, state } or null. */
export async function loadCall(kind, refId, deps = {}) {
  if (kind === 'allocation') {
    const a = await (deps.Allocation ?? SalesLeadAllocationModel).findOne({ allocationId: refId }).lean();
    if (!a) return null;
    return { kind, refId, bdaEmail: norm(a.bdaEmail), bdaName: a.bdaName ?? null, clientName: a.clientName ?? null, startMs: toMs(a.callAt), state: a.status };
  }
  const b = await (deps.Booking ?? CampaignBookingModel).findOne({ bookingId: refId }).lean();
  if (!b) return null;
  return {
    kind,
    refId,
    bdaEmail: getAssignedBdaEmail(b),
    bdaName: null,
    clientName: b.clientName ?? null,
    startMs: toMs(b.scheduledEventStartTime),
    state: b.bookingStatus ?? 'scheduled',
  };
}

/**
 * Turn an absence into a fine. For a Lead Allocation call the row is flipped scheduled -> absent first, in one
 * conditional update, so a BDA closing the call at the same moment cannot also be fined. If the fine is refused
 * (fines off, already fined...) the call is put back to scheduled. Returns { ok: true, deduction } or { ok: false, ... }.
 */
export async function applyAbsence(call, { actor, reason, requestId = null }, deps = {}) {
  const Allocation = deps.Allocation ?? SalesLeadAllocationModel;
  const fine = deps.createManualMiss ?? createManualMiss;

  if (call.kind === 'allocation') {
    const flipped = await Allocation.findOneAndUpdate(
      { allocationId: call.refId, status: 'scheduled' },
      { $set: { status: 'absent', outcomeNote: `Marked absent: ${reason}`.slice(0, 2000), reminderState: 'skipped', earlyReminderState: 'skipped' } },
      { new: true }
    ).lean();
    if (!flipped) return { ok: false, status: 409, code: 'not_scheduled', message: 'This call is no longer scheduled' };
  }

  let result;
  try {
    result = await fine({
      kind: call.kind,
      refId: call.refId,
      bdaEmail: call.bdaEmail,
      startMs: call.startMs,
      clientName: call.clientName,
      actor,
      reason,
      requestId,
    });
  } catch (err) {
    result = { ok: false, status: 500, code: 'internal_error', message: err?.message || 'Could not write the fine' };
  }

  if (!result.ok && call.kind === 'allocation') {
    // Put the call back exactly as it was. The reminders were already spent or irrelevant, so they stay skipped.
    await Allocation.updateOne({ allocationId: call.refId, status: 'absent' }, { $set: { status: 'scheduled', outcomeNote: null } });
  }
  return result;
}

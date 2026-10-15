import { DateTime } from 'luxon';
import { BdaLeaveRequestModel } from '../Schema_Models/BdaLeaveRequest.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { waiveDeduction } from './DeductionEngine.js';
import { invalidateRegistryCache } from './BdaRegistry.js';
import { istDate } from './BdaAssignment.js';
import { IST_ZONE } from './deductionPolicy.js';

// Leave requests: a BDA asks, an admin decides, approval waives that day's deductions.
//
// Approval has two halves and both matter:
//   forward  - the days go into BdaProfile.leaveDays, so countableReason() returns 'on_leave' and the
//              evaluators never create a new fine for a meeting on those days.
//   backward - fines already written for those days are waived, because the evaluator had no way to
//              know the leave was coming when it judged the meeting.
// Doing only the first half leaves the BDA charged for the day they were approved to be absent.

const LEAVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_PER_REQUEST = 60;
const WAIVABLE = ['shadow', 'needs_review', 'active']; // same set waiveDeduction accepts

const norm = (e) => String(e ?? '').trim().toLowerCase();
const fail = (status, code, message) => ({ ok: false, status, code, message });

export function isRealLeaveDay(day) {
  return LEAVE_DAY_RE.test(day) && DateTime.fromISO(day, { zone: IST_ZONE }).isValid;
}

/**
 * Every IST day from `from` to `to` inclusive. Returns { error } for a bad range so the caller can
 * answer 422 rather than silently storing nonsense.
 */
export function expandDays(from, to) {
  if (!isRealLeaveDay(from) || !isRealLeaveDay(to)) {
    return { error: { code: 'invalid_dates', message: 'fromDate and toDate must be real YYYY-MM-DD dates' } };
  }
  const start = DateTime.fromISO(from, { zone: IST_ZONE }).startOf('day');
  const end = DateTime.fromISO(to, { zone: IST_ZONE }).startOf('day');
  if (end < start) {
    return { error: { code: 'invalid_range', message: 'toDate cannot be before fromDate' } };
  }
  const days = [];
  for (let d = start; d <= end; d = d.plus({ days: 1 })) {
    days.push(d.toFormat('yyyy-LL-dd'));
    if (days.length > MAX_DAYS_PER_REQUEST) {
      return { error: { code: 'range_too_long', message: `A leave request can cover at most ${MAX_DAYS_PER_REQUEST} days` } };
    }
  }
  return { days };
}

/**
 * Active-ish deductions for this BDA whose meeting fell on one of `days` (IST).
 *
 * Narrowed by month first so this rides the {bdaEmail, month} index instead of scanning the BDA's
 * whole history: the day is inside the row's evidence, which Mongo cannot filter on by IST date.
 */
export async function findDeductionsOnDays(bdaEmail, days) {
  const set = new Set(days);
  if (set.size === 0) return [];
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  const rows = await BdaDeductionModel.find({
    bdaEmail: norm(bdaEmail),
    month: { $in: months },
    status: { $in: WAIVABLE },
  })
    .select('deductionId rule amountInr status month evidence.scheduledStart')
    .lean();
  return rows.filter((r) => {
    const start = r?.evidence?.scheduledStart;
    if (!start) return false;
    return set.has(istDate(new Date(start).getTime()));
  });
}

/**
 * Approve a request: flip it, add the days to the registry, waive the fines already written for them.
 *
 * The status flip is a guarded findOneAndUpdate so two admins clicking Approve cannot both run the
 * waiver. leaveDays is edited with $addToSet, never a whole-array write: a cached screen sending the
 * full list is how a previously approved leave day got dropped and a meeting on it was fined.
 */
export async function approveLeaveRequest(leaveRequestId, actor, note = null, { now = new Date() } = {}) {
  const req = await BdaLeaveRequestModel.findOneAndUpdate(
    { leaveRequestId, status: 'pending' },
    {
      $set: {
        status: 'approved',
        decidedBy: actor?.email || 'admin',
        decidedByName: actor?.name || null,
        decidedAt: now,
        decisionNote: note || null,
      },
    },
    { new: true }
  ).lean();
  if (!req) return notPending(leaveRequestId);

  const profile = await BdaProfileModel.findOne({ email: req.bdaEmail }).select('leaveDays').lean();
  const already = new Set(profile?.leaveDays || []);
  const toAdd = req.days.filter((d) => !already.has(d));

  if (toAdd.length) {
    await BdaProfileModel.updateOne({ email: req.bdaEmail }, { $addToSet: { leaveDays: { $each: toAdd } } });
    invalidateRegistryCache();
  }

  // Waive one at a time: waiveDeduction reprices the month after each missed_meeting row, which is how
  // a 6th miss at 1000 correctly falls back to 500 once an earlier one is waived.
  const targets = await findDeductionsOnDays(req.bdaEmail, req.days);
  const waivedIds = [];
  let waivedAmountInr = 0;
  for (const row of targets) {
    const reason = `Approved leave ${req.fromDate}${req.toDate !== req.fromDate ? ` to ${req.toDate}` : ''} (request ${req.leaveRequestId})`;
    const res = await waiveDeduction(row.deductionId, actor || { email: 'admin', name: 'Admin' }, reason, { now });
    if (res?.ok) {
      waivedIds.push(row.deductionId);
      waivedAmountInr += Number(res.deduction?.amountInr ?? row.amountInr ?? 0);
    }
  }

  const updated = await BdaLeaveRequestModel.findOneAndUpdate(
    { leaveRequestId },
    { $set: { waivedDeductionIds: waivedIds, waivedAmountInr, daysAlreadyOnLeave: req.days.filter((d) => already.has(d)) } },
    { new: true }
  ).lean();

  return { ok: true, request: updated, waived: { count: waivedIds.length, amountInr: waivedAmountInr }, daysAdded: toAdd };
}

/** Reject a pending request. Nothing is waived and the registry is untouched. */
export async function rejectLeaveRequest(leaveRequestId, actor, note, { now = new Date() } = {}) {
  const req = await BdaLeaveRequestModel.findOneAndUpdate(
    { leaveRequestId, status: 'pending' },
    {
      $set: {
        status: 'rejected',
        decidedBy: actor?.email || 'admin',
        decidedByName: actor?.name || null,
        decidedAt: now,
        decisionNote: note,
      },
    },
    { new: true }
  ).lean();
  if (!req) return notPending(leaveRequestId);
  return { ok: true, request: req };
}

/** The requester withdraws their own request, allowed only while it is still pending. */
export async function cancelLeaveRequest(leaveRequestId, bdaEmail, { now = new Date() } = {}) {
  const req = await BdaLeaveRequestModel.findOneAndUpdate(
    { leaveRequestId, bdaEmail: norm(bdaEmail), status: 'pending' },
    { $set: { status: 'cancelled', decidedAt: now } },
    { new: true }
  ).lean();
  if (!req) {
    const exists = await BdaLeaveRequestModel.findOne({ leaveRequestId }).select('status bdaEmail').lean();
    if (!exists) return fail(404, 'leave_request_not_found', 'No such leave request');
    if (exists.bdaEmail !== norm(bdaEmail)) return fail(403, 'forbidden', 'You can only cancel your own request');
    return fail(409, 'already_decided', `This request is already ${exists.status}`);
  }
  return { ok: true, request: req };
}

async function notPending(leaveRequestId) {
  const exists = await BdaLeaveRequestModel.findOne({ leaveRequestId }).select('status').lean();
  if (!exists) return fail(404, 'leave_request_not_found', 'No such leave request');
  return fail(409, 'already_decided', `This request is already ${exists.status}`);
}

import { DateTime } from 'luxon';

// The one place every deduction number lives (plan 8.1). Change a rule in plan 2.5 first, then here.
// Amounts are INR. Times are milliseconds unless the name says otherwise.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const IST_ZONE = 'Asia/Kolkata';

export const DEDUCTION_POLICY = Object.freeze({
  missedMeeting: Object.freeze({
    tierSize: 5, // 1st to 5th active miss in an IST month costs baseAmountInr
    baseAmountInr: 500,
    escalatedAmountInr: 1000, // 6th miss onward
  }),
  noShowNotCalled: Object.freeze({
    amountInr: 100,
    callWindowMs: 30 * MIN, // a counted call from start to start + 30 min satisfies the rule (plan D1)
    // The Zoom health window runs to start + 40 min (plan 2.7), and a verdict is only trustworthy once that window
    // is over. So the rule is judged at start + 40 min, never earlier, even though the call window is 30 min.
    healthWindowMs: 40 * MIN,
  }),
  statusNotUpdated: Object.freeze({
    amountInr: 50,
    deadlineMs: 2 * HOUR, // default start + 2 h (plan D2)
  }),
  // Plan 2.5 loophole: a no-show is judged for 60 days, so setting the status late cannot dodge the fine.
  rejudgeWindowMs: 60 * DAY,
  // The verdict job writes a verdict for meetings from the last 24 h; the sweep looks a little wider than that.
  verdictSweepLookbackMs: 60 * DAY,
  evaluatorIntervalMs: 5 * MIN,
  dailySummaryHourIst: 22,
});

/** Evaluator tick, overridable for tests and staging. */
export function getEvaluatorIntervalMs() {
  const n = Number(process.env.DEDUCTIONS_EVAL_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEDUCTION_POLICY.evaluatorIntervalMs;
}

export const DEDUCTION_RULES = Object.freeze(['missed_meeting', 'no_show_not_called', 'status_not_updated']);
export const DEDUCTION_STATUSES = Object.freeze(['shadow', 'needs_review', 'active', 'waived', 'voided']);
export const DEDUCTION_MODES = Object.freeze(['off', 'shadow', 'live']);

/** True only when real fines are being written. Every alert that mentions a fine must check this first. */
export function finesAreLive() {
  return getDeductionsMode() === 'live';
}

// The admin's choice from the CRM (AppSetting 'deductions'), cached here so these getters stay synchronous.
// Utils/DeductionSettings.js refreshes it every 30 s and right after an admin change. Env vars always win.
let dbSettings = { mode: null, liveFrom: null };

/** Called by Utils/DeductionSettings.js with the stored setting (or nulls to clear it). */
export function setDbDeductionSettings({ mode = null, liveFrom = null } = {}) {
  dbSettings = {
    mode: DEDUCTION_MODES.includes(mode) ? mode : null,
    liveFrom: liveFrom && Number.isFinite(new Date(liveFrom).getTime()) ? new Date(liveFrom) : null,
  };
}

/** 'env' when DEDUCTIONS_MODE is set (the CRM switch is then read-only), else 'crm'. */
export function deductionsModeSource() {
  return String(process.env.DEDUCTIONS_MODE ?? '').trim() ? 'env' : 'crm';
}

/** off (default) writes nothing, shadow writes admin-only rows, live writes real rows. Read on every call. */
export function getDeductionsMode() {
  const raw = String(process.env.DEDUCTIONS_MODE ?? '').trim().toLowerCase();
  if (raw) return DEDUCTION_MODES.includes(raw) ? raw : 'off';
  return dbSettings.mode || 'off';
}

/**
 * Go-live instant as a Date, or null when unset or unreadable. Meetings that start before it are never fined.
 * A bare date ("2026-11-01") means 00:00 IST that day, because the team announces dates in IST.
 */
export function getLiveFrom() {
  const raw = String(process.env.DEDUCTIONS_LIVE_FROM ?? '').trim();
  if (!raw) return deductionsModeSource() === 'env' ? null : dbSettings.liveFrom;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? DateTime.fromISO(raw, { zone: IST_ZONE })
    : DateTime.fromISO(raw, { zone: IST_ZONE, setZone: true }); // no offset in the string means IST, not the server's zone
  return parsed.isValid ? parsed.toJSDate() : null;
}

/** 'YYYY-MM' of an instant in IST. The missed-meeting counter resets at 00:00 IST on the 1st. */
export function monthKeyIST(when) {
  const ms = when instanceof Date ? when.getTime() : new Date(when).getTime();
  return DateTime.fromMillis(ms, { zone: IST_ZONE }).toFormat('yyyy-LL');
}

/** [start, end) instants of an IST month, as Dates. Returns null for a malformed month key. */
export function monthBoundsIST(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month ?? ''))) return null;
  const start = DateTime.fromFormat(month, 'yyyy-LL', { zone: IST_ZONE }).startOf('month');
  return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
}

/** Amount for the nth (1-based) active missed meeting of a month. */
export function missedMeetingAmount(tierIndex) {
  const p = DEDUCTION_POLICY.missedMeeting;
  return tierIndex > p.tierSize ? p.escalatedAmountInr : p.baseAmountInr;
}

export function baseAmountFor(rule) {
  if (rule === 'missed_meeting') return DEDUCTION_POLICY.missedMeeting.baseAmountInr;
  if (rule === 'no_show_not_called') return DEDUCTION_POLICY.noShowNotCalled.amountInr;
  if (rule === 'status_not_updated') return DEDUCTION_POLICY.statusNotUpdated.amountInr;
  throw new Error(`unknown deduction rule: ${rule}`);
}

/** Status deadline for the status rule; DEDUCTIONS_STATUS_DEADLINE_MIN overrides the 2 h default (plan D2). */
export function getStatusDeadlineMs() {
  const min = Number(process.env.DEDUCTIONS_STATUS_DEADLINE_MIN);
  return Number.isFinite(min) && min > 0 ? min * MIN : DEDUCTION_POLICY.statusNotUpdated.deadlineMs;
}

/** Totals per rule over the rows given. Only `active` rows count: shadow, needs_review, waived and voided never do. */
export function buildTotals(rows) {
  const byRule = Object.fromEntries(DEDUCTION_RULES.map((rule) => [rule, { count: 0, amountInr: 0 }]));
  let activeAmountInr = 0;
  for (const r of rows) {
    if (r.status !== 'active' || !byRule[r.rule]) continue;
    byRule[r.rule].count += 1;
    byRule[r.rule].amountInr += r.amountInr;
    activeAmountInr += r.amountInr;
  }
  return { byRule, activeAmountInr };
}

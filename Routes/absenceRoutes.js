import { BdaAbsenceReportModel, ABSENCE_KINDS, ABSENCE_STATUSES } from '../Schema_Models/BdaAbsenceReport.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { SalesLeadAllocationModel } from '../Schema_Models/SalesLeadAllocation.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getAllBdaProfiles, getBdaProfile, getTrackedBdas } from '../Utils/BdaRegistry.js';
import { getAssignedBdaEmail } from '../Utils/BdaAssignment.js';
import { isLeaveDayFor, workDayBounds, workDayOf } from '../Utils/WorkDay.js';
import { getDeductionsMode, monthBoundsIST } from '../Utils/deductionPolicy.js';
import { postAdminChannel } from '../Utils/attendanceDiscord.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { escapeRegex } from '../Utils/SalesAllocations.js';
import { LOOKBACK_MS, UPCOMING_MS, applyAbsence, checkEligible, cleanAbsenceReason, cleanReason, loadCall, validateReportInput } from '../Utils/AbsenceReports.js';
import { getAllocationCallChecksSafe } from '../Utils/AllocationCallCheck.js';
import { actorOf, requireCrmUserOrAdmin } from './deductionRoutes.js';

// "Mark absent" API. Admins mark a call absent directly (the fine is written at once). A BDA can only report a miss
// on their own call; it waits as `pending` until an admin approves it, and only then does a fine exist.
// Same error shape as the other CRM APIs: { success:false, error:{ code, message } }.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const norm = (e) => String(e ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);

const LIST_CAP = 300;
const CANDIDATE_CAP = 60;
const BATCH_MAX = 50;

async function requestIsAdmin(req) {
  if (req.crmAdmin) return true;
  return isCrmAdmin(req.crmUser);
}

function toRow(r) {
  return {
    reportId: r.reportId,
    kind: r.kind,
    refId: r.refId,
    bdaEmail: r.bdaEmail,
    bdaName: r.bdaName ?? r.bdaEmail.split('@')[0],
    clientName: r.clientName ?? '',
    callStart: iso(r.callStart),
    reason: r.reason,
    raisedBy: r.raisedBy,
    raisedByName: r.raisedByName ?? null,
    status: r.status,
    decidedByName: r.decidedByName ?? null,
    decidedAt: iso(r.decidedAt),
    decisionNote: r.decisionNote ?? null,
    deductionId: r.deductionId ?? null,
    createdAt: iso(r.createdAt),
  };
}

async function nameOf(email) {
  const p = await getBdaProfile(email);
  return p?.displayName || String(email).split('@')[0];
}

async function tellAdmins(text) {
  try {
    await postAdminChannel(text);
  } catch (err) {
    console.error('[absenceRoutes] admin post failed:', err?.message);
  }
}

/** One calendar day in IST as { start, end } (end is the next midnight), or null when it is not a real date. */
function istDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const start = new Date(`${text}T00:00:00+05:30`);
  if (Number.isNaN(start.getTime())) return null;
  const back = new Date(start.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
  if (back !== text) return null; // 2026-02-31 style dates roll over; reject them
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

const istTime = (d) =>
  new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) + ' IST';

export function registerAbsenceRoutes(app) {
  const BASE = '/api/crm/absences';

  /** Past calls that could be marked absent. BDA: their own. Admin: anyone's, optional bdaEmail. */
  app.get(`${BASE}/candidates`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const kind = String(req.query.kind ?? '');
      if (!ABSENCE_KINDS.includes(kind)) return fail(res, 422, 'invalid_kind', 'kind must be allocation or booking');
      const admin = await requestIsAdmin(req);
      const own = norm(req.crmUser?.email);
      let bdaEmail = norm(req.query.bdaEmail);
      if (!admin) {
        if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
        if (bdaEmail && bdaEmail !== own) return fail(res, 403, 'forbidden', 'You can only see your own calls');
        bdaEmail = own;
      }
      const q = String(req.query.q ?? '').trim().slice(0, 80);
      const nowMs = Date.now();
      const now = new Date(nowMs);
      let since = new Date(nowMs - LOOKBACK_MS);
      // An admin also sees the rest of the current working day (calls not started yet) so they can be marked in advance.
      let until = admin ? workDayBounds(workDayOf(nowMs)).end : now;
      // Optional range of working days (YYYY-MM-DD), inside the 30 day window. A BDA never sees the future; an admin sees up to a week ahead.
      for (const [name, edge] of [['from', 'start'], ['to', 'end']]) {
        const raw = String(req.query[name] ?? '').trim();
        if (!raw) continue;
        const day = istDay(raw) && workDayBounds(raw);
        if (!day) return fail(res, 422, 'invalid_date', `${name} must look like 2026-10-17`);
        if (edge === 'start') since = new Date(Math.max(since.getTime(), day.start.getTime()));
        else until = new Date(Math.min(admin ? nowMs + UPCOMING_MS : nowMs, day.end.getTime()));
      }

      let calls = [];
      if (kind === 'allocation') {
        const filter = { status: 'scheduled', callAt: { $lt: until, $gte: since } };
        if (bdaEmail) filter.bdaEmail = bdaEmail;
        if (q) {
          const rx = new RegExp(escapeRegex(q), 'i');
          filter.$or = [{ clientName: rx }, { phone: rx }, { email: rx }];
        }
        const docs = await SalesLeadAllocationModel.find(filter).sort({ callAt: -1 }).limit(CANDIDATE_CAP).lean();
        const checks = await getAllocationCallChecksSafe(docs, undefined, nowMs);
        calls = docs.map((a) => ({ kind, refId: a.allocationId, bdaEmail: a.bdaEmail, bdaName: a.bdaName, clientName: a.clientName, callStart: a.callAt, detail: [a.phone, a.email].filter(Boolean).join(' · '), callCheck: checks.get(a.allocationId) ?? null }));
      } else {
        const filter = { scheduledEventStartTime: { $lt: until, $gte: since }, bookingStatus: { $ne: 'not-scheduled' } };
        if (bdaEmail) {
          filter.$or = [{ 'attendanceAssignee.email': bdaEmail }, { 'calendlyHost.email': bdaEmail }, { 'claimedBy.email': bdaEmail }];
        }
        if (q) {
          const rx = new RegExp(escapeRegex(q), 'i');
          filter.$and = [{ $or: [{ clientName: rx }, { clientEmail: rx }, { clientPhone: rx }, { bookingId: rx }] }];
        }
        const docs = await CampaignBookingModel.find(filter)
          .select('bookingId bookingStatus clientName clientEmail clientPhone scheduledEventStartTime attendanceAssignee calendlyHost claimedBy')
          .sort({ scheduledEventStartTime: -1 })
          .limit(CANDIDATE_CAP * 3)
          .lean();
        const tracked = new Set((await getTrackedBdas()).map((p) => p.email));
        calls = docs
          .map((b) => ({ b, assigned: getAssignedBdaEmail(b) }))
          .filter(({ assigned }) => assigned && tracked.has(assigned) && (!bdaEmail || assigned === bdaEmail))
          .slice(0, CANDIDATE_CAP)
          .map(({ b, assigned }) => ({ kind, refId: b.bookingId, bdaEmail: assigned, bdaName: null, clientName: b.clientName, callStart: b.scheduledEventStartTime, detail: [b.clientPhone, b.clientEmail].filter(Boolean).join(' · '), dead: ['canceled', 'rescheduled'].includes(b.bookingStatus) ? b.bookingStatus : null }));
      }

      // Calls that already carry a fine or an open/approved report cannot be marked again.
      const refs = calls.map((c) => c.refId);
      const [fined, reported, profiles] = await Promise.all([
        refs.length ? BdaDeductionModel.find({ bookingId: { $in: refs }, rule: 'missed_meeting' }).select('bookingId bdaEmail').lean() : [],
        refs.length ? BdaAbsenceReportModel.find({ kind, refId: { $in: refs }, status: { $in: ['pending', 'approved'] } }).select('refId bdaEmail').lean() : [],
        getAllBdaProfiles(),
      ]);
      const finedKeys = new Set(fined.map((d) => `${d.bookingId}|${d.bdaEmail}`));
      const taken = new Set([...fined.map((d) => `${d.bookingId}|${d.bdaEmail}`), ...reported.map((r) => `${r.refId}|${r.bdaEmail}`)]);
      const names = new Map(profiles.map((p) => [p.email, p.displayName]));
      const profileOf = new Map(profiles.map((p) => [p.email, p]));
      // Every call in the range is listed so the admin sees the whole picture. A call that cannot be marked carries
      // blockedReason (the mark route refuses these too) and the dialog shows it greyed out with the reason.
      const out = calls.map(({ dead, ...c }) => {
        const workDay = workDayOf(new Date(c.callStart).getTime(), profileOf.get(c.bdaEmail) ?? null);
        const blockedReason = dead
          ? dead
          : taken.has(`${c.refId}|${c.bdaEmail}`)
            ? (finedKeys.has(`${c.refId}|${c.bdaEmail}`) ? 'fined' : 'reported')
            : (profileOf.get(c.bdaEmail)?.leaveDays || []).includes(workDay)
              ? 'leave'
              : null;
        return {
          ...c,
          bdaName: c.bdaName || names.get(c.bdaEmail) || c.bdaEmail.split('@')[0],
          upcoming: new Date(c.callStart).getTime() > nowMs,
          blockedReason,
          workDay,
          callStart: iso(c.callStart),
        };
      });
      return res.status(200).json({ success: true, kind, candidates: out });
    } catch (err) {
      console.error('[absenceRoutes] candidates failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load calls');
    }
  });

  /** Reports. BDA: their own. Admin: everyone, filtered by status, kind, bdaEmail and month. */
  app.get(BASE, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const admin = await requestIsAdmin(req);
      const filter = {};
      const status = String(req.query.status ?? '');
      if (status) {
        if (!ABSENCE_STATUSES.includes(status)) return fail(res, 422, 'invalid_status', 'Unknown status');
        filter.status = status;
      }
      const kind = String(req.query.kind ?? '');
      if (kind) {
        if (!ABSENCE_KINDS.includes(kind)) return fail(res, 422, 'invalid_kind', 'kind must be allocation or booking');
        filter.kind = kind;
      }
      if (req.query.month) {
        const b = monthBoundsIST(String(req.query.month));
        if (!b) return fail(res, 422, 'invalid_month', 'month must look like 2026-10');
        filter.callStart = { $gte: b.start, $lt: b.end };
      }
      const wanted = norm(req.query.bdaEmail);
      if (admin) {
        if (wanted) filter.bdaEmail = wanted;
      } else {
        const own = norm(req.crmUser?.email);
        if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
        if (wanted && wanted !== own) return fail(res, 403, 'forbidden', 'You can only see your own reports');
        filter.bdaEmail = own;
      }
      const rows = await BdaAbsenceReportModel.find(filter).sort({ createdAt: -1 }).limit(LIST_CAP).lean();
      const pending = admin ? await BdaAbsenceReportModel.countDocuments({ status: 'pending' }) : undefined;
      return res.status(200).json({ success: true, reports: rows.map(toRow), ...(admin ? { pendingCount: pending } : {}) });
    } catch (err) {
      console.error('[absenceRoutes] list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load absence reports');
    }
  });

  const out = (status, json, notice = null) => ({ status, json, notice });
  const refuse = (status, code, message) => out(status, { success: false, error: { code, message } });

  /**
   * Mark one call absent (admin: the fine is written now) or report it (BDA: a pending report). Returns
   * { status, json, notice } and never throws, so the single and the batch route share one set of rules.
   * `notice` is the admin-channel text for a BDA report; the caller posts it, so a batch can post one summary.
   */
  async function processOne(req, admin, actor, input) {
    try {
      const parsed = validateReportInput(input, { admin });
      if (parsed.error) return refuse(parsed.error.status, parsed.error.code, parsed.error.message);
      const { kind, refId, reason } = parsed.value;

      const call = await loadCall(kind, refId);
      if (!call) return refuse(404, 'call_not_found', 'No such call');
      if (!call.bdaEmail) return refuse(409, 'no_bda', 'This call has no assigned BDA');
      const eligible = checkEligible(call, Date.now(), { admin });
      if (!eligible.ok) return refuse(eligible.status, eligible.code, eligible.message);

      const profile = await getBdaProfile(call.bdaEmail);
      const bdaName = profile?.displayName || call.bdaEmail.split('@')[0];
      if (!profile || profile.active === false || profile.tracked !== true) {
        return refuse(409, 'not_tracked', `${bdaName} is not a tracked BDA`);
      }

      if (isLeaveDayFor(profile, call.startMs)) {
        return refuse(409, 'on_leave', `${bdaName} is on approved leave for the ${workDayOf(call.startMs, profile)} working day, so this call cannot be marked absent`);
      }

      const open = await BdaAbsenceReportModel.findOne({ kind, refId, bdaEmail: call.bdaEmail, status: { $in: ['pending', 'approved'] } }).lean();

      if (!admin) {
        if (!actor.email || actor.email !== call.bdaEmail) return refuse(403, 'forbidden', 'You can only report your own calls');
        if (getDeductionsMode() === 'off') return refuse(409, 'fines_off', 'Fines are switched off right now');
        if (open) return refuse(409, 'already_reported', open.status === 'pending' ? 'This call already has a pending report' : 'This call was already marked absent');
        // A fine in any state (even waived) means an admin could never approve this report, so do not queue it.
        const fined = await BdaDeductionModel.findOne({ bookingId: refId, bdaEmail: call.bdaEmail, rule: 'missed_meeting' }).select('status').lean();
        if (fined) return refuse(409, 'already_fined', `This call already has a fine (${fined.status})`);
        const created = await BdaAbsenceReportModel.create({
          kind, refId, bdaEmail: call.bdaEmail, bdaName, clientName: call.clientName, callStart: new Date(call.startMs), reason,
          raisedBy: 'bda', raisedByEmail: actor.email, raisedByName: actor.name || bdaName, status: 'pending',
        });
        const line = `${kind === 'allocation' ? 'allocated call' : 'meeting'} with ${call.clientName || 'a client'} (${istTime(call.startMs)})`;
        return out(201, { success: true, report: toRow(created.toObject()) }, { bdaName, line, reason });
      }

      // Admin: mark absent now. A pending report from the BDA for the same call is settled by this action.
      if (open?.status === 'approved') return refuse(409, 'already_reported', 'This call was already marked absent');
      const reportId = open?.reportId || `abs_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      // An admin's mark always goes through: attendance showing a join, a call from before fines went live or before the
      // BDA was tracked do not stop it. Never honoured for a BDA (the branch above returns first).
      const result = await applyAbsence(call, { actor, reason, requestId: reportId, force: true, ignoreStartGates: true });
      if (!result.ok) return refuse(result.status, result.code, result.message);
      const decided = { status: 'approved', decidedBy: actor.email || 'admin', decidedByName: actor.name || null, decidedAt: new Date(), decisionNote: reason, deductionId: result.deduction.deductionId };
      let report;
      if (open) {
        report = await BdaAbsenceReportModel.findOneAndUpdate({ reportId, status: 'pending' }, { $set: decided }, { new: true }).lean();
      } else {
        report = (await BdaAbsenceReportModel.create({
          reportId, kind, refId, bdaEmail: call.bdaEmail, bdaName, clientName: call.clientName, callStart: new Date(call.startMs), reason,
          raisedBy: 'admin', raisedByEmail: actor.email, raisedByName: actor.name, ...decided,
        })).toObject();
      }
      return out(201, { success: true, report: report ? toRow(report) : null, deductionId: result.deduction.deductionId });
    } catch (err) {
      if (err?.code === 11000) return refuse(409, 'already_reported', 'This call already has a report');
      console.error('[absenceRoutes] create failed:', err?.message);
      return refuse(500, 'internal_error', 'Could not record the absence');
    }
  }

  app.post(BASE, requireCrmUserOrAdmin, async (req, res) => {
    const done = await processOne(req, await requestIsAdmin(req), actorOf(req), req.body);
    if (done.notice) {
      await tellAdmins(`📝 **Absence report to review**\n${done.notice.bdaName} reports a missed ${done.notice.line}.\nReason: ${done.notice.reason}\nOpen the Deductions tab in the CRM to approve or reject.`);
    }
    return res.status(done.status).json(done.json);
  });

  /**
   * Several calls, one reason. Each call is judged on its own (one already fined does not block the rest), oldest
   * first so the monthly tiers fall in the order the calls happened. Answers 200 with a result per call.
   */
  app.post(`${BASE}/batch`, requireCrmUserOrAdmin, async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items || items.length === 0) return fail(res, 422, 'no_items', 'Choose at least one call');
    if (items.length > BATCH_MAX) return fail(res, 422, 'too_many_items', `Choose at most ${BATCH_MAX} calls at a time`);
    const batchAdmin = await requestIsAdmin(req);
    const checked = cleanAbsenceReason(req.body?.reason, { admin: batchAdmin });
    if (checked.error) return fail(res, checked.error.status, checked.error.code, checked.error.message);

    const seen = new Set();
    const unique = [];
    for (const it of items) {
      const key = `${it?.kind}|${it?.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ kind: it?.kind, refId: it?.refId });
    }
    // Oldest call first. Calls that cannot be loaded sort last and are refused one by one below.
    // Compare, never subtract: Infinity - Infinity is NaN.
    const starts = await Promise.all(unique.map(async (it) => ((await loadCall(it?.kind, String(it?.refId ?? '')).catch(() => null))?.startMs ?? Infinity)));
    const order = unique.map((it, i) => ({ it, at: starts[i] })).sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1)).map((x) => x.it);

    const admin = batchAdmin;
    const actor = actorOf(req);
    const results = [];
    const notices = [];
    for (const it of order) {
      const done = await processOne(req, admin, actor, { ...it, reason: checked.reason, force: req.body?.force === true });
      if (done.notice) notices.push(done.notice);
      results.push(done.json.success
        ? { kind: it.kind, refId: it.refId, ok: true, report: done.json.report }
        : { kind: it.kind, refId: it.refId, ok: false, error: done.json.error });
    }
    if (notices.length) {
      const lines = notices.map((n) => `• ${n.bdaName}: ${n.line}`).join('\n');
      await tellAdmins(`📝 **${notices.length} absence ${notices.length === 1 ? 'report' : 'reports'} to review**\n${lines}\nReason: ${checked.reason}\nOpen the Deductions tab in the CRM to approve or reject.`);
    }
    const succeeded = results.filter((r) => r.ok).length;
    return res.status(200).json({ success: true, results, succeeded, failed: results.length - succeeded });
  });

  app.post(`${BASE}/:id/approve`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      if (!(await requestIsAdmin(req))) return fail(res, 403, 'forbidden', 'Admin access required');
      const report = await BdaAbsenceReportModel.findOne({ reportId: String(req.params.id) }).lean();
      if (!report) return fail(res, 404, 'not_found', 'Report not found');
      if (report.status !== 'pending') return fail(res, 409, 'not_pending', `This report is already ${report.status}`);
      const note = req.body?.note == null || req.body.note === '' ? null : cleanReason(req.body.note);
      if (note?.error) return fail(res, note.error.status, note.error.code, note.error.message);

      const call = await loadCall(report.kind, report.refId);
      if (!call) return fail(res, 404, 'call_not_found', 'The call behind this report no longer exists');
      const eligible = checkEligible(call, Date.now(), { admin: true });
      if (!eligible.ok) return fail(res, eligible.status, eligible.code, `${eligible.message}. Reject this report instead.`);
      if (call.bdaEmail !== report.bdaEmail) return fail(res, 409, 'bda_changed', 'The call was reassigned since this report, reject it instead');

      const actor = actorOf(req);
      const result = await applyAbsence(call, { actor, reason: report.reason, requestId: report.reportId, force: req.body?.force === true });
      if (!result.ok) return fail(res, result.status, result.code, result.message);
      const updated = await BdaAbsenceReportModel.findOneAndUpdate(
        { reportId: report.reportId, status: 'pending' },
        { $set: { status: 'approved', decidedBy: actor.email || 'admin', decidedByName: actor.name || null, decidedAt: new Date(), decisionNote: note?.reason ?? null, deductionId: result.deduction.deductionId } },
        { new: true }
      ).lean();
      return res.status(200).json({ success: true, report: updated ? toRow(updated) : null, deductionId: result.deduction.deductionId });
    } catch (err) {
      console.error('[absenceRoutes] approve failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not approve the report');
    }
  });

  app.post(`${BASE}/:id/reject`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      if (!(await requestIsAdmin(req))) return fail(res, 403, 'forbidden', 'Admin access required');
      const checked = cleanReason(req.body?.reason);
      if (checked.error) return fail(res, checked.error.status, checked.error.code, checked.error.message);
      const actor = actorOf(req);
      const updated = await BdaAbsenceReportModel.findOneAndUpdate(
        { reportId: String(req.params.id), status: 'pending' },
        { $set: { status: 'rejected', decidedBy: actor.email || 'admin', decidedByName: actor.name || null, decidedAt: new Date(), decisionNote: checked.reason } },
        { new: true }
      ).lean();
      if (!updated) {
        const exists = await BdaAbsenceReportModel.findOne({ reportId: String(req.params.id) }).select('status').lean();
        return exists ? fail(res, 409, 'not_pending', `This report is already ${exists.status}`) : fail(res, 404, 'not_found', 'Report not found');
      }
      return res.status(200).json({ success: true, report: toRow(updated) });
    } catch (err) {
      console.error('[absenceRoutes] reject failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not reject the report');
    }
  });

  app.post(`${BASE}/:id/cancel`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const admin = await requestIsAdmin(req);
      const me = norm(req.crmUser?.email);
      const filter = { reportId: String(req.params.id), status: 'pending' };
      if (!admin) {
        if (!me) return fail(res, 401, 'unauthorized', 'Token has no email');
        filter.bdaEmail = me; // a BDA withdraws only their own report
      }
      const actor = actorOf(req);
      const updated = await BdaAbsenceReportModel.findOneAndUpdate(
        filter,
        { $set: { status: 'cancelled', decidedBy: actor.email || 'admin', decidedByName: actor.name || null, decidedAt: new Date() } },
        { new: true }
      ).lean();
      if (!updated) return fail(res, 404, 'not_found', 'No pending report of yours with that id');
      return res.status(200).json({ success: true, report: toRow(updated) });
    } catch (err) {
      console.error('[absenceRoutes] cancel failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not cancel the report');
    }
  });
}

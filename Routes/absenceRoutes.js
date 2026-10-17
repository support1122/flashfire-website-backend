import { BdaAbsenceReportModel, ABSENCE_KINDS, ABSENCE_STATUSES } from '../Schema_Models/BdaAbsenceReport.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { SalesLeadAllocationModel } from '../Schema_Models/SalesLeadAllocation.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getAllBdaProfiles, getBdaProfile, getTrackedBdas } from '../Utils/BdaRegistry.js';
import { getAssignedBdaEmail } from '../Utils/BdaAssignment.js';
import { getDeductionsMode, monthBoundsIST } from '../Utils/deductionPolicy.js';
import { postAdminChannel } from '../Utils/attendanceDiscord.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { escapeRegex } from '../Utils/SalesAllocations.js';
import { LOOKBACK_MS, applyAbsence, checkEligible, cleanReason, loadCall, validateReportInput } from '../Utils/AbsenceReports.js';
import { actorOf, requireCrmUserOrAdmin } from './deductionRoutes.js';

// "Mark absent" API. Admins mark a call absent directly (the fine is written at once). A BDA can only report a miss
// on their own call; it waits as `pending` until an admin approves it, and only then does a fine exist.
// Same error shape as the other CRM APIs: { success:false, error:{ code, message } }.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const norm = (e) => String(e ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);

const LIST_CAP = 300;
const CANDIDATE_CAP = 60;

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
      const since = new Date(nowMs - LOOKBACK_MS);

      let calls = [];
      if (kind === 'allocation') {
        const filter = { status: 'scheduled', callAt: { $lt: now, $gte: since } };
        if (bdaEmail) filter.bdaEmail = bdaEmail;
        if (q) {
          const rx = new RegExp(escapeRegex(q), 'i');
          filter.$or = [{ clientName: rx }, { phone: rx }, { email: rx }];
        }
        const docs = await SalesLeadAllocationModel.find(filter).sort({ callAt: -1 }).limit(CANDIDATE_CAP).lean();
        calls = docs.map((a) => ({ kind, refId: a.allocationId, bdaEmail: a.bdaEmail, bdaName: a.bdaName, clientName: a.clientName, callStart: a.callAt, detail: [a.phone, a.email].filter(Boolean).join(' · ') }));
      } else {
        const filter = { scheduledEventStartTime: { $lt: now, $gte: since }, bookingStatus: { $nin: ['canceled', 'rescheduled', 'not-scheduled'] } };
        if (bdaEmail) {
          filter.$or = [{ 'attendanceAssignee.email': bdaEmail }, { 'calendlyHost.email': bdaEmail }, { 'claimedBy.email': bdaEmail }];
        }
        if (q) {
          const rx = new RegExp(escapeRegex(q), 'i');
          filter.$and = [{ $or: [{ clientName: rx }, { clientEmail: rx }, { clientPhone: rx }, { bookingId: rx }] }];
        }
        const docs = await CampaignBookingModel.find(filter)
          .select('bookingId clientName clientEmail clientPhone scheduledEventStartTime attendanceAssignee calendlyHost claimedBy')
          .sort({ scheduledEventStartTime: -1 })
          .limit(CANDIDATE_CAP * 3)
          .lean();
        const tracked = new Set((await getTrackedBdas()).map((p) => p.email));
        calls = docs
          .map((b) => ({ b, assigned: getAssignedBdaEmail(b) }))
          .filter(({ assigned }) => assigned && tracked.has(assigned) && (!bdaEmail || assigned === bdaEmail))
          .slice(0, CANDIDATE_CAP)
          .map(({ b, assigned }) => ({ kind, refId: b.bookingId, bdaEmail: assigned, bdaName: null, clientName: b.clientName, callStart: b.scheduledEventStartTime, detail: [b.clientPhone, b.clientEmail].filter(Boolean).join(' · ') }));
      }

      // Hide calls that already carry a fine or an open/approved report, since a second one would be refused.
      const refs = calls.map((c) => c.refId);
      const [fined, reported, profiles] = await Promise.all([
        refs.length ? BdaDeductionModel.find({ bookingId: { $in: refs }, rule: 'missed_meeting' }).select('bookingId bdaEmail').lean() : [],
        refs.length ? BdaAbsenceReportModel.find({ kind, refId: { $in: refs }, status: { $in: ['pending', 'approved'] } }).select('refId bdaEmail').lean() : [],
        getAllBdaProfiles(),
      ]);
      const taken = new Set([...fined.map((d) => `${d.bookingId}|${d.bdaEmail}`), ...reported.map((r) => `${r.refId}|${r.bdaEmail}`)]);
      const names = new Map(profiles.map((p) => [p.email, p.displayName]));
      const out = calls
        .filter((c) => !taken.has(`${c.refId}|${c.bdaEmail}`))
        .map((c) => ({ ...c, bdaName: c.bdaName || names.get(c.bdaEmail) || c.bdaEmail.split('@')[0], callStart: iso(c.callStart) }));
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

  app.post(BASE, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const parsed = validateReportInput(req.body);
      if (parsed.error) return fail(res, parsed.error.status, parsed.error.code, parsed.error.message);
      const { kind, refId, reason } = parsed.value;

      const admin = await requestIsAdmin(req);
      const actor = actorOf(req);
      const call = await loadCall(kind, refId);
      if (!call) return fail(res, 404, 'call_not_found', 'No such call');
      if (!call.bdaEmail) return fail(res, 409, 'no_bda', 'This call has no assigned BDA');
      const eligible = checkEligible(call);
      if (!eligible.ok) return fail(res, eligible.status, eligible.code, eligible.message);

      const profile = await getBdaProfile(call.bdaEmail);
      const bdaName = profile?.displayName || call.bdaEmail.split('@')[0];
      if (!profile || profile.active === false || profile.tracked !== true) {
        return fail(res, 409, 'not_tracked', `${bdaName} is not a tracked BDA`);
      }

      const open = await BdaAbsenceReportModel.findOne({ kind, refId, bdaEmail: call.bdaEmail, status: { $in: ['pending', 'approved'] } }).lean();

      if (!admin) {
        if (!actor.email || actor.email !== call.bdaEmail) return fail(res, 403, 'forbidden', 'You can only report your own calls');
        if (getDeductionsMode() === 'off') return fail(res, 409, 'fines_off', 'Fines are switched off right now');
        if (open) return fail(res, 409, 'already_reported', open.status === 'pending' ? 'This call already has a pending report' : 'This call was already marked absent');
        const created = await BdaAbsenceReportModel.create({
          kind, refId, bdaEmail: call.bdaEmail, bdaName, clientName: call.clientName, callStart: new Date(call.startMs), reason,
          raisedBy: 'bda', raisedByEmail: actor.email, raisedByName: actor.name || bdaName, status: 'pending',
        });
        await tellAdmins(`📝 **Absence report to review**\n${bdaName} reports a missed ${kind === 'allocation' ? 'allocated call' : 'meeting'} with ${call.clientName || 'a client'} (${istTime(call.startMs)}).\nReason: ${reason}\nOpen the Deductions tab in the CRM to approve or reject.`);
        return res.status(201).json({ success: true, report: toRow(created.toObject()) });
      }

      // Admin: mark absent now. A pending report from the BDA for the same call is settled by this action.
      if (open?.status === 'approved') return fail(res, 409, 'already_reported', 'This call was already marked absent');
      const reportId = open?.reportId || `abs_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
      const result = await applyAbsence(call, { actor, reason, requestId: reportId });
      if (!result.ok) return fail(res, result.status, result.code, result.message);
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
      return res.status(201).json({ success: true, report: report ? toRow(report) : null, deductionId: result.deduction.deductionId });
    } catch (err) {
      if (err?.code === 11000) return fail(res, 409, 'already_reported', 'This call already has a report');
      console.error('[absenceRoutes] create failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not record the absence');
    }
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
      const eligible = checkEligible(call);
      if (!eligible.ok) return fail(res, eligible.status, eligible.code, `${eligible.message}. Reject this report instead.`);
      if (call.bdaEmail !== report.bdaEmail) return fail(res, 409, 'bda_changed', 'The call was reassigned since this report, reject it instead');

      const actor = actorOf(req);
      const result = await applyAbsence(call, { actor, reason: report.reason, requestId: report.reportId });
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

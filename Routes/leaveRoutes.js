import { BdaLeaveRequestModel } from '../Schema_Models/BdaLeaveRequest.js';
import { getAllBdaProfiles } from '../Utils/BdaRegistry.js';
import { postAdminChannel } from '../Utils/attendanceDiscord.js';
import {
  actorOf,
  requireAdminLive,
  requireCrmUserOrAdmin,
  validateReason,
} from './deductionRoutes.js';
import {
  approveLeaveRequest,
  cancelLeaveRequest,
  expandDays,
  findDeductionsOnDays,
  rejectLeaveRequest,
} from '../Utils/LeaveRequests.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';

// Leave requests API. Same contract shape as the deductions API: { success:false, error:{ code, message } }.
// Auth reuses deductionRoutes: a crm_user token or the crm_admin token, and requireAdminLive for decisions.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const norm = (e) => String(e ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);

const LEAVE_STATUS_FILTERS = ['pending', 'approved', 'rejected', 'cancelled'];

function toRow(r, nameByEmail) {
  return {
    leaveRequestId: r.leaveRequestId,
    bdaEmail: r.bdaEmail,
    bdaName: r.bdaName || nameByEmail.get(r.bdaEmail) || r.bdaEmail.split('@')[0],
    days: r.days ?? [],
    fromDate: r.fromDate,
    toDate: r.toDate,
    dayCount: (r.days ?? []).length,
    reason: r.reason,
    status: r.status,
    decidedBy: r.decidedBy ?? null,
    decidedByName: r.decidedByName ?? null,
    decidedAt: iso(r.decidedAt),
    decisionNote: r.decisionNote ?? null,
    waivedDeductionIds: r.waivedDeductionIds ?? [],
    waivedAmountInr: r.waivedAmountInr ?? 0,
    createdAt: iso(r.createdAt),
  };
}

async function nameMap() {
  const profiles = await getAllBdaProfiles();
  return new Map(profiles.map((p) => [p.email, p.displayName || p.email.split('@')[0]]));
}

async function requestIsAdmin(req) {
  if (req.crmAdmin) return true;
  return isCrmAdmin(req.crmUser);
}

export function registerLeaveRoutes(app) {
  // A BDA sees their own requests, an admin sees everyone's. Optional ?status= and ?bdaEmail= (admin only).
  app.get('/api/crm/leave-requests', requireCrmUserOrAdmin, async (req, res) => {
    try {
      const admin = await requestIsAdmin(req);
      const filter = {};

      const status = String(req.query.status ?? '').trim();
      if (status && status !== 'all') {
        if (!LEAVE_STATUS_FILTERS.includes(status)) {
          return fail(res, 422, 'invalid_status', `status must be one of: ${LEAVE_STATUS_FILTERS.join(', ')}, all`);
        }
        filter.status = status;
      }

      if (admin) {
        const requested = norm(req.query.bdaEmail);
        if (requested) filter.bdaEmail = requested;
      } else {
        const own = norm(req.crmUser?.email);
        if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
        filter.bdaEmail = own;
      }

      const [docs, names] = await Promise.all([
        BdaLeaveRequestModel.find(filter).sort({ createdAt: -1 }).limit(500).lean(),
        nameMap(),
      ]);
      return res.status(200).json({
        success: true,
        admin,
        rows: docs.map((d) => toRow(d, names)),
        pendingCount: docs.filter((d) => d.status === 'pending').length,
      });
    } catch (err) {
      console.error('[leaveRoutes] list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load leave requests');
    }
  });

  // A BDA files a request for themselves. Admins file against their own email too; to grant leave to
  // someone else an admin edits leaveDays directly on the BDA registry screen.
  app.post('/api/crm/leave-requests', requireCrmUserOrAdmin, async (req, res) => {
    try {
      const own = norm(req.crmUser?.email || req.crmAdmin?.email);
      if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');

      const checked = validateReason(req.body?.reason);
      if (!checked.reason) return fail(res, checked.status, checked.code, checked.message);

      const fromDate = String(req.body?.fromDate ?? '').trim();
      const toDate = String(req.body?.toDate ?? fromDate).trim();
      const expanded = expandDays(fromDate, toDate);
      if (expanded.error) return fail(res, 422, expanded.error.code, expanded.error.message);
      const { days } = expanded;

      // Block a second live request for a day that is already spoken for, so one day cannot be
      // approved twice and waive the same fines under two different requests.
      const clash = await BdaLeaveRequestModel.findOne({
        bdaEmail: own,
        status: { $in: ['pending', 'approved'] },
        days: { $in: days },
      })
        .select('leaveRequestId status days')
        .lean();
      if (clash) {
        const overlap = clash.days.filter((d) => days.includes(d));
        return fail(
          res,
          409,
          'overlapping_request',
          `You already have a ${clash.status} request covering ${overlap.join(', ')}`
        );
      }

      const created = await BdaLeaveRequestModel.create({
        bdaEmail: own,
        bdaName: req.crmUser?.name || req.crmAdmin?.name || null,
        days,
        fromDate: days[0],
        toDate: days[days.length - 1],
        reason: checked.reason,
        status: 'pending',
      });

      const names = await nameMap();
      const row = toRow(created.toObject(), names);
      const range = row.fromDate === row.toDate ? row.fromDate : `${row.fromDate} to ${row.toDate}`;
      postAdminChannel(
        `🌴 **Leave request** from ${row.bdaName} for ${range} (${row.dayCount} day${row.dayCount === 1 ? '' : 's'}): ${row.reason}`
      ).catch((err) => console.warn('[leaveRoutes] request notice failed:', err?.message));

      return res.status(201).json({ success: true, request: row });
    } catch (err) {
      console.error('[leaveRoutes] create failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not file the leave request');
    }
  });

  // What approving would waive, so the admin decides with the cost in front of them.
  app.get('/api/crm/leave-requests/:leaveRequestId/impact', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const reqDoc = await BdaLeaveRequestModel.findOne({ leaveRequestId: String(req.params.leaveRequestId) }).lean();
      if (!reqDoc) return fail(res, 404, 'leave_request_not_found', 'No such leave request');
      const rows = await findDeductionsOnDays(reqDoc.bdaEmail, reqDoc.days);
      return res.status(200).json({
        success: true,
        count: rows.length,
        amountInr: rows.reduce((s, r) => s + Number(r.amountInr || 0), 0),
        deductions: rows.map((r) => ({
          deductionId: r.deductionId,
          rule: r.rule,
          amountInr: r.amountInr,
          status: r.status,
          scheduledStart: iso(r?.evidence?.scheduledStart),
        })),
      });
    } catch (err) {
      console.error('[leaveRoutes] impact failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not work out the impact');
    }
  });

  app.post('/api/crm/leave-requests/:leaveRequestId/approve', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
      const out = await approveLeaveRequest(String(req.params.leaveRequestId), actorOf(req), note);
      if (!out.ok) return fail(res, out.status, out.code, out.message);

      const names = await nameMap();
      const row = toRow(out.request, names);
      const range = row.fromDate === row.toDate ? row.fromDate : `${row.fromDate} to ${row.toDate}`;
      postAdminChannel(
        `✅ **Leave approved** for ${row.bdaName}, ${range} (by ${row.decidedByName || row.decidedBy}). ` +
          `Waived ${out.waived.count} deduction${out.waived.count === 1 ? '' : 's'} worth ₹${out.waived.amountInr}.`
      ).catch((err) => console.warn('[leaveRoutes] approval notice failed:', err?.message));

      return res.status(200).json({ success: true, request: row, waived: out.waived, daysAdded: out.daysAdded });
    } catch (err) {
      console.error('[leaveRoutes] approve failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not approve the leave request');
    }
  });

  app.post('/api/crm/leave-requests/:leaveRequestId/reject', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const checked = validateReason(req.body?.note ?? req.body?.reason);
      if (!checked.reason) return fail(res, checked.status, checked.code, checked.message);
      const out = await rejectLeaveRequest(String(req.params.leaveRequestId), actorOf(req), checked.reason);
      if (!out.ok) return fail(res, out.status, out.code, out.message);
      const names = await nameMap();
      return res.status(200).json({ success: true, request: toRow(out.request, names) });
    } catch (err) {
      console.error('[leaveRoutes] reject failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not reject the leave request');
    }
  });

  app.post('/api/crm/leave-requests/:leaveRequestId/cancel', requireCrmUserOrAdmin, async (req, res) => {
    try {
      const own = norm(req.crmUser?.email || req.crmAdmin?.email);
      if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
      const out = await cancelLeaveRequest(String(req.params.leaveRequestId), own);
      if (!out.ok) return fail(res, out.status, out.code, out.message);
      const names = await nameMap();
      return res.status(200).json({ success: true, request: toRow(out.request, names) });
    } catch (err) {
      console.error('[leaveRoutes] cancel failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not cancel the leave request');
    }
  });
}

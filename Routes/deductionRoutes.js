import jwt from 'jsonwebtoken';
import { getCrmJwtSecret, requireCrmPermission, requireCrmUser } from '../Middlewares/CrmAuth.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { pullDeductions } from '../Controllers/PayrollController.js';
import { getAllBdaProfiles, getTrackedBdas } from '../Utils/BdaRegistry.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { activateDeduction, convertFlagToMiss, waiveDeduction } from '../Utils/DeductionEngine.js';
import { DEDUCTION_RULES, buildTotals, getDeductionsMode, monthBoundsIST, monthKeyIST } from '../Utils/deductionPolicy.js';

// Deductions API (plan 8.3, api-contracts.md). Errors use the shared shape { success:false, error:{ code, message } }.
//
// Auth: every route accepts EITHER a CRM user token (role crm_user) OR the admin token the CRM gets from the
// /admin/analysis gate (role crm_admin). A crm_admin token is an admin by construction. A crm_user is an admin only
// when isCrmAdmin says so (reads the database: role 'admin' or isAdmin true, never the token's bdaRole).

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const norm = (e) => String(e ?? '').trim().toLowerCase();

// requireCrmUser / requireCrmPermission answer in the older { error: 'text' } shape. Re-shape those answers.
function runLegacy(mw, req, res, next) {
  const proxy = {
    code: 401,
    status(code) {
      this.code = code;
      return this;
    },
    json(body) {
      const text = typeof body?.error === 'string' ? body.error : 'Not allowed';
      return fail(res, this.code, this.code === 403 ? 'forbidden' : 'unauthorized', text);
    },
  };
  return mw(req, proxy, next);
}

/** Accept a crm_admin token or a crm_user token. Sets req.crmAdmin or req.crmUser. */
export function requireCrmUserOrAdmin(req, res, next) {
  const header = String(req.headers?.authorization || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'unauthorized', 'Missing Authorization bearer token');
  let payload;
  try {
    payload = jwt.verify(token, getCrmJwtSecret());
  } catch {
    return fail(res, 401, 'unauthorized', 'Invalid or expired token');
  }
  if (payload?.role === 'crm_admin') {
    req.crmAdmin = payload;
    return next();
  }
  if (payload?.role === 'crm_user') return runLegacy(requireCrmUser, req, res, next); // also checks the session
  return fail(res, 403, 'forbidden', 'This token cannot use this endpoint');
}

/** True when the request is from an admin (admin token, or a user the database says is an admin). */
async function requestIsAdmin(req) {
  if (req.crmAdmin) return true;
  return isCrmAdmin(req.crmUser);
}

async function requireAdminLive(req, res, next) {
  try {
    if (await requestIsAdmin(req)) return next();
    return fail(res, 403, 'forbidden', 'Admin access required');
  } catch (err) {
    console.error('[deductionRoutes] admin check failed:', err?.message);
    return fail(res, 503, 'admin_check_failed', 'Could not verify admin access, try again');
  }
}

/** Who to write into waivedBy / reviewedBy. The old password gate issues a token with no email. */
function actorOf(req) {
  if (req.crmAdmin) return { email: norm(req.crmAdmin.email) || null, name: req.crmAdmin.name || 'Admin' };
  return { email: norm(req.crmUser?.email) || null, name: req.crmUser?.name || null };
}

// ---- response shaping ----------------------------------------------------------------------------------------

const iso = (d) => (d ? new Date(d).toISOString() : null);

function toRow(d, nameByEmail) {
  const ev = d.evidence || {};
  return {
    deductionId: d.deductionId,
    bdaEmail: d.bdaEmail,
    bdaName: nameByEmail.get(d.bdaEmail) || d.bdaEmail.split('@')[0],
    bookingId: d.bookingId,
    clientName: ev.clientName ?? '',
    rule: d.rule,
    month: d.month,
    amountInr: d.amountInr,
    tierIndex: d.tierIndex ?? null,
    status: d.status,
    evidence: {
      scheduledStart: iso(ev.scheduledStart),
      windowClosedAt: iso(ev.windowClosedAt),
      signals: ev.signals ?? [],
      bookingStatus: ev.bookingStatus ?? null,
      callSummary: ev.callSummary ?? {},
      clientName: ev.clientName ?? '',
      healthy: ev.healthy ?? null,
      convertedFromFlag: ev.convertedFromFlag ?? null,
    },
    waivedBy: d.waivedBy ?? null,
    waivedByName: d.waivedByName ?? null,
    waivedAt: iso(d.waivedAt),
    waiverReason: d.waiverReason ?? null,
    voidedAt: iso(d.voidedAt),
    voidReason: d.voidReason ?? null,
    reviewedBy: d.reviewedBy ?? null,
    reviewedByName: d.reviewedByName ?? null,
    reviewedAt: iso(d.reviewedAt),
    reviewReason: d.reviewReason ?? null,
    createdAt: iso(d.createdAt),
  };
}

async function nameMap() {
  const profiles = await getAllBdaProfiles();
  return new Map(profiles.map((p) => [p.email, p.displayName || p.email.split('@')[0]]));
}

function parseMonth(raw) {
  if (raw == null || raw === '') return { month: monthKeyIST(Date.now()) };
  const month = String(raw);
  return monthBoundsIST(month) ? { month } : { error: true };
}

/** 5 to 500 characters, trimmed. Returns { reason } or { status, code, message }. */
export function validateReason(raw) {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 5) return { status: 422, code: 'reason_required', message: 'A reason of 5 to 500 characters is required' };
  if (reason.length > 500) return { status: 422, code: 'reason_too_long', message: 'The reason can be at most 500 characters' };
  return { reason };
}

const sendAction = async (res, result) => {
  if (!result.ok) return fail(res, result.status, result.code, result.message);
  return res.status(200).json({ success: true, deduction: toRow(result.deduction, await nameMap()) });
};

// ---- routes ---------------------------------------------------------------------------------------------------

export function registerDeductionRoutes(app) {
  // BDA: own rows only. Admin: everyone, optional bdaEmail.
  app.get('/api/crm/deductions', requireCrmUserOrAdmin, async (req, res) => {
    try {
      const parsed = parseMonth(req.query.month);
      if (parsed.error) return fail(res, 422, 'invalid_month', 'month must look like 2026-10');
      const { month } = parsed;

      const admin = await requestIsAdmin(req);
      const requested = norm(req.query.bdaEmail);
      const filter = { month };
      if (admin) {
        if (requested) filter.bdaEmail = requested;
      } else {
        const own = norm(req.crmUser?.email);
        if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
        if (requested && requested !== own) return fail(res, 403, 'forbidden', 'You can only see your own deductions');
        filter.bdaEmail = own;
        filter.status = { $in: ['active', 'needs_review', 'waived', 'voided'] }; // shadow rows are admin only
      }

      const [docs, names] = await Promise.all([
        BdaDeductionModel.find(filter).sort({ 'evidence.scheduledStart': -1, createdAt: -1 }).lean(),
        nameMap(),
      ]);
      return res.status(200).json({
        success: true,
        month,
        mode: getDeductionsMode(),
        rows: docs.map((d) => toRow(d, names)),
        totals: buildTotals(docs), // active rows only, so needs_review ("Under review") never counts
      });
    } catch (err) {
      console.error('[deductionRoutes] list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load deductions');
    }
  });

  app.get('/api/crm/deductions/summary', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const parsed = parseMonth(req.query.month);
      if (parsed.error) return fail(res, 422, 'invalid_month', 'month must look like 2026-10');
      const { month } = parsed;
      const [docs, names, tracked] = await Promise.all([
        BdaDeductionModel.find({ month, status: 'active' }).select('bdaEmail rule amountInr status').lean(),
        nameMap(),
        getTrackedBdas(),
      ]);
      const emails = new Set([...tracked.map((p) => p.email), ...docs.map((d) => d.bdaEmail)]);
      const perBda = [...emails]
        .map((bdaEmail) => {
          const totals = buildTotals(docs.filter((d) => d.bdaEmail === bdaEmail));
          const count = DEDUCTION_RULES.reduce((s, r) => s + totals.byRule[r].count, 0);
          return {
            bdaEmail,
            name: names.get(bdaEmail) || bdaEmail.split('@')[0],
            activeAmountInr: totals.activeAmountInr,
            count,
            byRule: totals.byRule,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.status(200).json({ success: true, month, perBda });
    } catch (err) {
      console.error('[deductionRoutes] summary failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load the deduction summary');
    }
  });

  app.post('/api/crm/deductions/:deductionId/waive', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const checked = validateReason(req.body?.reason);
      if (!checked.reason) return fail(res, checked.status, checked.code, checked.message);
      return sendAction(res, await waiveDeduction(String(req.params.deductionId), actorOf(req), checked.reason));
    } catch (err) {
      console.error('[deductionRoutes] waive failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not waive the deduction');
    }
  });

  app.post('/api/crm/deductions/:deductionId/activate', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const checked = validateReason(req.body?.reason);
      if (!checked.reason) return fail(res, checked.status, checked.code, checked.message);
      const action = req.body?.action ?? 'activate';
      if (action !== 'activate' && action !== 'waive') {
        return fail(res, 422, 'invalid_action', 'action must be "activate" or "waive"');
      }
      return sendAction(
        res,
        await activateDeduction(String(req.params.deductionId), actorOf(req), checked.reason, action)
      );
    } catch (err) {
      console.error('[deductionRoutes] activate failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not update the deduction');
    }
  });

  // Decision D10: an admin turns a "marked present, never joined" flag into a missed meeting.
  app.post(
    '/api/crm/admin/attendance/:bookingId/convert-to-miss',
    requireCrmUserOrAdmin,
    requireAdminLive,
    async (req, res) => {
      try {
        const checked = validateReason(req.body?.reason);
        if (!checked.reason) return fail(res, checked.status, checked.code, checked.message);
        const bdaEmail = norm(req.body?.bdaEmail);
        if (!bdaEmail) return fail(res, 422, 'bda_email_required', 'bdaEmail is required');
        return sendAction(
          res,
          await convertFlagToMiss({
            bookingId: String(req.params.bookingId),
            bdaEmail,
            reason: checked.reason,
            actor: actorOf(req),
          })
        );
      } catch (err) {
        console.error('[deductionRoutes] convert-to-miss failed:', err?.message);
        return fail(res, 500, 'internal_error', 'Could not convert the flag');
      }
    }
  );

  // Payroll "Pull deductions": dry run unless the body says apply:true. The admin token passes; a CRM user needs
  // the same `payroll` permission the other payroll routes ask for.
  const payrollAccess = (req, res, next) =>
    req.crmAdmin ? next() : runLegacy(requireCrmPermission('payroll'), req, res, next);
  app.post('/api/payroll/pull-deductions', requireCrmUserOrAdmin, payrollAccess, pullDeductions);
}

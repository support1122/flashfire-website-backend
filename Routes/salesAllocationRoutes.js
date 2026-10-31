import { SalesLeadAllocationModel, ALLOCATION_STATUSES } from '../Schema_Models/SalesLeadAllocation.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getBdaProfile, getTrackedBdas } from '../Utils/BdaRegistry.js';
import { actorOf, requireAdminLive, requireCrmUserOrAdmin } from './deductionRoutes.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { getAllocationCallChecksSafe } from '../Utils/AllocationCallCheck.js';
import { detectTimezoneFromPhone } from '../Utils/PhoneTimezoneDetector.js';
import { workDayBounds, workDayOf, workDayStartHour } from '../Utils/WorkDay.js';
import {
  crmLinkFor,
  escapeRegex,
  guessTimezoneFromPhone,
  phoneBookingFilter,
  isOnLeaveAt,
  parseInstant,
  validateAllocationInput,
} from '../Utils/SalesAllocations.js';

// Sales Lead Allocation API. Same error shape as the leave API: { success:false, error:{ code, message } }.
// Admins create and reassign calls; a BDA sees and closes only the calls assigned to them.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });
const norm = (e) => String(e ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);

const PAST_GRACE_MS = 30 * 60 * 1000;
const LIST_CAP = 300;
const LOOKUP_MAX = 8;

export function toRow(a) {
  return {
    allocationId: a.allocationId,
    clientName: a.clientName,
    phone: a.phone ?? null,
    email: a.email ?? null,
    timezone: a.timezone,
    callAt: iso(a.callAt),
    bdaEmail: a.bdaEmail,
    bdaName: a.bdaName ?? null,
    status: a.status,
    notes: a.notes ?? null,
    outcomeNote: a.outcomeNote ?? null,
    createdBy: a.createdBy ?? null,
    createdByName: a.createdByName ?? null,
    createdAt: iso(a.createdAt),
    reminderState: a.reminderState,
    reminderSentAt: iso(a.reminderSentAt),
    crmUrl: crmLinkFor(a.allocationId),
  };
}

async function requestIsAdmin(req) {
  if (req.crmAdmin) return true;
  return isCrmAdmin(req.crmUser);
}

/** Resolve the BDA for an assignment. Returns { profile } or { error: { status, code, message } }. */
async function checkAssignableBda(bdaEmail, callAt) {
  const profile = await getBdaProfile(bdaEmail);
  if (!profile || profile.active === false || profile.tracked !== true) {
    return { error: { status: 400, code: 'unknown_bda', message: 'bdaEmail is not a tracked BDA' } };
  }
  if (isOnLeaveAt(profile.leaveDays, callAt, workDayStartHour(profile))) {
    return {
      error: {
        status: 409,
        code: 'bda_on_leave',
        message: `${profile.displayName || profile.email} is on approved leave for the ${workDayOf(callAt, profile)} working day`,
      },
    };
  }
  return { profile };
}

/** Email fragments are matched as an anchored prefix so the email indexes can serve the query. */
function parseLookupQuery(q) {
  const text = String(q ?? '').trim();
  if (text.length < 3) return null;
  if (/[@a-z]/i.test(text)) return { kind: 'email', email: text.toLowerCase() };
  const digits = text.replace(/\D/g, '');
  if (digits.length < 3) return null;
  return { kind: 'phone', digits };
}

export function registerSalesAllocationRoutes(app) {
  const BASE = '/api/crm/sales-allocations';

  app.get(BASE, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const admin = await requestIsAdmin(req);
      const now = Date.now();
      const scope = String(req.query.scope ?? 'upcoming').trim() || 'upcoming';
      if (!['upcoming', 'past', 'all'].includes(scope)) {
        return fail(res, 400, 'invalid_scope', 'scope must be upcoming, past or all');
      }
      const clauses = [];
      const status = String(req.query.status ?? '').trim();
      if (status && status !== 'all') {
        if (!ALLOCATION_STATUSES.includes(status)) {
          return fail(res, 400, 'invalid_status', `status must be one of: ${ALLOCATION_STATUSES.join(', ')}, all`);
        }
        clauses.push({ status });
      }
      const cutoff = new Date(now - PAST_GRACE_MS);
      if (scope === 'upcoming') clauses.push({ status: 'scheduled', callAt: { $gte: cutoff } });
      if (scope === 'past') clauses.push({ $or: [{ status: { $ne: 'scheduled' } }, { callAt: { $lt: cutoff } }] });

      if (admin) {
        const requested = norm(req.query.bdaEmail);
        if (requested) clauses.push({ bdaEmail: requested });
      } else {
        const own = norm(req.crmUser?.email);
        if (!own) return fail(res, 401, 'unauthorized', 'Token has no email');
        clauses.push({ bdaEmail: own });
      }

      const filter = clauses.length ? { $and: clauses } : {};
      const docs = await SalesLeadAllocationModel.find(filter)
        .sort({ callAt: scope === 'upcoming' ? 1 : -1 })
        .limit(LIST_CAP)
        .lean();
      // What the Zoom call log says about each call. A failure only blanks callCheck, never the list.
      const checks = await getAllocationCallChecksSafe(docs, undefined, now);
      const allocations = docs.map((a) => ({ ...toRow(a), callCheck: checks.get(a.allocationId) ?? null }));
      return res.status(200).json({ success: true, isAdmin: admin, allocations });
    } catch (err) {
      console.error('[salesAllocationRoutes] list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load allocations');
    }
  });

  app.get(`${BASE}/lookup`, requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const parsed = parseLookupQuery(req.query.q);
      if (!parsed) return fail(res, 400, 'query_too_short', 'q needs at least 3 characters (email fragment or phone digits)');

      let bookingFilter;
      let allocFilter;
      if (parsed.kind === 'email') {
        const re = new RegExp(`^${escapeRegex(parsed.email)}`);
        bookingFilter = { clientEmail: re };
        allocFilter = { email: re };
      } else {
        bookingFilter = phoneBookingFilter(parsed.digits);
        const tail = parsed.digits.length >= 10 ? `|${escapeRegex(parsed.digits.slice(-10))}$` : '';
        allocFilter = { phone: new RegExp(`^\\+?${escapeRegex(parsed.digits)}${tail}`) };
      }

      const [bookings, allocs] = await Promise.all([
        CampaignBookingModel.find(bookingFilter)
          .select('clientName clientEmail clientPhone inviteeTimezone bookingCreatedAt')
          .sort({ bookingCreatedAt: -1 })
          .limit(20)
          .lean(),
        SalesLeadAllocationModel.find(allocFilter)
          .select('clientName email phone timezone createdAt')
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
      ]);

      const seen = new Set();
      const matches = [];
      const push = (m) => {
        const keys = [m.email && `e:${m.email}`, m.phone && `p:${String(m.phone).replace(/\D/g, '')}`].filter(Boolean);
        if (!keys.length || keys.some((k) => seen.has(k))) return;
        keys.forEach((k) => seen.add(k));
        matches.push(m);
      };
      for (const b of bookings) {
        push({
          clientName: b.clientName,
          email: b.clientEmail || null,
          phone: b.clientPhone || null,
          timezone: b.inviteeTimezone || guessTimezoneFromPhone(b.clientPhone, detectTimezoneFromPhone),
          source: 'booking',
        });
      }
      for (const a of allocs) {
        push({ clientName: a.clientName, email: a.email || null, phone: a.phone || null, timezone: a.timezone || null, source: 'allocation' });
      }
      return res.status(200).json({ success: true, matches: matches.slice(0, LOOKUP_MAX) });
    } catch (err) {
      console.error('[salesAllocationRoutes] lookup failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not search leads');
    }
  });

  app.get(`${BASE}/bdas`, requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const callAt = parseInstant(String(req.query.callAt ?? ''));
      if (!callAt) return fail(res, 400, 'invalid_call_time', 'callAt must be an ISO timestamp with a UTC offset or Z');
      // "Calls that day" counts the working day the call falls in (a shift that crosses midnight is one day).
      const bounds = workDayBounds(workDayOf(callAt));

      const [bdas, counts] = await Promise.all([
        getTrackedBdas(),
        SalesLeadAllocationModel.aggregate([
          { $match: { status: 'scheduled', callAt: { $gte: bounds.start, $lt: bounds.end } } },
          { $group: { _id: '$bdaEmail', n: { $sum: 1 } } },
        ]),
      ]);
      const countBy = new Map(counts.map((c) => [c._id, c.n]));
      const list = bdas.map((p) => {
        const onLeave = isOnLeaveAt(p.leaveDays, callAt, workDayStartHour(p));
        return {
          email: p.email,
          name: p.displayName || p.email.split('@')[0],
          available: !onLeave,
          reason: onLeave ? 'on_leave' : null,
          callsThatDay: countBy.get(p.email) || 0,
        };
      });
      list.sort((a, b) => Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
      return res.status(200).json({ success: true, bdas: list });
    } catch (err) {
      console.error('[salesAllocationRoutes] bdas failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load BDAs');
    }
  });

  app.post(BASE, requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const checked = validateAllocationInput(req.body);
      if (checked.error) return fail(res, 400, checked.error.code, checked.error.message);
      const v = checked.value;

      const bda = await checkAssignableBda(v.bdaEmail, v.callAt);
      if (bda.error) return fail(res, bda.error.status, bda.error.code, bda.error.message);

      const actor = actorOf(req);
      const created = await SalesLeadAllocationModel.create({
        clientName: v.clientName,
        phone: v.phone,
        email: v.email,
        timezone: v.timezone,
        callAt: v.callAt,
        bdaEmail: bda.profile.email,
        bdaName: bda.profile.displayName || bda.profile.email.split('@')[0],
        notes: v.notes,
        createdBy: actor.email,
        createdByName: actor.name,
      });
      return res.status(201).json({ success: true, allocation: toRow(created.toObject()) });
    } catch (err) {
      console.error('[salesAllocationRoutes] create failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not create the allocation');
    }
  });

  app.post(`${BASE}/:id/reassign`, requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const id = String(req.params.id);
      const bdaEmail = norm(req.body?.bdaEmail);
      if (!bdaEmail) return fail(res, 400, 'invalid_bda', 'bdaEmail is required');

      const current = await SalesLeadAllocationModel.findOne({ allocationId: id }).lean();
      if (!current) return fail(res, 404, 'not_found', 'Allocation not found');
      if (current.status !== 'scheduled') return fail(res, 409, 'not_scheduled', `Allocation is already ${current.status}`);

      const bda = await checkAssignableBda(bdaEmail, current.callAt);
      if (bda.error) return fail(res, bda.error.status, bda.error.code, bda.error.message);

      // The new BDA still needs their reminder unless one already went out for this call.
      const now = new Date();
      const earlyCutoff = new Date(now.getTime() + 5 * 60 * 1000);
      const updated = await SalesLeadAllocationModel.findOneAndUpdate(
        { allocationId: id, status: 'scheduled' },
        [
          {
            $set: {
              bdaEmail: bda.profile.email,
              bdaName: bda.profile.displayName || bda.profile.email.split('@')[0],
              reminderState: {
                $cond: [
                  { $and: [{ $gt: ['$callAt', now] }, { $ne: ['$reminderState', 'sent'] }] },
                  'pending',
                  '$reminderState',
                ],
              },
              // The new BDA also needs the 30-minute heads-up, even if the previous BDA already got it, as long as
              // the call is still more than 5 minutes away (inside that, only the final reminder applies).
              earlyReminderState: {
                $cond: [{ $gt: ['$callAt', earlyCutoff] }, 'pending', '$earlyReminderState'],
              },
            },
          },
        ],
        { new: true }
      ).lean();
      if (!updated) return fail(res, 409, 'not_scheduled', 'Allocation changed, refresh and try again');
      return res.status(200).json({ success: true, allocation: toRow(updated) });
    } catch (err) {
      console.error('[salesAllocationRoutes] reassign failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not reassign the allocation');
    }
  });

  app.post(`${BASE}/:id/cancel`, requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const id = String(req.params.id);
      const updated = await SalesLeadAllocationModel.findOneAndUpdate(
        { allocationId: id, status: 'scheduled' },
        { $set: { status: 'cancelled', reminderState: 'skipped', earlyReminderState: 'skipped' } },
        { new: true }
      ).lean();
      if (updated) return res.status(200).json({ success: true, allocation: toRow(updated) });
      const exists = await SalesLeadAllocationModel.findOne({ allocationId: id }).select('status').lean();
      if (!exists) return fail(res, 404, 'not_found', 'Allocation not found');
      return fail(res, 409, 'not_scheduled', `Allocation is already ${exists.status}`);
    } catch (err) {
      console.error('[salesAllocationRoutes] cancel failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not cancel the allocation');
    }
  });

  app.post(`${BASE}/:id/outcome`, requireCrmUserOrAdmin, async (req, res) => {
    try {
      const id = String(req.params.id);
      const status = String(req.body?.status ?? '').trim();
      if (!['completed', 'no_answer'].includes(status)) {
        return fail(res, 400, 'invalid_status', 'status must be completed or no_answer');
      }
      const note = req.body?.note == null ? null : String(req.body.note).trim().slice(0, 2000) || null;

      const current = await SalesLeadAllocationModel.findOne({ allocationId: id }).lean();
      if (!current) return fail(res, 404, 'not_found', 'Allocation not found');

      const admin = await requestIsAdmin(req);
      const me = actorOf(req).email;
      if (!admin && (!me || me !== current.bdaEmail)) {
        return fail(res, 403, 'forbidden', 'Only the assigned BDA or an admin can record the outcome');
      }

      const updated = await SalesLeadAllocationModel.findOneAndUpdate(
        { allocationId: id, status: 'scheduled' },
        { $set: { status, outcomeNote: note, reminderState: current.reminderState === 'sent' ? 'sent' : 'skipped', earlyReminderState: current.earlyReminderState === 'sent' ? 'sent' : 'skipped' } },
        { new: true }
      ).lean();
      if (!updated) return fail(res, 409, 'not_scheduled', 'Allocation is no longer scheduled');
      return res.status(200).json({ success: true, allocation: toRow(updated) });
    } catch (err) {
      console.error('[salesAllocationRoutes] outcome failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not record the outcome');
    }
  });
}

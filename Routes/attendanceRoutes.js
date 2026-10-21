import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import { requireBdaExtension, requireCrmAdmin, requireCrmUser } from '../Middlewares/CrmAuth.js';
import { createUserRateLimiter } from '../Middlewares/perUserRateLimit.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import { BdaExtensionHeartbeatModel } from '../Schema_Models/BdaExtensionHeartbeat.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { findMeetingsOnLeave } from '../Utils/AttendanceVerdictJob.js';
import { countableReason, getAssignedBdaEmail, istDate } from '../Utils/BdaAssignment.js';
import { loadTakenSlots, reassignBooking } from '../Utils/BookingReassign.js';
import { postAdminChannel } from '../Utils/attendanceDiscord.js';
import { getBdaProfile, getTrackedBdas } from '../Utils/BdaRegistry.js';
import { getCallSummariesSafe } from '../Utils/BookingCallSummary.js';
import { SYNC_LIMITS_MS, getAllSyncHealth } from '../Utils/SyncHealth.js';
import { getAttendanceRowFields } from '../Utils/attendanceRowFields.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import { WINDOW_OPENS_BEFORE_MS, recordPresentSignal, windowFor } from '../Utils/recordPresentSignal.js';
import { BdaHeartbeatLogModel } from '../Schema_Models/BdaHeartbeatLog.js';

// Attendance endpoints (plan 5.3, api-contracts.md). Errors always look like
// { success: false, error: { code, message } } with a matching status.

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message }, ...extra });

const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const iso = (d) => (d ? new Date(d).toISOString() : null);
const internal = (res, label, err) => {
  console.error(`[attendanceRoutes] ${label} failed:`, err?.message || err);
  return fail(res, 500, 'internal_error', 'Something went wrong, try again');
};

// 10 Mark Present requests per minute per user, shared by the Meet-widget and the CRM endpoints.
export const markPresentRateLimit = createUserRateLimiter({
  max: 10,
  windowMs: 60 * 1000,
  keyOf: (req) => normEmail(req.bdaUser?.email || req.crmUser?.email),
});

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------

/**
 * The admin analysis page signs in with a `crm_admin` token, while the rest of the CRM uses `crm_user` tokens
 * that need a live database check (isCrmAdmin). Admin attendance routes accept both. The token's role claim only
 * picks which middleware verifies it; each branch still checks the signature itself.
 * Sets req.attendanceActor = { email, name, via }.
 */
export function requireAttendanceAdmin(req, res, next) {
  const header = String(req.headers?.authorization || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'unauthorized', 'Missing Authorization bearer token');
  const role = jwt.decode(token)?.role;

  if (role === 'crm_admin') {
    return requireCrmAdmin(req, res, () => {
      req.attendanceActor = { email: normEmail(req.crmAdmin?.email) || 'crm_admin', name: req.crmAdmin?.name || null, via: 'crm_admin' };
      next();
    });
  }
  return requireCrmUser(req, res, async () => {
    try {
      if (!(await isCrmAdmin(req.crmUser))) return fail(res, 403, 'forbidden', 'Admin access required');
      req.attendanceActor = { email: normEmail(req.crmUser?.email), name: req.crmUser?.name || null, via: 'crm_user' };
      return next();
    } catch (err) {
      console.error('[attendanceRoutes] admin check failed:', err?.message);
      return fail(res, 503, 'admin_check_failed', 'Could not verify admin access, try again');
    }
  });
}

// ---------------------------------------------------------------------------
// Mark Present (extension and CRM)
// ---------------------------------------------------------------------------

async function respondToMark(res, input) {
  const result = await recordPresentSignal(input);
  if (!result.ok) {
    const extra = result.windowOpensAt ? { windowOpensAt: result.windowOpensAt, windowClosesAt: result.windowClosesAt } : {};
    return fail(res, result.status, result.code, result.message, extra);
  }
  return res.status(200).json({ success: true, marked: true, markedPresentAt: iso(result.markedPresentAt) });
}

async function extensionMarkPresent(req, res) {
  try {
    const bookingId = req.body?.bookingId;
    if (!bookingId || typeof bookingId !== 'string') return fail(res, 400, 'booking_id_required', 'bookingId is required');
    // clientNow is deliberately unused: the server's receive time is the event time.
    return await respondToMark(res, {
      bookingId,
      bdaEmail: req.bdaUser.email,
      bdaName: req.bdaUser.name,
      kind: 'button_meet',
    });
  } catch (err) {
    return internal(res, 'extension mark-present', err);
  }
}

async function crmMarkPresent(req, res) {
  try {
    return await respondToMark(res, {
      bookingId: String(req.params.bookingId || ''),
      bdaEmail: req.crmUser.email,
      bdaName: req.crmUser.name,
      kind: 'button_crm',
    });
  } catch (err) {
    return internal(res, 'crm mark-present', err);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

const localPart = (email) => String(email ?? '').split('@')[0].toLowerCase();
// Same rule as the extension: the same name on a COMPANY domain is the same person (the CRM login and the Workspace
// account can sit on different company domains); the same name on a personal domain (gmail.com) is not.
const COMPANY_DOMAINS = ['flashfirehq.com', 'flashfirejobs.com'];
function sameBdaAccount(profileEmail, loginEmail) {
  if (profileEmail === loginEmail) return true;
  return localPart(profileEmail) === localPart(loginEmail) && COMPANY_DOMAINS.includes(String(profileEmail).split('@')[1]);
}

async function heartbeat(req, res) {
  try {
    const bdaEmail = normEmail(req.bdaUser?.email);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const profileEmail = normEmail(body.profileEmail) || null;
    const meetTabs = (Array.isArray(body.meetTabs) ? body.meetTabs : [])
      .slice(0, 20)
      .map((t) => ({
        code: typeof t?.code === 'string' ? t.code.slice(0, 40) : null,
        inCall: typeof t?.inCall === 'boolean' ? t.inCall : null,
      }));
    const now = new Date();
    await BdaExtensionHeartbeatModel.updateOne(
      { bdaEmail },
      {
        $set: {
          lastHeartbeatAt: now,
          updatedAt: now,
          version: typeof body.version === 'string' ? body.version.slice(0, 20) : null,
          profileEmail,
          profileMatchesLogin: profileEmail ? sameBdaAccount(profileEmail, bdaEmail) : null,
          meetTabs,
        },
      },
      { upsert: true }
    );
    // History for join-device detection (mobile vs PC). Best effort: a failed log write must not fail the heartbeat.
    BdaHeartbeatLogModel.create({ bdaEmail, at: now, meetTabs, profileMatchesLogin: profileEmail ? sameBdaAccount(profileEmail, bdaEmail) : null })
      .catch((err) => console.warn('[attendanceRoutes] heartbeat log write failed:', err?.message));
    return res.status(200).json({ success: true });
  } catch (err) {
    return internal(res, 'heartbeat', err);
  }
}

// ---------------------------------------------------------------------------
// CRM self views: my-window, my-month
// ---------------------------------------------------------------------------

const ASSIGNED_TO = (email) => ({
  $or: [{ 'attendanceAssignee.email': email }, { 'calendlyHost.email': email }, { 'claimedBy.email': email }],
});

function shapeWindow(booking, row) {
  const startMs = new Date(booking.scheduledEventStartTime).getTime();
  const { opensAtMs, closesAtMs } = windowFor(startMs);
  return {
    bookingId: booking.bookingId,
    clientName: booking.clientName || '',
    scheduledStart: new Date(startMs).toISOString(),
    windowOpensAt: new Date(opensAtMs).toISOString(),
    windowClosesAt: new Date(closesAtMs).toISOString(),
    marked: Boolean(row?.markedPresentAt),
    markedPresentAt: iso(row?.markedPresentAt),
    verdict: row?.verdict ?? null,
    verdictSignal: row?.verdictSignal ?? null,
  };
}

async function myWindow(req, res) {
  try {
    const email = normEmail(req.crmUser?.email);
    const now = new Date();
    const nowMs = now.getTime();
    const base = { success: true, serverTime: now.toISOString() };

    const profile = email ? await getBdaProfile(email) : null;
    if (!profile || profile.active === false || profile.tracked !== true) {
      return res.status(200).json({ ...base, tracked: false, current: null, next: null });
    }

    // At least 30 min ahead, past midnight IST when needed: a 00:02 meeting's window opens at 23:57.
    const endOfToday = DateTime.fromMillis(nowMs, { zone: 'Asia/Kolkata' }).endOf('day').toMillis();
    const horizon = Math.max(endOfToday, nowMs + 30 * 60 * 1000);
    const bookings = await CampaignBookingModel.find({
      scheduledEventStartTime: { $gte: new Date(nowMs - 30 * 60 * 1000), $lte: new Date(horizon) },
      ...ASSIGNED_TO(email),
    })
      .select('bookingId clientName bookingStatus statusHistory scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
      .sort({ scheduledEventStartTime: 1 })
      .limit(50)
      .lean();

    const mine = bookings.filter(
      (b) => getAssignedBdaEmail(b) === email && countableReason(b, profile, nowMs).countable
    );
    const startOf = (b) => new Date(b.scheduledEventStartTime).getTime();

    // current: the nearest meeting whose [start - 30 min, start + 30 min] band holds now
    const inBand = mine.filter((b) => Math.abs(nowMs - startOf(b)) <= 30 * 60 * 1000);
    const current = inBand.sort((a, b) => Math.abs(nowMs - startOf(a)) - Math.abs(nowMs - startOf(b)))[0] || null;
    const after = current ? startOf(current) : nowMs;
    // The first meeting after current, even when it is also inside the ±30 min band (10:00 and 10:20 meetings).
    const next = mine.find((b) => b !== current && startOf(b) > after) || null;

    const rows = await BdaAttendanceModel.find({
      bookingId: { $in: [current, next].filter(Boolean).map((b) => b.bookingId) },
      bdaEmail: email,
    })
      .select('bookingId markedPresentAt verdict verdictSignal')
      .lean();
    const rowOf = (b) => rows.find((r) => r.bookingId === b?.bookingId) || null;

    return res.status(200).json({
      ...base,
      tracked: true,
      current: current ? shapeWindow(current, rowOf(current)) : null,
      next: next ? shapeWindow(next, rowOf(next)) : null,
    });
  } catch (err) {
    return internal(res, 'my-window', err);
  }
}

async function myMonth(req, res) {
  try {
    const email = normEmail(req.crmUser?.email);
    const raw = req.query?.month;
    let monthStart;
    if (raw === undefined || raw === '') {
      monthStart = DateTime.now().setZone('Asia/Kolkata').startOf('month');
    } else {
      if (typeof raw !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) {
        return fail(res, 422, 'invalid_month', 'month must look like 2026-10');
      }
      monthStart = DateTime.fromFormat(raw, 'yyyy-MM', { zone: 'Asia/Kolkata' }).startOf('month');
    }

    const profile = email ? await getBdaProfile(email) : null;
    if (!profile || profile.active === false || profile.tracked !== true) {
      return fail(res, 403, 'not_tracked', 'Attendance is not tracked for this account');
    }

    const nowMs = Date.now();
    const bookings = await CampaignBookingModel.find({
      scheduledEventStartTime: { $gte: monthStart.toJSDate(), $lt: monthStart.plus({ months: 1 }).toJSDate() },
      ...ASSIGNED_TO(email),
    })
      .select(
        'bookingId clientName bookingStatus statusHistory statusChangedAt statusChangedBy statusChangedByName scheduledEventStartTime scheduledEventEndTime clientPhone normalizedClientPhone calendlyHost claimedBy attendanceAssignee'
      )
      .sort({ scheduledEventStartTime: -1 })
      .limit(500)
      .lean();
    const mine = bookings.filter((b) => getAssignedBdaEmail(b) === email && countableReason(b, profile, nowMs).countable);

    const [fields, callSummaries] = await Promise.all([
      getAttendanceRowFields(mine, { email, isAdmin: false }),
      getCallSummariesSafe(mine),
    ]);

    const rows = mine.map((b) => {
      const f = fields.get(b.bookingId);
      return {
        bookingId: b.bookingId,
        clientName: b.clientName || '',
        scheduledStart: iso(b.scheduledEventStartTime),
        scheduledEnd: iso(b.scheduledEventEndTime),
        bookingStatus: b.bookingStatus ?? null,
        attendance: f?.attendance ?? null,
        callSummary: callSummaries.get(b.bookingId) ?? null,
        statusUpdate: f?.statusUpdate ?? null,
        deductions: f?.deductions ?? [],
        transcript: f?.transcript ?? null, // the Calendly Notetaker summary, when one is stored
      };
    });
    return res.status(200).json({ success: true, month: monthStart.toFormat('yyyy-LL'), rows });
  } catch (err) {
    return internal(res, 'my-month', err);
  }
}

// ---------------------------------------------------------------------------
// Admin: reassign, health, review queues, dismiss
// ---------------------------------------------------------------------------

async function reassign(req, res) {
  try {
    const rawEmail = req.body?.email;
    const clearing = rawEmail === null || rawEmail === '';
    if (!clearing && typeof rawEmail !== 'string') {
      return fail(res, 400, 'invalid_body', 'Send { "email": "<tracked BDA email>" }, or null to hand the meeting back');
    }
    const out = await reassignBooking({
      bookingId: String(req.params.bookingId || ''),
      email: clearing ? null : rawEmail,
      actor: req.attendanceActor || {},
    });
    if (!out.ok) return fail(res, out.status, out.code, out.message);
    return res.status(200).json({
      success: true,
      booking: { bookingId: String(req.params.bookingId), assignedBdaEmail: out.assignedBdaEmail, attendanceAssignee: out.attendanceAssignee },
      warnings: out.warnings,
    });
  } catch (err) {
    return internal(res, 'reassign', err);
  }
}

const TRANSFER_MAX = 50;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Batch transfer: { items: [{ bookingId, email }] }, at most 50. One action is one call. Every meeting gets its own
 * result, so one refusal (window open, target on leave) never blocks the rest. One summary goes to the admin channel.
 */
async function reassignBatch(req, res) {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0) return fail(res, 422, 'invalid_items', 'Send { "items": [{ "bookingId", "email" }] }');
    if (items.length > TRANSFER_MAX) return fail(res, 422, 'too_many_items', `Move at most ${TRANSFER_MAX} meetings at a time`);
    const cleaned = [];
    for (const it of items) {
      const bookingId = typeof it?.bookingId === 'string' ? it.bookingId.trim() : '';
      const email = typeof it?.email === 'string' ? normEmail(it.email) : '';
      if (!bookingId || bookingId.length > 200 || !email) return fail(res, 422, 'invalid_items', 'Every item needs a bookingId and an email');
      cleaned.push({ bookingId, email });
    }
    if (new Set(cleaned.map((i) => i.bookingId)).size !== cleaned.length) {
      return fail(res, 422, 'duplicate_booking', 'A meeting can appear only once in a batch');
    }

    // Two queries for the whole batch: the start times, then who is already booked at those instants.
    const starts = await CampaignBookingModel.find({ bookingId: { $in: cleaned.map((i) => i.bookingId) } })
      .select('bookingId clientName scheduledEventStartTime')
      .lean();
    const infoOf = new Map(starts.map((b) => [b.bookingId, { clientName: b.clientName || '', startMs: new Date(b.scheduledEventStartTime).getTime() }]));
    const taken = await loadTakenSlots([...infoOf.values()].map((v) => v.startMs));

    const actor = req.attendanceActor || {};
    const results = [];
    for (const { bookingId, email } of cleaned) {
      const out = await reassignBooking({ bookingId, email, actor, taken });
      const info = infoOf.get(bookingId);
      if (out.ok) {
        // Meetings later in this batch see this one as taken.
        if (info && Number.isFinite(info.startMs)) taken.set(`${email}|${info.startMs}`, info.clientName || 'another meeting');
        results.push({ bookingId, ok: true, clientName: info?.clientName ?? '', assignedBdaEmail: out.assignedBdaEmail, previousEmail: out.previousEmail, warnings: out.warnings });
      } else {
        results.push({ bookingId, ok: false, clientName: info?.clientName ?? '', error: { code: out.code, message: out.message } });
      }
    }

    const moved = results.filter((r) => r.ok);
    if (moved.length > 0) {
      const when = (id) => {
        const ms = infoOf.get(id)?.startMs;
        return Number.isFinite(ms) ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '';
      };
      const nameOf = async (email) => (email ? (await getBdaProfile(email))?.displayName || email : 'the Calendly host');
      const lines = [];
      for (const r of moved.slice(0, 10)) lines.push(`• ${r.clientName || r.bookingId}, ${when(r.bookingId)} IST: ${await nameOf(r.previousEmail)} → ${await nameOf(r.assignedBdaEmail)}`);
      const more = moved.length > 10 ? `\n…and ${moved.length - 10} more` : '';
      postAdminChannel(`🔁 **${moved.length} meeting${moved.length === 1 ? '' : 's'} reassigned** by ${actor.email || 'an admin'}\n${lines.join('\n')}${more}`).catch((err) =>
        console.warn('[attendanceRoutes] reassign notice failed:', err?.message)
      );
    }
    return res.status(200).json({ success: true, results, summary: { moved: moved.length, failed: results.length - moved.length } });
  } catch (err) {
    return internal(res, 'reassign-batch', err);
  }
}

/**
 * Everything the Transfer dialog needs in one call: the BDA's meetings in a date range (each flagged as movable or
 * already inside the mark window), and every tracked BDA with their leave days and meeting count per day, so the
 * dialog can show who is free.
 */
async function transferCandidates(req, res) {
  try {
    const bdaEmail = normEmail(req.query.bdaEmail);
    if (!bdaEmail) return fail(res, 422, 'invalid_bda', 'bdaEmail is required');
    const today = DateTime.now().setZone('Asia/Kolkata').startOf('day');
    const fromDay = req.query.from ? String(req.query.from) : today.toFormat('yyyy-LL-dd');
    const toDay = req.query.to ? String(req.query.to) : today.plus({ days: 14 }).toFormat('yyyy-LL-dd');
    if (!DAY_RE.test(fromDay) || !DAY_RE.test(toDay) || toDay < fromDay) {
      return fail(res, 422, 'invalid_range', 'from and to must be days like 2026-10-25, with to on or after from');
    }
    const from = DateTime.fromISO(fromDay, { zone: 'Asia/Kolkata' }).startOf('day');
    const to = DateTime.fromISO(toDay, { zone: 'Asia/Kolkata' }).endOf('day');
    if (!from.isValid || !to.isValid || to.diff(from, 'days').days > 31) {
      return fail(res, 422, 'invalid_range', 'Pick a range of at most 31 days');
    }
    const nowMs = Date.now();
    const range = { $gte: from.toJSDate(), $lte: to.toJSDate() };
    const live = { $nin: ['canceled', 'rescheduled', 'not-scheduled'] };

    const [mine, everyone, tracked] = await Promise.all([
      CampaignBookingModel.find({
        scheduledEventStartTime: range,
        bookingStatus: live,
        $or: [{ 'attendanceAssignee.email': bdaEmail }, { 'calendlyHost.email': bdaEmail }, { 'claimedBy.email': bdaEmail }],
      })
        .select('bookingId clientName bookingStatus scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
        .sort({ scheduledEventStartTime: 1 })
        .limit(200)
        .lean(),
      CampaignBookingModel.find({ scheduledEventStartTime: range, bookingStatus: live })
        .select('scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
        .limit(2000)
        .lean(),
      getTrackedBdas(),
    ]);

    const meetings = mine
      .filter((b) => getAssignedBdaEmail(b) === bdaEmail)
      .map((b) => {
        const startMs = new Date(b.scheduledEventStartTime).getTime();
        return {
          bookingId: b.bookingId,
          clientName: b.clientName || '',
          bookingStatus: b.bookingStatus ?? null,
          scheduledStart: iso(b.scheduledEventStartTime),
          day: istDate(startMs),
          canMove: nowMs < startMs - WINDOW_OPENS_BEFORE_MS,
        };
      });

    const loadOf = new Map();
    for (const b of everyone) {
      const email = getAssignedBdaEmail(b);
      if (!email) continue;
      const day = istDate(new Date(b.scheduledEventStartTime).getTime());
      const days = loadOf.get(email) ?? {};
      days[day] = (days[day] ?? 0) + 1;
      loadOf.set(email, days);
    }
    const bdas = tracked
      .filter((p) => p.active !== false)
      .map((p) => ({
        email: p.email,
        displayName: p.displayName || p.email.split('@')[0],
        leaveDays: (p.leaveDays || []).filter((d) => d >= fromDay && d <= toDay),
        loadByDay: loadOf.get(p.email) ?? {},
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return res.status(200).json({ success: true, bdaEmail, from: fromDay, to: toDay, meetings, bdas });
  } catch (err) {
    return internal(res, 'transfer-candidates', err);
  }
}

async function health(req, res) {
  try {
    const nowMs = Date.now();
    const [rows, rows24h, tracked, beats] = await Promise.all([
      getAllSyncHealth(),
      BdaAttendanceModel.countDocuments({ updatedAt: { $gte: new Date(nowMs - 24 * 60 * 60 * 1000) } }),
      getTrackedBdas(),
      BdaExtensionHeartbeatModel.find({}).lean(),
    ]);

    const sources = rows.map((r) => {
      const ageMs = r.lastOkAt ? nowMs - new Date(r.lastOkAt).getTime() : null;
      const limitMs = SYNC_LIMITS_MS[r.source];
      return {
        source: r.source,
        lastOkAt: iso(r.lastOkAt),
        lastError: r.lastError ?? null,
        ageMs,
        limitMs,
        healthy: ageMs != null && ageMs <= limitMs,
      };
    });

    const beatOf = new Map(beats.map((b) => [b.bdaEmail, b]));
    const heartbeats = tracked.map((p) => {
      const b = beatOf.get(p.email);
      return {
        bdaEmail: p.email,
        lastHeartbeatAt: iso(b?.lastHeartbeatAt),
        ageMs: b?.lastHeartbeatAt ? nowMs - new Date(b.lastHeartbeatAt).getTime() : null,
        version: b?.version ?? null,
      };
    });
    return res.status(200).json({ success: true, sources, rows24h, heartbeats });
  } catch (err) {
    return internal(res, 'health', err);
  }
}

/** Deductions waiting on an admin. The model belongs to another module, so a missing one just means an empty list. */
async function loadNeedsReview() {
  let model;
  try {
    model = (await import('../Schema_Models/BdaDeduction.js')).BdaDeductionModel;
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return [];
    throw err;
  }
  if (!model) return [];
  const found = await model.find({ status: 'needs_review' }).sort({ createdAt: -1 }).limit(200).lean();
  // The full deduction row (same fields as GET /api/crm/deductions), plus the flat convenience fields older callers
  // read. The CRM opens the evidence drawer straight from this row, so `evidence` must be present.
  return found.map((d) => ({
    deductionId: d.deductionId,
    bookingId: d.bookingId,
    bdaEmail: d.bdaEmail,
    bdaName: d.bdaEmail ? d.bdaEmail.split('@')[0] : null,
    clientName: d.evidence?.clientName || d.bookingId || '',
    scheduledStart: iso(d.evidence?.scheduledStart),
    rule: d.rule,
    month: d.month ?? null,
    amountInr: d.amountInr,
    tierIndex: d.tierIndex ?? null,
    status: d.status,
    healthy: d.evidence?.healthy ?? null,
    evidence: {
      scheduledStart: iso(d.evidence?.scheduledStart),
      windowClosedAt: iso(d.evidence?.windowClosedAt),
      signals: d.evidence?.signals ?? [],
      bookingStatus: d.evidence?.bookingStatus ?? null,
      callSummary: d.evidence?.callSummary ?? {},
      clientName: d.evidence?.clientName ?? null,
      healthy: d.evidence?.healthy ?? null,
    },
    waivedBy: d.waivedBy ?? null,
    waivedByName: d.waivedByName ?? null,
    waivedAt: iso(d.waivedAt),
    waiverReason: d.waiverReason ?? null,
    voidedAt: iso(d.voidedAt),
    voidReason: d.voidReason ?? null,
    createdAt: iso(d.createdAt),
  }));
}

async function reviewQueues(req, res) {
  try {
    const nowMs = Date.now();

    const flagged = await BdaAttendanceModel.find({ integrityFlag: 'marked_never_joined', 'integrityResolved.at': null })
      .sort({ meetingScheduledStart: -1 })
      .limit(200)
      .lean();

    const stuckBookings = await CampaignBookingModel.find({
      bookingStatus: 'scheduled',
      scheduledEventStartTime: { $lte: new Date(nowMs - 24 * 60 * 60 * 1000), $gte: new Date(nowMs - 60 * 24 * 60 * 60 * 1000) },
      $or: [{ 'attendanceAssignee.email': { $nin: [null, ''] } }, { 'calendlyHost.email': { $nin: [null, ''] } }, { 'claimedBy.email': { $nin: [null, ''] } }],
    })
      .select('bookingId clientName bookingStatus statusHistory scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
      .sort({ scheduledEventStartTime: -1 })
      .limit(300)
      .lean();

    const flaggedBookings = flagged.length
      ? await CampaignBookingModel.find({ bookingId: { $in: flagged.map((r) => r.bookingId) } }).select('bookingId clientName').lean()
      : [];
    const clientOf = new Map(flaggedBookings.map((b) => [b.bookingId, b.clientName || '']));

    const profileCache = new Map();
    const profileFor = async (email) => {
      if (!profileCache.has(email)) profileCache.set(email, await getBdaProfile(email));
      return profileCache.get(email);
    };
    const stuckStatus = [];
    for (const b of stuckBookings) {
      const email = getAssignedBdaEmail(b);
      const profile = email ? await profileFor(email) : null;
      if (!countableReason(b, profile, nowMs).countable) continue;
      stuckStatus.push({
        bookingId: b.bookingId,
        clientName: b.clientName || '',
        bdaEmail: email,
        scheduledStart: iso(b.scheduledEventStartTime),
        bookingStatus: b.bookingStatus,
      });
    }

    const onLeave = await findMeetingsOnLeave({ fromMs: nowMs, untilMs: nowMs + 14 * 24 * 60 * 60 * 1000, deps: {} });

    return res.status(200).json({
      success: true,
      needsReview: await loadNeedsReview(),
      markedNeverJoined: flagged.map((r) => ({
        bookingId: r.bookingId,
        clientName: clientOf.get(r.bookingId) ?? '',
        bdaEmail: r.bdaEmail,
        scheduledStart: iso(r.meetingScheduledStart),
        markedAt: iso(r.markedPresentAt),
        signal: r.verdictSignal,
      })),
      stuckStatus,
      needsReassignment: onLeave.map(({ booking, bdaEmail }) => ({
        bookingId: booking.bookingId,
        clientName: booking.clientName || '',
        scheduledStart: iso(booking.scheduledEventStartTime),
        assignedBdaEmail: bdaEmail,
        reason: 'leave',
      })),
    });
  } catch (err) {
    return internal(res, 'review-queues', err);
  }
}

async function dismissIntegrityFlag(req, res) {
  try {
    const bookingId = String(req.params.bookingId || '');
    const bdaEmail = normEmail(req.body?.bdaEmail);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) {
      return fail(res, 422, 'reason_required', 'Give a reason of 5 to 500 characters');
    }
    if (!bdaEmail) return fail(res, 400, 'invalid_body', 'bdaEmail is required');

    const row = await BdaAttendanceModel.findOne({ bookingId, bdaEmail }).select('integrityFlag integrityResolved').lean();
    if (!row) return fail(res, 404, 'attendance_not_found', 'No attendance row for that booking and BDA');
    if (row.integrityFlag !== 'marked_never_joined' || row.integrityResolved?.at) {
      return fail(res, 409, 'no_open_flag', 'There is no open "marked present, never joined" flag on this meeting');
    }

    const actor = req.attendanceActor || {};
    const res2 = await BdaAttendanceModel.updateOne(
      { bookingId, bdaEmail, integrityFlag: 'marked_never_joined', 'integrityResolved.at': null },
      { $set: { integrityResolved: { at: new Date(), by: actor.email || null, action: 'dismissed', reason } } }
    );
    if ((res2.modifiedCount ?? 0) === 0) return fail(res, 409, 'no_open_flag', 'This flag was already closed');
    return res.status(200).json({ success: true });
  } catch (err) {
    return internal(res, 'dismiss-integrity-flag', err);
  }
}

// ---------------------------------------------------------------------------

export function registerAttendanceRoutes(app) {
  // Extension (requireBdaExtension)
  app.post('/api/bda-attendance/mark-present', requireBdaExtension, markPresentRateLimit, extensionMarkPresent);
  app.post('/api/bda-attendance/heartbeat', requireBdaExtension, heartbeat);

  // CRM, any signed-in user
  app.post('/api/crm/attendance/:bookingId/mark-present', requireCrmUser, markPresentRateLimit, crmMarkPresent);
  app.get('/api/crm/attendance/my-window', requireCrmUser, myWindow);
  // The tracked BDAs, for filter dropdowns (Meeting Info). Names and emails only.
  app.get('/api/crm/attendance/bdas', requireCrmUser, async (req, res) => {
    try {
      const tracked = await getTrackedBdas();
      const bdas = tracked
        .map((p) => ({ email: p.email, displayName: p.displayName || p.email.split('@')[0] }))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      return res.status(200).json({ success: true, bdas });
    } catch (err) {
      return internal(res, 'bdas', err);
    }
  });
  app.get('/api/crm/attendance/my-month', requireCrmUser, myMonth);

  // CRM, admins (crm_admin token or an admin crm_user)
  app.put('/api/crm/admin/bookings/:bookingId/attendance-assignee', requireAttendanceAdmin, reassign);
  app.post('/api/crm/admin/bookings/reassign', requireAttendanceAdmin, reassignBatch);
  app.get('/api/crm/admin/transfer-meetings', requireAttendanceAdmin, transferCandidates);
  app.get('/api/crm/admin/attendance/health', requireAttendanceAdmin, health);
  app.get('/api/crm/admin/attendance/review-queues', requireAttendanceAdmin, reviewQueues);
  app.post('/api/crm/admin/attendance/:bookingId/dismiss-integrity-flag', requireAttendanceAdmin, dismissIntegrityFlag);
}

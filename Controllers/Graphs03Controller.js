import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';

/**
 * Graphs 03 — BDA performance analytics.
 *
 *  1. getBdaMeetingsAnalytics    — completed meetings vs paid, per BDA, daily or weekly.
 *  2. getNoShowFollowupAnalytics — no-show follow-ups called vs not called, per BDA.
 *  3. getBdaCallActivity         — calls made and time spent on calls, per BDA.
 *  4. getBdaScorecard            — meeting attendance, sales-cycle length, plan mix.
 *
 * Attribution: a booking's BDA is the Calendly round-robin host (`calendlyHost.email`,
 * set on invitee.created) and falls back to the manual claim (`claimedBy.email`).
 * Bookings with neither are bucketed as `unassigned` rather than dropped, so the
 * charts never silently under-count. `coverage` in each response reports how much of
 * the data is actually attributed.
 */

// The business operates on ET; day/week boundaries must match how the team reads them.
const TZ = 'America/New_York';
const UNASSIGNED = 'unassigned';
const UNASSIGNED_LABEL = 'Unassigned';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Lower-cased, trimmed host/claim emails, so the resolve stage can test for "". */
const OWNER_EMAILS_STAGE = {
  $addFields: {
    _host: { $trim: { input: { $toLower: { $ifNull: ['$calendlyHost.email', ''] } } } },
    _claim: { $trim: { input: { $toLower: { $ifNull: ['$claimedBy.email', ''] } } } },
  },
};

/** host → claim → unassigned. */
const OWNER_RESOLVE_STAGE = {
  $addFields: {
    bdaEmail: {
      $cond: [
        { $ne: ['$_host', ''] }, '$_host',
        { $cond: [{ $ne: ['$_claim', ''] }, '$_claim', UNASSIGNED] },
      ],
    },
    bdaName: {
      $cond: [
        { $ne: ['$_host', ''] }, { $ifNull: ['$calendlyHost.name', '$_host'] },
        {
          $cond: [
            { $ne: ['$_claim', ''] }, { $ifNull: ['$claimedBy.name', '$_claim'] },
            UNASSIGNED_LABEL,
          ],
        },
      ],
    },
  },
};

/** Local (ET) calendar date of an instant, as YYYY-MM-DD. */
const ymdInTZ = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);

/** Monday of the ISO week containing a YYYY-MM-DD calendar date. */
const mondayOf = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // Mon = 0
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
};

/** Every bucket key between two instants, so the time axis has no invisible gaps. */
const enumerateBuckets = (from, to, granularity) => {
  const keys = [];
  const seen = new Set();
  for (let t = from.getTime(); t <= to.getTime(); t += 86400000) {
    const ymd = ymdInTZ(new Date(t));
    const key = granularity === 'week' ? mondayOf(ymd) : ymd;
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
  }
  return keys;
};

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);

/** Real BDAs first (busiest first), `unassigned` always last. */
const sortBdas = (list) =>
  list.sort((a, b) => {
    if (a.email === UNASSIGNED) return 1;
    if (b.email === UNASSIGNED) return -1;
    return (b.completed ?? b.total ?? 0) - (a.completed ?? a.total ?? 0);
  });

/**
 * Completed meetings vs paid, per BDA, bucketed daily or weekly.
 *
 * A meeting "happened" when its status is `completed` or `paid` — a paid client also
 * sat through the meeting, so `paid` is a strict subset of `completed`. Both series
 * are bucketed by `scheduledEventStartTime` (when the meeting actually took place),
 * making each bucket a cohort: "of the meetings held that day/week, how many paid?"
 *
 * GET /api/crm/graphs03/bda-meetings?granularity=day|week&days=30
 */
export const getBdaMeetingsAnalytics = async (req, res) => {
  try {
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const days = clamp(
      parseInt(req.query.days, 10) || (granularity === 'week' ? 84 : 30),
      1, 400
    );

    const to = req.query.toDate ? new Date(req.query.toDate) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = req.query.fromDate
      ? new Date(req.query.fromDate)
      : new Date(to.getTime() - (days - 1) * 86400000);
    from.setHours(0, 0, 0, 0);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid fromDate/toDate' });
    }

    // startOfWeek is only valid when unit is "week".
    const trunc = { date: '$scheduledEventStartTime', unit: granularity, timezone: TZ };
    if (granularity === 'week') trunc.startOfWeek = 'monday';

    const rows = await CampaignBookingModel.aggregate([
      {
        $match: {
          bookingStatus: { $in: ['completed', 'paid'] },
          scheduledEventStartTime: { $gte: from, $lte: to },
        },
      },
      OWNER_EMAILS_STAGE,
      OWNER_RESOLVE_STAGE,
      {
        $addFields: {
          _bucket: { $dateToString: { format: '%Y-%m-%d', date: { $dateTrunc: trunc }, timezone: TZ } },
        },
      },
      {
        $group: {
          _id: { bucket: '$_bucket', bda: '$bdaEmail' },
          name: { $first: '$bdaName' },
          completed: { $sum: 1 },
          paid: { $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] } },
        },
      },
    ]);

    const bdaMap = new Map();
    const dataByBucket = new Map();
    for (const r of rows) {
      const email = r._id.bda;
      if (!bdaMap.has(email)) {
        bdaMap.set(email, { email, name: r.name || email, completed: 0, paid: 0 });
      }
      const agg = bdaMap.get(email);
      agg.completed += r.completed;
      agg.paid += r.paid;

      if (!dataByBucket.has(r._id.bucket)) dataByBucket.set(r._id.bucket, {});
      dataByBucket.get(r._id.bucket)[email] = { completed: r.completed, paid: r.paid };
    }

    const bdas = sortBdas([...bdaMap.values()]);
    const buckets = enumerateBuckets(from, to, granularity).map((bucket) => {
      const present = dataByBucket.get(bucket) || {};
      const byBda = {};
      for (const b of bdas) {
        byBda[b.email] = present[b.email] || { completed: 0, paid: 0 };
      }
      return { bucket, byBda };
    });

    const totals = {};
    for (const b of bdas) {
      totals[b.email] = { completed: b.completed, paid: b.paid, conversionRate: pct(b.paid, b.completed) };
    }

    const completedAll = bdas.reduce((s, b) => s + b.completed, 0);
    const paidAll = bdas.reduce((s, b) => s + b.paid, 0);
    const unattributed = bdaMap.get(UNASSIGNED)?.completed ?? 0;

    return res.status(200).json({
      success: true,
      data: {
        granularity,
        timezone: TZ,
        from: from.toISOString(),
        to: to.toISOString(),
        bdas: bdas.map(({ email, name }) => ({ email, name })),
        buckets,
        totals,
        overall: { completed: completedAll, paid: paidAll, conversionRate: pct(paidAll, completedAll) },
        coverage: {
          total: completedAll,
          attributed: completedAll - unattributed,
          unattributed,
          attributedPct: pct(completedAll - unattributed, completedAll),
        },
      },
    });
  } catch (error) {
    console.error('getBdaMeetingsAnalytics error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load BDA meeting analytics' });
  }
};

/**
 * No-show follow-ups: called vs not called, per BDA.
 *
 * One row per client (deduped on normalized phone, latest booking wins). A no-show
 * counts as "called" when a CallLog exists for that phone whose `startedAt` is at or
 * after the missed meeting — a call placed *before* the meeting is not a follow-up.
 *
 * `bdas` groups by the BDA who *owns* the lead (host → claim). Ownership deliberately
 * does NOT fall back to whoever placed the call: a lead attributed to its own caller
 * is "called" by construction, which would pin every BDA at 100% and dump every
 * missed lead into `unassigned`. Owning the lead has to be independent of whether the
 * call happened for the ratio to mean anything.
 *
 * Because ownership is only recorded on Calendly round-robin bookings, most historic
 * no-shows land in `unassigned` — `coverage` reports exactly how many. `calledBy` is
 * the complementary view that IS well populated today: who actually placed the
 * follow-up calls.
 *
 * Leads with no phone can never be matched to a call log, so they are excluded from
 * the called/not-called denominators and reported as `excludedNoPhone`.
 *
 * GET /api/crm/graphs03/no-show-followup?days=90
 */
export const getNoShowFollowupAnalytics = async (req, res) => {
  try {
    const days = clamp(parseInt(req.query.days, 10) || 90, 1, 400);
    const since = new Date(Date.now() - days * 86400000);

    const [facet] = await CampaignBookingModel.aggregate([
      {
        $match: {
          bookingStatus: 'no-show',
          $or: [{ scheduledEventStartTime: { $gte: since } }, { bookingCreatedAt: { $gte: since } }],
        },
      },
      // Dedupe to one row per client, keeping their most recent no-show.
      { $addFields: { _key: { $ifNull: ['$normalizedClientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      { $group: { _id: '$_key', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      {
        $addFields: {
          // $ne against null is true for a *missing* field, so coerce first — otherwise
          // a phone-less lead is treated as callable and lands in "not called".
          _hasPhone: { $ne: [{ $ifNull: ['$normalizedClientPhone', ''] }, ''] },
        },
      },
      {
        $lookup: {
          from: 'calllogs',
          let: { p: { $ifNull: ['$normalizedClientPhone', ''] }, t: '$scheduledEventStartTime' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $ne: ['$$p', ''] },
                    { $eq: ['$leadNumberNormalized', '$$p'] },
                    // No meeting time on record → any call counts as the follow-up.
                    { $or: [{ $eq: ['$$t', null] }, { $gte: ['$startedAt', '$$t'] }] },
                  ],
                },
              },
            },
            { $sort: { startedAt: 1 } },
            { $limit: 1 },
            { $project: { salesEmail: 1, salesName: 1 } },
          ],
          as: '_calls',
        },
      },
      {
        $addFields: {
          _called: { $gt: [{ $size: '$_calls' }, 0] },
          _callerEmail: { $trim: { input: { $toLower: { $ifNull: [{ $first: '$_calls.salesEmail' }, ''] } } } },
          _callerName: { $ifNull: [{ $first: '$_calls.salesName' }, null] },
        },
      },
      OWNER_EMAILS_STAGE,
      OWNER_RESOLVE_STAGE,
      {
        $facet: {
          noPhone: [{ $match: { _hasPhone: false } }, { $count: 'n' }],
          byOwner: [
            { $match: { _hasPhone: true } },
            {
              $group: {
                _id: '$bdaEmail',
                name: { $first: '$bdaName' },
                called: { $sum: { $cond: ['$_called', 1, 0] } },
                notCalled: { $sum: { $cond: ['$_called', 0, 1] } },
              },
            },
          ],
          calledBy: [
            { $match: { _hasPhone: true, _called: true } },
            {
              $group: {
                _id: { $cond: [{ $ne: ['$_callerEmail', ''] }, '$_callerEmail', UNASSIGNED] },
                name: { $first: { $ifNull: ['$_callerName', 'Unknown caller'] } },
                calls: { $sum: 1 },
              },
            },
            { $sort: { calls: -1 } },
          ],
        },
      },
    ]);

    const excludedNoPhone = facet?.noPhone?.[0]?.n ?? 0;

    const bdas = sortBdas(
      (facet?.byOwner ?? []).map((r) => ({
        email: r._id,
        name: r.name || r._id,
        called: r.called,
        notCalled: r.notCalled,
        total: r.called + r.notCalled,
        calledPct: pct(r.called, r.called + r.notCalled),
      }))
    );

    const calledBy = (facet?.calledBy ?? []).map((r) => ({
      email: r._id,
      name: r._id === UNASSIGNED ? 'Unknown caller' : r.name || r._id,
      calls: r.calls,
    }));

    const called = bdas.reduce((s, b) => s + b.called, 0);
    const notCalled = bdas.reduce((s, b) => s + b.notCalled, 0);
    const total = called + notCalled;
    const unattributed = bdas.find((b) => b.email === UNASSIGNED)?.total ?? 0;

    return res.status(200).json({
      success: true,
      data: {
        days,
        from: since.toISOString(),
        to: new Date().toISOString(),
        bdas,
        calledBy,
        overall: { called, notCalled, total, calledPct: pct(called, total) },
        coverage: {
          total,
          attributed: total - unattributed,
          unattributed,
          attributedPct: pct(total - unattributed, total),
        },
        excludedNoPhone,
      },
    });
  } catch (error) {
    console.error('getNoShowFollowupAnalytics error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load no-show follow-up analytics' });
  }
};

/**
 * Calls made and time spent on calls, per BDA.
 *
 * "Calls made" counts only OUTBOUND CallLog rows that carry a `salesEmail` — an
 * inbound call is not a call the BDA placed, and a row with no sales side cannot be
 * attributed. Both are reported (`inboundCalls`, `unattributedOutbound`) rather than
 * silently folded into someone's total.
 *
 * "Time spent" is Zoom's `durationSec` (talk time). A call with duration 0 never
 * connected, so `connected` / `talkSec` are tracked separately from `calls` — a BDA
 * who dials 100 numbers and connects twice should not look busy.
 *
 * Callers are labelled from CrmUser. Anyone whose CRM role is not `bda` (admins, or
 * an email with no CRM user at all) is still shown, flagged with their real role, so
 * the totals reconcile against the raw call log.
 *
 * GET /api/crm/graphs03/bda-call-activity?granularity=day|week&days=30
 */
export const getBdaCallActivity = async (req, res) => {
  try {
    const granularity = req.query.granularity === 'week' ? 'week' : 'day';
    const days = clamp(
      parseInt(req.query.days, 10) || (granularity === 'week' ? 84 : 30),
      1, 400
    );

    const to = req.query.toDate ? new Date(req.query.toDate) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = req.query.fromDate
      ? new Date(req.query.fromDate)
      : new Date(to.getTime() - (days - 1) * 86400000);
    from.setHours(0, 0, 0, 0);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid fromDate/toDate' });
    }

    const trunc = { date: '$startedAt', unit: granularity, timezone: TZ };
    if (granularity === 'week') trunc.startOfWeek = 'monday';

    const inWindow = { startedAt: { $gte: from, $lte: to } };
    // A caller is identified by salesEmail; missing/empty means Zoom gave us no sales side.
    const madeByAPerson = {
      ...inWindow,
      direction: 'outbound',
      $expr: { $ne: [{ $ifNull: ['$salesEmail', ''] }, ''] },
    };

    const [rows, inboundCalls, unattributedOutbound, users] = await Promise.all([
      CallLogModel.aggregate([
        { $match: madeByAPerson },
        {
          $addFields: {
            _bucket: { $dateToString: { format: '%Y-%m-%d', date: { $dateTrunc: trunc }, timezone: TZ } },
            _sec: { $ifNull: ['$durationSec', 0] },
          },
        },
        {
          $group: {
            _id: { bucket: '$_bucket', email: '$salesEmail' },
            name: { $first: '$salesName' },
            calls: { $sum: 1 },
            connected: { $sum: { $cond: [{ $gt: ['$_sec', 0] }, 1, 0] } },
            talkSec: { $sum: '$_sec' },
            // Duration buckets. `connected` (>0s) counts voicemail and one-ring
            // hangups as successes; only the >60s bucket is a real conversation.
            under10s: { $sum: { $cond: [{ $lt: ['$_sec', 10] }, 1, 0] } },
            s10to60: { $sum: { $cond: [{ $and: [{ $gte: ['$_sec', 10] }, { $lt: ['$_sec', 60] }] }, 1, 0] } },
            over60s: { $sum: { $cond: [{ $gte: ['$_sec', 60] }, 1, 0] } },
          },
        },
      ]),
      CallLogModel.countDocuments({ ...inWindow, direction: 'inbound' }),
      CallLogModel.countDocuments({
        ...inWindow,
        direction: 'outbound',
        $expr: { $eq: [{ $ifNull: ['$salesEmail', ''] }, ''] },
      }),
      CrmUserModel.find({}).select('email name role').lean(),
    ]);

    const userByEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));

    const agentMap = new Map();
    const dataByBucket = new Map();
    for (const r of rows) {
      const email = String(r._id.email).toLowerCase();
      if (!agentMap.has(email)) {
        const u = userByEmail.get(email);
        agentMap.set(email, {
          email,
          name: u?.name || r.name || email,
          // Only an explicit role === 'bda' counts. The schema *defaults* to 'bda', but
          // older CrmUser docs store no role at all — defaulting those to BDA would
          // silently promote admins into the BDA charts.
          role: u ? u.role || 'unspecified' : 'unknown',
          isBda: u?.role === 'bda',
          calls: 0, connected: 0, talkSec: 0,
          under10s: 0, s10to60: 0, over60s: 0,
        });
      }
      const a = agentMap.get(email);
      a.calls += r.calls;
      a.connected += r.connected;
      a.talkSec += r.talkSec;
      a.under10s += r.under10s;
      a.s10to60 += r.s10to60;
      a.over60s += r.over60s;

      if (!dataByBucket.has(r._id.bucket)) dataByBucket.set(r._id.bucket, {});
      dataByBucket.get(r._id.bucket)[email] = { calls: r.calls, talkSec: r.talkSec };
    }

    // BDAs first (busiest first), then everyone else.
    const agents = [...agentMap.values()].sort((a, b) => {
      if (a.isBda !== b.isBda) return a.isBda ? -1 : 1;
      return b.calls - a.calls;
    });
    for (const a of agents) {
      a.talkMinutes = Math.round((a.talkSec / 60) * 10) / 10;
      a.avgCallSec = a.connected > 0 ? Math.round(a.talkSec / a.connected) : 0;
      a.connectRate = pct(a.connected, a.calls);
      // The honest headline: a call that lasted over a minute is a conversation.
      a.conversations = a.over60s;
      a.conversationRate = pct(a.over60s, a.calls);
    }

    const buckets = enumerateBuckets(from, to, granularity).map((bucket) => {
      const present = dataByBucket.get(bucket) || {};
      const byBda = {};
      for (const a of agents) {
        const v = present[a.email] || { calls: 0, talkSec: 0 };
        byBda[a.email] = { calls: v.calls, talkMinutes: Math.round((v.talkSec / 60) * 10) / 10 };
      }
      return { bucket, byBda };
    });

    const calls = agents.reduce((s, a) => s + a.calls, 0);
    const connected = agents.reduce((s, a) => s + a.connected, 0);
    const talkSec = agents.reduce((s, a) => s + a.talkSec, 0);
    const over60s = agents.reduce((s, a) => s + a.over60s, 0);

    return res.status(200).json({
      success: true,
      data: {
        granularity,
        timezone: TZ,
        from: from.toISOString(),
        to: to.toISOString(),
        agents,
        buckets,
        overall: {
          calls,
          connected,
          talkSec,
          talkMinutes: Math.round((talkSec / 60) * 10) / 10,
          avgCallSec: connected > 0 ? Math.round(talkSec / connected) : 0,
          connectRate: pct(connected, calls),
          conversations: over60s,
          conversationRate: pct(over60s, calls),
        },
        // Excluded from "calls made" on purpose — surfaced so the totals reconcile.
        inboundCalls,
        unattributedOutbound,
      },
    });
  } catch (error) {
    console.error('getBdaCallActivity error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load BDA call activity' });
  }
};

/**
 * BDA scorecard — meeting attendance, sales-cycle length, and plan mix.
 *
 * Attendance comes from `bdaattendances`, keyed on `bdaEmail` directly, so it does NOT
 * depend on the sparse Calendly-host attribution the other charts fight with. Only
 * `present`/`absent` form the rate; `unmarked` means nobody recorded an outcome and is
 * reported separately rather than counted as a miss. `joinedAt` is null on every row,
 * so time-in-meeting and lateness are not computable and are deliberately absent.
 *
 * Sales cycle = paymentPlan.selectedAt − scheduledEventStartTime, in days. Rows outside
 * [-1, 365] days are treated as bad data and reported as `excludedOutliers`.
 *
 * Plan mix is intentionally COUNTS ONLY. `paymentPlan.price` mixes USD, "$", CAD and ₹
 * in one field, so summing it produces a meaningless revenue figure. Use the Stripe
 * endpoints for money.
 *
 * GET /api/crm/graphs03/bda-scorecard?days=180
 */
export const getBdaScorecard = async (req, res) => {
  try {
    const days = clamp(parseInt(req.query.days, 10) || 180, 1, 400);
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86400000);
    from.setHours(0, 0, 0, 0);

    const PLAN_TIERS = ['IGNITE', 'PRIME', 'PROFESSIONAL', 'EXECUTIVE'];

    const [attRows, paidRows, users] = await Promise.all([
      BdaAttendanceModel.aggregate([
        {
          $match: {
            $or: [
              { meetingScheduledStart: { $gte: from, $lte: to } },
              { meetingScheduledStart: null, createdAt: { $gte: from, $lte: to } },
            ],
          },
        },
        {
          $group: {
            _id: { $toLower: '$bdaEmail' },
            name: { $first: '$bdaName' },
            present: { $sum: { $cond: [{ $eq: ['$status', 'present'] }, 1, 0] } },
            absent: { $sum: { $cond: [{ $eq: ['$status', 'absent'] }, 1, 0] } },
            unmarked: { $sum: { $cond: [{ $eq: ['$status', 'unmarked'] }, 1, 0] } },
            manual: { $sum: { $cond: [{ $eq: ['$status', 'manual'] }, 1, 0] } },
          },
        },
      ]),
      CampaignBookingModel.aggregate([
        {
          $match: {
            bookingStatus: 'paid',
            'paymentPlan.selectedAt': { $gte: from, $lte: to },
            scheduledEventStartTime: { $ne: null },
          },
        },
        OWNER_EMAILS_STAGE,
        OWNER_RESOLVE_STAGE,
        {
          $addFields: {
            _cycleDays: {
              $divide: [{ $subtract: ['$paymentPlan.selectedAt', '$scheduledEventStartTime'] }, 86400000],
            },
          },
        },
        {
          $group: {
            _id: '$bdaEmail',
            name: { $first: '$bdaName' },
            plans: { $push: '$paymentPlan.name' },
            cycles: { $push: '$_cycleDays' },
          },
        },
      ]),
      CrmUserModel.find({}).select('email name role').lean(),
    ]);

    const userByEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u]));
    const label = (email, fallback) => {
      const u = userByEmail.get(email);
      return {
        name: u?.name || fallback || email,
        role: email === UNASSIGNED ? 'unassigned' : u ? u.role || 'unspecified' : 'unknown',
        isBda: u?.role === 'bda',
      };
    };

    // ── Attendance ──
    const attendance = attRows
      .map((r) => {
        const marked = r.present + r.absent;
        return {
          email: r._id,
          ...label(r._id, r.name),
          present: r.present,
          absent: r.absent,
          unmarked: r.unmarked,
          manual: r.manual,
          marked,
          total: r.present + r.absent + r.unmarked + r.manual,
          presentRate: pct(r.present, marked),
        };
      })
      .sort((a, b) => (a.isBda !== b.isBda ? (a.isBda ? -1 : 1) : b.total - a.total));

    // ── Sales cycle + plan mix ──
    let excludedOutliers = 0;
    const perBda = paidRows.map((r) => {
      const cycles = r.cycles.filter((d) => {
        const ok = typeof d === 'number' && d >= -1 && d <= 365;
        if (!ok) excludedOutliers += 1;
        return ok;
      });
      cycles.sort((a, b) => a - b);
      const n = cycles.length;
      const avg = n ? cycles.reduce((s, d) => s + d, 0) / n : 0;
      const median = n ? (n % 2 ? cycles[(n - 1) / 2] : (cycles[n / 2 - 1] + cycles[n / 2]) / 2) : 0;

      const planMix = {};
      for (const t of PLAN_TIERS) planMix[t] = 0;
      let unknownPlan = 0;
      for (const p of r.plans) {
        if (p && Object.prototype.hasOwnProperty.call(planMix, p)) planMix[p] += 1;
        else unknownPlan += 1;
      }

      return {
        email: r._id,
        ...label(r._id, r.name),
        paid: r.plans.length,
        cycleN: n,
        avgCycleDays: n ? Math.round(avg * 10) / 10 : null,
        medianCycleDays: n ? Math.round(median * 10) / 10 : null,
        fastestDays: n ? Math.round(cycles[0] * 10) / 10 : null,
        slowestDays: n ? Math.round(cycles[n - 1] * 10) / 10 : null,
        planMix,
        unknownPlan,
      };
    }).sort((a, b) => {
      if (a.email === UNASSIGNED) return 1;
      if (b.email === UNASSIGNED) return -1;
      if (a.isBda !== b.isBda) return a.isBda ? -1 : 1;
      return b.paid - a.paid;
    });

    const allCycles = perBda.flatMap((b) => (b.cycleN ? [{ n: b.cycleN, avg: b.avgCycleDays }] : []));
    const totalCycleN = allCycles.reduce((s, c) => s + c.n, 0);
    const overallAvgCycle = totalCycleN
      ? Math.round((allCycles.reduce((s, c) => s + c.avg * c.n, 0) / totalCycleN) * 10) / 10
      : null;

    const paidAll = perBda.reduce((s, b) => s + b.paid, 0);
    const unattributedPaid = perBda.find((b) => b.email === UNASSIGNED)?.paid ?? 0;

    return res.status(200).json({
      success: true,
      data: {
        days,
        timezone: TZ,
        from: from.toISOString(),
        to: to.toISOString(),
        planTiers: PLAN_TIERS,
        attendance,
        salesCycle: perBda,
        overall: { paid: paidAll, avgCycleDays: overallAvgCycle, cycleN: totalCycleN },
        coverage: {
          total: paidAll,
          attributed: paidAll - unattributedPaid,
          unattributed: unattributedPaid,
          attributedPct: pct(paidAll - unattributedPaid, paidAll),
        },
        excludedOutliers,
        // Stated so nobody builds a revenue number on a field that mixes currencies.
        revenueOmitted: 'paymentPlan.price mixes USD/$/CAD/INR — use the Stripe endpoints for money.',
      },
    });
  } catch (error) {
    console.error('getBdaScorecard error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to load BDA scorecard' });
  }
};

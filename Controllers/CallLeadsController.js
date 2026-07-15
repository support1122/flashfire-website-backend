import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';

/**
 * Call Leads — Meta leads that filled the form but never booked a meeting.
 *
 * A lead qualifies once it is at least COOL_OFF_HOURS old and still has no
 * meeting. Both conditions matter:
 *   - bookingStatus === 'not-scheduled'  (never converted)
 *   - scheduledEventStartTime === null   (belt and braces: the Calendly sync sets
 *     both, but a manually-edited status could leave the two disagreeing)
 *
 * Calls are placed from the browser via the `zoomphonecall://` deep link, so the
 * server never sees the dial. Call facts (who, how long) come from CallLog, which
 * the Zoom webhook + the 5-minute call-history sync populate after the fact.
 */

const COOL_OFF_HOURS = 24;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_NOTE_LENGTH = 5000;

/** Meta-sourced leads, whichever ingest path created them. */
const META_LEAD_MATCH = {
  $or: [{ leadSource: 'meta_lead_ad' }, { metaLeadId: { $exists: true, $ne: null } }],
};

const JOB_TYPE_LABELS = {
  opt_jobs: 'OPT Jobs',
  h1b_visa_jobs: 'H1B Visa Jobs',
  sponsored_jobs: 'Sponsored Jobs',
};

/** A value that is really a phone number, not an answer to a form question. */
const PHONE_LIKE_RX = '^[+(]?[0-9][0-9 ()\\-.]{5,}$';

/** Form field names that leaked into the answer slot via the same ingest bug. */
const LEAKED_FIELD_NAMES = ['whatsapp_number', 'phone_number', 'mobile_number', 'phone', 'mobile'];

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Aggregation stages that derive the two values this tab computes rather than stores:
 *
 *   _phoneKey — the lead's last-10 digits. CampaignBooking.normalizedClientPhone is
 *               already last-10, but ~9 rows never got one (they were written through
 *               an update path that skips the pre-save hook), so fall back to the raw
 *               clientPhone and truncate it here.
 *
 *   _type     — the job-type answer, which the ingest buries in the first line of
 *               `anythingToKnow` ("Job type: opt_jobs"). Null unless it is a real
 *               answer, because both ingest paths have been landing junk in that slot:
 *               the lead's phone number (Sheets sends the phone in its `job_type`
 *               column) and bare field names. Rendering a phone number under "Type"
 *               would be wrong and would duplicate the Phone column.
 *
 * Defined once and shared by the list and summary endpoints, so a lead can never be
 * filtered under one definition and displayed under another.
 */
const DERIVE_STAGES = [
  {
    $addFields: {
      _rawPhone: {
        $cond: [
          { $ne: [{ $ifNull: ['$normalizedClientPhone', ''] }, ''] },
          '$normalizedClientPhone',
          { $ifNull: ['$clientPhone', ''] },
        ],
      },
      _jtRaw: {
        $let: {
          vars: {
            m: {
              $regexFind: {
                input: { $ifNull: ['$anythingToKnow', ''] },
                regex: 'Job type:[ \\t]*([^\\n\\r]*)',
              },
            },
          },
          in: { $trim: { input: { $ifNull: [{ $arrayElemAt: ['$$m.captures', 0] }, ''] } } },
        },
      },
    },
  },
  {
    $addFields: {
      _digits: {
        $reduce: {
          input: { $regexFindAll: { input: '$_rawPhone', regex: '[0-9]' } },
          initialValue: '',
          in: { $concat: ['$$value', '$$this.match'] },
        },
      },
    },
  },
  {
    $addFields: {
      _phoneKey: {
        $cond: [
          { $gt: [{ $strLenCP: '$_digits' }, 10] },
          { $substrCP: ['$_digits', { $subtract: [{ $strLenCP: '$_digits' }, 10] }, 10] },
          '$_digits',
        ],
      },
      _type: {
        $cond: [
          {
            $or: [
              { $eq: ['$_jtRaw', ''] },
              // No letter anywhere: "+1", "+9163", a bare digit string.
              { $not: [{ $regexMatch: { input: '$_jtRaw', regex: '[A-Za-z]' } }] },
              { $regexMatch: { input: '$_jtRaw', regex: PHONE_LIKE_RX } },
              { $in: [{ $toLower: '$_jtRaw' }, LEAKED_FIELD_NAMES] },
            ],
          },
          null,
          '$_jtRaw',
        ],
      },
      // Bucket boundaries must mirror ageRange() exactly, or the dropdown would show a
      // count that its own filter cannot reproduce.
      _ageBucket: {
        $let: {
          vars: {
            days: {
              $divide: [{ $subtract: ['$$NOW', '$bookingCreatedAt'] }, 24 * 60 * 60 * 1000],
            },
          },
          in: {
            $switch: {
              branches: [
                { case: { $lt: ['$$days', 2] }, then: 'lt2d' },
                { case: { $lt: ['$$days', 7] }, then: '2to7d' },
                { case: { $lt: ['$$days', 30] }, then: '7to30d' },
              ],
              default: 'gt30d',
            },
          },
        },
      },
    },
  },
];

/**
 * A call long enough to have been an actual conversation rather than a ring-out.
 * Same threshold the Graphs 03 tab uses, so the two never disagree about what
 * "reached the client" means.
 */
const CONVERSATION_MIN_SEC = 60;

/**
 * Which numbers have been called at all, and which produced a real conversation.
 *
 * Held in memory and passed back into the pipeline: there are a few hundred distinct
 * called numbers against a lead set in the thousands. That is what lets the status
 * filter run INSIDE the query, so totalCount and the page count describe the filtered
 * set instead of the filter quietly trimming a single page.
 */
async function callActivityKeys() {
  const rows = await CallLogModel.find({ leadNumberNormalized: { $nin: [null, ''] } })
    .select('leadNumberNormalized durationSec')
    .lean();

  const called = new Set();
  const conversed = new Set();
  for (const r of rows) {
    const k = last10(r.leadNumberNormalized);
    if (!k) continue;
    called.add(k);
    if ((Number(r.durationSec) || 0) >= CONVERSATION_MIN_SEC) conversed.add(k);
  }
  return { calledKeys: [...called], conversationKeys: [...conversed] };
}

/**
 * Call progress — the only status that carries information on this tab.
 *
 * Every lead here is `bookingStatus: 'not-scheduled'` by definition, so showing that
 * would be a column with one value repeated down every row. What a caller actually
 * needs to know is how far along the lead is:
 *
 *   new       — Zoom has no call to this number
 *   attempted — Zoom logged a call, but none reached 60s (rang out, voicemail, hang-up)
 *   contacted — a call of 60s or more actually happened
 *
 * Derived purely from Zoom's CallLog, the same source the Phone Calls tab reads. The
 * three are mutually exclusive and cover the set, so they can be counted as a funnel.
 */
function statusStage(calledKeys, conversationKeys) {
  return {
    $addFields: {
      _status: {
        $cond: [
          { $in: ['$_phoneKey', conversationKeys] },
          'contacted',
          { $cond: [{ $in: ['$_phoneKey', calledKeys] }, 'attempted', 'new'] },
        ],
      },
    },
  };
}

/**
 * How long ago the lead filled the form. Merged into (not over) the base 24h cutoff:
 * the age ranges below are all older than 24h, so spreading this last narrows the
 * window correctly rather than reopening it.
 */
function ageRange(age) {
  const now = Date.now();
  const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000);
  switch (age) {
    case 'lt2d':
      return { $gt: daysAgo(2) };
    case '2to7d':
      return { $gt: daysAgo(7), $lte: daysAgo(2) };
    case '7to30d':
      return { $gt: daysAgo(30), $lte: daysAgo(7) };
    case 'gt30d':
      return { $lte: daysAgo(30) };
    default:
      return null;
  }
}

const jobTypeLabel = (t) =>
  t ? JOB_TYPE_LABELS[t] || t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;

/** Digits only, e.g. "+1 (817) 757-6833" -> "18177576833". */
const digitsOf = (s) => String(s || '').replace(/\D+/g, '');

/**
 * The last 10 digits — the one key both phone conventions in this codebase agree on.
 * CampaignBooking.normalizedClientPhone is last-10, but CallLog.leadNumberNormalized
 * only strips a leading US "1" (Utils/ZoomPhone.js), so a +91 number is stored as
 * "919959348539" on one side and "9959348539" on the other. Comparing the last 10
 * digits matches both without special-casing country codes.
 */
const last10 = (s) => {
  const d = digitsOf(s);
  return d.length > 10 ? d.slice(-10) : d;
};

const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';

/**
 * Every digit string a CallLog might have stored this lead's number under.
 *
 * Must consider BOTH fields: normalizedClientPhone is already truncated to 10 digits,
 * so on its own it can never produce the country-code form ("919959348539") that
 * CallLog.leadNumberNormalized holds for a non-US number. clientPhone keeps the full
 * number, so it is what yields that form.
 */
function phoneCandidatesOf(booking, into) {
  for (const raw of [booking.normalizedClientPhone, booking.clientPhone]) {
    const d = digitsOf(raw);
    if (!d) continue;
    into.add(d);
    into.add(last10(d));
  }
  return into;
}

function cutoffDate() {
  return new Date(Date.now() - COOL_OFF_HOURS * 60 * 60 * 1000);
}

/** The full set of leads this tab is about, before any user-supplied filter. */
function baseMatch() {
  return {
    ...META_LEAD_MATCH,
    bookingStatus: 'not-scheduled',
    scheduledEventStartTime: null,
    bookingCreatedAt: { $lte: cutoffDate() },
  };
}

/* ------------------------------------------------------------------------ */
/* BDA rotation                                                              */
/* ------------------------------------------------------------------------ */

/**
 * The BDAs in the round-robin, in a stable order.
 *
 * `role: 'bda'` alone is NOT a safe test: CrmUser.role DEFAULTS to 'bda', so an admin
 * whose document predates the field — or who simply never had it set — reads as a BDA.
 * Requiring isAdmin !== true drops them. Today this resolves to exactly Siddhartha and
 * Kalpataru; add a BDA in the CRM and they join the rotation with no code change.
 */
async function rotationBdas() {
  const users = await CrmUserModel.find({
    role: 'bda',
    isActive: { $ne: false },
    isAdmin: { $ne: true },
  })
    .select('email name')
    .lean();

  return users
    .map((u) => ({ email: String(u.email).toLowerCase().trim(), name: u.name || u.email }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

/**
 * The email this request may see, or null for someone who sees every lead.
 *
 * Deliberately the SAME predicate as the rotation: if you are in the rotation you see
 * only your own leads, and if you are not, you see all of them. That equivalence is
 * what makes the tab coherent — nobody can be assigned leads they cannot open, and
 * nobody is scoped to a queue they are not in.
 *
 * Resolved from the database rather than the JWT on purpose. The token's `bdaRole`
 * claim is `user.role || 'bda'`, so an admin with no role field arrives claiming to be
 * a BDA and would otherwise be scoped to an empty queue.
 */
async function ownScopeEmail(req) {
  const email = req.crmUser?.email ? String(req.crmUser.email).toLowerCase().trim() : null;
  if (!email) return null;
  const roster = await rotationBdas();
  return roster.some((b) => b.email === email) ? email : null;
}

/**
 * Round-robin every unassigned call lead across the active BDAs.
 *
 * Balances against each BDA's CURRENT total rather than cycling a stored pointer, so
 * repeated runs converge instead of drifting, and a BDA added later catches up rather
 * than staying permanently behind. Oldest leads go first — they have waited longest.
 *
 * Idempotent and safe to run concurrently: every update re-asserts "still unassigned"
 * in its own filter, so a lead cannot be handed to two BDAs by two overlapping runs.
 */
export async function assignUnassignedCallLeads({ limit = 5000 } = {}) {
  const roster = await rotationBdas();
  if (roster.length === 0) {
    return { ok: true, assigned: 0, reason: 'no active BDAs in the rotation' };
  }

  const counts = new Map(roster.map((b) => [b.email, 0]));
  const existing = await CampaignBookingModel.aggregate([
    {
      $match: {
        ...META_LEAD_MATCH,
        bookingStatus: 'not-scheduled',
        'callLeadAssignee.email': { $nin: [null, ''] },
      },
    },
    { $group: { _id: '$callLeadAssignee.email', n: { $sum: 1 } } },
  ]);
  for (const e of existing) {
    const k = String(e._id).toLowerCase();
    if (counts.has(k)) counts.set(k, e.n);
  }

  const pending = await CampaignBookingModel.find({
    ...baseMatch(),
    'callLeadAssignee.email': { $in: [null, ''] },
  })
    .select('bookingId')
    .sort({ bookingCreatedAt: 1 })
    .limit(limit)
    .lean();

  if (pending.length === 0) return { ok: true, assigned: 0, roster: roster.map((b) => b.email) };

  const now = new Date();
  const ops = pending.map((lead) => {
    // Fewest leads wins; ties fall to the earlier email, so the split is deterministic.
    let pick = roster[0];
    for (const b of roster) {
      if (counts.get(b.email) < counts.get(pick.email)) pick = b;
    }
    counts.set(pick.email, counts.get(pick.email) + 1);

    return {
      updateOne: {
        filter: { bookingId: lead.bookingId, 'callLeadAssignee.email': { $in: [null, ''] } },
        update: {
          $set: {
            'callLeadAssignee.email': pick.email,
            'callLeadAssignee.name': pick.name,
            'callLeadAssignee.assignedAt': now,
          },
        },
      },
    };
  });

  const result = await CampaignBookingModel.bulkWrite(ops, { ordered: false });

  return {
    ok: true,
    assigned: result.modifiedCount ?? 0,
    considered: pending.length,
    totals: Object.fromEntries(counts),
  };
}

/**
 * Fetch every CallLog belonging to the given leads, in one indexed query, and
 * bucket them by last-10 phone key.
 *
 * `leadNumberNormalized` is indexed, so we query it by exact value ($in) rather
 * than with a suffix regex (which could not use the index). We pass both digit
 * forms — the last-10 and the full digit string — so a call logged under a full
 * international number is still found.
 */
async function callsByPhoneKey(bookings) {
  const candidates = new Set();
  for (const b of bookings) phoneCandidatesOf(b, candidates);
  const byKey = new Map();
  if (candidates.size === 0) return byKey;

  const rows = await CallLogModel.find({ leadNumberNormalized: { $in: [...candidates] } })
    .select('leadNumberNormalized salesEmail salesName durationSec direction status startedAt callId')
    .sort({ startedAt: -1 })
    .lean();

  for (const r of rows) {
    const key = last10(r.leadNumberNormalized);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return byKey;
}

/** Roll a lead's raw CallLog rows up into the numbers the table shows. */
function summarizeCalls(rows) {
  const list = rows || [];
  const byAgent = new Map();
  let totalDurationSec = 0;
  let lastCallAt = null;

  for (const r of list) {
    const sec = Number(r.durationSec) || 0;
    totalDurationSec += sec;
    if (r.startedAt && (!lastCallAt || r.startedAt > lastCallAt)) lastCallAt = r.startedAt;

    // A call with no salesEmail is one Zoom could not attribute to an agent. Keep it
    // in the totals (it happened) but do not invent a caller for it.
    const email = nonEmpty(r.salesEmail) ? r.salesEmail.toLowerCase() : null;
    const key = email || '__unattributed__';
    if (!byAgent.has(key)) {
      byAgent.set(key, { email, name: r.salesName || null, calls: 0, durationSec: 0 });
    }
    const a = byAgent.get(key);
    a.calls += 1;
    a.durationSec += sec;
    if (!a.name && r.salesName) a.name = r.salesName;
  }

  const callers = [...byAgent.values()].sort((a, b) => b.calls - a.calls);

  return {
    count: list.length,
    totalDurationSec,
    lastCallAt,
    callers,
    // Newest first, capped — the row detail panel does not need an unbounded history.
    history: list.slice(0, 20).map((r) => ({
      callId: r.callId,
      startedAt: r.startedAt,
      durationSec: Number(r.durationSec) || 0,
      direction: r.direction,
      status: r.status,
      salesName: r.salesName || null,
      salesEmail: r.salesEmail || null,
    })),
  };
}

/** GET /api/crm/call-leads */
export const getCallLeads = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
    const search = String(req.query.search || '').trim();
    const typeFilter = String(req.query.type || '').trim();
    const assigneeFilter = String(req.query.assignee || '').trim().toLowerCase();
    const statusFilter = String(req.query.status || 'all').trim();
    const ageFilter = String(req.query.age || 'all').trim();
    const sort = String(req.query.sort || 'newest').trim();

    const match = baseMatch();

    if (search) {
      const rx = new RegExp(escapeRegex(search), 'i');
      // `match` already owns a top-level $or (the Meta-source test), so the search
      // clause has to be $and-ed in rather than overwrite it.
      match.$and = [{ $or: [{ clientName: rx }, { clientEmail: rx }, { clientPhone: rx }] }];
    }

    if (assigneeFilter === 'unassigned') {
      match['callLeadAssignee.email'] = { $in: [null, ''] };
    } else if (assigneeFilter) {
      match['callLeadAssignee.email'] = assigneeFilter;
    }

    const age = ageRange(ageFilter);
    if (age) match.bookingCreatedAt = { ...match.bookingCreatedAt, ...age };

    // Applied last so it overwrites any assignee filter: a BDA cannot widen their own
    // scope by passing ?assignee=someone-else.
    const scopedTo = await ownScopeEmail(req);
    if (scopedTo) match['callLeadAssignee.email'] = scopedTo;

    const { calledKeys, conversationKeys } = await callActivityKeys();

    const pipeline = [
      { $match: match },
      ...DERIVE_STAGES,
      statusStage(calledKeys, conversationKeys),
    ];

    // These run INSIDE the query, so totalCount and the page count describe the filtered
    // set. Filtering after $limit would only ever trim the current page — ask for
    // "contacted", land on page 1 of the newest leads, and see an empty table while the
    // contacted ones sat on later pages.
    if (typeFilter && typeFilter !== 'all') {
      pipeline.push({ $match: typeFilter === 'unknown' ? { _type: null } : { _type: typeFilter } });
    }
    if (['new', 'attempted', 'contacted'].includes(statusFilter)) {
      pipeline.push({ $match: { _status: statusFilter } });
    }

    const [facet] = await CampaignBookingModel.aggregate([
      ...pipeline,
      {
        $facet: {
          rows: [
            { $sort: { bookingCreatedAt: sort === 'oldest' ? 1 : -1 } },
            { $skip: (page - 1) * limit },
            { $limit: limit },
            {
              $project: {
                bookingId: 1, clientName: 1, clientEmail: 1, clientPhone: 1,
                normalizedClientPhone: 1, bookingStatus: 1, bookingCreatedAt: 1,
                metaCampaignName: 1, metaPlatform: 1, callLeadAssignee: 1, callLeadNotes: 1,
                _phoneKey: 1, _type: 1, _status: 1,
              },
            },
          ],
          total: [{ $count: 'n' }],
        },
      },
    ]);

    const bookings = facet?.rows ?? [];
    const totalCount = facet?.total?.[0]?.n ?? 0;

    const callMap = await callsByPhoneKey(bookings);
    const now = Date.now();

    const data = bookings.map((b) => {
      const type = b._type ?? null;
      const calls = summarizeCalls(callMap.get(b._phoneKey));

      const notes = (b.callLeadNotes || [])
        .map((n) => ({
          text: n.text,
          authorEmail: n.authorEmail || null,
          authorName: n.authorName || n.authorEmail || 'Unknown',
          createdAt: n.createdAt,
        }))
        .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));

      return {
        bookingId: b.bookingId,
        clientName: b.clientName,
        clientEmail: b.clientEmail,
        clientPhone: b.clientPhone,
        type,
        typeLabel: jobTypeLabel(type),
        // Call progress: new | attempted | contacted. NOT bookingStatus, which is
        // 'not-scheduled' on every row here and so says nothing.
        status: b._status,
        bookingCreatedAt: b.bookingCreatedAt,
        ageHours: b.bookingCreatedAt
          ? Math.floor((now - new Date(b.bookingCreatedAt).getTime()) / 3600000)
          : null,
        campaign: b.metaCampaignName || null,
        platform: b.metaPlatform || null,
        assignedBda: assigneeOf(b),
        notes,
        notesCount: notes.length,
        calls,
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.max(1, Math.ceil(totalCount / limit)),
      },
      // Non-null when the caller is a BDA seeing only their own queue. The UI uses it
      // to drop the columns and filters that are meaningless in that view.
      scopedTo,
      coolOffHours: COOL_OFF_HOURS,
    });
  } catch (error) {
    console.error('[CallLeads] getCallLeads error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * GET /api/crm/call-leads/summary
 * Whole-set counters + the values the filter dropdowns offer. Kept off the list
 * endpoint so paging does not recompute it.
 */
export const getCallLeadsSummary = async (req, res) => {
  try {
    const { calledKeys, conversationKeys } = await callActivityKeys();

    // A BDA's counters must describe THEIR queue. Showing them "1,611 leads to call"
    // when 806 are someone else's would be worse than showing nothing.
    const scopedTo = await ownScopeEmail(req);
    const match = baseMatch();
    if (scopedTo) match['callLeadAssignee.email'] = scopedTo;

    const [facet] = await CampaignBookingModel.aggregate([
      { $match: match },
      ...DERIVE_STAGES,
      statusStage(calledKeys, conversationKeys),
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                // The funnel. Mutually exclusive, so these three sum to `total`.
                statusNew: { $sum: { $cond: [{ $eq: ['$_status', 'new'] }, 1, 0] } },
                attempted: { $sum: { $cond: [{ $eq: ['$_status', 'attempted'] }, 1, 0] } },
                contacted: { $sum: { $cond: [{ $eq: ['$_status', 'contacted'] }, 1, 0] } },
                assigned: {
                  $sum: {
                    $cond: [{ $ne: [{ $ifNull: ['$callLeadAssignee.email', ''] }, ''] }, 1, 0],
                  },
                },
                // A lead with no number cannot be called from this tab. Reported,
                // not silently folded into "never called".
                noPhone: { $sum: { $cond: [{ $eq: ['$_phoneKey', ''] }, 1, 0] } },
              },
            },
          ],
          byType: [{ $group: { _id: '$_type', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
          byAge: [{ $group: { _id: '$_ageBucket', count: { $sum: 1 } } }],
          byAssignee: [
            { $match: { 'callLeadAssignee.email': { $nin: [null, ''] } } },
            {
              $group: {
                _id: '$callLeadAssignee.email',
                name: { $first: '$callLeadAssignee.name' },
                leads: { $sum: 1 },
              },
            },
            { $sort: { leads: -1 } },
          ],
        },
      },
    ]);

    const t = facet?.totals?.[0] ?? {
      total: 0, statusNew: 0, attempted: 0, contacted: 0, assigned: 0, noPhone: 0,
    };

    const ageCounts = Object.fromEntries((facet?.byAge ?? []).map((r) => [r._id, r.count]));

    return res.status(200).json({
      success: true,
      summary: {
        total: t.total,
        new: t.statusNew,
        attempted: t.attempted,
        contacted: t.contacted,
        assigned: t.assigned,
        unassigned: t.total - t.assigned,
        noPhone: t.noPhone,
      },
      types: (facet?.byType ?? []).map((r) => ({
        value: r._id ?? 'unknown',
        label: r._id ? jobTypeLabel(r._id) : 'Unknown',
        count: r.count,
      })),
      statuses: [
        { value: 'new', label: 'New', count: t.statusNew },
        { value: 'attempted', label: 'Attempted', count: t.attempted },
        { value: 'contacted', label: 'Contacted', count: t.contacted },
      ],
      ages: [
        { value: 'lt2d', label: '1–2 days', count: ageCounts.lt2d ?? 0 },
        { value: '2to7d', label: '2–7 days', count: ageCounts['2to7d'] ?? 0 },
        { value: '7to30d', label: '7–30 days', count: ageCounts['7to30d'] ?? 0 },
        { value: 'gt30d', label: '30+ days', count: ageCounts.gt30d ?? 0 },
      ],
      assignees: (facet?.byAssignee ?? []).map((r) => ({
        email: r._id,
        name: r.name || r._id,
        leads: r.leads,
      })),
      scopedTo,
      coolOffHours: COOL_OFF_HOURS,
    });
  } catch (error) {
    console.error('[CallLeads] getCallLeadsSummary error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * POST /api/crm/call-leads/assign
 * Manual trigger for the round-robin. The scheduler runs it anyway; this exists so an
 * admin can force a pass (and see the resulting split) without waiting for the tick.
 */
export const triggerCallLeadAssignment = async (req, res) => {
  try {
    // A scoped BDA must not be able to reshuffle the queue.
    if (await ownScopeEmail(req)) {
      return res.status(403).json({ success: false, error: 'Admins only' });
    }
    const result = await assignUnassignedCallLeads({});
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[CallLeads] triggerCallLeadAssignment error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Guard for the write endpoints. A scoped BDA may only act on leads that are already
 * theirs — the list already hides everyone else's, and this closes the gap where a
 * bookingId could simply be POSTed directly.
 *
 * Returns an error object to send, or null to proceed.
 */
async function denyIfNotOwn(req, booking) {
  const scopedTo = await ownScopeEmail(req);
  if (!scopedTo) return null;

  const owner = String(booking.callLeadAssignee?.email || '').toLowerCase();
  if (owner === scopedTo) return null;

  return owner
    ? { code: 403, error: 'This lead is assigned to another BDA' }
    : { code: 403, error: 'This lead is not assigned to you yet' };
}

/** Shape the stored assignee for the API, or null when nobody owns the lead. */
const assigneeOf = (booking) =>
  nonEmpty(booking?.callLeadAssignee?.email)
    ? {
        email: booking.callLeadAssignee.email,
        name: booking.callLeadAssignee.name || booking.callLeadAssignee.email,
        assignedAt: booking.callLeadAssignee.assignedAt || null,
      }
    : null;

/** POST /api/crm/call-leads/:bookingId/notes  { text } */
export const addCallLeadNote = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const text = String(req.body?.text ?? '').trim();

    if (!text) {
      return res.status(400).json({ success: false, error: 'Note text is required' });
    }
    if (text.length > MAX_NOTE_LENGTH) {
      return res
        .status(400)
        .json({ success: false, error: `Note is too long (max ${MAX_NOTE_LENGTH} characters)` });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId })
      .select('bookingId bookingStatus callLeadAssignee')
      .lean();
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Lead not found' });
    }
    if (booking.bookingStatus !== 'not-scheduled') {
      return res.status(400).json({
        success: false,
        error: 'This lead has already booked a meeting and is no longer a call lead',
      });
    }

    const denied = await denyIfNotOwn(req, booking);
    if (denied) return res.status(denied.code).json({ success: false, error: denied.error });

    const note = {
      text,
      authorEmail: req.crmUser?.email ? String(req.crmUser.email).toLowerCase() : null,
      authorName: req.crmUser?.name || req.crmUser?.email || null,
      createdAt: new Date(),
    };

    // Writing a note does NOT claim the lead. Round-robin owns assignment; letting a
    // touch claim it would hand ownership to whichever admin happened to look first.
    const updated = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { $push: { callLeadNotes: note } },
      { new: true }
    )
      .select('callLeadNotes callLeadAssignee')
      .lean();

    const notes = (updated?.callLeadNotes || [])
      .map((n) => ({
        text: n.text,
        authorEmail: n.authorEmail || null,
        authorName: n.authorName || n.authorEmail || 'Unknown',
        createdAt: n.createdAt,
      }))
      .sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));

    return res.status(200).json({
      success: true,
      notes,
      assignedBda: assigneeOf(updated),
    });
  } catch (error) {
    console.error('[CallLeads] addCallLeadNote error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Note: there is deliberately no "call attempt" endpoint. Clicking Call opens the
// `zoomphonecall://` deep link and nothing else — every call fact on this tab (who
// called, how long, when) comes from Zoom's own CallLog, exactly like the Phone Calls
// tab. Recording our own click would be a second, disagreeing source of truth.

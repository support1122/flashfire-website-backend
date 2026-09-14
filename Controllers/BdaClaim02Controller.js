import Stripe from 'stripe';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaClaim02Model } from '../Schema_Models/BdaClaim02.js';
import { BdaIncentiveConfigModel } from '../Schema_Models/BdaIncentiveConfig.js';
import {
  getClientTrackingRecordModel,
  getClientUserModel,
} from '../Utils/ClientsTrackingDB.js';
import { normalizeCurrency } from '../Utils/currency.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * "Claim Leads 02" controller.
 *
 * Parallel to BdaLeadController's claim flow, but:
 *  - driven by a lightweight BdaClaim02 collection (one row per booking),
 *  - the Registered plan/currency/amount are a read-only snapshot from the
 *    clients-tracking DB, matched by CRM email,
 *  - BDAs see only their own rows and never the Registered currency/amount,
 *  - admins see everything, approve with a tick, and may edit the BDA amount
 *    (which recomputes the incentive).
 *
 * All routes here use `requireCrmUser`; admin vs BDA is decided in-controller
 * from `req.crmUser.bdaRole` (the CrmUser.role value carried in the token).
 */

// Fallback base prices per currency — mirrors BdaLeadController.
const CURRENCY_BASE_PRICES = {
  USD: { PRIME: 99, IGNITE: 199, PROFESSIONAL: 349, EXECUTIVE: 599 },
  CAD: { PRIME: 139, IGNITE: 239, PROFESSIONAL: 409, EXECUTIVE: 799 },
  GBP: { PRIME: 79, IGNITE: 149, PROFESSIONAL: 299, EXECUTIVE: 499 },
};

const PLAN_KEYS = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];
const BDA_CURRENCIES = ['USD', 'GBP', 'INR', 'CAD'];
// Leads eligible to be claimed here — same set the original claim flow allows.
const CLAIMABLE_STATUSES = ['paid', 'scheduled', 'completed', 'rescheduled'];

const isAdmin = (req) => req.crmUser?.bdaRole === 'admin';

/** clients-tracking `planType` (any case, or a label) -> incentive plan key or ''. */
function toPlanKey(raw) {
  const v = String(raw || '').trim().toUpperCase();
  return PLAN_KEYS.includes(v) ? v : '';
}

/**
 * Parse a clients-tracking amount value into a number, stripping any currency
 * symbol / code prefix ("£999", "CAD 749", "$1,200"). Returns null when there
 * is no usable number.
 */
function parseAmount(raw) {
  if (raw == null) return null;
  const cleaned = String(raw).replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve the Registered currency for a clients-tracking record.
 *
 * Verified against live data (290 dashboardtrackings rows): the `currency`
 * field on dashboardtrackings is NEVER populated. The reliable source is the
 * matching `users` row (`currency` in {CAD,GBP,INR,USD}, set on 244/293 rows).
 * Failing that, the `amountPaid` string usually carries a symbol/code prefix
 * ("£79", "$99", "CAD749", "₹46629"). Bare values like "579" give nothing.
 *
 *  1) `users.currency` (primary),
 *  2) a symbol/code prefix on the `amountPaid` string,
 *  3) an explicit `currency` on the record (future-proofing; absent today),
 * else null — shown as "—" in the admin view (no guessing).
 */
function resolveRegisteredCurrency(record, userRow) {
  const fromUser = String(userRow?.currency || '').trim();
  if (fromUser) return normalizeCurrency(fromUser);

  const amt = String(record?.amountPaid || '').trim().toUpperCase();
  if (amt.startsWith('CAD') || amt.startsWith('CA$')) return 'CAD';
  if (amt.startsWith('₹') || amt.startsWith('INR')) return 'INR';
  if (amt.startsWith('£') || amt.startsWith('GBP')) return 'GBP';
  if (amt.startsWith('€') || amt.startsWith('EUR')) return 'EUR';
  if (amt.startsWith('$') || amt.startsWith('USD')) return 'USD';

  const fromRecord = String(record?.currency || '').trim();
  if (fromRecord) return normalizeCurrency(fromRecord);

  return null;
}

/** Build Map("PLAN|CURRENCY" -> { basePrice, incentivePerLeadInr }) — mirrors BdaLeadController. */
async function buildIncentiveConfig() {
  const rows = await BdaIncentiveConfigModel.find({}).lean();
  const configByKey = new Map();
  rows.forEach((r) => {
    const currency = (r.currency || 'USD').toUpperCase();
    const basePrice =
      r.basePrice != null
        ? r.basePrice
        : r.basePriceUsd ?? (CURRENCY_BASE_PRICES.USD[r.planName] ?? 0);
    configByKey.set(`${r.planName}|${currency}`, {
      basePrice,
      incentivePerLeadInr: r.incentivePerLeadInr ?? 0,
    });
  });
  return configByKey;
}

/** Prorated incentive (INR) for one claim line — same formula as BdaLeadController.incentiveForLine. */
function incentiveForLine(configByKey, planKey, amount, currency) {
  if (!planKey || !amount || amount <= 0) return 0;
  const cur = (currency || 'USD').toUpperCase();
  const config = configByKey.get(`${planKey}|${cur}`) || configByKey.get(`${planKey}|USD`);
  if (!config) return 0;

  const fallback = (CURRENCY_BASE_PRICES[cur] || CURRENCY_BASE_PRICES.USD)[planKey] || 1;
  const base = config.basePrice > 0 ? config.basePrice : fallback;
  const ratio = Math.min(1, amount / base);
  return config.incentivePerLeadInr * ratio;
}

/**
 * Most recent SUCCEEDED Stripe charge for a payment email → { amount, currency }.
 * Returns null when Stripe is not configured, the email is empty, or there is
 * no matching succeeded charge. `amount` is in major units (dollars/pounds),
 * `currency` an uppercased ISO code.
 */
async function fetchStripePaymentByEmail(paymentEmail) {
  const email = String(paymentEmail || '').toLowerCase().trim();
  if (!stripe || !email) return null;

  try {
    // charges.search matches by billing_details.email; sort newest first.
    const q = `status:'succeeded' AND billing_details.email:'${email.replace(/'/g, "\\'")}'`;
    const res = await stripe.charges.search({ query: q, limit: 20 });
    const charges = (res.data || [])
      .filter((c) => c.status === 'succeeded' && c.amount > 0)
      .sort((a, b) => (b.created || 0) - (a.created || 0));

    // Fallback: receipt_email is not covered by charges.search — if nothing
    // matched, scan a page of recent charges for it.
    let best = charges[0];
    if (!best) {
      const page = await stripe.charges.list({ limit: 100 });
      best = (page.data || [])
        .filter(
          (c) =>
            c.status === 'succeeded' &&
            c.amount > 0 &&
            String(c.receipt_email || c.billing_details?.email || '').toLowerCase().trim() === email
        )
        .sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    }
    if (!best) return null;

    return { amount: best.amount / 100, currency: String(best.currency || '').toUpperCase() || null };
  } catch (e) {
    console.warn('[claim02] Stripe lookup failed for', email, '-', e?.message || e);
    return null;
  }
}

/** Look up the clients-tracking registration snapshot for a CRM email. */
async function fetchRegisteredSnapshot(crmEmail) {
  const empty = { registeredPlan: '', registeredCurrency: null, registeredAmountPaid: null };
  const email = String(crmEmail || '').toLowerCase().trim();
  if (!email) return empty;

  const RecordModel = await getClientTrackingRecordModel();
  if (!RecordModel) return empty;

  // Match ONLY on crmEmail — the CRM email captured at registration. We do not
  // fall back to dashboardtrackings.email: that is the client's dashboard login
  // address (a different mailbox), so matching it pairs the claim with the
  // wrong person. A lead with no crmEmail match simply has no Registered data.
  const record = await RecordModel.findOne({ crmEmail: email }).lean();
  if (!record) return empty;

  let userRow = null;
  const UserModel = await getClientUserModel();
  if (UserModel && record.email) {
    userRow = await UserModel.findOne({ email: String(record.email).toLowerCase().trim() }).lean();
  }

  // Payment Received (Stripe): the actual Stripe charge for this client's
  // `paymentEmail` (the "Payment Email" on the registration form), taking the
  // most recent succeeded charge. Falls back to the hand-typed
  // dashboardtrackings.amountPaid, then planPrice, when there is no Stripe
  // match (or Stripe is unconfigured).
  const stripePayment = await fetchStripePaymentByEmail(record.paymentEmail);
  const fallbackAmount =
    parseAmount(record.amountPaid) ?? (record.planPrice > 0 ? record.planPrice : null);

  return {
    registeredPlan: toPlanKey(record.planType),
    registeredCurrency:
      stripePayment?.currency
        ? normalizeCurrency(stripePayment.currency)
        : resolveRegisteredCurrency(record, userRow),
    registeredAmountPaid: stripePayment?.amount ?? fallbackAmount,
  };
}

/** Shape a row for the client. BDA view drops the Registered currency/amount. */
function serialize(doc, { admin }) {
  const o = doc.toObject ? doc.toObject() : doc;
  const base = {
    _id: o._id,
    bookingId: o.bookingId,
    clientName: o.clientName,
    crmEmail: o.crmEmail,
    clientPhone: o.clientPhone,
    registeredPlan: o.registeredPlan || '',
    bdaCurrency: o.bdaCurrency || null,
    bdaAmountCollected: o.bdaAmountCollected ?? null,
    incentiveInr: Math.round((o.incentiveInr ?? 0) * 100) / 100,
    claimedBy: o.claimedBy,
    claimedAt: o.claimedAt,
    status: o.status,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
  if (!admin) return base;

  const registeredAmountPaid = o.registeredAmountPaid ?? null;
  const mismatch =
    registeredAmountPaid != null &&
    o.bdaAmountCollected != null &&
    Math.round(registeredAmountPaid) !== Math.round(o.bdaAmountCollected);

  return {
    ...base,
    registeredCurrency: o.registeredCurrency || null,
    registeredAmountPaid,
    approvedBy: o.approvedBy,
    approvedAt: o.approvedAt,
    mismatch,
  };
}

/** Recompute + persist incentiveInr from the current registered plan + BDA amount/currency. */
async function recomputeIncentive(doc) {
  const configByKey = await buildIncentiveConfig();
  doc.incentiveInr = incentiveForLine(
    configByKey,
    doc.registeredPlan,
    doc.bdaAmountCollected,
    doc.bdaCurrency
  );
}

/* ------------------------------------------------------------------ */
/*  BDA + shared endpoints                                            */
/* ------------------------------------------------------------------ */

/**
 * GET /api/bda/claim02/search?q=
 * Search CRM leads (CampaignBooking) by email / name / phone. Returns a
 * dropdown list, each marked with whether it is already claimed here.
 */
export const searchLeads = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) {
      return res.status(200).json({ success: true, data: [] });
    }

    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const bookings = await CampaignBookingModel.find({
      bookingStatus: { $in: CLAIMABLE_STATUSES },
      $or: [{ clientEmail: rx }, { clientName: rx }, { clientPhone: rx }, { normalizedClientPhone: rx }],
    })
      .sort({ scheduledEventStartTime: -1 })
      .limit(20)
      .select('bookingId clientName clientEmail clientPhone bookingStatus')
      .lean();

    const ids = bookings.map((b) => b.bookingId);
    // Only an ACTIVE (non-denied) claim locks a lead. Denied rows are history —
    // the lead is released and shows as claimable again.
    const claims = await BdaClaim02Model.find({
      bookingId: { $in: ids },
      status: { $in: ['pending', 'approved'] },
    })
      .select('bookingId claimedBy status')
      .lean();
    const claimByBooking = new Map(claims.map((c) => [c.bookingId, c]));

    const data = bookings.map((b) => {
      const claim = claimByBooking.get(b.bookingId);
      return {
        bookingId: b.bookingId,
        clientName: b.clientName,
        clientEmail: b.clientEmail,
        clientPhone: b.clientPhone,
        bookingStatus: b.bookingStatus,
        alreadyClaimed: Boolean(claim),
        claimedByName: claim?.claimedBy?.name || null,
        claimedByMe: claim?.claimedBy?.email === req.crmUser?.email,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error('[claim02] searchLeads error:', error);
    return res.status(500).json({ success: false, message: 'Search failed', error: error.message });
  }
};

/**
 * GET /api/bda/claim02/my
 * The logged-in BDA's own claimed rows. Admins get every row (all columns).
 */
export const listMyClaims = async (req, res) => {
  try {
    const admin = isAdmin(req);
    // A BDA sees only their own still-active claims — a denied claim means the
    // lead was taken back, so it drops off their list (admins keep the history).
    const filter = admin
      ? {}
      : { 'claimedBy.email': req.crmUser.email, status: { $in: ['pending', 'approved'] } };
    const rows = await BdaClaim02Model.find(filter).sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      data: rows.map((r) => serialize(r, { admin })),
    });
  } catch (error) {
    console.error('[claim02] listMyClaims error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load claims', error: error.message });
  }
};

/**
 * POST /api/bda/claim02/claim/:bookingId
 * Claim a CRM lead. Creates a pending row owned by the logged-in BDA and
 * snapshots the Registered plan/currency/amount from clients-tracking.
 */
export const claimLead = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const email = req.crmUser?.email;
    const name = req.crmUser?.name;
    if (!email || !name) {
      return res.status(401).json({ success: false, message: 'User authentication required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId })
      .select('bookingId clientName clientEmail clientPhone bookingStatus')
      .lean();
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    if (!CLAIMABLE_STATUSES.includes(booking.bookingStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Only leads with status paid, scheduled, completed, or rescheduled can be claimed',
      });
    }

    // Block only when there is an ACTIVE (pending/approved) claim. Denied rows
    // are history — the lead is released, so this claim is allowed and a fresh
    // row is created alongside them.
    const activeClaim = await BdaClaim02Model.findOne({
      bookingId,
      status: { $in: ['pending', 'approved'] },
    });
    if (activeClaim) {
      return res.status(409).json({
        success: false,
        message: `Already claimed by ${activeClaim.claimedBy?.name || 'another BDA'}`,
        claimedByName: activeClaim.claimedBy?.name || null,
      });
    }

    const snapshot = await fetchRegisteredSnapshot(booking.clientEmail);

    const created = await BdaClaim02Model.create({
      bookingId: booking.bookingId,
      clientName: booking.clientName || '',
      crmEmail: String(booking.clientEmail || '').toLowerCase().trim(),
      clientPhone: booking.clientPhone || '',
      ...snapshot,
      claimedBy: { email, name },
      claimedAt: new Date(),
      status: 'pending',
    });

    return res.status(201).json({ success: true, data: serialize(created, { admin: isAdmin(req) }) });
  } catch (error) {
    // Unique index race — someone claimed it a moment ago.
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'Lead was just claimed by another BDA' });
    }
    console.error('[claim02] claimLead error:', error);
    return res.status(500).json({ success: false, message: 'Failed to claim lead', error: error.message });
  }
};

/**
 * PUT /api/bda/claim02/:id
 * BDA sets/updates the currency + amount they collected. Recomputes incentive.
 * A BDA may only touch their own row.
 */
export const updateOwnClaim = async (req, res) => {
  try {
    const { id } = req.params;
    const { bdaCurrency, bdaAmountCollected } = req.body;

    const row = await BdaClaim02Model.findById(id);
    if (!row) return res.status(404).json({ success: false, message: 'Claim not found' });
    if (row.claimedBy?.email !== req.crmUser?.email) {
      return res.status(403).json({ success: false, message: 'You can only edit your own claimed leads' });
    }
    if (row.status === 'denied') {
      return res.status(409).json({
        success: false,
        message: 'This claim was denied by an admin — the lead has been released.',
      });
    }

    if (bdaCurrency != null) {
      if (!BDA_CURRENCIES.includes(bdaCurrency)) {
        return res.status(400).json({ success: false, message: 'Invalid currency' });
      }
      row.bdaCurrency = bdaCurrency;
    }
    if (bdaAmountCollected != null) {
      const amt = Number(bdaAmountCollected);
      if (!Number.isFinite(amt) || amt < 0) {
        return res.status(400).json({ success: false, message: 'Amount must be a non-negative number' });
      }
      row.bdaAmountCollected = amt;
    }

    await recomputeIncentive(row);
    await row.save();

    return res.status(200).json({ success: true, data: serialize(row, { admin: isAdmin(req) }) });
  } catch (error) {
    console.error('[claim02] updateOwnClaim error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update claim', error: error.message });
  }
};

/* ------------------------------------------------------------------ */
/*  Admin-only endpoints                                              */
/* ------------------------------------------------------------------ */

/** GET /api/bda/claim02/admin/all — every row, all columns, mismatch flag. */
export const adminListAll = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin only' });
    const { bda, status } = req.query;
    const filter = {};
    if (bda) filter['claimedBy.email'] = String(bda).toLowerCase().trim();
    if (status) filter.status = status;

    const rows = await BdaClaim02Model.find(filter).sort({ createdAt: -1 });

    // For any row where the registered snapshot is missing (claim was made before
    // the client had a dashboard record), re-fetch it now and persist it so the
    // admin always sees up-to-date data on page load.
    const needsRefresh = rows.filter((r) => !r.registeredPlan);
    if (needsRefresh.length > 0) {
      const configByKey = await buildIncentiveConfig();
      await Promise.all(
        needsRefresh.map(async (row) => {
          try {
            const snapshot = await fetchRegisteredSnapshot(row.crmEmail);
            if (!snapshot.registeredPlan) return; // still nothing — skip
            row.registeredPlan = snapshot.registeredPlan;
            row.registeredCurrency = snapshot.registeredCurrency;
            row.registeredAmountPaid = snapshot.registeredAmountPaid;
            // Recompute incentive now that we have the registered plan
            row.incentiveInr = incentiveForLine(
              configByKey,
              row.registeredPlan,
              row.bdaAmountCollected,
              row.bdaCurrency
            );
            await row.save();
          } catch (e) {
            console.warn('[claim02] snapshot refresh failed for', row.crmEmail, '-', e?.message);
          }
        })
      );
    }

    return res.status(200).json({
      success: true,
      data: rows.map((r) => serialize(r, { admin: true })),
    });
  } catch (error) {
    console.error('[claim02] adminListAll error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load claims', error: error.message });
  }
};

/** POST /api/bda/claim02/admin/:id/approve — tick to approve (or set status). */
export const adminSetStatus = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin only' });
    const { id } = req.params;
    const status = req.body?.status || 'approved';
    if (!['pending', 'approved', 'denied'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const row = await BdaClaim02Model.findById(id);
    if (!row) return res.status(404).json({ success: false, message: 'Claim not found' });

    row.status = status;
    if (status === 'approved') {
      row.approvedBy = { email: req.crmUser.email, name: req.crmUser.name };
      row.approvedAt = new Date();
    } else {
      row.approvedBy = { email: '', name: '' };
      row.approvedAt = null;
    }
    await row.save();

    return res.status(200).json({ success: true, data: serialize(row, { admin: true }) });
  } catch (error) {
    console.error('[claim02] adminSetStatus error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update status', error: error.message });
  }
};

/**
 * PUT /api/bda/claim02/admin/:id
 * Admin edits the BDA-entered amount / currency. Recomputes the incentive.
 */
export const adminUpdateClaim = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin only' });
    const { id } = req.params;
    const { bdaCurrency, bdaAmountCollected } = req.body;

    const row = await BdaClaim02Model.findById(id);
    if (!row) return res.status(404).json({ success: false, message: 'Claim not found' });

    if (bdaCurrency != null) {
      if (!BDA_CURRENCIES.includes(bdaCurrency)) {
        return res.status(400).json({ success: false, message: 'Invalid currency' });
      }
      row.bdaCurrency = bdaCurrency;
    }
    if (bdaAmountCollected != null) {
      const amt = Number(bdaAmountCollected);
      if (!Number.isFinite(amt) || amt < 0) {
        return res.status(400).json({ success: false, message: 'Amount must be a non-negative number' });
      }
      row.bdaAmountCollected = amt;
    }

    await recomputeIncentive(row);
    await row.save();

    return res.status(200).json({ success: true, data: serialize(row, { admin: true }) });
  } catch (error) {
    console.error('[claim02] adminUpdateClaim error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update claim', error: error.message });
  }
};

/**
 * GET /api/bda/claim02/bdas — admin: per-BDA rollup for the summary bar +
 * filter dropdown. `earnedIncentiveInr` counts only APPROVED rows (money the
 * BDA has actually earned); `pendingIncentiveInr` is the not-yet-approved rest.
 */
export const adminListBdas = async (req, res) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ success: false, message: 'Admin only' });
    const rows = await BdaClaim02Model.aggregate([
      {
        $group: {
          _id: '$claimedBy.email',
          name: { $first: '$claimedBy.name' },
          count: { $sum: 1 },
          approvedCount: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          earnedIncentiveInr: {
            $sum: { $cond: [{ $eq: ['$status', 'approved'] }, { $ifNull: ['$incentiveInr', 0] }, 0] },
          },
          pendingIncentiveInr: {
            $sum: { $cond: [{ $ne: ['$status', 'approved'] }, { $ifNull: ['$incentiveInr', 0] }, 0] },
          },
        },
      },
      { $sort: { name: 1 } },
    ]);
    return res.status(200).json({
      success: true,
      data: rows.map((r) => ({
        email: r._id,
        name: r.name,
        count: r.count,
        approvedCount: r.approvedCount,
        earnedIncentiveInr: Math.round((r.earnedIncentiveInr || 0) * 100) / 100,
        pendingIncentiveInr: Math.round((r.pendingIncentiveInr || 0) * 100) / 100,
      })),
    });
  } catch (error) {
    console.error('[claim02] adminListBdas error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load BDAs', error: error.message });
  }
};

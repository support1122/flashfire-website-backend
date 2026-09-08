import mongoose from 'mongoose';

/**
 * "Claim Leads 02" — a lightweight, parallel claim flow (distinct from the
 * CampaignBooking `claimedBy` + BdaClaimApproval flow used by the original
 * "Claim Your Leads" tab).
 *
 * A BDA searches CRM leads (CampaignBooking), claims one here, and records the
 * currency + amount they personally collected. The "Registered*" fields are a
 * read-only snapshot pulled from the clients-tracking DB (the registration
 * record created when the client paid), matched by CRM email. BDAs never see
 * the Registered currency/amount; admins see every column, approve rows with a
 * tick, and may edit the BDA-entered amount (which recomputes the incentive).
 */
const BdaClaim02Schema = new mongoose.Schema(
  {
    // Source CRM lead (CampaignBooking.bookingId). At most one ACTIVE
    // (pending/approved) claim per booking — enforced by the partial unique
    // index below. When a claim is denied the lead is released: the denied row
    // is kept for history, and a new BDA can create a fresh row for the same
    // bookingId.
    bookingId: {
      type: String,
      required: true,
      index: true,
    },

    // --- Client identity (snapshot from the CRM lead) ---
    clientName: { type: String, default: '' },
    crmEmail: { type: String, default: '', lowercase: true, trim: true, index: true },
    clientPhone: { type: String, default: '' },

    // --- Registered* : read-only snapshot from clients-tracking DB (admin-only) ---
    // Uppercased plan key (PRIME/IGNITE/PROFESSIONAL/EXECUTIVE) or '' when unknown.
    registeredPlan: { type: String, default: '' },
    // ISO code (USD/CAD/GBP/INR/EUR) or null when it could not be resolved.
    registeredCurrency: { type: String, default: null },
    // Numeric, symbols stripped. null when there was no usable amount.
    registeredAmountPaid: { type: Number, default: null },

    // --- BDA-entered (BDA sees + edits; admin may also edit) ---
    bdaCurrency: {
      type: String,
      enum: ['USD', 'GBP', 'INR', 'CAD'],
      default: null,
    },
    bdaAmountCollected: { type: Number, default: null, min: 0 },

    // Prorated incentive in INR — recomputed on every currency/amount change,
    // using the same logic as BdaLeadController (BdaIncentiveConfig).
    incentiveInr: { type: Number, default: 0, min: 0 },

    // --- Claim ownership ---
    claimedBy: {
      email: { type: String, required: true, lowercase: true, trim: true, index: true },
      name: { type: String, required: true, trim: true },
    },
    claimedAt: { type: Date, default: Date.now },

    // --- Approval ---
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      default: 'pending',
      index: true,
    },
    approvedBy: {
      email: { type: String, default: '' },
      name: { type: String, default: '' },
    },
    approvedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'bda_claim02' }
);

BdaClaim02Schema.index({ 'claimedBy.email': 1, status: 1 });

// At most one active (non-denied) claim per booking. Denied rows are exempt,
// so a released lead can be claimed again while its denied history remains.
BdaClaim02Schema.index(
  { bookingId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } }
);

export const BdaClaim02Model =
  mongoose.models.BdaClaim02 || mongoose.model('BdaClaim02', BdaClaim02Schema);

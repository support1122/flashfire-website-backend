import mongoose from 'mongoose';

// One document per leave request a BDA files (request -> admin decision -> deductions waived).
//
// Why a separate collection instead of just writing BdaProfile.leaveDays: leaveDays is the *effect*
// (the registry flag the deduction engine reads), this is the *record* of who asked, why, who decided
// and what it cost. Rows are never deleted; a cancel or a reject changes `status` and keeps the trail.

const LEAVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const LEAVE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);

const BdaLeaveRequestSchema = new mongoose.Schema(
  {
    leaveRequestId: {
      type: String,
      unique: true,
      required: true,
      default: () => `leave_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    },
    bdaEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    bdaName: { type: String, default: null },
    // Every IST calendar day this request covers, 'YYYY-MM-DD'. Stored expanded rather than as a
    // range so approval is a plain $addToSet into BdaProfile.leaveDays and needs no date maths.
    days: {
      type: [String],
      required: true,
      validate: [
        { validator: (d) => d.length > 0, message: 'A leave request needs at least one day' },
        { validator: (d) => d.every((x) => LEAVE_DAY_RE.test(x)), message: 'days must be YYYY-MM-DD strings' },
      ],
    },
    fromDate: { type: String, required: true }, // days[0], kept for sorting and display
    toDate: { type: String, required: true }, // days[days.length - 1]
    reason: { type: String, required: true, trim: true },
    status: { type: String, enum: LEAVE_STATUSES, default: 'pending', index: true },

    decidedBy: { type: String, default: null },
    decidedByName: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null },

    // What approving this request actually waived, so the money side is auditable from the request.
    waivedDeductionIds: { type: [String], default: [] },
    waivedAmountInr: { type: Number, default: 0 },
    // Days that were already in BdaProfile.leaveDays before this approval, so a later revoke knows
    // not to take them away from some other approved request.
    daysAlreadyOnLeave: { type: [String], default: [] },
  },
  { timestamps: true }
);

BdaLeaveRequestSchema.index({ bdaEmail: 1, status: 1 });
BdaLeaveRequestSchema.index({ status: 1, createdAt: -1 });

export const BdaLeaveRequestModel =
  mongoose.models.BdaLeaveRequest || mongoose.model('BdaLeaveRequest', BdaLeaveRequestSchema);

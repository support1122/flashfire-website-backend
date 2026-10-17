import mongoose from 'mongoose';

// One row per "this call was missed" claim about a single call. A BDA raises one about their own call and it stays
// `pending` until an admin approves (which writes the fine) or rejects it. An admin marking a call absent writes the
// same row already `approved`, so every manual fine has a trail of who asked, who decided and why.
// Rows are never deleted.

export const ABSENCE_KINDS = Object.freeze(['allocation', 'booking']);
export const ABSENCE_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'cancelled']);

const BdaAbsenceReportSchema = new mongoose.Schema(
  {
    reportId: {
      type: String,
      unique: true,
      required: true,
      default: () => `abs_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    },
    kind: { type: String, enum: ABSENCE_KINDS, required: true },
    // allocationId for a Lead Allocation call, bookingId for a Calendly meeting.
    refId: { type: String, required: true },
    bdaEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    bdaName: { type: String, default: null },
    clientName: { type: String, default: null },
    callStart: { type: Date, required: true },
    reason: { type: String, required: true },
    raisedBy: { type: String, enum: ['bda', 'admin'], required: true },
    raisedByEmail: { type: String, default: null },
    raisedByName: { type: String, default: null },
    status: { type: String, enum: ABSENCE_STATUSES, default: 'pending' },
    decidedBy: { type: String, default: null },
    decidedByName: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null },
    deductionId: { type: String, default: null },
  },
  { timestamps: true }
);

// One open or approved report per call and BDA. A rejected or cancelled one does not block a fresh report.
BdaAbsenceReportSchema.index(
  { kind: 1, refId: 1, bdaEmail: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'approved'] } } }
);
BdaAbsenceReportSchema.index({ status: 1, createdAt: -1 });

export const BdaAbsenceReportModel =
  mongoose.models.BdaAbsenceReport || mongoose.model('BdaAbsenceReport', BdaAbsenceReportSchema);

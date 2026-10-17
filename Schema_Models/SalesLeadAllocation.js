import mongoose from 'mongoose';

// One document per call an admin hands to a BDA ("Sales Lead Allocation"). callAt is a UTC instant;
// timezone is the client's IANA zone, kept so the reminder can show the client's wall-clock time.
// Rows are never deleted: cancel and outcome change `status` and keep the trail.

export const ALLOCATION_STATUSES = Object.freeze(['scheduled', 'completed', 'no_answer', 'cancelled', 'absent']);
export const REMINDER_STATES = Object.freeze(['pending', 'sending', 'sent', 'failed', 'skipped']);

const SalesLeadAllocationSchema = new mongoose.Schema(
  {
    allocationId: {
      type: String,
      unique: true,
      required: true,
      default: () => `alloc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
    },
    clientName: { type: String, required: true, trim: true },
    phone: { type: String, default: null }, // digits with an optional leading +
    email: { type: String, default: null, trim: true, lowercase: true },
    timezone: { type: String, required: true, trim: true }, // IANA, e.g. America/New_York
    callAt: { type: Date, required: true, index: true },
    bdaEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    bdaName: { type: String, default: null },
    status: { type: String, enum: ALLOCATION_STATUSES, default: 'scheduled' },
    notes: { type: String, default: null },
    outcomeNote: { type: String, default: null },
    createdBy: { type: String, default: null },
    createdByName: { type: String, default: null },
    reminderState: { type: String, enum: REMINDER_STATES, default: 'pending' },
    reminderSentAt: { type: Date, default: null },
    // Set when the reminder poller claims a row, so a row stuck in `sending` can be reset.
    reminderClaimedAt: { type: Date, default: null },
    // The earlier "30 minutes to go" heads-up. Tracked apart from the 5-minute reminder above so neither can block
    // or double-fire the other. Rows created before this field existed have no value and count as pending.
    earlyReminderState: { type: String, enum: REMINDER_STATES, default: 'pending' },
    earlyReminderSentAt: { type: Date, default: null },
    earlyReminderClaimedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SalesLeadAllocationSchema.index({ status: 1, callAt: 1 });
SalesLeadAllocationSchema.index({ bdaEmail: 1, callAt: 1 });
// Lookup-as-you-type on past allocations (anchored prefix queries).
SalesLeadAllocationSchema.index({ email: 1 }, { sparse: true });
SalesLeadAllocationSchema.index({ phone: 1 }, { sparse: true });

export const SalesLeadAllocationModel =
  mongoose.models.SalesLeadAllocation || mongoose.model('SalesLeadAllocation', SalesLeadAllocationSchema);

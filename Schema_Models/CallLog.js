import mongoose from 'mongoose';

const CallLogSchema = new mongoose.Schema(
  {
    // Stable identifier from the call provider (Zoom).
    callId: { type: String, required: true, unique: true, index: true },

    direction: { type: String, enum: ['inbound', 'outbound', 'internal'], required: true },
    status: {
      type: String,
      enum: ['ringing', 'answered', 'missed', 'voicemail', 'busy', 'cancelled', 'completed', 'unknown'],
      default: 'unknown',
      index: true,
    },

    // Sales-person side (the BDA / CRM user who made or received the call)
    salesEmail: { type: String, default: null, index: true, lowercase: true, trim: true },
    salesName: { type: String, default: null },
    salesNumber: { type: String, default: null }, // raw

    // Lead / external side
    leadNumber: { type: String, default: null }, // raw
    // Normalized digits-only version for matching against CampaignBooking.clientPhone.
    leadNumberNormalized: { type: String, default: null, index: true },
    // Resolved lead info once matched.
    bookingId: { type: String, default: null, index: true },
    leadEmail: { type: String, default: null, lowercase: true, trim: true },
    leadName: { type: String, default: null },

    startedAt: { type: Date, default: null, index: true },
    answeredAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    // Duration in seconds (Zoom returns seconds). Total talk time.
    durationSec: { type: Number, default: 0 },

    recordingUrl: { type: String, default: null }, // requires Zoom auth — proxy via backend
    transcriptUrl: { type: String, default: null },
    aiSummary: { type: String, default: null },

    // Full Zoom call_history metadata
    callPathId: { type: String, default: null },
    callType: { type: String, default: null },
    connectType: { type: String, default: null },
    callResult: { type: String, default: null },
    recordingStatus: { type: String, default: null },
    international: { type: Boolean, default: null },
    hideCallerId: { type: Boolean, default: null },
    endToEnd: { type: Boolean, default: null },

    callerExtNumber: { type: String, default: null },
    callerExtType: { type: String, default: null },
    callerNumberType: { type: String, default: null },
    callerDeviceType: { type: String, default: null },
    callerCountryCode: { type: String, default: null },
    callerCountryIso: { type: String, default: null },

    calleeName: { type: String, default: null },
    calleeEmail: { type: String, default: null, lowercase: true, trim: true },
    calleeExtNumber: { type: String, default: null },
    calleeNumberType: { type: String, default: null },
    calleeCountryCode: { type: String, default: null },
    calleeCountryIso: { type: String, default: null },

    // Source of this row — 'webhook' (pushed) or 'sync' (polled call_history).
    source: { type: String, enum: ['webhook', 'sync', 'unknown'], default: 'unknown' },

    // The raw webhook / sync payload, kept for debugging.
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

CallLogSchema.index({ leadNumberNormalized: 1, startedAt: -1 });
CallLogSchema.index({ salesEmail: 1, startedAt: -1 });

export const CallLogModel = mongoose.models.CallLog || mongoose.model('CallLog', CallLogSchema);

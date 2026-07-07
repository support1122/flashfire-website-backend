import mongoose from 'mongoose';

/**
 * Cached Zoom presence / on-call state per agent, keyed by email.
 *
 * Zoom has no GET presence endpoint — state only arrives via webhooks
 * (`user.presence_status_updated`, `phone.*_connected`, `phone.*_ended`).
 * We upsert the latest event here so the CRM can read an agent's availability
 * without a live Zoom call. Anyone we've never received an event for simply
 * has no row, which the API surfaces as status "unknown".
 */
const ZoomUserPresenceSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },

    // Raw Zoom presence: Available | Away | Do_Not_Disturb | In_Meeting | On_Phone_Call | Offline | ...
    presenceStatus: { type: String, default: null },

    // Derived from phone.* webhooks — the most reliable "busy" signal.
    onCall: { type: Boolean, default: false },
    // The callId currently in progress (so a stale ended-event for a different
    // call can't wrongly clear a live one).
    activeCallId: { type: String, default: null },

    lastPresenceEventAt: { type: Date, default: null },
    lastCallEventAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const ZoomUserPresenceModel =
  mongoose.models.ZoomUserPresence || mongoose.model('ZoomUserPresence', ZoomUserPresenceSchema);

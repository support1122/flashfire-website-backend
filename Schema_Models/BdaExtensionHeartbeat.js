import mongoose from 'mongoose';

// Last sign of life from each BDA's attendance extension (plan 4.4.2 and 5.2). One row per BDA, overwritten on
// every heartbeat. The verdict job warns before a meeting when this goes quiet, and the data-health check uses it
// to vouch for a verdict when Google's sync lagged.
const BdaExtensionHeartbeatSchema = new mongoose.Schema({
  bdaEmail: { type: String, required: true, unique: true, lowercase: true, trim: true },
  lastHeartbeatAt: { type: Date, required: true },
  version: { type: String, default: null },
  /** The Chrome profile's account, as the extension reported it. Null when Chrome would not say. */
  profileEmail: { type: String, default: null, lowercase: true, trim: true },
  /** True when the profile email's local part equals the CRM login's. Null when the profile email is unknown. */
  profileMatchesLogin: { type: Boolean, default: null },
  meetTabs: {
    type: [{ _id: false, code: { type: String, default: null }, inCall: { type: Boolean, default: null } }],
    default: [],
  },
  updatedAt: { type: Date, default: null },
});

export const BdaExtensionHeartbeatModel =
  mongoose.models.BdaExtensionHeartbeat || mongoose.model('BdaExtensionHeartbeat', BdaExtensionHeartbeatSchema);

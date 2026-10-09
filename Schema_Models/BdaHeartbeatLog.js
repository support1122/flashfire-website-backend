import mongoose from 'mongoose';

// Every extension heartbeat, kept 14 days. BdaExtensionHeartbeat holds only the LAST one; telling a phone join from
// a PC join needs to know whether the extension was alive, and which Meet tabs it saw in a call, DURING the BDA's
// Google session (Utils/JoinDevice.js). About 1,440 rows per BDA per day; the TTL index deletes them after 14 days.
const BdaHeartbeatLogSchema = new mongoose.Schema(
  {
    bdaEmail: { type: String, required: true, lowercase: true, trim: true },
    at: { type: Date, required: true },
    meetTabs: {
      type: [{ _id: false, code: { type: String, default: null }, inCall: { type: Boolean, default: null } }],
      default: [],
    },
    profileMatchesLogin: { type: Boolean, default: null },
  },
  { versionKey: false }
);

BdaHeartbeatLogSchema.index({ bdaEmail: 1, at: 1 });
BdaHeartbeatLogSchema.index({ at: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

export const BdaHeartbeatLogModel =
  mongoose.models.BdaHeartbeatLog || mongoose.model('BdaHeartbeatLog', BdaHeartbeatLogSchema);

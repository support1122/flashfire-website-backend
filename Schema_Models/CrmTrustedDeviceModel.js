import mongoose from 'mongoose';

// A device/browser combination that an admin has already approved for a given
// BDA email. Future logins matching the same (email, deviceKey) skip approval.
const CrmTrustedDeviceSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  deviceKey: { type: String, required: true },
  browser: { type: String },
  os: { type: String },
  approvedBy: { type: String },
  approvedAt: { type: Date, default: Date.now },
}, { timestamps: true });

CrmTrustedDeviceSchema.index({ email: 1, deviceKey: 1 }, { unique: true });

export const CrmTrustedDeviceModel = mongoose.model('CrmTrustedDevice', CrmTrustedDeviceSchema);

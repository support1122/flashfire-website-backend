import mongoose from 'mongoose';

const CrmSessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  email: { type: String, required: true, index: true },
  deviceKey: { type: String },
  ip: { type: String },
  countryCode: { type: String },
  country: { type: String },
  browser: { type: String },
  os: { type: String },
  deviceType: { type: String },
  userAgent: { type: String },
  revoked: { type: Boolean, default: false },
  revokedAt: { type: Date },
  lastSeenAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

export const CrmSessionModel = mongoose.model('CrmSession', CrmSessionSchema);

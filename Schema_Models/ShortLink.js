import mongoose from 'mongoose';

const ShortLinkSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  longUrl: { type: String, required: true },
  createdBy: { type: String },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

export const ShortLinkModel = mongoose.model('ShortLink', ShortLinkSchema);

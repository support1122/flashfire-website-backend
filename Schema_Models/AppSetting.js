import mongoose from 'mongoose';

// Small app-wide settings an admin changes from the CRM instead of an env var (bsc's call: no Render setup).
// One document per key. Today: key 'deductions' -> { mode: 'off'|'shadow'|'live', liveFrom: Date|null }.
// An env var for the same setting always wins (see Utils/deductionPolicy.js).
const AppSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    value: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

export const AppSettingModel = mongoose.models.AppSetting || mongoose.model('AppSetting', AppSettingSchema);

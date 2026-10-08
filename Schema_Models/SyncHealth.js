import mongoose from 'mongoose';

// One row per background source (plan 2.7). The deduction engine reads it to decide whether a fine rests on
// healthy data. `okTimes` is a thin history of successes (at most one per 30 s, newest 2880 = 24 h) because
// "was Zoom synced recently at every moment of this window" cannot be answered from the latest success alone.
const SyncHealthSchema = new mongoose.Schema({
  source: { type: String, required: true, unique: true, enum: ['google_meet', 'zoom_phone', 'verdict_job'] },
  lastOkAt: { type: Date, default: null },
  lastError: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
  okTimes: { type: [Date], default: [] },
  updatedAt: { type: Date, default: null },
});

export const SyncHealthModel = mongoose.models.SyncHealth || mongoose.model('SyncHealth', SyncHealthSchema);

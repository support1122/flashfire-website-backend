import mongoose from 'mongoose';

// One row per setup action that WROTE something (seed, relink). Gives bsc an answer to "who ran that, when, on which
// database, and what did it change" after the fact. Dry runs are not recorded: they change nothing.
const AttendanceSetupRunSchema = new mongoose.Schema(
  {
    action: { type: String, required: true, enum: ['seed-profiles', 'relink-calls', 'run'] },
    database: { type: String, required: true },
    byEmail: { type: String, default: null },
    byName: { type: String, default: null },
    summary: { type: mongoose.Schema.Types.Mixed, default: null },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const AttendanceSetupRunModel =
  mongoose.models.AttendanceSetupRun || mongoose.model('AttendanceSetupRun', AttendanceSetupRunSchema);

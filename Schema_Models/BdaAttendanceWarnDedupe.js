import mongoose from 'mongoose';

/** One Discord "BDA Not in Meeting" per (bookingId, bdaEmail), including before an attendance row exists */
const BdaAttendanceWarnDedupeSchema = new mongoose.Schema(
  {
    bookingId: { type: String, required: true },
    bdaEmail: { type: String, required: true, lowercase: true, trim: true },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

BdaAttendanceWarnDedupeSchema.index({ bookingId: 1, bdaEmail: 1 }, { unique: true });

export const BdaAttendanceWarnDedupeModel =
  mongoose.models.BdaAttendanceWarnDedupe ||
  mongoose.model('BdaAttendanceWarnDedupe', BdaAttendanceWarnDedupeSchema);

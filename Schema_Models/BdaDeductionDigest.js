import mongoose from 'mongoose';

// Dedupe marker for the 22:00 IST daily summary (plan D7): one row per (IST date, BDA, channel), so a restart
// or a second backend instance cannot post the same summary twice.
const BdaDeductionDigestSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, required: true }, // `${yyyy-LL-dd}|${bdaEmail}|${channel}`
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

export const BdaDeductionDigestModel =
  mongoose.models.BdaDeductionDigest || mongoose.model('BdaDeductionDigest', BdaDeductionDigestSchema);

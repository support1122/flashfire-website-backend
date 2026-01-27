import mongoose from 'mongoose';

const BdaIncentiveConfigSchema = new mongoose.Schema(
  {
    planName: {
      type: String,
      enum: ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'],
      required: true,
      unique: true
    },
    incentivePercent: {
      type: Number,
      required: true,
      min: 0
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

export const BdaIncentiveConfigModel =
  mongoose.models.BdaIncentiveConfig || mongoose.model('BdaIncentiveConfig', BdaIncentiveConfigSchema);


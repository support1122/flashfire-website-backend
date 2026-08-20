import mongoose from 'mongoose';

const BdaIncentiveConfigSchema = new mongoose.Schema(
  {
    planName: {
      type: String,
      enum: ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'],
      required: true
    },
    currency: {
      type: String,
      enum: ['USD', 'CAD', 'GBP', 'EUR', 'INR'],
      required: true,
      default: 'USD'
    },
    basePrice: {
      type: Number,
      default: null,
      min: 0
    },
    // Legacy field kept for backward compatibility
    basePriceUsd: {
      type: Number,
      default: null,
      min: 0
    },
    incentivePerLeadInr: {
      type: Number,
      default: 0,
      min: 0
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

BdaIncentiveConfigSchema.index({ planName: 1, currency: 1 }, { unique: true });

export const BdaIncentiveConfigModel =
  mongoose.models.BdaIncentiveConfig || mongoose.model('BdaIncentiveConfig', BdaIncentiveConfigSchema);

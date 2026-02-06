import mongoose from 'mongoose';

const BdaClaimApprovalSchema = new mongoose.Schema(
  {
    bookingId: {
      type: String,
      required: true
    },
    bdaEmail: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },
    bdaName: {
      type: String,
      required: true,
      trim: true
    },
    clientName: {
      type: String
    },
    clientEmail: {
      type: String
    },
    clientPhone: {
      type: String
    },
    paymentPlan: {
      name: String,
      price: Number,
      currency: String,
      displayPrice: String
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'denied'],
      default: 'pending',
      index: true
    }
  },
  { timestamps: true }
);

export const BdaClaimApprovalModel =
  mongoose.models.BdaClaimApproval || mongoose.model('BdaClaimApproval', BdaClaimApprovalSchema);


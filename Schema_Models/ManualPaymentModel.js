import mongoose from 'mongoose';

const ManualPaymentSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  amount: { type: Number, required: true },
  currency: { type: String, required: true, default: 'INR' },
  customerName: { type: String, required: true },
  customerEmail: { type: String, required: true },
  planName: { type: String, required: true },
  paymentMethod: { type: String, required: true },
  referenceId: { type: String },
  notes: { type: String },
  createdBy: { type: String },
}, { timestamps: true });

export const ManualPaymentModel = mongoose.model('ManualPayment', ManualPaymentSchema);

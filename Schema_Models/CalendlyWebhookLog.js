import mongoose from 'mongoose';

const CalendlyWebhookLogSchema = new mongoose.Schema({
  webhookId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  eventType: {
    type: String,
    default: null,
    index: true
  },
  payload: {
    type: mongoose.Schema.Types.Mixed,
    required: true
  },
  bookingId: {
    type: String,
    default: null,
    index: true
  },
  error: {
    type: String,
    default: null
  }
}, { timestamps: true });

CalendlyWebhookLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // auto-delete after 90 days

export const CalendlyWebhookLogModel = mongoose.model('CalendlyWebhookLog', CalendlyWebhookLogSchema);

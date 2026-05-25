import mongoose from 'mongoose';

/**
 * Every Zoom Phone webhook delivery is persisted here for debugging /
 * replay. Lets us see exactly what Zoom is sending, regardless of whether
 * our parser found a call_id or matched a lead.
 */
const ZoomWebhookEventSchema = new mongoose.Schema(
  {
    event: { type: String, index: true },
    eventTs: { type: Date, default: null },
    signatureValid: { type: Boolean, default: null },
    handled: { type: Boolean, default: false, index: true },
    handlerNote: { type: String, default: null },
    callId: { type: String, default: null, index: true },
    headers: { type: mongoose.Schema.Types.Mixed, default: null },
    body: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

ZoomWebhookEventSchema.index({ createdAt: -1 });

export const ZoomWebhookEventModel =
  mongoose.models.ZoomWebhookEvent ||
  mongoose.model('ZoomWebhookEvent', ZoomWebhookEventSchema);

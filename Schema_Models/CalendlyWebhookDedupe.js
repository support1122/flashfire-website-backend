import mongoose from 'mongoose';

/**
 * Prevents duplicate processing when Calendly retries invitee.created or when
 * multiple instances race the same delivery. Key = event label + invitee URI.
 */
const CalendlyWebhookDedupeSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: 'calendlywebhookdedupes' }
);

export const CalendlyWebhookDedupeModel = mongoose.model(
  'CalendlyWebhookDedupe',
  CalendlyWebhookDedupeSchema
);

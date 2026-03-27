import mongoose from 'mongoose';

const ReminderErrorSchema = new mongoose.Schema({
  bookingId: { type: String, index: true },
  clientEmail: { type: String, index: true },
  clientPhone: { type: String },
  clientName: { type: String },
  category: {
    type: String,
    enum: ['call', 'whatsapp', 'discord', 'bda', 'workflow', 'webhook', 'scheduler'],
    required: true,
    index: true
  },
  severity: {
    type: String,
    enum: ['info', 'warning', 'error', 'critical'],
    default: 'error',
    index: true
  },
  message: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed },
  stack: { type: String },
  source: { type: String }, // e.g. 'CalendlyWebhookController', 'CallScheduler'
  resolved: { type: Boolean, default: false, index: true },
  resolvedAt: { type: Date },
  resolvedBy: { type: String },
}, {
  timestamps: true,
});

ReminderErrorSchema.index({ createdAt: -1 });
ReminderErrorSchema.index({ category: 1, severity: 1, createdAt: -1 });

export const ReminderErrorModel = mongoose.model('ReminderError', ReminderErrorSchema);

/**
 * Log a reminder error to the database (non-blocking)
 */
export async function logReminderError({
  bookingId = null,
  clientEmail = null,
  clientPhone = null,
  clientName = null,
  category,
  severity = 'error',
  message,
  details = null,
  stack = null,
  source = null
}) {
  try {
    await ReminderErrorModel.create({
      bookingId, clientEmail, clientPhone, clientName,
      category, severity, message, details, stack, source
    });
  } catch (err) {
    console.error('[ReminderError] Failed to log error:', err.message);
  }
}

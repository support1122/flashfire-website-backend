import mongoose from 'mongoose';

const ActivityLogSchema = new mongoose.Schema(
  {
    actorEmail: { type: String, default: 'unknown', lowercase: true, trim: true, index: true },
    actorName: { type: String, default: null },
    actorRole: {
      type: String,
      enum: ['crm_user', 'crm_admin', 'bda_extension', 'system', 'anonymous'],
      default: 'anonymous',
      index: true,
    },

    // What happened
    action: { type: String, required: true, index: true }, // stable key, e.g. crm.users.create
    label: { type: String, default: null }, // human readable
    category: { type: String, default: 'general', index: true },

    // Request context
    method: { type: String, default: null },
    path: { type: String, default: null }, // matched route pattern
    url: { type: String, default: null }, // actual url hit
    statusCode: { type: Number, default: null, index: true },
    success: { type: Boolean, default: true, index: true },
    durationMs: { type: Number, default: null },

    // Target of the action (best-effort)
    targetType: { type: String, default: null },
    targetId: { type: String, default: null, index: true },

    // Extra detail (request params/body summary, error message, etc.)
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },

    ip: { type: String, default: null },
    userAgent: { type: String, default: null },

    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false, minimize: false }
);

// Compound indexes for the activity feed + filters
ActivityLogSchema.index({ createdAt: -1, _id: -1 });
ActivityLogSchema.index({ actorEmail: 1, createdAt: -1 });
ActivityLogSchema.index({ category: 1, createdAt: -1 });
ActivityLogSchema.index({ action: 1, createdAt: -1 });

// Optional retention: set ACTIVITY_LOG_TTL_DAYS to auto-expire old logs.
const ttlDays = Number(process.env.ACTIVITY_LOG_TTL_DAYS || 0);
if (ttlDays > 0) {
  ActivityLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlDays * 86400 });
}

export const ActivityLogModel =
  mongoose.models.ActivityLog || mongoose.model('ActivityLog', ActivityLogSchema);

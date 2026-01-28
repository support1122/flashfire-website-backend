import mongoose from "mongoose";

export const WorkflowLogSchema = new mongoose.Schema({
  logId: {
    type: String,
    unique: true,
    required: true,
    default: () => `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  workflowId: {
    type: String,
    required: true,
    index: true
  },
  workflowName: {
    type: String,
    default: null
  },
  triggerAction: {
    type: String,
    enum: ['no-show', 'complete', 'cancel', 're-schedule', 'paid'],
    required: true,
    index: true
  },
  bookingId: {
    type: String,
    required: true,
    index: true
  },
  clientEmail: {
    type: String,
    required: true,
    index: true
  },
  clientName: {
    type: String,
    default: null
  },
  clientPhone: {
    type: String,
    default: null
  },
  // Step details
  step: {
    channel: {
      type: String,
      enum: ['email', 'whatsapp'],
      required: true
    },
    daysAfter: {
      type: Number,
      required: true
    },
    templateId: {
      type: String,
      required: true
    },
    templateName: {
      type: String,
      default: null
    },
    domainName: {
      type: String,
      default: null
    },
    senderEmail: {
      type: String,
      default: null
    },
    order: {
      type: Number,
      default: 0
    }
  },
  // Execution details
  status: {
    type: String,
    enum: ['scheduled', 'executed', 'failed', 'cancelled'],
    required: true,
    default: 'scheduled',
    index: true
  },
  scheduledFor: {
    type: Date,
    required: true,
    index: true
  },
  executedAt: {
    type: Date,
    default: null
  },
  error: {
    type: String,
    default: null
  },
  errorDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Response details
  responseData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

WorkflowLogSchema.index({ workflowId: 1, createdAt: -1 });
WorkflowLogSchema.index({ bookingId: 1, createdAt: -1 });
WorkflowLogSchema.index({ status: 1, scheduledFor: 1 });
WorkflowLogSchema.index({ createdAt: -1 });
WorkflowLogSchema.index({ triggerAction: 1, status: 1 });
WorkflowLogSchema.index({ bookingId: 1, workflowId: 1, 'step.templateId': 1 });

export const WorkflowLogModel = mongoose.model('WorkflowLog', WorkflowLogSchema);


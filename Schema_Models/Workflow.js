import mongoose from "mongoose";

export const WorkflowSchema = new mongoose.Schema({
  workflowId: {
    type: String,
    unique: true,
    required: true,
    default: () => `workflow_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  triggerAction: {
    type: String,
    enum: ['no-show', 'complete', 'cancel', 're-schedule', 'paid', 'custom'],
    required: true,
    index: true
  },
  isCustom: {
    type: Boolean,
    default: false,
    index: true
  },
  steps: [{
    channel: {
      type: String,
      enum: ['email', 'whatsapp'],
      required: true
    },
    daysAfter: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    templateId: {
      type: String,
      required: true,
      trim: true
    },
    templateName: {
      type: String,
      default: null
    },
    domainName: {
      type: String,
      default: null,
      trim: true
    },
    senderEmail: {
      type: String,
      default: null,
      trim: true
    },
    order: {
      type: Number,
      required: true,
      default: 0
    },
    templateConfig: {
      planName: {
        type: String,
        default: null
      },
      planAmount: {
        type: Number,
        default: null
      },
      days: {
        type: Number,
        default: 7
      }
    }
  }],
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  name: {
    type: String,
    default: null,
    trim: true
  },
  description: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

WorkflowSchema.index({ triggerAction: 1, isActive: 1 });
WorkflowSchema.index({ createdAt: -1 });

WorkflowSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export const WorkflowModel = mongoose.model('Workflow', WorkflowSchema);


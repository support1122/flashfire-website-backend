import mongoose from "mongoose";

// Schema for tracking WhatsApp campaigns using WATI
export const WhatsAppCampaignSchema = new mongoose.Schema({
  campaignId: {
    type: String,
    unique: true,
    required: true,
    default: () => `whatsapp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  templateName: {
    type: String,
    required: true,
    trim: true
  },
  templateId: {
    type: String,
    default: null
  },
  // Recipients
  mobileNumbers: [{
    type: String,
    required: true,
    trim: true
  }],
  // Template parameters
  parameters: {
    type: [String],
    default: []
  },
  // Campaign statistics
  totalRecipients: {
    type: Number,
    default: 0
  },
  successCount: {
    type: Number,
    default: 0
  },
  failedCount: {
    type: Number,
    default: 0
  },
  // Campaign status
  status: {
    type: String,
    enum: ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'FAILED'],
    default: 'PENDING'
  },
  // Individual message statuses
  messageStatuses: [{
    mobileNumber: String,
    status: {
      type: String,
      enum: ['pending', 'scheduled', 'sent', 'failed'],
      default: 'pending'
    },
    sentAt: Date,
    scheduledSendDate: Date,
    sendDay: Number, // 0 for immediate, 1 for +1 day, 2 for +2 days
    errorMessage: String,
    watiResponse: mongoose.Schema.Types.Mixed
  }],
  // Scheduling
  isScheduled: {
    type: Boolean,
    default: false
  },
  scheduledFor: {
    type: Date,
    default: null
  },
  // Metadata
  createdBy: {
    type: String,
    default: 'system'
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  completedAt: {
    type: Date,
    default: null
  },
  // Error tracking
  errorMessage: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
WhatsAppCampaignSchema.index({ createdAt: -1 });
WhatsAppCampaignSchema.index({ status: 1 });
WhatsAppCampaignSchema.index({ templateName: 1, createdAt: -1 });
WhatsAppCampaignSchema.index({ isScheduled: 1, scheduledFor: 1 });

export const WhatsAppCampaignModel = mongoose.model('WhatsAppCampaign', WhatsAppCampaignSchema);


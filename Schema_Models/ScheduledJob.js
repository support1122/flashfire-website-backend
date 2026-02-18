import mongoose from 'mongoose';


export const ScheduledJobSchema = new mongoose.Schema({
  jobId: {
    type: String,
    unique: true,
    required: true,
    default: () => `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },

  jobType: {
    type: String,
    enum: ['email', 'whatsapp'],
    required: true,
    index: true
  },
  
  // Job status
  status: {
    type: String,
    enum: ['pending', 'scheduled', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending',
    index: true
  },
  
  // Scheduling information
  scheduledFor: {
    type: Date,
    required: true,
    index: true
  },
  
  // Priority (lower = higher priority)
  priority: {
    type: Number,
    default: 5,
    min: 1,
    max: 10
  },
  
  // Batch information - for grouping jobs
  batchId: {
    type: String,
    index: true
  },
  batchIndex: {
    type: Number,
    default: 0
  },
  totalInBatch: {
    type: Number,
    default: 1
  },
  
  // Email-specific data
  emailData: {
    to: String,
    from: String,
    templateId: String,
    templateName: String,
    domainName: String,
    dynamicTemplateData: mongoose.Schema.Types.Mixed
  },
  
  // WhatsApp-specific data
  whatsappData: {
    mobileNumber: String,
    templateName: String,
    templateId: String,
    parameters: [String],
    campaignId: String
  },
  
  // Campaign/workflow reference
  campaignId: String,
  workflowId: String,
  bookingId: String,
  
  // Execution tracking
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3
  },
  lastAttemptAt: Date,
  processedAt: Date,
  completedAt: Date,
  
  // Response/Error tracking
  response: mongoose.Schema.Types.Mixed,
  error: String,
  errorDetails: mongoose.Schema.Types.Mixed,
  
  // Metadata
  metadata: mongoose.Schema.Types.Mixed,
  createdBy: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: true
});

// Compound indexes for efficient querying
ScheduledJobSchema.index({ status: 1, scheduledFor: 1, jobType: 1 });
ScheduledJobSchema.index({ scheduledFor: 1, status: 1, jobType: 1 });
ScheduledJobSchema.index({ batchId: 1, batchIndex: 1 });
ScheduledJobSchema.index({ batchId: 1, status: 1 });
ScheduledJobSchema.index({ status: 1, jobType: 1, scheduledFor: 1, priority: 1 });
ScheduledJobSchema.index({ campaignId: 1, status: 1 });

export const ScheduledJobModel = mongoose.model('ScheduledJob', ScheduledJobSchema);

import mongoose from "mongoose";

/**
 * MongoDB-based Call Scheduler
 * Alternative to BullMQ - works reliably everywhere without Redis
 */
const ScheduledCallSchema = new mongoose.Schema({
  // Unique identifier for the call
  callId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  
  // Phone number to call
  phoneNumber: {
    type: String,
    required: true,
    index: true
  },
  
  // When to make the call (10 minutes before meeting)
  scheduledFor: {
    type: Date,
    required: true,
    index: true
  },
  
  // Meeting details
  meetingTime: {
    type: String,
    required: true
  },
  meetingStartISO: {
    type: Date,
    required: true
  },
  
  // Invitee details
  inviteeName: {
    type: String,
    default: null
  },
  inviteeEmail: {
    type: String,
    default: null,
    index: true
  },
  
  // Call status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'skipped'],
    default: 'pending',
    index: true
  },
  
  // Twilio call SID (after call is made)
  twilioCallSid: {
    type: String,
    default: null,
    index: true
  },
  
  // Error message if failed
  errorMessage: {
    type: String,
    default: null
  },
  
  // Number of attempts
  attempts: {
    type: Number,
    default: 0
  },
  maxAttempts: {
    type: Number,
    default: 3
  },
  
  // Timestamps for tracking
  processedAt: {
    type: Date,
    default: null
  },
  completedAt: {
    type: Date,
    default: null
  },
  
  // Source of the booking
  source: {
    type: String,
    enum: ['calendly', 'manual', 'campaign', 'reschedule', 'debug', 'crm_followup'],
    default: 'calendly'
  },
  
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  statusHistory: [{
    status: String,
    answeredBy: String,
    timestamp: Date,
    duration: Number,
    rawData: mongoose.Schema.Types.Mixed
  }]
}, {
  timestamps: true // createdAt, updatedAt
});

// Compound index for efficient polling (twilioCallSid already has index: true in schema)
ScheduledCallSchema.index({ status: 1, scheduledFor: 1 });
ScheduledCallSchema.index({ scheduledFor: 1, status: 1 });
ScheduledCallSchema.index({ phoneNumber: 1, meetingStartISO: 1 }, { unique: true });

export const ScheduledCallModel = mongoose.model('ScheduledCall', ScheduledCallSchema);


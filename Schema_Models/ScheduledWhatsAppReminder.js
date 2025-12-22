import mongoose from "mongoose";


const ScheduledWhatsAppReminderSchema = new mongoose.Schema({
  reminderId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  
  phoneNumber: {
    type: String,
    required: true,
    index: true
  },
  scheduledFor: {
    type: Date,
    required: true,
    index: true
  },
  
  meetingTime: {
    type: String,
    required: true
  },
  meetingDate: {
    type: String,
    required: true
  },
  meetingStartISO: {
    type: Date,
    required: true
  },
  clientName: {
    type: String,
    required: true
  },
  clientEmail: {
    type: String,
    default: null,
    index: true
  },
  
  meetingLink: {
    type: String,
    default: null
  },
  rescheduleLink: {
    type: String,
    default: null
  },
  
  // Reminder status
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled', 'skipped'],
    default: 'pending',
    index: true
  },
  
  // WATI response data
  watiResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: null
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
    enum: ['calendly', 'manual', 'campaign', 'reschedule', 'debug'],
    default: 'calendly'
  },
  
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true // createdAt, updatedAt
});

// Compound index for efficient polling
ScheduledWhatsAppReminderSchema.index({ status: 1, scheduledFor: 1 });
ScheduledWhatsAppReminderSchema.index({ phoneNumber: 1, meetingStartISO: 1 });

export const ScheduledWhatsAppReminderModel = mongoose.model('ScheduledWhatsAppReminder', ScheduledWhatsAppReminderSchema);


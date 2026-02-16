import mongoose from "mongoose";

// Schema for tracking successful Calendly bookings from campaigns
export const CampaignBookingSchema = new mongoose.Schema({
  bookingId: {
    type: String,
    unique: true,
    required: true,
    default: () => `booking_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  // Campaign tracking
  campaignId: {
    type: String,
    ref: 'Campaign',
    index: true
  },
  utmSource: {
    type: String,
    required: true,
    index: true
  },
  utmMedium: {
    type: String,
    default: null
  },
  utmCampaign: {
    type: String,
    default: null
  },
  utmContent: {
    type: String,
    default: null
  },
  utmTerm: {
    type: String,
    default: null
  },
  // Client details
  clientName: {
    type: String,
    required: true,
    trim: true
  },
  clientEmail: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    index: true
  },
  clientPhone: {
    type: String,
    default: null
  },
  // Calendly details
  calendlyEventUri: {
    type: String,
    default: null
  },
  calendlyInviteeUri: {
    type: String,
    default: null
  },
  calendlyMeetLink: {
    type: String,
    default: null
  },
  googleMeetCode: {
    type: String,
    default: null,
    index: true
  },
  googleMeetUrl: {
    type: String,
    default: null
  },
  meetingVideoUrl: {
    type: String,
    default: null
  },
  calendlyRescheduleLink: {
    type: String,
    default: null
  },
  scheduledEventStartTime: {
    type: Date,
    default: null
  },
  scheduledEventEndTime: {
    type: Date,
    default: null
  },
  inviteeTimezone: {
    type: String,
    default: null
  },
  // Additional information
  anythingToKnow: {
    type: String,
    default: null
  },
  questionsAndAnswers: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  // Booking metadata
  bookingCreatedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  // Visitor tracking
  visitorId: {
    type: String,
    default: null
  },
  userAgent: {
    type: String,
    default: null
  },
  ipAddress: {
    type: String,
    default: null
  },
  // Status tracking
  bookingStatus: {
    type: String,
    enum: ['scheduled', 'completed', 'canceled', 'rescheduled', 'no-show', 'ignored', 'paid'],
    default: 'scheduled'
  },
  paymentPlan: {
    name: {
      type: String,
      enum: ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'],
      default: null
    },
    price: {
      type: Number,
      default: null
    },
    currency: {
      type: String,
      default: 'USD'
    },
    displayPrice: {
      type: String,
      default: null
    },
    selectedAt: {
      type: Date,
      default: null
    }
  },
  // Plan details for finalkk template workflow
  planDetails: {
    days: {
      type: Number,
      default: 7
    },
    updatedAt: {
      type: Date,
      default: null
    }
  },
  // Sync status
  syncedToMicroservice: {
    type: Boolean,
    default: false
  },
  syncedAt: {
    type: Date,
    default: null
  },
  // No-show tracking
  noShowDate: {
    type: Date,
    default: null
  },
  noShowProcessed: {
    type: Boolean,
    default: false
  },
  whatsappReminderSent: {
    type: Boolean,
    default: false
  },
  whatsappSentAt: {
    type: Date,
    default: null
  },
  // Payment reminder tracking
  paymentReminders: [{
    jobId: {
      type: String,
      required: true
    },
    paymentLink: {
      type: String,
      required: true
    },
    reminderDays: {
      type: Number,
      required: true
    },
    scheduledTime: {
      type: Date,
      required: true
    },
    status: {
      type: String,
      enum: ['scheduled', 'sent', 'failed', 'cancelled'],
      default: 'scheduled'
    },
    sentAt: {
      type: Date,
      default: null
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  // Reschedule tracking
  rescheduledFrom: {
    type: Date,
    default: null
  },
  rescheduledTo: {
    type: Date,
    default: null
  },
  rescheduledAt: {
    type: Date,
    default: null
  },
  rescheduledCount: {
    type: Number,
    default: 0
  },
  reminderCallJobId: {
    type: String,
    default: null
  },
  meetingNotes: {
    type: String,
    default: null
  },
  firefliesTranscriptId: {
    type: String,
    default: null,
    index: true
  },
  scheduledWorkflows: [{
    workflowId: {
      type: String,
      required: true
    },
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
    scheduledFor: {
      type: Date,
      required: true
    },
    status: {
      type: String,
      enum: ['scheduled', 'executed', 'failed', 'cancelled'],
      default: 'scheduled'
    },
    executedAt: {
      type: Date,
      default: null
    },
    error: {
      type: String,
      default: null
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  claimedBy: {
    email: {
      type: String,
      default: null,
      index: true
    },
    name: {
      type: String,
      default: null
    },
    claimedAt: {
      type: Date,
      default: null
    }
  },
  attachedCustomWorkflowIds: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
CampaignBookingSchema.index({ utmSource: 1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ clientEmail: 1, utmSource: 1 });
CampaignBookingSchema.index({ bookingStatus: 1 });
CampaignBookingSchema.index({ campaignId: 1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ bookingStatus: 1, clientEmail: 1, scheduledEventStartTime: -1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ bookingStatus: 1, 'paymentPlan.name': 1, 'paymentPlan.price': 1 });
CampaignBookingSchema.index({ 'claimedBy.email': 1, bookingStatus: 1 });
// Duplicate detection and lookups (plan 5.2)
CampaignBookingSchema.index({ calendlyEventUri: 1 });
CampaignBookingSchema.index({ calendlyInviteeUri: 1 });
CampaignBookingSchema.index({ clientPhone: 1 });
CampaignBookingSchema.index({ clientEmail: 1, scheduledEventStartTime: 1 });
CampaignBookingSchema.index({ scheduledEventStartTime: 1, bookingStatus: 1 });

export const CampaignBookingModel = mongoose.model('CampaignBooking', CampaignBookingSchema);


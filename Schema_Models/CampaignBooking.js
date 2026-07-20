import mongoose from "mongoose";
import { normalizePhoneForMatching } from "../Utils/normalizePhoneForMatching.js";

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
    trim: true,
    index: true
  },
  utmMedium: {
    type: String,
    trim: true,
    default: null
  },
  utmCampaign: {
    type: String,
    trim: true,
    default: null
  },
  utmContent: {
    type: String,
    trim: true,
    default: null
  },
  utmTerm: {
    type: String,
    trim: true,
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
  // Phone exactly as the client typed it in the Meta form, before country-code
  // resolution (Twilio lookup / heuristics) rewrote clientPhone. CRM shows both.
  rawClientPhone: {
    type: String,
    default: null
  },
  // How clientPhone's country code was decided ('twilio-in', 'nanp-shape-us',
  // 'wati-pending', 'wati-verified-in', ...). 'wati-pending' means the first
  // workflow WhatsApp send verifies the +1 guess and flips to +91 on failure.
  phoneResolution: {
    type: String,
    default: null
  },
  // Normalized phone (no country code) for matching/sync (e.g. Meta leads merge)
  normalizedClientPhone: {
    type: String,
    default: null,
    index: true
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
  // Lead source tracking (where the lead originated from)
  leadSource: {
    type: String,
    enum: ['calendly', 'meta_lead_ad', 'manual', 'frontend_direct', 'bulk_import'],
    default: 'calendly'
  },
  // Meta Lead Ads specific fields
  metaLeadId: {
    type: String,
    default: null,
    index: true
  },
  metaFormId: {
    type: String,
    default: null
  },
  metaAdId: {
    type: String,
    default: null
  },
  metaCampaignId: {
    type: String,
    default: null
  },
  metaCampaignName: {
    type: String,
    default: null,
    index: true
  },
  metaAdsetId: {
    type: String,
    default: null
  },
  metaAdsetName: {
    type: String,
    default: null
  },
  metaAdName: {
    type: String,
    default: null
  },
  metaPageId: {
    type: String,
    default: null
  },
  metaFormName: {
    type: String,
    default: null
  },
  metaPlatform: {
    type: String,
    default: null
  },
  metaIsOrganic: {
    type: Boolean,
    default: null
  },
  metaLeadStatus: {
    type: String,
    default: null
  },
  metaRawData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
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
    enum: ['not-scheduled', 'scheduled', 'completed', 'canceled', 'rescheduled', 'no-show', 'ignored', 'paid'],
    default: 'scheduled'
  },
  // Who/what changed the status last, and when
  statusChangedAt: {
    type: Date,
    default: null
  },
  statusChangeSource: {
    type: String,
    enum: ['admin', 'calendly', 'system', 'bda', 'microservice'],
    default: null
  },
  statusChangedBy: {
    type: String, // email or identifier of who changed it
    default: null
  },
  statusChangedByName: {
    type: String, // display name of who changed it last (for the CRM table)
    default: null
  },
  // Append-only trail of every status change, oldest first. Powers the Status timeline.
  statusHistory: [{
    status: { type: String },
    previousStatus: { type: String, default: null },
    changedByEmail: { type: String, default: null },
    changedByName: { type: String, default: null },
    source: {
      type: String,
      enum: ['admin', 'calendly', 'system', 'bda', 'microservice'],
      default: null
    },
    changedAt: { type: Date, default: Date.now }
  }],
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
  // Primary client + referral lines: each { planName, amount, currency }. Incentive = sum per line.
  paymentBreakdown: [{
    planName: {
      type: String,
      enum: ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'],
      required: true
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'USD' }
  }],
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
  // --- Call Leads tab --------------------------------------------------------
  // A Meta lead that never booked has no owner anywhere else: claimLead() rejects
  // the 'not-scheduled' status outright, and Calendly never runs so calendlyHost
  // stays null. This is the follow-up owner, set on first touch (a call placed or
  // a note written from the Call Leads tab) and never reassigned automatically.
  callLeadAssignee: {
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      default: null
    },
    assignedAt: {
      type: Date,
      default: null
    }
  },
  // Append-only, attributed follow-up notes. Deliberately NOT `meetingNotes` above,
  // which is a single string that the Fireflies webhook overwrites with transcript
  // summaries — appending call notes there would lose them.
  callLeadNotes: [{
    text: {
      type: String,
      required: true,
      trim: true
    },
    authorEmail: {
      type: String,
      default: null,
      lowercase: true,
      trim: true
    },
    authorName: {
      type: String,
      default: null
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
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
  // Calendly round-robin host — the BDA this meeting is assigned to. Captured from
  // scheduled_event.event_memberships on invitee.created and matched to a CRM user by
  // email. Distinct from claimedBy (which drives the manual claim + approval flow).
  calendlyHost: {
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
      index: true
    },
    name: {
      type: String,
      default: null
    },
    calendlyUserUri: {
      type: String,
      default: null
    },
    matchedCrmUser: {
      type: Boolean,
      default: false
    }
  },
  attachedCustomWorkflowIds: {
    type: [String],
    default: []
  },
  // Single-winner dispatch flags. First dispatcher (main or microservice) atomically
  // claims the field via { field: null } → { $set: { field: <now> } }. Atomic claim
  // wins exactly once, preventing duplicate Discord/WA/Call sends across backends.
  bdaDiscordReminderSentAt: {
    type: Date,
    default: null,
    index: true
  },
  bdaDiscordReminderSentBy: {
    type: String,
    default: null
  },
  whatsappReminderSentAt: {
    type: Date,
    default: null
  },
  whatsappReminderSentBy: {
    type: String,
    default: null
  },
  bdaCallPlacedAt: {
    type: Date,
    default: null
  },
  bdaCallPlacedBy: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

const UTM_STRING_FIELDS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];

function trimUtmObject(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const k of UTM_STRING_FIELDS) {
    if (typeof obj[k] === 'string') {
      const t = obj[k].trim();
      obj[k] = t === '' ? null : t;
    }
  }
}

// Keep normalizedClientPhone in sync with clientPhone for lead matching/sync.
// Also trim utm* strings — URL-decoded `+` can leave leading whitespace (e.g. " Canada-Arun")
// which breaks exact-match filters in the CRM.
CampaignBookingSchema.pre('save', function (next) {
  if (this.clientPhone) {
    this.normalizedClientPhone = normalizePhoneForMatching(this.clientPhone) || null;
  } else {
    this.normalizedClientPhone = null;
  }
  trimUtmObject(this);
  next();
});

// Default human-readable actor name when an automated flow doesn't provide one.
function defaultActorName(source) {
  switch (source) {
    case 'calendly': return 'Calendly';
    case 'bda': return 'BDA';
    case 'admin': return 'Admin';
    case 'microservice':
    case 'system':
    default: return 'System';
  }
}

// Append-only status history for every `.save()`-based transition (Calendly no-show /
// reschedule / cancel, creation genesis, etc.). Manual CRM edits go through
// findOneAndUpdate (which bypasses save hooks) and push their own richer entry there.
// Callers may set a transient `this._statusActor = { email, name, source, previousStatus }`
// before saving to attribute the change; otherwise it defaults to a system actor.
CampaignBookingSchema.pre('save', function (next) {
  if (this.isModified('bookingStatus') && this.bookingStatus) {
    const actor = this._statusActor || {};
    const source = actor.source || 'system';
    const changedAt = new Date();
    const changedByEmail = actor.email || null;
    const changedByName = actor.name || defaultActorName(source);
    const previousStatus = actor.previousStatus ?? null;

    this.statusChangedAt = changedAt;
    this.statusChangeSource = source;
    this.statusChangedBy = changedByEmail || this.statusChangedBy || null;
    this.statusChangedByName = changedByName;

    if (!Array.isArray(this.statusHistory)) this.statusHistory = [];
    this.statusHistory.push({
      status: this.bookingStatus,
      previousStatus,
      changedByEmail,
      changedByName,
      source,
      changedAt,
    });
  }
  next();
});

// Mongoose schema `trim: true` does not apply to update-style writes ($set / upserts).
// Mirror the normalization on every update query so sheet upserts & status updates
// never re-introduce leading/trailing whitespace in utm fields.
function preUpdateTrimUtm(next) {
  const update = this.getUpdate() || {};
  if (update.$set) trimUtmObject(update.$set);
  trimUtmObject(update);
  this.setUpdate(update);
  next();
}
CampaignBookingSchema.pre('updateOne', preUpdateTrimUtm);
CampaignBookingSchema.pre('updateMany', preUpdateTrimUtm);
CampaignBookingSchema.pre('findOneAndUpdate', preUpdateTrimUtm);

// Indexes for efficient queries
CampaignBookingSchema.index({ utmSource: 1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ clientEmail: 1, utmSource: 1 });
CampaignBookingSchema.index({ bookingStatus: 1 });
CampaignBookingSchema.index({ campaignId: 1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ bookingStatus: 1, clientEmail: 1, scheduledEventStartTime: -1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ bookingStatus: 1, 'paymentPlan.name': 1, 'paymentPlan.price': 1 });
CampaignBookingSchema.index({ 'claimedBy.email': 1, bookingStatus: 1 });
CampaignBookingSchema.index({ 'scheduledWorkflows.status': 1, 'scheduledWorkflows.scheduledFor': 1 });
// Call Leads tab: Meta leads still on 'not-scheduled', newest first.
CampaignBookingSchema.index({ leadSource: 1, bookingStatus: 1, bookingCreatedAt: -1 });
CampaignBookingSchema.index({ 'callLeadAssignee.email': 1 });

export const CampaignBookingModel = mongoose.model('CampaignBooking', CampaignBookingSchema);


import mongoose from "mongoose";

// Schema for tracking individual page visits
const PageVisitSchema = new mongoose.Schema({
  visitorId: {
    type: String,
    required: true,
    index: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  userAgent: String,
  ipAddress: String,
  referrer: String,
  pageUrl: String
});

// Schema for tracking button clicks
const ButtonClickSchema = new mongoose.Schema({
  visitorId: {
    type: String,
    required: true,
    index: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  buttonText: {
    type: String,
    required: true
  },
  buttonLocation: {
    type: String,
    required: true
  },
  buttonType: {
    type: String,
    enum: ['cta', 'secondary', 'link', 'icon'],
    default: 'cta'
  },
  pageUrl: String,
  userAgent: String,
  ipAddress: String
});

// Main Campaign Schema
export const CampaignSchema = new mongoose.Schema({
  campaignId: {
    type: String,
    unique: true,
    required: true,
    default: () => `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  },
  campaignName: {
    type: String,
    required: true,
    trim: true
  },
  utmSource: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  utmMedium: {
    type: String,
    default: 'campaign'
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
  generatedUrl: {
    type: String,
    required: true
  },
  baseUrl: {
    type: String,
    default: 'https://www.flashfirejobs.com'
  },
  // Tracking metrics
  totalClicks: {
    type: Number,
    default: 0
  },
  totalButtonClicks: {
    type: Number,
    default: 0
  },
  uniqueVisitors: {
    type: [String], // Array of unique visitor IDs
    default: []
  },
  pageVisits: [PageVisitSchema],
  buttonClicks: [ButtonClickSchema],
  // Campaign status
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: String,
    default: 'admin'
  }
}, {
  timestamps: true
});

// Index for efficient queries
CampaignSchema.index({ utmSource: 1, createdAt: -1 });
CampaignSchema.index({ isActive: 1 });

export const CampaignModel = mongoose.model('Campaign', CampaignSchema);


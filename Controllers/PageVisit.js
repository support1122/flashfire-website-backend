import mongoose from "mongoose";
import { detectCountryFromIp } from "../Utils/GeoIP.js";

// Schema for tracking ALL page visits (campaigns + organic + direct)
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
  pageUrl: {
    type: String,
    required: true,
    index: true
  },
  userAgent: String,
  ipAddress: String,
  referrer: String,
  
  // UTM Parameters (optional - for campaign tracking)
  utmSource: {
    type: String,
    default: null,
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
  
  // Geo Location (detected from IP)
  countryCode: {
    type: String,
    default: null,
    index: true
  },
  countryName: {
    type: String,
    default: null
  },
  
  // Traffic Source Classification
  trafficSource: {
    type: String,
    enum: ['campaign', 'organic', 'direct', 'referral', 'social', 'email', 'other'],
    default: 'other',
    index: true
  },
  
  // Session info
  sessionId: String,
  
  // Additional metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Indexes for fast queries
PageVisitSchema.index({ timestamp: -1 });
PageVisitSchema.index({ visitorId: 1, timestamp: -1 });
PageVisitSchema.index({ utmSource: 1, timestamp: -1 });
PageVisitSchema.index({ countryCode: 1, timestamp: -1 });
PageVisitSchema.index({ trafficSource: 1, timestamp: -1 });
PageVisitSchema.index({ pageUrl: 1, timestamp: -1 });

// Pre-save hook to detect country from IP and classify traffic source
PageVisitSchema.pre('save', async function(next) {
  // Detect country from IP if not already set
  if (this.ipAddress && !this.countryCode) {
    try {
      const geoData = detectCountryFromIp(this.ipAddress);
      this.countryCode = geoData.countryCode;
      this.countryName = geoData.country;
    } catch (error) {
      console.error('Error detecting country:', error);
    }
  }
  
  // Classify traffic source if not already set
  if (!this.trafficSource || this.trafficSource === 'other') {
    if (this.utmSource) {
      // Has UTM source = campaign
      this.trafficSource = 'campaign';
    } else if (this.referrer) {
      // Has referrer = check what type
      const referrerLower = this.referrer.toLowerCase();
      if (referrerLower.includes('google') || referrerLower.includes('bing') || referrerLower.includes('yahoo') || referrerLower.includes('duckduckgo')) {
        this.trafficSource = 'organic';
      } else if (referrerLower.includes('facebook') || referrerLower.includes('linkedin') || referrerLower.includes('twitter') || referrerLower.includes('instagram')) {
        this.trafficSource = 'social';
      } else if (referrerLower.includes('mail') || referrerLower.includes('email') || referrerLower.includes('gmail')) {
        this.trafficSource = 'email';
      } else {
        this.trafficSource = 'referral';
      }
    } else {
      // No referrer = direct traffic
      this.trafficSource = 'direct';
    }
  }
  
  next();
});

export const PageVisitModel = mongoose.model('PageVisit', PageVisitSchema);

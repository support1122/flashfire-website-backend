/**
 * LinkedIn Conversion API Service
 * 
 * Sends server-side conversion events to LinkedIn for better tracking accuracy
 * and privacy compliance (ad blockers, iOS 14.5+, etc.)
 * 
 * Required Environment Variables:
 * - LINKEDIN_PARTNER_ID: Your LinkedIn Partner ID (e.g., 515334183)
 * - LINKEDIN_ACCESS_TOKEN: Your LinkedIn API Access Token (with ads_management permission)
 * - LINKEDIN_SCHEDULE_CONVERSION_ID: Your Schedule conversion ID from Campaign Manager
 * 
 * Setup Steps:
 * 1. Go to LinkedIn Campaign Manager → Analyze → Sources → Google Tag Manager
 * 2. Generate an API Access Token
 * 3. Create a conversion action in Campaign Manager → Conversion Tracking
 * 4. Get the conversion ID from the conversion action
 * 5. Add these to your environment variables
 * 
 * Documentation: https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api
 */

import crypto from 'crypto';

const LINKEDIN_PARTNER_ID = process.env.LINKEDIN_PARTNER_ID || process.env.NEXT_PUBLIC_LINKEDIN_PARTNER_ID || '515334183';
const LINKEDIN_ACCESS_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
const LINKEDIN_SCHEDULE_CONVERSION_ID = process.env.LINKEDIN_SCHEDULE_CONVERSION_ID || process.env.NEXT_PUBLIC_LINKEDIN_SCHEDULE_CONVERSION_ID;

// LinkedIn Conversions API endpoint
// Format: https://api.linkedin.com/rest/conversionEvents
const CONVERSION_API_URL = 'https://api.linkedin.com/rest/conversionEvents';

// LinkedIn API requires version format YYYYMM. Using confirmed working version 202503 (March 2025).
// DO NOT use dynamic date generation - LinkedIn versions are released monthly
// and must match an active, supported version. Versions are supported for minimum 1 year.
// LinkedIn Conversions API requires 202503 or newer for conversions ingestion.
// See: https://learn.microsoft.com/en-us/linkedin/marketing/versioning
const LINKEDIN_API_VERSION = '202503';

/**
 * Hash user data for privacy compliance (SHA256)
 * LinkedIn requires hashed email/phone for matching
 */
function hashData(data) {
  if (!data) return null;
  return crypto
    .createHash('sha256')
    .update(data.toLowerCase().trim())
    .digest('hex');
}

/**
 * Extract first name and last name from full name
 */
function parseName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = fullName.trim().split(/\s+/);
  return {
    firstName: parts[0] || null,
    lastName: parts.slice(1).join(' ') || null,
  };
}

/**
 * Send conversion event to LinkedIn Conversion API
 * 
 * @param {Object} params - Event parameters
 * @param {string} params.conversionId - Conversion ID from Campaign Manager
 * @param {string} params.email - User email (will be hashed)
 * @param {string} params.phone - User phone (will be hashed)
 * @param {string} params.firstName - User first name (will be hashed)
 * @param {string} params.lastName - User last name (will be hashed)
 * @param {string} params.clientIp - User IP address
 * @param {string} params.userAgent - User agent string
 * @param {string} params.eventId - Unique event ID (for deduplication)
 * @param {string} params.eventSourceUrl - URL where event occurred
 * @param {Object} params.customData - Custom event data (value, currency, etc.)
 * @returns {Promise<Object>} API response
 */
export async function sendConversionEvent({
  conversionId,
  email = null,
  phone = null,
  firstName = null,
  lastName = null,
  clientIp = null,
  userAgent = null,
  eventId = null,
  eventSourceUrl = null,
  customData = {},
}) {
  // Validate required configuration
  if (!LINKEDIN_PARTNER_ID) {
    console.warn('⚠️ LINKEDIN_PARTNER_ID not configured, skipping Conversion API call');
    return { success: false, error: 'LINKEDIN_PARTNER_ID not configured' };
  }

  if (!LINKEDIN_ACCESS_TOKEN) {
    console.warn('⚠️ LINKEDIN_ACCESS_TOKEN not configured, skipping Conversion API call');
    return { success: false, error: 'LINKEDIN_ACCESS_TOKEN not configured' };
  }

  if (!conversionId && !LINKEDIN_SCHEDULE_CONVERSION_ID) {
    console.warn('⚠️ LinkedIn conversion ID not provided, skipping Conversion API call');
    return { success: false, error: 'Conversion ID not provided' };
  }

  const finalConversionId = conversionId || LINKEDIN_SCHEDULE_CONVERSION_ID;

  // At least one identifier is required (email OR firstName+lastName)
  // LinkedIn accepts: SHA256_EMAIL OR (firstName + lastName)
  if (!email && (!firstName || !lastName)) {
    console.warn('⚠️ LinkedIn Conversion API requires email OR (firstName + lastName)');
    return { success: false, error: 'Email or (firstName + lastName) is required' };
  }

  try {
    // Prepare user data according to LinkedIn Conversions API schema
    // LinkedIn requires userIds array and userInfo object
    // At least one identifier is required: SHA256_EMAIL or (firstName + lastName)
    const userIds = [];
    const userInfo = {};
    
    // Add email to userIds array (hashed) - REQUIRED if available
    // LinkedIn accepts: SHA256_EMAIL OR (firstName + lastName)
    if (email) {
      userIds.push({
        idType: 'SHA256_EMAIL',
        idValue: hashData(email),
      });
    }
    
    // Add LinkedIn first-party tracking UUID (li_fat_id cookie) for better attribution
    // This increases match rate from 30-40% to 70-90%
    if (customData.li_fat_id) {
      userIds.push({
        idType: 'LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID',
        idValue: customData.li_fat_id,
      });
    }
    
    // Add user info (plain text, not hashed)
    // Required if no email: must have firstName AND lastName
    if (firstName) {
      userInfo.firstName = firstName;
    }
    if (lastName) {
      userInfo.lastName = lastName;
    }
    
    // Build user object - must have at least userIds OR (firstName + lastName)
    const userData = {};
    if (userIds.length > 0) {
      userData.userIds = userIds;
    }
    if (Object.keys(userInfo).length > 0) {
      userData.userInfo = userInfo;
    }
    
    // Validate: Must have at least email OR (firstName + lastName)
    // LinkedIn requires: SHA256_EMAIL OR LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID OR (firstName + lastName)
    if (userIds.length === 0 && (!userInfo.firstName || !userInfo.lastName)) {
      console.warn('⚠️ LinkedIn Conversion API requires SHA256_EMAIL or (firstName + lastName)');
      return { success: false, error: 'Email or (firstName + lastName) is required' };
    }

    // Prepare conversion event data
    // Note: URN format should be urn:lla:llaPartnerConversion:{conversionId}
    // The conversion ID from Campaign Manager is the llaPartnerConversionId
    const conversionEvent = {
      conversion: `urn:lla:llaPartnerConversion:${finalConversionId}`,
      conversionHappenedAt: Date.now(), // Unix timestamp in milliseconds
      user: userData, // Always include user object
      ...(eventId && { eventId }), // For deduplication
      ...(eventSourceUrl && { eventSourceUrl }),
      ...(clientIp && { ipAddress: clientIp }),
      ...(userAgent && { userAgent }),
      // Always include conversionValue (LinkedIn prefers it always present, even if 0)
      conversionValue: {
        currencyCode: customData.currency || 'USD',
        amount: String(customData.value ?? 0),
      },
    };

    // Prepare API request
    // For single event, send the event object directly (not wrapped)
    const requestBody = conversionEvent;

    // LinkedIn API requires version format YYYYMM. Using confirmed working version 202503.
    // IMPORTANT: Version must be exactly 6 digits (YYYYMM), not 8 digits (YYYYMMDD)
    // LinkedIn Conversions API requires 202503 or newer for conversions ingestion
    // Debug: Verify version format before sending
    const versionToSend = String(LINKEDIN_API_VERSION).trim();
    console.log('🔍 DEBUG - Version Check:', {
      constant: LINKEDIN_API_VERSION,
      sending: versionToSend,
      length: versionToSend.length,
      type: typeof versionToSend,
    });
    
    console.log('📤 Sending LinkedIn Conversion API event:', {
      conversionId: finalConversionId,
      partnerId: LINKEDIN_PARTNER_ID,
      email: email ? `${email.substring(0, 3)}***` : 'none',
      hasUserData: Object.keys(userData).length > 0,
      linkedInVersion: versionToSend,
    });

    // Send to LinkedIn Conversion API
    // LinkedIn requires header 'LinkedIn-Version' with format YYYYMM (6 digits)
    // Using confirmed working version: 202503 (March 2025)
    const response = await fetch(CONVERSION_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
        'LinkedIn-Version': versionToSend, // Capital I and N - LinkedIn's gateway is strict about casing
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify(requestBody),
    });

    // Safer response handling - LinkedIn may send empty response body
    let responseData = {};
    try {
      const text = await response.text();
      if (text) {
        responseData = JSON.parse(text);
      }
    } catch (e) {
      // Empty response or invalid JSON - use empty object
      responseData = {};
    }

    if (!response.ok) {
      console.error('❌ LinkedIn Conversion API error:', {
        status: response.status,
        error: responseData,
      });

      return {
        success: false,
        error: responseData.message || responseData.error || 'Unknown error',
        response: responseData,
      };
    }

    console.log('✅ LinkedIn Conversion API event sent successfully:', {
      conversionId: finalConversionId,
      status: response.status,
      response: responseData,
    });

    return {
      success: true,
      data: responseData,
    };
  } catch (error) {
    console.error('❌ LinkedIn Conversion API request failed:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

/**
 * Send Schedule event for meeting booking
 * Convenience wrapper for booking conversions
 */
export async function sendScheduleEvent({
  email,
  phone,
  fullName,
  clientIp,
  userAgent,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
  utmTerm,
  eventId,
  eventSourceUrl,
  conversionId = null,
  li_fat_id = null, // LinkedIn first-party tracking UUID (from li_fat_id cookie)
}) {
  const { firstName, lastName } = parseName(fullName);

  const customData = {
    value: 0,
    currency: 'USD',
    // Add LinkedIn tracking cookie for better attribution (increases match rate from 30-40% to 70-90%)
    ...(li_fat_id && { li_fat_id }),
    // Add UTM parameters for attribution
    ...(utmSource && { utm_source: utmSource }),
    ...(utmMedium && { utm_medium: utmMedium }),
    ...(utmCampaign && { utm_campaign: utmCampaign }),
    ...(utmContent && { utm_content: utmContent }),
    ...(utmTerm && { utm_term: utmTerm }),
  };

  return sendConversionEvent({
    conversionId: conversionId || LINKEDIN_SCHEDULE_CONVERSION_ID,
    email,
    phone,
    firstName,
    lastName,
    clientIp,
    userAgent,
    eventId,
    eventSourceUrl,
    customData,
  });
}

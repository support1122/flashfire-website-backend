/**
 * Facebook Conversion API Service
 * 
 * Sends server-side conversion events to Facebook for better tracking accuracy
 * and privacy compliance (iOS 14.5+, ad blockers, etc.)
 * 
 * Required Environment Variables:
 * - FB_PIXEL_ID: Your Facebook Pixel ID
 * - FB_ACCESS_TOKEN: Your Facebook Access Token (with ads_management permission)
 * - FB_TEST_EVENT_CODE: (Optional) Test event code for testing in Events Manager
 */

import crypto from 'crypto';

const FB_PIXEL_ID = process.env.FB_PIXEL_ID;
const FB_ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;
const FB_TEST_EVENT_CODE = process.env.FB_TEST_EVENT_CODE;

const CONVERSION_API_URL = 'https://graph.facebook.com/v21.0';

/**
 * Hash user data for privacy compliance (SHA256)
 * Facebook requires hashed email/phone for matching
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
 * Send conversion event to Facebook Conversion API
 * 
 * @param {Object} params - Event parameters
 * @param {string} params.eventName - Event name (e.g., 'Schedule', 'Lead', 'CompleteRegistration')
 * @param {string} params.email - User email (will be hashed)
 * @param {string} params.phone - User phone (will be hashed)
 * @param {string} params.firstName - User first name (will be hashed)
 * @param {string} params.lastName - User last name (will be hashed)
 * @param {string} params.clientIp - User IP address
 * @param {string} params.userAgent - User agent string
 * @param {string} params.fbp - Facebook browser ID (_fbp cookie)
 * @param {string} params.fbc - Facebook click ID (_fbc cookie)
 * @param {Object} params.customData - Custom event data (value, currency, etc.)
 * @param {string} params.eventSourceUrl - URL where event occurred
 * @param {string} params.eventId - Unique event ID (for deduplication)
 * @returns {Promise<Object>} API response
 */
export async function sendConversionEvent({
  eventName = 'Schedule',
  email = null,
  phone = null,
  firstName = null,
  lastName = null,
  clientIp = null,
  userAgent = null,
  fbp = null,
  fbc = null,
  customData = {},
  eventSourceUrl = null,
  eventId = null,
}) {
  // Validate required configuration
  if (!FB_PIXEL_ID) {
    console.warn('⚠️ FB_PIXEL_ID not configured, skipping Conversion API call');
    return { success: false, error: 'FB_PIXEL_ID not configured' };
  }

  if (!FB_ACCESS_TOKEN) {
    console.warn('⚠️ FB_ACCESS_TOKEN not configured, skipping Conversion API call');
    return { success: false, error: 'FB_ACCESS_TOKEN not configured' };
  }

  try {
    // Prepare user data (hashed for privacy)
    const userData = {};
    
    if (email) {
      userData.em = hashData(email);
    }
    if (phone) {
      // Remove non-numeric characters before hashing
      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone) {
        userData.ph = hashData(cleanPhone);
      }
    }
    if (firstName) {
      userData.fn = hashData(firstName);
    }
    if (lastName) {
      userData.ln = hashData(lastName);
    }
    if (clientIp) {
      userData.client_ip_address = clientIp;
    }
    if (userAgent) {
      userData.client_user_agent = userAgent;
    }
    if (fbp) {
      userData.fbp = fbp;
    }
    if (fbc) {
      userData.fbc = fbc;
    }

    // Prepare event data
    const eventData = {
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000), // Unix timestamp in seconds
      action_source: 'website',
      ...(eventSourceUrl && { event_source_url: eventSourceUrl }),
      ...(eventId && { event_id: eventId }), // For deduplication with Pixel
      user_data: userData,
      custom_data: {
        ...customData,
      },
    };

    // Add test event code if in test mode
    const testEventCode = FB_TEST_EVENT_CODE || null;

    // Prepare API request
    const requestBody = {
      data: [eventData],
      access_token: FB_ACCESS_TOKEN,
      ...(testEventCode && { test_event_code: testEventCode }),
    };

    const apiUrl = `${CONVERSION_API_URL}/${FB_PIXEL_ID}/events`;

    console.log('📤 Sending Facebook Conversion API event:', {
      eventName,
      email: email ? `${email.substring(0, 3)}***` : 'none',
      hasUserData: Object.keys(userData).length > 0,
      testMode: !!testEventCode,
    });

    // Send to Facebook Conversion API
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    const responseData = await response.json();

    if (!response.ok) {
      console.error('❌ Facebook Conversion API error:', {
        status: response.status,
        error: responseData,
      });
      return {
        success: false,
        error: responseData.error?.message || 'Unknown error',
        response: responseData,
      };
    }

    console.log('✅ Facebook Conversion API event sent successfully:', {
      eventName,
      events_received: responseData.events_received,
      messages: responseData.messages,
    });

    return {
      success: true,
      data: responseData,
    };
  } catch (error) {
    console.error('❌ Facebook Conversion API request failed:', error);
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
  fbp,
  fbc,
  utmSource,
  utmMedium,
  utmCampaign,
  utmContent,
  utmTerm,
  eventId,
  eventSourceUrl,
}) {
  const { firstName, lastName } = parseName(fullName);

  const customData = {
    content_name: 'Meeting Booked',
    content_category: 'Consultation',
    value: 0,
    currency: 'USD',
    // Add UTM parameters for attribution
    ...(utmSource && { utm_source: utmSource }),
    ...(utmMedium && { utm_medium: utmMedium }),
    ...(utmCampaign && { utm_campaign: utmCampaign }),
    ...(utmContent && { utm_content: utmContent }),
    ...(utmTerm && { utm_term: utmTerm }),
  };

  return sendConversionEvent({
    eventName: 'Schedule',
    email,
    phone,
    firstName,
    lastName,
    clientIp,
    userAgent,
    fbp,
    fbc,
    customData,
    eventSourceUrl,
    eventId,
  });
}

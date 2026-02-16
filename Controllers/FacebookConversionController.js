/**
 * Facebook Conversion API Controller
 * 
 * Endpoints for manually triggering Facebook Conversion API events
 * Useful for testing and debugging
 */

import { sendScheduleEvent, sendConversionEvent } from '../Services/FacebookConversionAPI.js';

/**
 * Manually send Schedule event (for testing/debugging)
 * POST /api/facebook-conversion/schedule
 */
export const sendScheduleEventManual = async (req, res) => {
  try {
    const {
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
    } = req.body;

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Email or phone is required',
      });
    }

    const result = await sendScheduleEvent({
      email,
      phone,
      fullName,
      clientIp: clientIp || req.ip || null,
      userAgent: userAgent || req.get('user-agent') || null,
      fbp,
      fbc,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      eventId,
      eventSourceUrl: eventSourceUrl || 'https://www.flashfirejobs.com/meeting-booked',
    });

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Facebook Conversion API event sent successfully',
        data: result.data,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to send Facebook Conversion API event',
        error: result.error,
      });
    }
  } catch (error) {
    console.error('❌ Error sending Facebook Conversion API event:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send conversion event',
      error: error.message,
    });
  }
};

/**
 * Send custom conversion event (for testing/debugging)
 * POST /api/facebook-conversion/custom
 */
export const sendCustomEvent = async (req, res) => {
  try {
    const {
      eventName,
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
    } = req.body;

    if (!eventName) {
      return res.status(400).json({
        success: false,
        message: 'eventName is required',
      });
    }

    if (!email && !phone) {
      return res.status(400).json({
        success: false,
        message: 'Email or phone is required',
      });
    }

    const result = await sendConversionEvent({
      eventName,
      email,
      phone,
      firstName,
      lastName,
      clientIp: clientIp || req.ip || null,
      userAgent: userAgent || req.get('user-agent') || null,
      fbp,
      fbc,
      customData: customData || {},
      eventSourceUrl: eventSourceUrl || 'https://www.flashfirejobs.com',
      eventId,
    });

    if (result.success) {
      return res.status(200).json({
        success: true,
        message: 'Facebook Conversion API event sent successfully',
        data: result.data,
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to send Facebook Conversion API event',
        error: result.error,
      });
    }
  } catch (error) {
    console.error('❌ Error sending Facebook Conversion API event:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send conversion event',
      error: error.message,
    });
  }
};

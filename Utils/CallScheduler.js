import Twilio from 'twilio';
import dotenv from 'dotenv';
import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';
import { Logger } from './Logger.js';
import { scheduleWhatsAppReminder } from './WhatsAppReminderScheduler.js';
import { DateTime } from 'luxon';
import { getRescheduleLinkForBooking } from './CalendlyAPIHelper.js';

dotenv.config();



const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;
const POLL_INTERVAL_MS = 30000; // Check every 30 seconds
const DISCORD_WEBHOOK = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;

let twilioClient = null;
let isRunning = false;
let pollInterval = null;

// Initialize Twilio client
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('✅ [CallScheduler] Twilio client initialized');
} else {
  console.error('❌ [CallScheduler] Missing Twilio credentials');
}

/**
 * Schedule a call 10 minutes before a meeting
 */
export async function scheduleCall({
  phoneNumber,
  meetingStartISO,
  meetingTime,
  inviteeName = null,
  inviteeEmail = null,
  source = 'calendly',
  metadata = {},
  meetingLink = null,
  rescheduleLink = null
}) {
  try {
    // Validate phone number
    if (!phoneNumber || !/^\+?[1-9]\d{9,14}$/.test(phoneNumber)) {
      console.error('❌ [CallScheduler] Invalid phone number:', phoneNumber);
      return { success: false, error: 'Invalid phone number' };
    }

    // Calculate call time (10 minutes before meeting)
    const meetingStart = new Date(meetingStartISO);
    const callTime = new Date(meetingStart.getTime() - 10 * 60 * 1000);
    
    // Don't schedule if call time is in the past
    if (callTime <= new Date()) {
      console.warn('⚠️ [CallScheduler] Call time is in the past, skipping:', {
        phoneNumber,
        meetingStart: meetingStart.toISOString(),
        callTime: callTime.toISOString()
      });
      return { success: false, error: 'Call time is in the past' };
    }

    // Create unique call ID
    const callId = `call_${phoneNumber}_${meetingStart.getTime()}`;

    // Check if call already exists
    const existingCall = await ScheduledCallModel.findOne({ callId });
    if (existingCall) {
      console.log('ℹ️ [CallScheduler] Call already scheduled:', callId);
      return { success: true, callId, existing: true, scheduledFor: existingCall.scheduledFor };
    }

    // Create scheduled call
    const scheduledCall = await ScheduledCallModel.create({
      callId,
      phoneNumber,
      scheduledFor: callTime,
      meetingTime,
      meetingStartISO: meetingStart,
      inviteeName,
      inviteeEmail,
      source,
      metadata
    });

    const delayMinutes = Math.round((callTime - new Date()) / 60000);
    
    console.log('✅ [CallScheduler] Call scheduled:', {
      callId,
      phoneNumber,
      scheduledFor: callTime.toISOString(),
      meetingTime,
      delayMinutes
    });

    if (DISCORD_WEBHOOK) {
      await DiscordConnect(DISCORD_WEBHOOK, 
        `📅 **Call Scheduled (MongoDB)**\n` +
        `📞 Phone: ${phoneNumber}\n` +
        `👤 Name: ${inviteeName || 'Unknown'}\n` +
        `📧 Email: ${inviteeEmail || 'Unknown'}\n` +
        `⏰ Call at: ${callTime.toISOString()}\n` +
        `📆 Meeting: ${meetingTime}\n` +
        `⏳ In: ${delayMinutes} minutes\n` +
        `🔖 Source: ${source}`
      );
    }

    // Also schedule WhatsApp reminder 5 minutes before meeting
    try {
      // Fetch reschedule link from booking record if bookingId is available
      let finalRescheduleLink = rescheduleLink || metadata?.rescheduleLink || null;
      
      if (metadata?.bookingId && !finalRescheduleLink) {
        try {
          const booking = await CampaignBookingModel.findOne({ bookingId: metadata.bookingId });
          if (booking) {
            // Try to get reschedule link from Calendly API if not in DB
            const fetchedLink = await getRescheduleLinkForBooking(booking);
            if (fetchedLink) {
              finalRescheduleLink = fetchedLink;
              console.log('✅ [CallScheduler] Fetched reschedule link from Calendly API:', finalRescheduleLink);
            } else if (booking?.calendlyRescheduleLink) {
              finalRescheduleLink = booking.calendlyRescheduleLink;
              console.log('✅ [CallScheduler] Fetched reschedule link from booking record:', finalRescheduleLink);
            }
          }
        } catch (bookingError) {
          console.warn('⚠️ [CallScheduler] Could not fetch booking record:', bookingError.message);
        }
      }
      
      // Also try fetching by email and meeting time if bookingId not available
      if (!finalRescheduleLink && inviteeEmail && meetingStartISO) {
        try {
          const booking = await CampaignBookingModel.findOne({
            clientEmail: inviteeEmail,
            scheduledEventStartTime: new Date(meetingStartISO)
          }).sort({ bookingCreatedAt: -1 });
          
          if (booking) {
            // Try to get reschedule link from Calendly API if not in DB
            const fetchedLink = await getRescheduleLinkForBooking(booking);
            if (fetchedLink) {
              finalRescheduleLink = fetchedLink;
              console.log('✅ [CallScheduler] Fetched reschedule link from Calendly API by email/time:', finalRescheduleLink);
            } else if (booking?.calendlyRescheduleLink) {
              finalRescheduleLink = booking.calendlyRescheduleLink;
              console.log('✅ [CallScheduler] Fetched reschedule link from booking by email/time:', finalRescheduleLink);
            }
          }
        } catch (bookingError) {
          console.warn('⚠️ [CallScheduler] Could not fetch booking by email/time:', bookingError.message);
        }
      }
      
      // Format meeting date and time for WhatsApp template
      // Format: "Saturday Dec 27, 2025" and "12am – 12:15am" (America/New_York timezone)
      const meetingStart = new Date(meetingStartISO);
      const meetingEnd = metadata?.meetingEndISO ? new Date(metadata.meetingEndISO) : new Date(meetingStart.getTime() + 15 * 60 * 1000); // Default 15 min if not provided
      
      const meetingStartUTC = DateTime.fromJSDate(meetingStart, { zone: 'utc' });
      const meetingEndUTC = DateTime.fromJSDate(meetingEnd, { zone: 'utc' });
      
      // Format date: "Saturday Dec 27, 2025" (America/New_York)
      const meetingDateFormatted = meetingStartUTC.setZone('America/New_York').toFormat('EEEE MMM d, yyyy');
      
      const startTimeET = meetingStartUTC.setZone('America/New_York');
      const startTimeFormatted = startTimeET.minute === 0 
        ? startTimeET.toFormat('ha').toLowerCase()
        : startTimeET.toFormat('h:mma').toLowerCase();
      
      // End time: always include minutes if present
      const endTimeET = meetingEndUTC.setZone('America/New_York');
      const endTimeFormatted = endTimeET.minute === 0
        ? endTimeET.toFormat('ha').toLowerCase()
        : endTimeET.toFormat('h:mma').toLowerCase();
      
      const meetingTimeFormatted = `${startTimeFormatted} – ${endTimeFormatted}`;

      const whatsappResult = await scheduleWhatsAppReminder({
        phoneNumber,
        meetingStartISO,
        meetingTime: meetingTimeFormatted,
        meetingDate: meetingDateFormatted,
        clientName: inviteeName,
        clientEmail: inviteeEmail,
        meetingLink: meetingLink || metadata?.meetingLink || null,
        rescheduleLink: finalRescheduleLink,
        source,
        metadata: {
          ...metadata,
          meetingEndISO: meetingEnd.toISOString()
        }
      });

      if (whatsappResult.success) {
        console.log('✅ [CallScheduler] WhatsApp reminder also scheduled:', whatsappResult.reminderId);
      } else {
        console.warn('⚠️ [CallScheduler] Failed to schedule WhatsApp reminder:', whatsappResult.error);
      }
    } catch (whatsappError) {
      console.error('❌ [CallScheduler] Error scheduling WhatsApp reminder:', whatsappError.message);
      // Don't fail the call scheduling if WhatsApp reminder fails
    }

    return { 
      success: true, 
      callId, 
      scheduledFor: callTime,
      delayMinutes 
    };

  } catch (error) {
    console.error('❌ [CallScheduler] Error scheduling call:', error);
    Logger.error('[CallScheduler] Error scheduling call', { error: error.message, phoneNumber });
    return { success: false, error: error.message };
  }
}

/**
 * Cancel a scheduled call
 */
export async function cancelCall({ phoneNumber, meetingStartISO }) {
  try {
    const meetingStart = new Date(meetingStartISO);
    const callId = `call_${phoneNumber}_${meetingStart.getTime()}`;

    const result = await ScheduledCallModel.findOneAndUpdate(
      { callId, status: 'pending' },
      { status: 'cancelled' },
      { new: true }
    );

    if (result) {
      console.log('✅ [CallScheduler] Call cancelled:', callId);
      return { success: true, callId };
    } else {
      console.log('ℹ️ [CallScheduler] No pending call found to cancel:', callId);
      return { success: false, error: 'Call not found or already processed' };
    }
  } catch (error) {
    console.error('❌ [CallScheduler] Error cancelling call:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Make the actual Twilio call
 */
async function makeCall(scheduledCall) {
  const { phoneNumber, meetingTime, callId } = scheduledCall;

  try {
    if (!twilioClient) {
      throw new Error('Twilio client not initialized');
    }

    if (!TWILIO_FROM) {
      throw new Error('TWILIO_FROM not configured');
    }

    // Build TwiML
    const { VoiceResponse } = Twilio.twiml;
    const twiml = new VoiceResponse();
    twiml.pause({ length: 1 });
    twiml.say(
      { voice: 'alice', language: 'en-US' },
      `Hi, this is FlashFire. This is a quick reminder for your meeting scheduled at ${meetingTime}.`
    );
    twiml.say(
      { voice: 'alice', language: 'en-US' },
      'See you in the meeting. Thank you and good luck.'
    );

    const baseUrl = process.env.API_BASE_URL || 'https://api.flashfirejobs.com';
    const statusCallbackUrl = `${baseUrl}/call-status`;

    const call = await twilioClient.calls.create({
      to: phoneNumber,
      from: TWILIO_FROM,
      twiml: twiml.toString(),
      statusCallback: statusCallbackUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed', 'busy', 'failed', 'no-answer', 'canceled'],
      statusCallbackMethod: 'POST'
    });

    console.log('✅ [CallScheduler] Call initiated:', {
      callId,
      phoneNumber,
      twilioCallSid: call.sid
    });

    return { success: true, twilioCallSid: call.sid };

  } catch (error) {
    console.error('❌ [CallScheduler] Error making call:', {
      callId,
      phoneNumber,
      error: error.message
    });
    return { success: false, error: error.message };
  }
}

/**
 * Process due calls - called by the polling mechanism
 */
export async function processDueCalls() {
  try {
    const now = new Date();

    // Find all pending calls that are due
    const dueCalls = await ScheduledCallModel.find({
      status: 'pending',
      scheduledFor: { $lte: now },
      attempts: { $lt: 3 } // Max 3 attempts
    }).limit(10); // Process max 10 at a time

    if (dueCalls.length === 0) {
      return;
    }

    console.log(`📞 [CallScheduler] Processing ${dueCalls.length} due call(s)...`);

    for (const call of dueCalls) {
      try {
        // Mark as processing
        await ScheduledCallModel.updateOne(
          { _id: call._id },
          { 
            status: 'processing',
            processedAt: new Date(),
            $inc: { attempts: 1 }
          }
        );

        // Make the call
        const result = await makeCall(call);

        if (result.success) {
          // Update with Twilio call SID - status updates will come via webhook
          await ScheduledCallModel.updateOne(
            { _id: call._id },
            { 
              twilioCallSid: result.twilioCallSid
            }
          );

          console.log('✅ [CallScheduler] Call initiated, waiting for Twilio status updates:', {
            callId: call.callId,
            twilioCallSid: result.twilioCallSid,
            phoneNumber: call.phoneNumber
          });
        } else {
          // Check if we should retry
          const updatedCall = await ScheduledCallModel.findById(call._id);
          
          if (updatedCall.attempts >= updatedCall.maxAttempts) {
            // Max attempts reached, mark as failed
            await ScheduledCallModel.updateOne(
              { _id: call._id },
              { 
                status: 'failed',
                errorMessage: result.error
              }
            );

            // Send failure notification
            if (DISCORD_WEBHOOK) {
              await DiscordConnect(DISCORD_WEBHOOK,
                `❌ **Call Failed (MongoDB Scheduler)**\n` +
                `📞 Phone: ${call.phoneNumber}\n` +
                `👤 Name: ${call.inviteeName || 'Unknown'}\n` +
                `📧 Email: ${call.inviteeEmail || 'Unknown'}\n` +
                `📆 Meeting: ${call.meetingTime}\n` +
                `❗ Error: ${result.error}\n` +
                `🔄 Attempts: ${updatedCall.attempts}/${updatedCall.maxAttempts}`
              );
            }
          } else {
            // Reset to pending for retry
            await ScheduledCallModel.updateOne(
              { _id: call._id },
              { 
                status: 'pending',
                errorMessage: result.error
              }
            );
            console.log(`🔄 [CallScheduler] Call will retry (attempt ${updatedCall.attempts}/${updatedCall.maxAttempts}):`, call.callId);
          }
        }
      } catch (error) {
        console.error('❌ [CallScheduler] Error processing call:', call.callId, error.message);
        
        // Reset to pending for retry
        await ScheduledCallModel.updateOne(
          { _id: call._id },
          { 
            status: 'pending',
            errorMessage: error.message
          }
        );
      }
    }

  } catch (error) {
    console.error('❌ [CallScheduler] Error in processDueCalls:', error.message);
  }
}

/**
 * Start the scheduler polling
 */
export function startScheduler() {
  if (isRunning) {
    console.log('ℹ️ [CallScheduler] Scheduler already running');
    return;
  }

  if (!twilioClient) {
    console.error('❌ [CallScheduler] Cannot start scheduler - Twilio not configured');
    return;
  }

  isRunning = true;
  console.log('🚀 [CallScheduler] Starting MongoDB-based call scheduler...');
  console.log(`⏱️ [CallScheduler] Polling interval: ${POLL_INTERVAL_MS / 1000} seconds`);

  // Initial check
  processDueCalls();

  // Start polling
  pollInterval = setInterval(processDueCalls, POLL_INTERVAL_MS);

  console.log('✅ [CallScheduler] Scheduler started successfully!');
}

/**
 * Stop the scheduler
 */
export function stopScheduler() {
  if (!isRunning) {
    return;
  }

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  isRunning = false;
  console.log('🛑 [CallScheduler] Scheduler stopped');
}

/**
 * Get scheduler stats
 */
export async function getSchedulerStats() {
  const [pending, processing, completed, failed, cancelled] = await Promise.all([
    ScheduledCallModel.countDocuments({ status: 'pending' }),
    ScheduledCallModel.countDocuments({ status: 'processing' }),
    ScheduledCallModel.countDocuments({ status: 'completed' }),
    ScheduledCallModel.countDocuments({ status: 'failed' }),
    ScheduledCallModel.countDocuments({ status: 'cancelled' })
  ]);

  return {
    isRunning,
    pollIntervalMs: POLL_INTERVAL_MS,
    counts: { pending, processing, completed, failed, cancelled, total: pending + processing + completed + failed + cancelled }
  };
}

/**
 * Get upcoming calls
 */
export async function getUpcomingCalls(limit = 20) {
  return await ScheduledCallModel.find({ status: 'pending' })
    .sort({ scheduledFor: 1 })
    .limit(limit)
    .lean();
}

export default {
  scheduleCall,
  cancelCall,
  startScheduler,
  stopScheduler,
  getSchedulerStats,
  getUpcomingCalls
};


import dotenv from 'dotenv';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { DiscordConnect } from './DiscordConnect.js';
import { Logger } from './Logger.js';
import watiService from './WatiService.js';
import { DateTime } from 'luxon';

dotenv.config();

const POLL_INTERVAL_MS = 30000; // Check every 30 seconds
const DISCORD_WEBHOOK = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
const DEFAULT_RESCHEDULE_LINK = 'https://www.google.com/url?q=https%3A%2F%2Fcalendly.com%2Freschedulings%2F8e172654-1dfa-49ae-944e-e260067a0f1f&sa=D&source=calendar&usd=2&usg=AOvVaw0_ea9AmvIBNwPqLl0HSU0g'; // Default reschedule link

let isRunning = false;
let pollInterval = null;


/**
 * Determine timezone abbreviation (ET/PST) from meeting time
 * Checks the UTC offset to determine if meeting is in ET or PST timezone
 * ET: UTC-5 (EST) or UTC-4 (EDT) 
 * PST: UTC-8 (PST) or UTC-7 (PDT)
 */
function getTimezoneAbbreviation(meetingStartISO) {
  try {
    const meetingStart = new Date(meetingStartISO);
    const meetingStartUTC = DateTime.fromJSDate(meetingStart, { zone: 'utc' });
    
    // Check PST timezone first (more specific offset)
    const meetingPST = meetingStartUTC.setZone('America/Los_Angeles');
    const pstOffset = meetingPST.offset / 60; // Offset in hours from UTC
    
    // PST is UTC-8 (PST) or UTC-7 (PDT)
    if (pstOffset === -8 || pstOffset === -7) {
      return 'PST';
    }
    
    // Check ET timezone
    const meetingET = meetingStartUTC.setZone('America/New_York');
    const etOffset = meetingET.offset / 60; // Offset in hours from UTC
    
    // ET is UTC-5 (EST) or UTC-4 (EDT)
    if (etOffset === -5 || etOffset === -4) {
      return 'ET';
    }
    
    // Default to ET if we can't determine (most common timezone for bookings)
    console.warn('⚠️ [WhatsAppReminderScheduler] Could not determine timezone from offset, defaulting to ET', {
      pstOffset,
      etOffset,
      meetingStartISO
    });
    return 'ET';
  } catch (error) {
    console.warn('⚠️ [WhatsAppReminderScheduler] Error determining timezone, defaulting to ET:', error.message);
    return 'ET'; // Default to ET
  }
}

/**
 * Schedule a WhatsApp reminder at a specific offset before a meeting
 * @param {Object} params - Reminder parameters
 * @param {number} params.reminderOffsetMinutes - Minutes before meeting (e.g., 5, 120, 1440)
 * @param {string} params.reminderType - Type label for Discord (e.g., "5min", "2h", "24h")
 */
export async function scheduleWhatsAppReminder({
  phoneNumber,
  meetingStartISO,
  meetingTime,
  meetingDate,
  clientName,
  clientEmail = null,
  meetingLink = null,
  rescheduleLink = null,
  source = 'calendly',
  metadata = {},
  timezone = null, // Optional: if not provided, will be determined from meetingStartISO
  reminderOffsetMinutes = 5, // Default to 5 minutes (backward compatibility)
  reminderType = '5min' // Default reminder type label
}) {
  try {
    // Validate phone number
    if (!phoneNumber || !/^\+?[1-9]\d{9,14}$/.test(phoneNumber)) {
      console.error('❌ [WhatsAppReminderScheduler] Invalid phone number:', phoneNumber);
      return { success: false, error: 'Invalid phone number' };
    }

    // Calculate reminder time (offset minutes before meeting)
    const meetingStart = new Date(meetingStartISO);
    const reminderTime = new Date(meetingStart.getTime() - reminderOffsetMinutes * 60 * 1000);
    
    // Don't schedule if reminder time is in the past
    if (reminderTime <= new Date()) {
      console.warn(`⚠️ [WhatsAppReminderScheduler] ${reminderType} reminder time is in the past, skipping:`, {
        phoneNumber,
        meetingStart: meetingStart.toISOString(),
        reminderTime: reminderTime.toISOString(),
        reminderType
      });
      return { success: false, error: 'Reminder time is in the past', skipped: true };
    }

    // Create unique reminder ID with reminder type
    const reminderId = `whatsapp_reminder_${reminderType}_${phoneNumber}_${meetingStart.getTime()}`;

    // Check if reminder already exists
    const existingReminder = await ScheduledWhatsAppReminderModel.findOne({ reminderId });
    if (existingReminder) {
      console.log(`ℹ️ [WhatsAppReminderScheduler] ${reminderType} reminder already scheduled:`, reminderId);
      return { success: true, reminderId, existing: true, scheduledFor: existingReminder.scheduledFor };
    }

    // Use default reschedule link if not provided
    const finalRescheduleLink = rescheduleLink || DEFAULT_RESCHEDULE_LINK;

    // Determine timezone if not provided
    const meetingTimezone = timezone || getTimezoneAbbreviation(meetingStartISO);

    // Create scheduled reminder
    const scheduledReminder = await ScheduledWhatsAppReminderModel.create({
      reminderId,
      phoneNumber,
      scheduledFor: reminderTime,
      meetingTime,
      meetingDate,
      meetingStartISO: meetingStart,
      clientName,
      clientEmail,
      meetingLink: meetingLink || 'Not Provided',
      rescheduleLink: finalRescheduleLink,
      timezone: meetingTimezone,
      source,
      metadata: {
        ...metadata,
        reminderType,
        reminderOffsetMinutes
      }
    });

    const delayMinutes = Math.round((reminderTime - new Date()) / 60000);
    const delayHours = Math.round(delayMinutes / 60);
    const delayDays = Math.round(delayHours / 24);
    
    // Format delay string for Discord
    let delayString = '';
    if (delayDays > 0) {
      delayString = `${delayDays}d ${delayHours % 24}h`;
    } else if (delayHours > 0) {
      delayString = `${delayHours}h ${delayMinutes % 60}m`;
    } else {
      delayString = `${delayMinutes}m`;
    }
    
    console.log(`✅ [WhatsAppReminderScheduler] ${reminderType} WhatsApp reminder scheduled:`, {
      reminderId,
      phoneNumber,
      scheduledFor: reminderTime.toISOString(),
      meetingTime,
      meetingDate,
      delayMinutes,
      reminderType
    });

    if (DISCORD_WEBHOOK) {
      await DiscordConnect(DISCORD_WEBHOOK, 
        `⏰ WA reminder scheduled: ${reminderType} (${source})\n` +
        `📞 ${phoneNumber} • ${clientName || 'Unknown'}\n` +
        `📧 ${clientEmail || 'Unknown'}\n` +
        `🗓️ ${meetingDate} @ ${meetingTime}\n` +
        `➡️ reminder at ${reminderTime.toISOString()}\n` +
        `🔗 join: ${meetingLink || 'n/a'} | resched: ${finalRescheduleLink || 'n/a'}\n` +
        `⏳ in ${delayString}`
      );
    }

    return { 
      success: true, 
      reminderId, 
      scheduledFor: reminderTime,
      delayMinutes,
      reminderType
    };

  } catch (error) {
    console.error(`❌ [WhatsAppReminderScheduler] Error scheduling ${reminderType} reminder:`, error);
    Logger.error(`[WhatsAppReminderScheduler] Error scheduling ${reminderType} reminder`, { error: error.message, phoneNumber });
    return { success: false, error: error.message };
  }
}

export async function scheduleAllWhatsAppReminders({
  phoneNumber,
  meetingStartISO,
  meetingTime,
  meetingDate,
  clientName,
  clientEmail = null,
  meetingLink = null,
  rescheduleLink = null,
  source = 'calendly',
  metadata = {},
  timezone = null
}) {
  const results = {
    'immediate': { success: false, skipped: false },
    '3h': { success: false, skipped: false },
    '5min': { success: false, skipped: false }
  };

  const meetingStart = new Date(meetingStartISO);
  const now = new Date();
  const hoursUntilMeeting = (meetingStart.getTime() - now.getTime()) / (1000 * 60 * 60);
  const minutesUntilMeeting = (meetingStart.getTime() - now.getTime()) / (1000 * 60);

  const immediateReminderTime = new Date(now.getTime() + 1 * 60 * 1000);
  const immediateReminderId = `whatsapp_reminder_immediate_${phoneNumber}_${meetingStart.getTime()}`;
  
  try {
    const existingImmediate = await ScheduledWhatsAppReminderModel.findOne({ reminderId: immediateReminderId });
    if (!existingImmediate) {
      const immediateReminder = await ScheduledWhatsAppReminderModel.create({
        reminderId: immediateReminderId,
        phoneNumber,
        scheduledFor: immediateReminderTime,
        meetingTime,
        meetingDate,
        meetingStartISO: meetingStart,
        clientName,
        clientEmail,
        meetingLink: meetingLink || 'Not Provided',
        rescheduleLink: rescheduleLink || DEFAULT_RESCHEDULE_LINK,
        timezone: timezone || getTimezoneAbbreviation(meetingStartISO),
        source,
        metadata: {
          ...metadata,
          isImmediateReminder: true,
          actualMeetingTime: meetingStartISO
        }
      });
      
      const delayMinutes = Math.round((immediateReminderTime - now) / 60000);
      
      console.log('✅ [WhatsAppReminderScheduler] Immediate WhatsApp reminder scheduled:', {
        reminderId: immediateReminderId,
        phoneNumber,
        scheduledFor: immediateReminderTime.toISOString(),
        meetingTime,
        meetingDate,
        delayMinutes
      });
      
      if (DISCORD_WEBHOOK) {
        await DiscordConnect(DISCORD_WEBHOOK, 
          `⏰ WA reminder scheduled: immediate (${source})\n` +
          `📞 ${phoneNumber} • ${clientName || 'Unknown'}\n` +
          `📧 ${clientEmail || 'Unknown'}\n` +
          `🗓️ ${meetingDate} @ ${meetingTime}\n` +
          `➡️ reminder at ${immediateReminderTime.toISOString()}\n` +
          `⏳ in ${delayMinutes}m`
        );
      }
      
      results['immediate'] = { success: true, reminderId: immediateReminderId, scheduledFor: immediateReminderTime };
    } else {
      results['immediate'] = { success: true, reminderId: immediateReminderId, existing: true };
    }
  } catch (error) {
    console.error('❌ [WhatsAppReminderScheduler] Error scheduling immediate reminder:', error);
    results['immediate'] = { success: false, error: error.message };
  }

  if (hoursUntilMeeting > 3) {
    const result3h = await scheduleWhatsAppReminder({
      phoneNumber,
      meetingStartISO,
      meetingTime,
      meetingDate,
      clientName,
      clientEmail,
      meetingLink,
      rescheduleLink,
      source,
      metadata,
      timezone,
      reminderOffsetMinutes: 3 * 60,
      reminderType: '3h'
    });
    results['3h'] = result3h;
  } else {
    console.log(`⏭️ [WhatsAppReminderScheduler] Skipping 3h reminder - meeting is ${hoursUntilMeeting.toFixed(1)}h away (< 3h)`);
    results['3h'] = { success: false, skipped: true, reason: `Meeting is only ${hoursUntilMeeting.toFixed(1)}h away` };
    
    if (DISCORD_WEBHOOK) {
      await DiscordConnect(DISCORD_WEBHOOK,
        `⏭️ WA reminder skipped: 3h\n` +
        `📞 ${phoneNumber} • ${clientName || 'Unknown'}\n` +
        `📧 ${clientEmail || 'Unknown'}\n` +
        `🗓️ ${meetingDate} @ ${meetingTime}\n` +
        `⚠️ Meeting is only ${hoursUntilMeeting.toFixed(1)}h away (booked within 3h)`
      );
    }
  }

  if (minutesUntilMeeting > 5) {
    const result5min = await scheduleWhatsAppReminder({
      phoneNumber,
      meetingStartISO,
      meetingTime,
      meetingDate,
      clientName,
      clientEmail,
      meetingLink,
      rescheduleLink,
      source,
      metadata,
      timezone,
      reminderOffsetMinutes: 5,
      reminderType: '5min'
    });
    results['5min'] = result5min;
  } else {
    console.log(`⏭️ [WhatsAppReminderScheduler] Skipping 5min reminder - meeting is ${minutesUntilMeeting.toFixed(1)}m away (< 5min)`);
    results['5min'] = { success: false, skipped: true, reason: `Meeting is only ${minutesUntilMeeting.toFixed(1)}m away` };
    
    if (DISCORD_WEBHOOK) {
      await DiscordConnect(DISCORD_WEBHOOK,
        `⏭️ WA reminder skipped: 5min\n` +
        `📞 ${phoneNumber} • ${clientName || 'Unknown'}\n` +
        `📧 ${clientEmail || 'Unknown'}\n` +
        `🗓️ ${meetingDate} @ ${meetingTime}\n` +
        `⚠️ Meeting is only ${minutesUntilMeeting.toFixed(1)}m away (< 5min)`
      );
    }
  }

  if (DISCORD_WEBHOOK) {
    const scheduledCount = Object.values(results).filter(r => r.success).length;
    const skippedCount = Object.values(results).filter(r => r.skipped).length;
    
    await DiscordConnect(DISCORD_WEBHOOK,
      `📋 WA Reminders Summary (${source})\n` +
      `📞 ${phoneNumber} • ${clientName || 'Unknown'}\n` +
      `📧 ${clientEmail || 'Unknown'}\n` +
      `🗓️ ${meetingDate} @ ${meetingTime}\n` +
      `✅ Scheduled: ${scheduledCount}/3\n` +
      `   • Immediate: ${results['immediate'].success ? '✅' : (results['immediate'].skipped ? '⏭️ Skipped' : '❌ Failed')}\n` +
      `   • 3h: ${results['3h'].success ? '✅' : (results['3h'].skipped ? '⏭️ Skipped' : '❌ Failed')}\n` +
      `   • 5min: ${results['5min'].success ? '✅' : (results['5min'].skipped ? '⏭️ Skipped' : '❌ Failed')}`
    );
  }

  return results;
}

/**
 * Cancel a scheduled WhatsApp reminder by phoneNumber and meetingStartISO
 * Cancels all reminder types (24h, 2h, 5min) for the meeting
 */
export async function cancelWhatsAppReminder({ phoneNumber, meetingStartISO }) {
  try {
    const meetingStart = new Date(meetingStartISO);
    
    const reminderTypes = ['immediate', '3h', '5min'];
    const cancelledReminders = [];
    
    for (const reminderType of reminderTypes) {
      const reminderId = `whatsapp_reminder_${reminderType}_${phoneNumber}_${meetingStart.getTime()}`;
      
      const result = await ScheduledWhatsAppReminderModel.findOneAndUpdate(
        { reminderId, status: 'pending' },
        { status: 'cancelled' },
        { new: true }
      );

      if (result) {
        cancelledReminders.push({ reminderType, reminderId });
        console.log(`✅ [WhatsAppReminderScheduler] ${reminderType} reminder cancelled:`, reminderId);
      }
    }

    if (cancelledReminders.length > 0) {
      // Send Discord notification
      if (DISCORD_WEBHOOK) {
        await DiscordConnect(DISCORD_WEBHOOK,
          `🚫 **WhatsApp Reminders Cancelled**\n` +
          `📞 Phone: ${phoneNumber}\n` +
          `📅 Meeting: ${meetingStart.toISOString()}\n` +
          `❌ Cancelled: ${cancelledReminders.length} reminder(s)\n` +
          `📝 Types: ${cancelledReminders.map(r => r.reminderType).join(', ')}`
        );
      }
      
      return { success: true, cancelledCount: cancelledReminders.length, cancelledReminders };
    } else {
      console.log('ℹ️ [WhatsAppReminderScheduler] No pending reminders found to cancel');
      return { success: false, error: 'No reminders found or already processed' };
    }
  } catch (error) {
    console.error('❌ [WhatsAppReminderScheduler] Error cancelling reminder:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Cancel all scheduled WhatsApp reminders for a client (by email or phoneNumber)
 * Used when booking status changes to "paid" or "canceled"
 */
export async function cancelWhatsAppRemindersForClient({ clientEmail = null, phoneNumber = null, meetingStartISO = null }) {
  try {
    const query = {
      status: { $in: ['pending', 'processing'] } // Only cancel pending or processing reminders
    };

    // Build query based on available parameters
    if (clientEmail) {
      query.clientEmail = clientEmail.toLowerCase().trim();
    }
    if (phoneNumber) {
      query.phoneNumber = phoneNumber;
    }
    if (meetingStartISO) {
      query.meetingStartISO = new Date(meetingStartISO);
    }

    // Find all matching reminders
    const reminders = await ScheduledWhatsAppReminderModel.find(query);

    if (reminders.length === 0) {
      console.log('ℹ️ [WhatsAppReminderScheduler] No pending reminders found to cancel for client:', { clientEmail, phoneNumber });
      return { success: true, cancelledCount: 0, message: 'No reminders found' };
    }

    // Cancel all matching reminders
    const updateResult = await ScheduledWhatsAppReminderModel.updateMany(
      query,
      { 
        status: 'cancelled',
        errorMessage: 'Cancelled: Booking status changed to paid'
      }
    );

    const cancelledCount = updateResult.modifiedCount;

    console.log(`✅ [WhatsAppReminderScheduler] Cancelled ${cancelledCount} reminder(s) for client:`, { clientEmail, phoneNumber });

    // Send Discord notification if reminders were cancelled
    if (cancelledCount > 0 && DISCORD_WEBHOOK) {
      await DiscordConnect(DISCORD_WEBHOOK,
        `🚫 **WhatsApp Reminders Cancelled**\n` +
        `📧 Email: ${clientEmail || 'Unknown'}\n` +
        `📞 Phone: ${phoneNumber || 'Unknown'}\n` +
        `❌ Cancelled: ${cancelledCount} reminder(s)\n` +
        `📝 Reason: Booking status changed to paid`
      );
    }

    return { 
      success: true, 
      cancelledCount,
      reminderIds: reminders.map(r => r.reminderId)
    };

  } catch (error) {
    console.error('❌ [WhatsAppReminderScheduler] Error cancelling reminders for client:', error);
    Logger.error('[WhatsAppReminderScheduler] Error cancelling reminders for client', { 
      error: error.message, 
      clientEmail, 
      phoneNumber 
    });
    return { success: false, error: error.message };
  }
}

/**
 * Send the actual WhatsApp message using WATI template
 */
async function sendWhatsAppMessage(scheduledReminder) {
  const { phoneNumber, clientName, meetingDate, meetingTime, meetingLink, rescheduleLink, reminderId, timezone } = scheduledReminder;

  try {
    if (!watiService) {
      throw new Error('WATI service not initialized');
    }

    // Template name
    const templateName = 'flashfire_appointment_reminder';
    
    // Format meeting time with timezone: "4pm - 4:15pm ET" or "4pm - 4:15pm PST"
    const meetingTimeWithTimezone = timezone ? `${meetingTime} ${timezone}` : meetingTime;
    
    // Template parameters: {{1}} = name, {{2}} = date, {{3}} = time with timezone, {{4}} = meeting link, {{5}} = reschedule link
    const parameters = [
      clientName || 'Valued Client', // {{1}}
      meetingDate, // {{2}}
      meetingTimeWithTimezone, // {{3}} - now includes timezone (e.g., "4pm - 4:15pm ET")
      meetingLink || 'Not Provided', // {{4}}
      rescheduleLink || DEFAULT_RESCHEDULE_LINK // {{5}}
    ];

    // Send template message via WATI
    const result = await watiService.sendTemplateMessage({
      mobileNumber: phoneNumber,
      templateName: templateName,
      parameters: parameters,
      campaignId: `reminder_${reminderId}_${Date.now()}`
    });

    if (result.success) {
      console.log('✅ [WhatsAppReminderScheduler] WhatsApp message sent:', {
        reminderId,
        phoneNumber,
        templateName,
        watiResponse: result.data
      });

      return { success: true, watiResponse: result.data };
    } else {
      throw new Error(result.error || 'Failed to send WhatsApp message');
    }

  } catch (error) {
    console.error('❌ [WhatsAppReminderScheduler] Error sending WhatsApp message:', {
      reminderId,
      phoneNumber,
      error: error.message
    });
    return { success: false, error: error.message };
  }
}

/**
 * Process due WhatsApp reminders - called by the polling mechanism
 */
export async function processDueWhatsAppReminders() {
  try {
    const now = new Date();

    // Find all pending reminders that are due
    const dueReminders = await ScheduledWhatsAppReminderModel.find({
      status: 'pending',
      scheduledFor: { $lte: now },
      attempts: { $lt: 3 } // Max 3 attempts
    }).limit(10); // Process max 10 at a time

    if (dueReminders.length === 0) {
      return;
    }

    console.log(`📱 [WhatsAppReminderScheduler] Processing ${dueReminders.length} due reminder(s)...`);

    for (const reminder of dueReminders) {
      try {
        // Mark as processing
        await ScheduledWhatsAppReminderModel.updateOne(
          { _id: reminder._id },
          { 
            status: 'processing',
            processedAt: new Date(),
            $inc: { attempts: 1 }
          }
        );

        // Send the WhatsApp message
        const result = await sendWhatsAppMessage(reminder);

        if (result.success) {
          // Mark as completed
          await ScheduledWhatsAppReminderModel.updateOne(
            { _id: reminder._id },
            { 
              status: 'completed',
              completedAt: new Date(),
              watiResponse: result.watiResponse
            }
          );

          // Send success notification to Discord
          if (DISCORD_WEBHOOK) {
            const reminderType = reminder.metadata?.reminderType || '5min';
            await DiscordConnect(DISCORD_WEBHOOK,
              `✅ WA reminder sent: ${reminderType}\n` +
              `📞 ${reminder.phoneNumber} • ${reminder.clientName || 'Unknown'}\n` +
              `📧 ${reminder.clientEmail || 'Unknown'}\n` +
              `🗓️ ${reminder.meetingDate} @ ${reminder.meetingTime}\n` +
              `🔗 join: ${reminder.meetingLink || 'n/a'} | resched: ${reminder.rescheduleLink || 'n/a'}\n` +
              `⏰ ${new Date().toISOString()}`
            );
          }
        } else {
          // Check if we should retry
          const updatedReminder = await ScheduledWhatsAppReminderModel.findById(reminder._id);
          
          if (updatedReminder.attempts >= updatedReminder.maxAttempts) {
            // Max attempts reached, mark as failed
            await ScheduledWhatsAppReminderModel.updateOne(
              { _id: reminder._id },
              { 
                status: 'failed',
                errorMessage: result.error
              }
            );

            // Send failure notification
            if (DISCORD_WEBHOOK) {
              const reminderType = reminder.metadata?.reminderType || '5min';
              await DiscordConnect(DISCORD_WEBHOOK,
                `❌ WA reminder failed: ${reminderType}\n` +
                `📞 ${reminder.phoneNumber} • ${reminder.clientName || 'Unknown'}\n` +
                `📧 ${reminder.clientEmail || 'Unknown'}\n` +
                `🗓️ ${reminder.meetingDate} @ ${reminder.meetingTime}\n` +
                `⚠️ ${result.error}\n` +
                `🔄 ${updatedReminder.attempts}/${updatedReminder.maxAttempts}`
              );
            }
          } else {
            // Reset to pending for retry
            await ScheduledWhatsAppReminderModel.updateOne(
              { _id: reminder._id },
              { 
                status: 'pending',
                errorMessage: result.error
              }
            );
            console.log(`🔄 [WhatsAppReminderScheduler] Reminder will retry (attempt ${updatedReminder.attempts}/${updatedReminder.maxAttempts}):`, reminder.reminderId);
          }
        }
      } catch (error) {
        console.error('❌ [WhatsAppReminderScheduler] Error processing reminder:', reminder.reminderId, error.message);
        
        // Reset to pending for retry
        await ScheduledWhatsAppReminderModel.updateOne(
          { _id: reminder._id },
          { 
            status: 'pending',
            errorMessage: error.message
          }
        );
      }
    }

  } catch (error) {
    console.error('❌ [WhatsAppReminderScheduler] Error in processDueWhatsAppReminders:', error.message);
  }
}

/**
 * Start the scheduler polling
 */
export function startWhatsAppReminderScheduler() {
  if (isRunning) {
    console.log('ℹ️ [WhatsAppReminderScheduler] Scheduler already running');
    return;
  }

  isRunning = true;
  console.log('🚀 [WhatsAppReminderScheduler] Starting MongoDB-based WhatsApp reminder scheduler...');
  console.log(`⏱️ [WhatsAppReminderScheduler] Polling interval: ${POLL_INTERVAL_MS / 1000} seconds`);

  // Initial check
  processDueWhatsAppReminders();

  // Start polling
  pollInterval = setInterval(processDueWhatsAppReminders, POLL_INTERVAL_MS);

  console.log('✅ [WhatsAppReminderScheduler] Scheduler started successfully!');
}

/**
 * Stop the scheduler
 */
export function stopWhatsAppReminderScheduler() {
  if (!isRunning) {
    return;
  }

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }

  isRunning = false;
  console.log('🛑 [WhatsAppReminderScheduler] Scheduler stopped');
}

/**
 * Get scheduler stats
 */
export async function getWhatsAppReminderSchedulerStats() {
  const [pending, processing, completed, failed, cancelled] = await Promise.all([
    ScheduledWhatsAppReminderModel.countDocuments({ status: 'pending' }),
    ScheduledWhatsAppReminderModel.countDocuments({ status: 'processing' }),
    ScheduledWhatsAppReminderModel.countDocuments({ status: 'completed' }),
    ScheduledWhatsAppReminderModel.countDocuments({ status: 'failed' }),
    ScheduledWhatsAppReminderModel.countDocuments({ status: 'cancelled' })
  ]);

  return {
    isRunning,
    pollIntervalMs: POLL_INTERVAL_MS,
    counts: { pending, processing, completed, failed, cancelled, total: pending + processing + completed + failed + cancelled }
  };
}

/**
 * Get upcoming reminders
 */
export async function getUpcomingWhatsAppReminders(limit = 20) {
  return await ScheduledWhatsAppReminderModel.find({ status: 'pending' })
    .sort({ scheduledFor: 1 })
    .limit(limit)
    .lean();
}

export default {
  scheduleWhatsAppReminder,
  scheduleAllWhatsAppReminders,
  cancelWhatsAppReminder,
  cancelWhatsAppRemindersForClient,
  startWhatsAppReminderScheduler,
  stopWhatsAppReminderScheduler,
  getWhatsAppReminderSchedulerStats,
  getUpcomingWhatsAppReminders
};


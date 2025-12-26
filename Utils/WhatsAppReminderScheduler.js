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
 * Schedule a WhatsApp reminder 5 minutes before a meeting
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
  metadata = {}
}) {
  try {
    // Validate phone number
    if (!phoneNumber || !/^\+?[1-9]\d{9,14}$/.test(phoneNumber)) {
      console.error('❌ [WhatsAppReminderScheduler] Invalid phone number:', phoneNumber);
      return { success: false, error: 'Invalid phone number' };
    }

    // Calculate reminder time (5 minutes before meeting)
    const meetingStart = new Date(meetingStartISO);
    const reminderTime = new Date(meetingStart.getTime() - 5 * 60 * 1000);
    
    // Don't schedule if reminder time is in the past
    if (reminderTime <= new Date()) {
      console.warn('⚠️ [WhatsAppReminderScheduler] Reminder time is in the past, skipping:', {
        phoneNumber,
        meetingStart: meetingStart.toISOString(),
        reminderTime: reminderTime.toISOString()
      });
      return { success: false, error: 'Reminder time is in the past' };
    }

    // Create unique reminder ID
    const reminderId = `whatsapp_reminder_${phoneNumber}_${meetingStart.getTime()}`;

    // Check if reminder already exists
    const existingReminder = await ScheduledWhatsAppReminderModel.findOne({ reminderId });
    if (existingReminder) {
      console.log('ℹ️ [WhatsAppReminderScheduler] Reminder already scheduled:', reminderId);
      return { success: true, reminderId, existing: true, scheduledFor: existingReminder.scheduledFor };
    }

    // Use default reschedule link if not provided
    const finalRescheduleLink = rescheduleLink || DEFAULT_RESCHEDULE_LINK;

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
      source,
      metadata
    });

    const delayMinutes = Math.round((reminderTime - new Date()) / 60000);
    
    console.log('✅ [WhatsAppReminderScheduler] WhatsApp reminder scheduled:', {
      reminderId,
      phoneNumber,
      scheduledFor: reminderTime.toISOString(),
      meetingTime,
      meetingDate,
      delayMinutes
    });

    if (DISCORD_WEBHOOK) {
      await DiscordConnect(DISCORD_WEBHOOK, 
        `⏰ WA reminder scheduled (${source})\n` +
        `📞 ${phoneNumber} • ${clientName || 'Unknown'}\n` +
        `📧 ${clientEmail || 'Unknown'}\n` +
        `🗓️ ${meetingDate} @ ${meetingTime}\n` +
        `➡️ reminder at ${reminderTime.toISOString()}\n` +
        `🔗 join: ${meetingLink || 'n/a'} | resched: ${finalRescheduleLink || 'n/a'}\n` +
        `⏳ in ${delayMinutes}m`
      );
    }

    return { 
      success: true, 
      reminderId, 
      scheduledFor: reminderTime,
      delayMinutes 
    };

  } catch (error) {
    console.error('❌ [WhatsAppReminderScheduler] Error scheduling reminder:', error);
    Logger.error('[WhatsAppReminderScheduler] Error scheduling reminder', { error: error.message, phoneNumber });
    return { success: false, error: error.message };
  }
}

/**
 * Cancel a scheduled WhatsApp reminder by phoneNumber and meetingStartISO
 */
export async function cancelWhatsAppReminder({ phoneNumber, meetingStartISO }) {
  try {
    const meetingStart = new Date(meetingStartISO);
    const reminderId = `whatsapp_reminder_${phoneNumber}_${meetingStart.getTime()}`;

    const result = await ScheduledWhatsAppReminderModel.findOneAndUpdate(
      { reminderId, status: 'pending' },
      { status: 'cancelled' },
      { new: true }
    );

    if (result) {
      console.log('✅ [WhatsAppReminderScheduler] Reminder cancelled:', reminderId);
      return { success: true, reminderId };
    } else {
      console.log('ℹ️ [WhatsAppReminderScheduler] No pending reminder found to cancel:', reminderId);
      return { success: false, error: 'Reminder not found or already processed' };
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
  const { phoneNumber, clientName, meetingDate, meetingTime, meetingLink, rescheduleLink, reminderId } = scheduledReminder;

  try {
    if (!watiService) {
      throw new Error('WATI service not initialized');
    }

    // Template name
    const templateName = 'flashfire_appointment_reminder';
    
    // Template parameters: {{1}} = name, {{2}} = date, {{3}} = time, {{4}} = meeting link, {{5}} = reschedule link
    const parameters = [
      clientName || 'Valued Client', // {{1}}
      meetingDate, // {{2}}
      meetingTime, // {{3}}
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
            await DiscordConnect(DISCORD_WEBHOOK,
              `✅ WA reminder sent\n` +
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
              await DiscordConnect(DISCORD_WEBHOOK,
                `❌ WA reminder failed\n` +
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
  cancelWhatsAppReminder,
  cancelWhatsAppRemindersForClient,
  startWhatsAppReminderScheduler,
  stopWhatsAppReminderScheduler,
  getWhatsAppReminderSchedulerStats,
  getUpcomingWhatsAppReminders
};


import cron from 'node-cron';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import sgMail from '@sendgrid/mail';
import watiService from './WatiService.js';
import { EmailCampaignModel } from '../Schema_Models/EmailCampaign.js';
import { DateTime } from 'luxon';
import { scheduleEmailBatch, scheduleWhatsAppBatch } from './JobScheduler.js';
import { buildTemplateParameters } from './TemplateParameterBuilder.js';
import { safeErrorDetails } from './safeErrorDetails.js';
import { sendgridCircuitBreaker } from './CircuitBreaker.js';
import { clientHasPaidBooking } from '../Controllers/WorkflowController.js';

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

const IST_TIMEZONE = 'Asia/Kolkata';
const SEND_HOUR = 19; // 7 PM IST (for backward compatibility with campaigns)
const SEND_MINUTE = 30;

// WhatsApp workflow timing: 11 PM IST
const WHATSAPP_WORKFLOW_HOUR = 23;
const WHATSAPP_WORKFLOW_MINUTE = 0;

// Email workflow timing: Random between 8-10 PM IST
const EMAIL_WORKFLOW_START_HOUR = 20; // 8 PM IST
const EMAIL_WORKFLOW_END_HOUR = 22; // 10 PM IST

function getIST730PM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: SEND_HOUR, minute: SEND_MINUTE, second: 0, millisecond: 0 }).toJSDate();
}

function getIST10AM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: 10, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

/**
 * Get WhatsApp workflow send time: 11 PM IST
 */
function getIST11PM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: WHATSAPP_WORKFLOW_HOUR, minute: WHATSAPP_WORKFLOW_MINUTE, second: 0, millisecond: 0 }).toJSDate();
}

/**
 * Get Email workflow send time: Random between 8-10 PM IST
 * Uses a deterministic random based on bookingId to ensure same time for same booking
 */
function getISTEmailWindow(date, bookingId = null) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  
  // Generate deterministic random hour between 20-22 (8-10 PM) based on bookingId or date
  let seed = bookingId ? bookingId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) : date.getTime();
  const randomHour = EMAIL_WORKFLOW_START_HOUR + (seed % (EMAIL_WORKFLOW_END_HOUR - EMAIL_WORKFLOW_START_HOUR + 1));
  
  // Random minute between 0-59
  const randomMinute = seed % 60;
  
  return istDate.set({ hour: randomHour, minute: randomMinute, second: 0, millisecond: 0 }).toJSDate();
}

/**
 * Calculate scheduled date for workflows based on channel type
 * @param {Date} triggerDate - The date to calculate from
 * @param {number} daysAfter - Days after trigger date
 * @param {string} channel - 'email' or 'whatsapp' (for workflows)
 * @param {string} bookingId - Optional booking ID for deterministic email timing
 * @param {number} hoursAfter - Hours after trigger date (added on top of days)
 */
function calculateScheduledDate(triggerDate, daysAfter, channel = null, bookingId = null, hoursAfter = 0) {
  const targetDate = new Date(triggerDate);
  targetDate.setDate(targetDate.getDate() + daysAfter);

  // If hoursAfter is set, use exact time scheduling (no window-based)
  if (hoursAfter > 0) {
    targetDate.setTime(targetDate.getTime() + (hoursAfter * 60 * 60 * 1000));
    return targetDate;
  }

  if (channel === 'whatsapp') {
    return getIST11PM(targetDate);
  } else if (channel === 'email') {
    return getISTEmailWindow(targetDate, bookingId);
  }

  // Default: 7:30 PM IST (for backward compatibility with campaigns)
  return getIST730PM(targetDate);
}

export async function executeWorkflowLog(log) {
  try {
    const booking = await CampaignBookingModel.findOne({ bookingId: log.bookingId }).lean();
    if (!booking) {
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        { 
          $set: { 
            status: 'failed',
            error: 'Booking not found',
            executedAt: new Date()
          }
        }
      );
      return;
    }

    // STRICT: Never execute workflows for paid clients (safety check at execution time)
    if (booking.bookingStatus === 'paid') {
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        { 
          $set: { 
            status: 'cancelled',
            error: 'Skipped: Client is marked as paid - workflows are not sent to paid clients',
            executedAt: new Date()
          }
        }
      );
      console.log(`⏭️ Skipped workflow log ${log.logId}: booking ${log.bookingId} is paid`);
      return;
    }
    const hasPaid = await clientHasPaidBooking(booking.clientEmail, booking.clientPhone);
    if (hasPaid) {
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        { 
          $set: { 
            status: 'cancelled',
            error: 'Skipped: Client has paid booking - workflows are not sent to paid clients',
            executedAt: new Date()
          }
        }
      );
      console.log(`⏭️ Skipped workflow log ${log.logId}: client has paid booking elsewhere`);
      return;
    }

    if (log.step.channel === 'email') {
      if (!booking.clientEmail) {
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          { $set: { status: 'failed', error: 'Client email not available', executedAt: new Date() } }
        );
        return;
      }
      const domainName = log.step.domainName || 'flashfiremails.com';
      let senderEmail = log.step.senderEmail || process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';

      const msg = {
        to: booking.clientEmail,
        from: senderEmail,
        templateId: log.step.templateId,
        dynamicTemplateData: {
          domain: domainName,
          clientName: booking.clientName,
          bookingId: booking.bookingId
        }
      };

      const result = await sendgridCircuitBreaker.execute(() => sgMail.send(msg));
      const responseData = { statusCode: result[0]?.statusCode, messageId: result[0]?.headers?.['x-message-id'] };

      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'executed',
            executedAt: new Date(),
            responseData
          }
        }
      );

      console.log(`✅ Workflow email sent: ${log.logId} to ${booking.clientEmail}`);
    } else if (log.step.channel === 'whatsapp') {
      if (!booking.clientPhone) {
        await WorkflowLogModel.updateOne(
          { logId: log.logId },
          {
            $set: {
              status: 'failed',
              error: 'Client phone number not available',
              executedAt: new Date()
            }
          }
        );
        return;
      }

      // Resolve the actual WATI template name from ID if templateName is missing
      // This ensures buildTemplateParameters gets the real name (e.g., "meta_2") not the ID
      let resolvedTemplateName = log.step.templateName;
      if (!resolvedTemplateName && log.step.templateId) {
        try {
          resolvedTemplateName = await watiService.resolveTemplateName(null, log.step.templateId);
          console.log(`[cronScheduler] Resolved template ID ${log.step.templateId} → name: ${resolvedTemplateName}`);
        } catch (resolveErr) {
          console.warn(`[cronScheduler] Could not resolve template ID ${log.step.templateId}:`, resolveErr.message);
          resolvedTemplateName = log.step.templateId; // fallback
        }
      }

      const parameters = await buildTemplateParameters(resolvedTemplateName || log.step.templateId, {
        booking,
        step: log.step,
        executedAt: new Date()
      });

      const result = await watiService.sendTemplateMessage({
        mobileNumber: booking.clientPhone,
        templateId: log.step.templateId,
        templateName: resolvedTemplateName,
        parameters,
        campaignId: `workflow_${log.workflowId}_${Date.now()}`
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to send WhatsApp message');
      }

      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'executed',
            executedAt: new Date(),
            responseData: result.data
          }
        }
      );

      console.log(`✅ Workflow WhatsApp sent: ${log.logId} to ${booking.clientPhone}`);
    }
  } catch (error) {
    console.error(`[cronScheduler] Error executing workflow log ${log.logId}:`, error.message);

    const isCircuitBreakerError = error.message?.includes('Circuit breaker');
    const currentAttempts = isCircuitBreakerError
      ? (log.attempts || 0)  // Don't count circuit breaker blocks as real attempts
      : (log.attempts || 0) + 1;
    const maxAttempts = log.maxAttempts || 3;

    if (currentAttempts < maxAttempts) {
      // Circuit breaker errors: retry in 2 minutes (service might be back)
      // Other errors: exponential backoff — 5min, 20min, 80min
      const delayMs = isCircuitBreakerError
        ? 2 * 60 * 1000
        : Math.pow(4, currentAttempts) * 5 * 60 * 1000;
      const nextRetry = new Date(Date.now() + delayMs);

      console.log(`[cronScheduler] Retry ${currentAttempts}/${maxAttempts} for ${log.logId}, next at ${nextRetry.toISOString()}`);

      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'scheduled',
            scheduledFor: nextRetry,
            error: `Attempt ${currentAttempts} failed: ${error.message}`,
            errorDetails: safeErrorDetails(error),
            attempts: currentAttempts
          }
        }
      );
    } else {
      // Max retries exhausted — mark as permanently failed
      await WorkflowLogModel.updateOne(
        { logId: log.logId },
        {
          $set: {
            status: 'failed',
            error: error.message,
            errorDetails: safeErrorDetails(error),
            executedAt: new Date(),
            attempts: currentAttempts
          }
        }
      );
    }
  }
}

export async function executeScheduledEmailCampaign(campaign, scheduleItem) {
  try {
    const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === scheduleItem.day);
    if (scheduleIndex === -1) return;

    campaign.sendSchedule[scheduleIndex].status = 'processing';
    await campaign.save();

    let senderEmail = campaign.senderEmail;
    if (!senderEmail) {
      const stepDomainName = campaign.domainName || process.env.DOMAIN_NAME || null;
      if (stepDomainName) {
        senderEmail = `elizabeth@${stepDomainName}`;
      } else {
        senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      }
    }

    const normalizedEmails = campaign.recipientEmails
      .map(email => email.trim().toLowerCase())
      .filter(email => email.length > 0);

    const existingBookings = await CampaignBookingModel.find({
      clientEmail: { $in: normalizedEmails },
      bookingStatus: { $in: ['scheduled', 'completed'] }
    }).select('clientEmail').lean();

    const bookedEmails = new Set(existingBookings.map(b => b.clientEmail));
    
    const validRecipients = [];
    const skippedEmails = [];
    
    for (const email of normalizedEmails) {
      if (bookedEmails.has(email)) {
        skippedEmails.push({
          email: email,
          reason: 'User has booking',
          skippedAt: new Date()
        });
      } else {
        validRecipients.push(email);
      }
    }

    // Use JobScheduler to schedule emails with time spreading (over 1 hour)
    // This will spread the emails evenly and process only 3 at a time
    if (validRecipients.length > 0) {
      const schedulingResult = await scheduleEmailBatch({
        recipients: validRecipients,
        templateId: campaign.templateId,
        templateName: campaign.templateName,
        domainName: campaign.domainName,
        senderEmail,
        scheduledStartTime: new Date(), // Start immediately, will spread over 1 hour
        campaignId: campaign._id?.toString(),
        dynamicTemplateData: {
          domain: campaign.domainName
        }
      });

      if (schedulingResult.success) {
        console.log(`✅ [CronScheduler] Scheduled ${validRecipients.length} emails with time spreading over ${schedulingResult.spreadMinutes} minutes`);
        
        campaign.logs.push({
          timestamp: new Date(),
          level: 'info',
          message: `Scheduled ${validRecipients.length} emails with time spreading`,
          details: {
            sendDay: scheduleItem.day,
            totalRecipients: validRecipients.length,
            skipped: skippedEmails.length,
            batchId: schedulingResult.batchId,
            spreadMinutes: schedulingResult.spreadMinutes,
            firstSendTime: schedulingResult.firstSendTime,
            lastSendTime: schedulingResult.lastSendTime
          }
        });
      } else {
        throw new Error(schedulingResult.error || 'Failed to schedule emails');
      }
    }

    // Mark as processing (actual completion will be tracked by JobScheduler)
    // We don't mark as completed yet since emails will be sent over time
    campaign.sendSchedule[scheduleIndex].status = 'processing';
    campaign.sendSchedule[scheduleIndex].skippedCount = skippedEmails.length;

    campaign.logs.push({
      timestamp: new Date(),
      level: 'success',
      message: `Queued email send for day ${scheduleItem.day} with time spreading`,
      details: {
        sendDay: scheduleItem.day,
        queued: validRecipients.length,
        skipped: skippedEmails.length,
        note: 'Emails will be sent over 1 hour with 3 concurrent max'
      }
    });

    await campaign.save();
    console.log(`✅ Scheduled email campaign ${campaign._id} day ${scheduleItem.day} queued (${validRecipients.length} emails over 1 hour)`);
  } catch (error) {
    console.error(`❌ Error executing scheduled email campaign:`, error);
    const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === scheduleItem.day);
    if (scheduleIndex !== -1) {
      campaign.sendSchedule[scheduleIndex].status = 'failed';
      campaign.logs.push({
        timestamp: new Date(),
        level: 'error',
        message: `Failed to execute day ${scheduleItem.day}`,
        details: { error: error.message }
      });
      await campaign.save();
    }
  }
}

export async function executeWhatsAppCampaign(campaign) {
  try {
    const campaignId = campaign.campaignId || campaign._id?.toString();
    if (!campaignId) return;

    const campaignDoc = await WhatsAppCampaignModel.findOne({ campaignId });
    if (!campaignDoc) return;

    const pendingMessages = campaignDoc.messageStatuses.filter(
      msg => msg.status === 'pending' || msg.status === 'scheduled'
    );

    if (pendingMessages.length === 0) return;

    const now = new Date();
    const dueMessages = pendingMessages.filter(msg => {
      if (msg.sendDay === 0) return true;
      if (!msg.scheduledSendDate) return false;
      return new Date(msg.scheduledSendDate) <= now;
    });

    if (dueMessages.length === 0) return;

    const dayGroups = {};
    dueMessages.forEach(msg => {
      if (!dayGroups[msg.sendDay]) {
        dayGroups[msg.sendDay] = [];
      }
      dayGroups[msg.sendDay].push(msg.mobileNumber);
    });

    const nextDay = Math.min(...Object.keys(dayGroups).map(Number));
    const mobilesToSend = dayGroups[nextDay];

    campaignDoc.status = 'IN_PROGRESS';
    await campaignDoc.save();

    // Use JobScheduler to schedule WhatsApp messages with time spreading
    // This will spread messages over 1 hour and process sequentially
    if (mobilesToSend.length > 0) {
      const schedulingResult = await scheduleWhatsAppBatch({
        mobileNumbers: mobilesToSend,
        templateName: campaignDoc.templateName,
        templateId: campaignDoc.templateId,
        parameters: Array.isArray(campaignDoc.parameters) ? campaignDoc.parameters : [],
        scheduledStartTime: new Date(),
        campaignId: campaignDoc.campaignId,
        metadata: { sendDay: nextDay }
      });

      if (schedulingResult.success) {
        console.log(`✅ [CronScheduler] Scheduled ${mobilesToSend.length} WhatsApp messages with time spreading over ${schedulingResult.spreadMinutes} minutes`);
        console.log(`✅ WhatsApp campaign ${campaignDoc.campaignId} day ${nextDay} queued (${mobilesToSend.length} messages over 1 hour)`);
      } else {
        throw new Error(schedulingResult.error || 'Failed to schedule WhatsApp messages');
      }
    }
  } catch (error) {
    console.error(`❌ Error executing WhatsApp campaign:`, error);
    try {
      const campaignId = campaign.campaignId || campaign._id?.toString();
      if (campaignId) {
        const campaignDoc = await WhatsAppCampaignModel.findOne({ campaignId });
        if (campaignDoc) {
          campaignDoc.status = 'FAILED';
          campaignDoc.errorMessage = error.message;
          await campaignDoc.save();
        }
      }
    } catch (saveError) {
      console.error('Failed to update campaign error status:', saveError);
    }
  }
}

async function processScheduledItems() {
  try {
    const now = new Date();
    const nowIST = DateTime.fromJSDate(now).setZone(IST_TIMEZONE);
    const currentHour = nowIST.hour;
    const currentMinute = nowIST.minute;

    // Check for WhatsApp workflow window (11 PM IST)
    const isWhatsAppWorkflowWindow = currentHour === WHATSAPP_WORKFLOW_HOUR && currentMinute >= WHATSAPP_WORKFLOW_MINUTE && currentMinute < WHATSAPP_WORKFLOW_MINUTE + 15;
    
    // Check for Email workflow window (8-10 PM IST)
    const isEmailWorkflowWindow = currentHour >= EMAIL_WORKFLOW_START_HOUR && currentHour < EMAIL_WORKFLOW_END_HOUR;
    
    // Legacy send window for campaigns (7:30 PM IST)
    const isSendWindow = currentHour === SEND_HOUR && currentMinute >= SEND_MINUTE && currentMinute < SEND_MINUTE + 15;

    // Atomic claim pattern: use findOneAndUpdate to claim one log at a time.
    // This prevents duplicate execution when multiple cron ticks or server instances overlap.

    // Helper: atomically claim and execute workflow logs matching a filter
    async function claimAndExecute(extraFilter, label) {
      let count = 0;
      let claimed;
      do {
        claimed = await WorkflowLogModel.findOneAndUpdate(
          {
            status: 'scheduled',
            scheduledFor: { $lte: now },
            ...extraFilter
          },
          {
            $set: { status: 'processing', claimedAt: now }
          },
          { returnDocument: 'after', sort: { scheduledFor: 1 } }
        );
        if (claimed) {
          count++;
          await executeWorkflowLog(claimed);
        }
      } while (claimed);
      if (count > 0) {
        console.log(`[cronScheduler] ${label}: processed ${count} workflow logs`);
      }
    }

    // 1. Hour-based workflows execute immediately (no window restriction)
    await claimAndExecute(
      { 'step.hoursAfter': { $gt: 0 } },
      'Hour-based (immediate)'
    );

    // 2. Day-based email workflows — only during email window (8-10 PM IST)
    if (isEmailWorkflowWindow) {
      await claimAndExecute(
        { 'step.channel': 'email', $or: [{ 'step.hoursAfter': { $exists: false } }, { 'step.hoursAfter': 0 }] },
        'Email workflows (8-10 PM IST)'
      );
    }

    // 3. Day-based WhatsApp workflows — only during WhatsApp window (11 PM IST)
    if (isWhatsAppWorkflowWindow) {
      await claimAndExecute(
        { 'step.channel': 'whatsapp', $or: [{ 'step.hoursAfter': { $exists: false } }, { 'step.hoursAfter': 0 }] },
        'WhatsApp workflows (11 PM IST)'
      );
    }

    // Log waiting workflows outside their windows (for monitoring)
    if (!isEmailWorkflowWindow || !isWhatsAppWorkflowWindow) {
      const waitingCount = await WorkflowLogModel.countDocuments({
        status: 'scheduled',
        scheduledFor: { $lte: now },
        $or: [{ 'step.hoursAfter': { $exists: false } }, { 'step.hoursAfter': 0 }]
      });
      if (waitingCount > 0) {
        console.log(`[cronScheduler] ${waitingCount} day-based workflows waiting for their send windows`);
      }
    }

    if (isSendWindow) {
      const scheduledCampaigns = await ScheduledEmailCampaignModel.find({
        status: { $in: ['active'] },
        'sendSchedule.status': 'pending'
      }).limit(50);

      for (const campaign of scheduledCampaigns) {
        const dueSchedules = campaign.sendSchedule.filter(
          s => s.status === 'pending' && new Date(s.scheduledDate) <= now
        );

        for (const scheduleItem of dueSchedules) {
          await executeScheduledEmailCampaign(campaign, scheduleItem);
        }
      }

      const whatsappCampaigns = await WhatsAppCampaignModel.find({
        status: { $in: ['SCHEDULED', 'PENDING', 'IN_PROGRESS'] },
        $or: [
          { scheduledFor: { $lte: now } },
          { scheduledFor: null },
          { 'messageStatuses.sendDay': 0 }
        ]
      }).limit(50);

      for (const campaign of whatsappCampaigns) {
        const hasPending = campaign.messageStatuses.some(
          msg => {
            if (msg.status === 'pending') return true;
            if (msg.status === 'scheduled' && msg.scheduledSendDate && new Date(msg.scheduledSendDate) <= now) return true;
            return false;
          }
        );
        if (hasPending) {
          await executeWhatsAppCampaign(campaign);
        }
      }
    }
  } catch (error) {
    console.error('❌ Error in cron scheduler:', error);
  }
}

export function startCronScheduler() {
  cron.schedule('*/15 * * * *', async () => {
    await processScheduledItems();
  }, {
    scheduled: true,
    timezone: IST_TIMEZONE
  });

  console.log('✅ Cron scheduler started - checking every 15 minutes for scheduled items');
  
  processScheduledItems();
}

export { calculateScheduledDate, getIST730PM, getIST11PM, getISTEmailWindow, getIST10AM };

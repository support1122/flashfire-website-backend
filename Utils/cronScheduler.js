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
 */
function calculateScheduledDate(triggerDate, daysAfter, channel = null, bookingId = null) {
  const targetDate = new Date(triggerDate);
  targetDate.setDate(targetDate.getDate() + daysAfter);

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

    if (log.step.channel === 'email') {
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

      const result = await sgMail.send(msg);
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

      const result = await watiService.sendTemplateMessage({
        mobileNumber: booking.clientPhone,
        templateId: log.step.templateId,
        templateName: log.step.templateName,
        parameters: [],
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
    console.error(`❌ Error executing workflow log ${log.logId}:`, error);
    await WorkflowLogModel.updateOne(
      { logId: log.logId },
      {
        $set: {
          status: 'failed',
          error: error.message,
          errorDetails: error.response || error,
          executedAt: new Date()
        }
      }
    );
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
        parameters: campaignDoc.parameters || [],
        scheduledStartTime: new Date(), // Start immediately, will spread over 1 hour
        campaignId: `${campaignDoc.campaignId}_day${nextDay}`
      });

      if (schedulingResult.success) {
        console.log(`✅ [CronScheduler] Scheduled ${mobilesToSend.length} WhatsApp messages with time spreading over ${schedulingResult.spreadMinutes} minutes`);
        
        // Mark messages as scheduled (actual completion will be tracked by JobScheduler)
        for (const mobile of mobilesToSend) {
          const msgStatus = campaignDoc.messageStatuses.find(m => m.mobileNumber === mobile && m.sendDay === nextDay);
          if (msgStatus) {
            msgStatus.status = 'scheduled';
            msgStatus.scheduledSendDate = schedulingResult.firstSendTime;
          }
        }
        
        await campaignDoc.save();
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

    // Process workflow logs based on channel type and timing
    // Find workflows that are due (scheduledFor <= now)
    const allDueWorkflows = await WorkflowLogModel.find({
      status: 'scheduled',
      scheduledFor: { $lte: now }
    }).limit(100);

    if (allDueWorkflows.length > 0) {
      // Separate workflows by channel
      const emailWorkflows = allDueWorkflows.filter(log => log.step?.channel === 'email');
      const whatsappWorkflows = allDueWorkflows.filter(log => log.step?.channel === 'whatsapp');
      
      // Process email workflows only during email window (8-10 PM IST)
      if (isEmailWorkflowWindow && emailWorkflows.length > 0) {
        console.log(`📧 Processing ${emailWorkflows.length} scheduled email workflow logs (8-10 PM IST window)`);
        for (const log of emailWorkflows) {
          await executeWorkflowLog(log);
        }
      }
      
      // Process WhatsApp workflows only during WhatsApp window (11 PM IST)
      if (isWhatsAppWorkflowWindow && whatsappWorkflows.length > 0) {
        console.log(`📱 Processing ${whatsappWorkflows.length} scheduled WhatsApp workflow logs (11 PM IST window)`);
        for (const log of whatsappWorkflows) {
          await executeWorkflowLog(log);
        }
      }
      
      // Log if workflows are waiting outside their windows (for monitoring)
      const waitingEmail = emailWorkflows.length > 0 && !isEmailWorkflowWindow;
      const waitingWhatsApp = whatsappWorkflows.length > 0 && !isWhatsAppWorkflowWindow;
      
      if (waitingEmail || waitingWhatsApp) {
        const emailCount = waitingEmail ? emailWorkflows.length : 0;
        const whatsappCount = waitingWhatsApp ? whatsappWorkflows.length : 0;
        console.log(`⏳ Workflows waiting for their send windows: ${emailCount > 0 ? `${emailCount} email (waiting for 8-10 PM IST)` : ''} ${whatsappCount > 0 ? `${whatsappCount} WhatsApp (waiting for 11 PM IST)` : ''}`);
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

export { calculateScheduledDate, getIST730PM, getIST11PM, getISTEmailWindow };

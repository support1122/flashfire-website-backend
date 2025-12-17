import cron from 'node-cron';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import sgMail from '@sendgrid/mail';
import watiService from './WatiService.js';
import { EmailCampaignModel } from '../Schema_Models/EmailCampaign.js';
import { DateTime } from 'luxon';

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

const IST_TIMEZONE = 'Asia/Kolkata';
const SEND_HOUR = 19;
const SEND_MINUTE = 30;

function getIST730PM(date) {
  const istDate = DateTime.fromJSDate(date).setZone(IST_TIMEZONE);
  return istDate.set({ hour: SEND_HOUR, minute: SEND_MINUTE, second: 0, millisecond: 0 }).toJSDate();
}

function calculateScheduledDate(triggerDate, daysAfter) {
  const targetDate = new Date(triggerDate);
  targetDate.setDate(targetDate.getDate() + daysAfter);
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
        templateName: log.step.templateId,
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

    const results = {
      successful: [],
      failed: [],
      skipped: []
    };

    let senderEmail = campaign.senderEmail;
    if (!senderEmail) {
      const stepDomainName = campaign.domainName || process.env.DOMAIN_NAME || null;
      if (stepDomainName) {
        senderEmail = `elizabeth@${stepDomainName}`;
      } else {
        senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
      }
    }

    for (const email of campaign.recipientEmails) {
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail) continue;

      const hasBooking = await CampaignBookingModel.findOne({
        clientEmail: trimmedEmail,
        bookingStatus: { $in: ['scheduled', 'completed'] }
      }).lean();

      if (hasBooking) {
        results.skipped.push({
          email: trimmedEmail,
          reason: 'User has booking',
          skippedAt: new Date()
        });
        continue;
      }

      try {
        const msg = {
          to: trimmedEmail,
          from: senderEmail,
          templateId: campaign.templateId,
          dynamicTemplateData: {
            domain: campaign.domainName
          }
        };

        await sgMail.send(msg);
        results.successful.push({
          email: trimmedEmail,
          sentAt: new Date(),
          sendDay: scheduleItem.day,
          scheduledSendDate: scheduleItem.scheduledDate
        });
      } catch (error) {
        results.failed.push({
          email: trimmedEmail,
          error: error.message,
          failedAt: new Date(),
          sendDay: scheduleItem.day,
          scheduledSendDate: scheduleItem.scheduledDate
        });
      }
    }

    const emailCampaign = new EmailCampaignModel({
      templateName: campaign.templateName,
      domainName: campaign.domainName,
      templateId: campaign.templateId,
      provider: 'sendgrid',
      total: campaign.recipientEmails.length,
      success: results.successful.length,
      failed: results.failed.length,
      successfulEmails: results.successful,
      failedEmails: results.failed,
      status: results.failed.length === 0 ? 'SUCCESS' : (results.successful.length > 0 ? 'PARTIAL' : 'FAILED'),
      isScheduled: true,
      scheduledCampaignId: campaign._id
    });
    await emailCampaign.save();

    campaign.sendSchedule[scheduleIndex].status = 'completed';
    campaign.sendSchedule[scheduleIndex].sentCount = results.successful.length;
    campaign.sendSchedule[scheduleIndex].failedCount = results.failed.length;
    campaign.sendSchedule[scheduleIndex].skippedCount = results.skipped.length;
    campaign.sendSchedule[scheduleIndex].completedAt = new Date();

    const allCompleted = campaign.sendSchedule.every(s => s.status === 'completed');
    if (allCompleted) {
      campaign.status = 'completed';
      campaign.completedAt = new Date();
    }

    campaign.logs.push({
      timestamp: new Date(),
      level: 'success',
      message: `Completed email send for day ${scheduleItem.day}`,
      details: {
        sendDay: scheduleItem.day,
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      }
    });

    await campaign.save();
    console.log(`✅ Scheduled email campaign ${campaign._id} day ${scheduleItem.day} completed`);
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

    const results = {
      successful: 0,
      failed: 0
    };

    for (const mobile of mobilesToSend) {
      try {
        const result = await watiService.sendTemplateMessage({
          mobileNumber: mobile,
          templateName: campaignDoc.templateName,
          parameters: campaignDoc.parameters || [],
          campaignId: `${campaignDoc.campaignId}_${Date.now()}`
        });

        if (result.success) {
          results.successful++;
          const msgStatus = campaignDoc.messageStatuses.find(m => m.mobileNumber === mobile && m.sendDay === nextDay);
          if (msgStatus) {
            msgStatus.status = 'sent';
            msgStatus.sentAt = new Date();
            msgStatus.watiResponse = result.data;
          }
        } else {
          results.failed++;
          const msgStatus = campaignDoc.messageStatuses.find(m => m.mobileNumber === mobile && m.sendDay === nextDay);
          if (msgStatus) {
            msgStatus.status = 'failed';
            msgStatus.errorMessage = result.error || 'Failed to send';
          }
        }
      } catch (error) {
        results.failed++;
        const msgStatus = campaignDoc.messageStatuses.find(m => m.mobileNumber === mobile && m.sendDay === nextDay);
        if (msgStatus) {
          msgStatus.status = 'failed';
          msgStatus.errorMessage = error.message;
        }
      }
    }

    campaignDoc.successCount += results.successful;
    campaignDoc.failedCount += results.failed;

    const allSent = campaignDoc.messageStatuses.every(msg => msg.status === 'sent' || msg.status === 'failed');
    if (allSent) {
      campaignDoc.status = campaignDoc.failedCount === 0 ? 'COMPLETED' : (campaignDoc.successCount > 0 ? 'PARTIAL' : 'FAILED');
      campaignDoc.completedAt = new Date();
    } else {
      campaignDoc.status = 'IN_PROGRESS';
    }

    await campaignDoc.save();
    console.log(`✅ WhatsApp campaign ${campaignDoc.campaignId} day ${nextDay} completed: ${results.successful} sent, ${results.failed} failed`);
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

    const isSendWindow = currentHour === SEND_HOUR && currentMinute >= SEND_MINUTE && currentMinute < SEND_MINUTE + 15;

    const workflowLogs = await WorkflowLogModel.find({
      status: 'scheduled',
      scheduledFor: { $lte: now }
    }).limit(100);

    if (workflowLogs.length > 0) {
      console.log(`📧 Processing ${workflowLogs.length} scheduled workflow logs`);
      for (const log of workflowLogs) {
        await executeWorkflowLog(log);
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

export { calculateScheduledDate, getIST730PM };

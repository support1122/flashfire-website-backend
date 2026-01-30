
import { ScheduledJobModel } from '../Schema_Models/ScheduledJob.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import sgMail from '@sendgrid/mail';
import watiService from './WatiService.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { Logger } from './Logger.js';
import dotenv from 'dotenv';

dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

// Configuration
const CONFIG = {
  // Email: Max 3 concurrent sends
  EMAIL_CONCURRENCY: 3,
  // WhatsApp: Max 10 messages per second (1000ms delay between batches)
  WHATSAPP_RATE_LIMIT: 10,
  WHATSAPP_DELAY_MS: 1000,
  // Time spread: Distribute over 1 hour (3600000ms)
  TIME_SPREAD_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  // Polling interval
  POLL_INTERVAL_MS: 10000, // 10 seconds
  // Batch size for processing
  BATCH_SIZE: 10
};

// Scheduler state
let isRunning = false;
let pollInterval = null;
let activeEmailJobs = 0;

/**
 * Calculate spread times for a batch of recipients
 * Distributes jobs evenly over the time spread window (1 hour)
 * @param {Date} startTime - Base start time
 * @param {number} totalRecipients - Number of recipients
 * @returns {Date[]} Array of scheduled times
 */
function calculateSpreadTimes(startTime, totalRecipients) {
  const spreadTimes = [];
  const baseTime = new Date(startTime).getTime();
  
  if (totalRecipients <= 1) {
    spreadTimes.push(new Date(baseTime));
    return spreadTimes;
  }
  
  // Spread evenly over the time window
  const intervalMs = CONFIG.TIME_SPREAD_WINDOW_MS / (totalRecipients - 1);
  
  for (let i = 0; i < totalRecipients; i++) {
    const scheduledTime = new Date(baseTime + (intervalMs * i));
    spreadTimes.push(scheduledTime);
  }
  
  return spreadTimes;
}

/**
 * Schedule email jobs with time spreading
 * @param {Object} params
 * @param {string[]} params.recipients - Array of email addresses
 * @param {string} params.templateId - SendGrid template ID
 * @param {string} params.templateName - Template name for reference
 * @param {string} params.domainName - Domain name for template data
 * @param {string} params.senderEmail - From email address
 * @param {Date} params.scheduledStartTime - When to start sending (base time)
 * @param {string} params.campaignId - Campaign reference ID
 * @param {Object} params.dynamicTemplateData - Additional template data
 * @returns {Promise<Object>} Scheduling result
 */
export async function scheduleEmailBatch({
  recipients,
  templateId,
  templateName,
  domainName,
  senderEmail = null,
  scheduledStartTime = new Date(),
  campaignId = null,
  dynamicTemplateData = {}
}) {
  try {
    const batchId = `email_batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const spreadTimes = calculateSpreadTimes(scheduledStartTime, recipients.length);
    
    // Determine sender email
    const finalSenderEmail = senderEmail || 
      (domainName ? `elizabeth@${domainName}` : null) ||
      process.env.SENDER_EMAIL || 
      process.env.SENDGRID_FROM_EMAIL || 
      'elizabeth@flashfirehq.com';
    
    const jobs = [];
    
    for (let i = 0; i < recipients.length; i++) {
      const email = recipients[i].trim().toLowerCase();
      if (!email) continue;
      
      const job = new ScheduledJobModel({
        jobType: 'email',
        status: 'scheduled',
        scheduledFor: spreadTimes[i],
        priority: 5,
        batchId,
        batchIndex: i,
        totalInBatch: recipients.length,
        emailData: {
          to: email,
          from: finalSenderEmail,
          templateId,
          templateName,
          domainName,
          dynamicTemplateData: {
            ...dynamicTemplateData,
            domain: domainName
          }
        },
        campaignId,
        metadata: {
          originalRecipientIndex: i,
          totalRecipients: recipients.length,
          timeSpreadWindow: CONFIG.TIME_SPREAD_WINDOW_MS
        }
      });
      
      jobs.push(job);
    }
    
    // Bulk insert all jobs
    await ScheduledJobModel.insertMany(jobs);
    
    const firstSendTime = spreadTimes[0];
    const lastSendTime = spreadTimes[spreadTimes.length - 1];
    const spreadMinutes = Math.round((lastSendTime - firstSendTime) / 60000);
    
    console.log(`✅ [JobScheduler] Email batch scheduled:`, {
      batchId,
      totalJobs: jobs.length,
      firstSendTime: firstSendTime.toISOString(),
      lastSendTime: lastSendTime.toISOString(),
      spreadOverMinutes: spreadMinutes
    });
    
    return {
      success: true,
      batchId,
      totalScheduled: jobs.length,
      firstSendTime,
      lastSendTime,
      spreadMinutes
    };
    
  } catch (error) {
    console.error('❌ [JobScheduler] Error scheduling email batch:', error);
    Logger.error('[JobScheduler] Error scheduling email batch', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Schedule WhatsApp jobs with time spreading
 * @param {Object} params
 * @param {string[]} params.mobileNumbers - Array of phone numbers
 * @param {string} params.templateName - WATI template name
 * @param {string} params.templateId - WATI template ID
 * @param {string[]} params.parameters - Template parameters
 * @param {Date} params.scheduledStartTime - When to start sending (base time)
 * @param {string} params.campaignId - Campaign reference ID
 * @param {Object} params.metadata - Optional metadata (e.g. sendDay for campaign sync)
 * @returns {Promise<Object>} Scheduling result
 */
export async function scheduleWhatsAppBatch({
  mobileNumbers,
  templateName,
  templateId = null,
  parameters = [],
  scheduledStartTime = new Date(),
  campaignId = null,
  metadata = null
}) {
  try {
    const batchId = `whatsapp_batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const spreadTimes = calculateSpreadTimes(scheduledStartTime, mobileNumbers.length);
    
    const jobs = [];
    
    for (let i = 0; i < mobileNumbers.length; i++) {
      const mobile = mobileNumbers[i];
      if (!mobile) continue;
      
      const jobMeta = {
        originalRecipientIndex: i,
        totalRecipients: mobileNumbers.length,
        timeSpreadWindow: CONFIG.TIME_SPREAD_WINDOW_MS
      };
      if (metadata && typeof metadata === 'object') {
        Object.assign(jobMeta, metadata);
      }
      
      const job = new ScheduledJobModel({
        jobType: 'whatsapp',
        status: 'scheduled',
        scheduledFor: spreadTimes[i],
        priority: 5,
        batchId,
        batchIndex: i,
        totalInBatch: mobileNumbers.length,
        whatsappData: {
          mobileNumber: mobile,
          templateName,
          templateId,
          parameters: Array.isArray(parameters) ? parameters : [],
          campaignId: campaignId || batchId
        },
        campaignId,
        metadata: jobMeta
      });
      
      jobs.push(job);
    }
    
    // Bulk insert all jobs
    await ScheduledJobModel.insertMany(jobs);
    
    const firstSendTime = spreadTimes[0];
    const lastSendTime = spreadTimes[spreadTimes.length - 1];
    const spreadMinutes = Math.round((lastSendTime - firstSendTime) / 60000);
    
    console.log(`✅ [JobScheduler] WhatsApp batch scheduled:`, {
      batchId,
      totalJobs: jobs.length,
      firstSendTime: firstSendTime.toISOString(),
      lastSendTime: lastSendTime.toISOString(),
      spreadOverMinutes: spreadMinutes
    });
    
    return {
      success: true,
      batchId,
      totalScheduled: jobs.length,
      firstSendTime,
      lastSendTime,
      spreadMinutes
    };
    
  } catch (error) {
    console.error('❌ [JobScheduler] Error scheduling WhatsApp batch:', error);
    Logger.error('[JobScheduler] Error scheduling WhatsApp batch', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Schedule a single email job
 */
export async function scheduleSingleEmail({
  to,
  templateId,
  templateName,
  domainName,
  senderEmail = null,
  scheduledFor = new Date(),
  dynamicTemplateData = {},
  campaignId = null,
  workflowId = null,
  bookingId = null
}) {
  try {
    const finalSenderEmail = senderEmail || 
      (domainName ? `elizabeth@${domainName}` : null) ||
      process.env.SENDER_EMAIL || 
      process.env.SENDGRID_FROM_EMAIL || 
      'elizabeth@flashfirehq.com';
    
    const job = new ScheduledJobModel({
      jobType: 'email',
      status: 'scheduled',
      scheduledFor,
      priority: 5,
      emailData: {
        to: to.trim().toLowerCase(),
        from: finalSenderEmail,
        templateId,
        templateName,
        domainName,
        dynamicTemplateData: {
          ...dynamicTemplateData,
          domain: domainName
        }
      },
      campaignId,
      workflowId,
      bookingId
    });
    
    await job.save();
    
    console.log(`✅ [JobScheduler] Single email scheduled:`, {
      jobId: job.jobId,
      to,
      scheduledFor: scheduledFor.toISOString()
    });
    
    return { success: true, jobId: job.jobId, scheduledFor };
    
  } catch (error) {
    console.error('❌ [JobScheduler] Error scheduling single email:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Schedule a single WhatsApp job
 */
export async function scheduleSingleWhatsApp({
  mobileNumber,
  templateName,
  templateId = null,
  parameters = [],
  scheduledFor = new Date(),
  campaignId = null,
  workflowId = null,
  bookingId = null
}) {
  try {
    const job = new ScheduledJobModel({
      jobType: 'whatsapp',
      status: 'scheduled',
      scheduledFor,
      priority: 5,
      whatsappData: {
        mobileNumber,
        templateName,
        templateId,
        parameters,
        campaignId
      },
      campaignId,
      workflowId,
      bookingId
    });
    
    await job.save();
    
    console.log(`✅ [JobScheduler] Single WhatsApp scheduled:`, {
      jobId: job.jobId,
      mobileNumber,
      scheduledFor: scheduledFor.toISOString()
    });
    
    return { success: true, jobId: job.jobId, scheduledFor };
    
  } catch (error) {
    console.error('❌ [JobScheduler] Error scheduling single WhatsApp:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Check if user has a booking (to skip sending)
 */
async function checkUserHasBooking(emailOrPhone, type = 'email') {
  try {
    let query;
    if (type === 'email') {
      query = {
        clientEmail: emailOrPhone.toLowerCase(),
        bookingStatus: { $in: ['scheduled', 'completed'] }
      };
    } else {
      const normalizedMobile = emailOrPhone.replace(/\D/g, '');
      query = {
        clientPhone: { $regex: normalizedMobile, $options: 'i' },
        bookingStatus: { $in: ['scheduled', 'completed'] }
      };
    }
    
    const booking = await CampaignBookingModel.findOne(query).lean();
    return !!booking;
  } catch (error) {
    console.error(`[JobScheduler] Error checking booking:`, error.message);
    return false;
  }
}

/**
 * Process a single email job
 */
async function processEmailJob(job) {
  const { to, from, templateId, dynamicTemplateData } = job.emailData;
  
  try {
    // Check if user has booking - skip if they do
    const hasBooking = await checkUserHasBooking(to, 'email');
    if (hasBooking) {
      await ScheduledJobModel.updateOne(
        { _id: job._id },
        {
          status: 'completed',
          completedAt: new Date(),
          response: { skipped: true, reason: 'User has booking' }
        }
      );
      console.log(`⏭️ [JobScheduler] Skipped email to ${to} - user has booking`);
      return { success: true, skipped: true };
    }
    
    const msg = {
      to,
      from,
      templateId,
      dynamicTemplateData
    };
    
    const result = await sgMail.send(msg);
    
    await ScheduledJobModel.updateOne(
      { _id: job._id },
      {
        status: 'completed',
        completedAt: new Date(),
        response: { 
          statusCode: result[0]?.statusCode,
          messageId: result[0]?.headers?.['x-message-id']
        }
      }
    );
    
    console.log(`✅ [JobScheduler] Email sent to ${to}`);
    return { success: true };
    
  } catch (error) {
    const attempts = (job.attempts || 0) + 1;
    const shouldRetry = attempts < job.maxAttempts;
    
    await ScheduledJobModel.updateOne(
      { _id: job._id },
      {
        status: shouldRetry ? 'scheduled' : 'failed',
        attempts,
        lastAttemptAt: new Date(),
        error: error.message,
        errorDetails: error.response?.body || null,
        // If retrying, schedule for 5 minutes later
        ...(shouldRetry ? { scheduledFor: new Date(Date.now() + 5 * 60 * 1000) } : {})
      }
    );
    
    console.error(`❌ [JobScheduler] Email to ${to} failed:`, error.message);
    return { success: false, error: error.message, willRetry: shouldRetry };
  }
}

/**
 * Process a single WhatsApp job
 */
async function processWhatsAppJob(job) {
  const { mobileNumber, templateName, templateId, parameters, campaignId } = job.whatsappData;
  
  try {
    // Check if user has booking - skip if they do (for follow-up campaigns)
    if (templateName.toLowerCase().includes('follow')) {
      const hasBooking = await checkUserHasBooking(mobileNumber, 'whatsapp');
      if (hasBooking) {
        await ScheduledJobModel.updateOne(
          { _id: job._id },
          {
            status: 'completed',
            completedAt: new Date(),
            response: { skipped: true, reason: 'User has booking' }
          }
        );
        console.log(`⏭️ [JobScheduler] Skipped WhatsApp to ${mobileNumber} - user has booking`);
        return { success: true, skipped: true };
      }
    }
    
    const result = await watiService.sendTemplateMessage({
      mobileNumber,
      templateName,
      templateId,
      parameters: Array.isArray(parameters) ? parameters : [],
      campaignId: campaignId || `job_${job.jobId}`
    });
    
    if (result.success) {
      await ScheduledJobModel.updateOne(
        { _id: job._id },
        {
          status: 'completed',
          completedAt: new Date(),
          response: result.data
        }
      );
      if (campaignId && String(campaignId).startsWith('whatsapp_')) {
        const mobileNorm = String(mobileNumber).replace(/\D/g, '');
        const sendDay = job.metadata?.sendDay;
        const regexSafe = mobileNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mobileRegex = new RegExp('^\\+?' + regexSafe + '$');
        const filter = sendDay !== undefined
          ? { 'elem.sendDay': sendDay, 'elem.mobileNumber': { $regex: mobileRegex } }
          : { 'elem.mobileNumber': { $regex: mobileRegex }, 'elem.status': { $in: ['pending', 'scheduled'] } };
        await WhatsAppCampaignModel.updateOne(
          { campaignId },
          {
            $set: {
              'messageStatuses.$[elem].status': 'sent',
              'messageStatuses.$[elem].sentAt': new Date(),
              'messageStatuses.$[elem].watiResponse': result.data
            },
            $inc: { successCount: 1 }
          },
          { arrayFilters: [ filter ] }
        );
      }
      console.log(`✅ [JobScheduler] WhatsApp sent to ${mobileNumber}`);
      return { success: true };
    } else {
      throw new Error(result.error || 'WATI send failed');
    }
    
  } catch (error) {
    const attempts = (job.attempts || 0) + 1;
    const shouldRetry = attempts < job.maxAttempts;
    
    await ScheduledJobModel.updateOne(
      { _id: job._id },
      {
        status: shouldRetry ? 'scheduled' : 'failed',
        attempts,
        lastAttemptAt: new Date(),
        error: error.message,
        ...(shouldRetry ? { scheduledFor: new Date(Date.now() + 5 * 60 * 1000) } : {})
      }
    );
    if (!shouldRetry && campaignId && String(campaignId).startsWith('whatsapp_')) {
      const mobileNorm = String(mobileNumber).replace(/\D/g, '');
      const sendDay = job.metadata?.sendDay;
      const regexSafe = mobileNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const mobileRegex = new RegExp('^\\+?' + regexSafe + '$');
      const filter = sendDay !== undefined
        ? { 'elem.sendDay': sendDay, 'elem.mobileNumber': { $regex: mobileRegex } }
        : { 'elem.mobileNumber': { $regex: mobileRegex }, 'elem.status': { $in: ['pending', 'scheduled'] } };
      await WhatsAppCampaignModel.updateOne(
        { campaignId },
        {
          $set: {
            'messageStatuses.$[elem].status': 'failed',
            'messageStatuses.$[elem].errorMessage': error.message
          },
          $inc: { failedCount: 1 }
        },
        { arrayFilters: [ filter ] }
      );
    }
    console.error(`❌ [JobScheduler] WhatsApp to ${mobileNumber} failed:`, error.message);
    return { success: false, error: error.message, willRetry: shouldRetry };
  }
}

/**
 * Process due jobs - called by the polling mechanism
 * Rate limits: 3 concurrent emails, sequential WhatsApp
 */
async function processDueJobs() {
  const now = new Date();
  
  try {
    // ==================== PROCESS EMAILS ====================
    // Only process if we have capacity (less than 3 active)
    const availableSlots = CONFIG.EMAIL_CONCURRENCY - activeEmailJobs;
    
    if (availableSlots > 0) {
      const dueEmailJobs = await ScheduledJobModel.find({
        jobType: 'email',
        status: 'scheduled',
        scheduledFor: { $lte: now }
      })
        .sort({ scheduledFor: 1, priority: 1 })
        .limit(availableSlots);
      
      if (dueEmailJobs.length > 0) {
        console.log(`📧 [JobScheduler] Processing ${dueEmailJobs.length} email(s) (${activeEmailJobs} active, ${availableSlots} slots)`);
        
        // Process emails with concurrency limit
        const emailPromises = dueEmailJobs.map(async (job) => {
          activeEmailJobs++;
          
          // Mark as processing
          await ScheduledJobModel.updateOne(
            { _id: job._id },
            { status: 'processing', processedAt: new Date() }
          );
          
          try {
            return await processEmailJob(job);
          } finally {
            activeEmailJobs--;
          }
        });
        
        await Promise.all(emailPromises);
      }
    }
    
    // ==================== PROCESS WHATSAPP ====================
    // Process WhatsApp sequentially with delay
    const dueWhatsAppJobs = await ScheduledJobModel.find({
      jobType: 'whatsapp',
      status: 'scheduled',
      scheduledFor: { $lte: now }
    })
      .sort({ scheduledFor: 1, priority: 1 })
      .limit(CONFIG.WHATSAPP_RATE_LIMIT);
    
    if (dueWhatsAppJobs.length > 0) {
      console.log(`📱 [JobScheduler] Processing ${dueWhatsAppJobs.length} WhatsApp message(s)`);
      
      for (const job of dueWhatsAppJobs) {
        // Mark as processing
        await ScheduledJobModel.updateOne(
          { _id: job._id },
          { status: 'processing', processedAt: new Date() }
        );
        
        await processWhatsAppJob(job);
        
        // Small delay between WhatsApp messages to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
  } catch (error) {
    console.error('❌ [JobScheduler] Error processing due jobs:', error.message);
    Logger.error('[JobScheduler] Error processing due jobs', { error: error.message });
  }
}

/**
 * Start the job scheduler
 */
export function startJobScheduler() {
  if (isRunning) {
    console.log('ℹ️ [JobScheduler] Scheduler already running');
    return;
  }
  
  isRunning = true;
  console.log('🚀 [JobScheduler] Starting MongoDB-based job scheduler...');
  console.log(`⏱️ [JobScheduler] Poll interval: ${CONFIG.POLL_INTERVAL_MS / 1000} seconds`);
  console.log(`📧 [JobScheduler] Email concurrency: ${CONFIG.EMAIL_CONCURRENCY}`);
  console.log(`📱 [JobScheduler] WhatsApp rate: ${CONFIG.WHATSAPP_RATE_LIMIT}/batch`);
  console.log(`⏰ [JobScheduler] Time spread window: ${CONFIG.TIME_SPREAD_WINDOW_MS / 60000} minutes`);
  
  // Initial check
  processDueJobs();
  
  // Start polling
  pollInterval = setInterval(processDueJobs, CONFIG.POLL_INTERVAL_MS);
  
  console.log('✅ [JobScheduler] Scheduler started successfully!');
}

/**
 * Stop the job scheduler
 */
export function stopJobScheduler() {
  if (!isRunning) {
    return;
  }
  
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  
  isRunning = false;
  console.log('🛑 [JobScheduler] Scheduler stopped');
}

/**
 * Get scheduler stats
 */
export async function getJobSchedulerStats() {
  const [pending, scheduled, processing, completed, failed, cancelled] = await Promise.all([
    ScheduledJobModel.countDocuments({ status: 'pending' }),
    ScheduledJobModel.countDocuments({ status: 'scheduled' }),
    ScheduledJobModel.countDocuments({ status: 'processing' }),
    ScheduledJobModel.countDocuments({ status: 'completed' }),
    ScheduledJobModel.countDocuments({ status: 'failed' }),
    ScheduledJobModel.countDocuments({ status: 'cancelled' })
  ]);
  
  const [emailPending, whatsappPending] = await Promise.all([
    ScheduledJobModel.countDocuments({ status: 'scheduled', jobType: 'email' }),
    ScheduledJobModel.countDocuments({ status: 'scheduled', jobType: 'whatsapp' })
  ]);
  
  return {
    isRunning,
    pollIntervalMs: CONFIG.POLL_INTERVAL_MS,
    emailConcurrency: CONFIG.EMAIL_CONCURRENCY,
    activeEmailJobs,
    timeSpreadWindowMinutes: CONFIG.TIME_SPREAD_WINDOW_MS / 60000,
    counts: {
      pending,
      scheduled,
      processing,
      completed,
      failed,
      cancelled,
      total: pending + scheduled + processing + completed + failed + cancelled
    },
    byType: {
      emailPending,
      whatsappPending
    }
  };
}

/**
 * Get upcoming jobs
 */
export async function getUpcomingJobs(limit = 20) {
  return await ScheduledJobModel.find({ status: 'scheduled' })
    .sort({ scheduledFor: 1 })
    .limit(limit)
    .lean();
}

/**
 * Cancel all jobs in a batch
 */
export async function cancelBatch(batchId) {
  const result = await ScheduledJobModel.updateMany(
    { batchId, status: { $in: ['pending', 'scheduled'] } },
    { status: 'cancelled' }
  );
  
  console.log(`🚫 [JobScheduler] Cancelled ${result.modifiedCount} jobs in batch ${batchId}`);
  return { success: true, cancelledCount: result.modifiedCount };
}

/**
 * Cancel a single job
 */
export async function cancelJob(jobId) {
  const result = await ScheduledJobModel.updateOne(
    { jobId, status: { $in: ['pending', 'scheduled'] } },
    { status: 'cancelled' }
  );
  
  return { success: result.modifiedCount > 0 };
}

export default {
  scheduleEmailBatch,
  scheduleWhatsAppBatch,
  scheduleSingleEmail,
  scheduleSingleWhatsApp,
  startJobScheduler,
  stopJobScheduler,
  getJobSchedulerStats,
  getUpcomingJobs,
  cancelBatch,
  cancelJob
};

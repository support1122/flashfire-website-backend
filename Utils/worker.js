import { Worker } from 'bullmq';
import Twilio from 'twilio';
import dotenv from 'dotenv';
import { sendWhatsAppMessage } from '../Utils/WatiHelper.js';
import { Logger } from './Logger.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import redisConnection from './redisConnection.js';
import { isEventPresent } from './GoogleCalendarHelper.js';
import { DiscordConnect } from './DiscordConnect.js';

dotenv.config();

const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const worker = redisConnection ? new Worker(
  'callQueue',
  async (job) => {
    const { type } = job.data;

    try {
      if (type === 'payment_reminder') {
        await processPaymentReminder(job);
      } else {
        await processCallReminder(job);
      }
    } catch (err) {
      Logger.error(`Job processing failed: ${job.id}`, {
        error: err.message,
        stack: err.stack,
        jobData: job.data
      });
      throw err; // important so BullMQ marks job as failed
    }
  },
  { connection: redisConnection }
) : null;

if (!worker) {
  console.warn('[Worker] ⚠️ Redis connection not available. Call worker disabled.');
} else {
  console.log('[Worker] ✅ Call worker started and listening for jobs on callQueue');
}

// Process payment reminder jobs
async function processPaymentReminder(job) {
  const { bookingId, clientName, clientPhone, paymentLink, reminderDays } = job.data;
  
  Logger.info(`Processing payment reminder job for ${clientName}`, {
    jobId: job.id,
    bookingId,
    clientPhone,
    reminderDays
  });

  const message = `Hello ${clientName},

I hope this message finds you well. I wanted to reach out regarding the payment information we discussed during our consultation.

As mentioned, here are the payment details for our services:

Payment Link: ${paymentLink}

Please feel free to review the payment options at your convenience. If you have any questions about the pricing, payment methods, or need to discuss a payment plan, I'm here to help.

You can also visit our website at https://www.flashfirejobs.com/ for more information about our services.

Thank you for considering FlashFire for your career development needs. I look forward to hearing from you soon.

Best regards,
FlashFire Team`;

  const result = await sendWhatsAppMessage(clientPhone, message);
  
  if (result.success) {
    // Update payment reminder status in database
    await CampaignBookingModel.findOneAndUpdate(
      { 
        bookingId,
        'paymentReminders.jobId': job.id.toString()
      },
      { 
        $set: { 
          'paymentReminders.$.status': 'sent',
          'paymentReminders.$.sentAt': new Date()
        }
      }
    );

    Logger.info(`Payment reminder sent successfully to ${clientName}`, {
      jobId: job.id,
      bookingId,
      clientPhone
    });
  } else {
    // Update payment reminder status to failed
    await CampaignBookingModel.findOneAndUpdate(
      { 
        bookingId,
        'paymentReminders.jobId': job.id.toString()
      },
      { 
        $set: { 
          'paymentReminders.$.status': 'failed'
        }
      }
    );

    Logger.error(`Failed to send payment reminder to ${clientName}`, {
      jobId: job.id,
      bookingId,
      clientPhone,
      error: result.error
    });
    throw new Error(`WhatsApp message failed: ${result.error}`);
  }
}

// Process call reminder jobs (with Google Calendar check)
async function processCallReminder(job) {
  const meta = {
    jobId: job?.id,
    type: job?.data?.type || 'call_reminder',
    phone: job?.data?.phone,
    meetingTime: job?.data?.meetingTime,
    inviteeEmail: job?.data?.inviteeEmail
  };
  console.log('[Worker] Processing job', meta);

  // Validate job data before processing
  const phone = job?.data?.phone;
  if (!phone) {
    Logger.error('[Worker] Missing phone in job data; aborting call', {
      ...meta,
      fullJobData: job?.data,
      jobName: job?.name
    });
    
    // Send Discord notification about invalid job
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `⚠️ Invalid call job detected (ID: ${job?.id}). Missing phone number. Job data: ${JSON.stringify(job?.data)}`
      );
    }
    
    // Remove invalid job from queue to prevent reprocessing
    try {
      await job.remove();
      Logger.info('[Worker] Removed invalid job from queue', { jobId: job?.id });
    } catch (removeError) {
      Logger.warn('[Worker] Could not remove invalid job', { jobId: job?.id, error: removeError.message });
    }
    
    return;
  }

  const phoneRegex = /^\+?[1-9]\d{9,14}$/;
  if (!phoneRegex.test(phone)) {
    Logger.error('[Worker] Invalid E.164 phone format; aborting call', { ...meta, phone });
    return;
  }

  if (!process.env.TWILIO_FROM) {
    Logger.error('[Worker] TWILIO_FROM not configured; aborting call');
    return;
  }

  // Pre-call Google Calendar presence check (optional, env-driven)
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const shouldCheck = Boolean(calendarId);
  if (shouldCheck) {
    const present = await isEventPresent({
      calendarId,
      eventStartISO: job.data.eventStartISO,
      inviteeEmail: job.data.inviteeEmail,
      windowMinutes: 20
    });
    if (!present) {
      Logger.info('Event not present in Google Calendar window; skipping call', {
        phone: job.data.phone,
        inviteeEmail: job.data.inviteeEmail,
        eventStartISO: job.data.eventStartISO
      });
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `Skipping call. Event not found in calendar window for ${job.data.phone} (${job.data.inviteeEmail || 'unknown email'}).`
      );
      return;
    }
  }

  try {
    Logger.info('[Worker] Attempting to create Twilio call', {
      jobId: job?.id,
      phone,
      meetingTime: job.data.meetingTime,
      inviteeEmail: job.data.inviteeEmail
    });

    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_FROM,
      url: `https://api.flashfirejobs.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`,
      machineDetection: 'Enable',
      statusCallback: 'https://api.flashfirejobs.com/call-status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      method: 'POST',
    });

    Logger.info('[Worker] ✅ Call initiated successfully', {
      jobId: job?.id,
      sid: call?.sid,
      status: call?.status,
      to: phone,
      from: process.env.TWILIO_FROM,
      callUrl: call?.url
    });

    console.log('[Worker] ✅ Call initiated', {
      jobId: job?.id,
      sid: call?.sid,
      status: call?.status,
      to: phone,
      from: process.env.TWILIO_FROM
    });

    // Send Discord notification if configured
    const discordWebhookUrl = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    if (discordWebhookUrl) {
      Logger.info('[Worker] Sending Discord notification', { jobId: job?.id, hasWebhook: !!discordWebhookUrl });
      await DiscordConnect(
        discordWebhookUrl,
        `[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status} To: ${phone}`
      );
    } else {
      Logger.warn('[Worker] ⚠️ DISCORD_REMINDER_CALL_WEBHOOK_URL not configured - Discord notification skipped', {
        jobId: job?.id
      });
      console.warn('[Worker] ⚠️ DISCORD_REMINDER_CALL_WEBHOOK_URL not configured');
    }
  } catch (error) {
    Logger.error('[Worker] ❌ Twilio call failed', {
      jobId: job?.id,
      phone,
      error: error?.message,
      code: error?.code,
      moreInfo: error?.moreInfo
    });

    // Send Discord notification if configured
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `❌ Twilio call failed for ${job.data.phone}. Error: ${error.message}`
      );
    }
    throw error;
  }
}

// Track worker lifecycle
worker.on("completed", (job) => {
  console.log(`✅ Job completed: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`❌ Job failed: ${job?.id}`, err);
});

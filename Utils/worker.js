import { Worker } from 'bullmq';
import Twilio from 'twilio';
import dotenv from 'dotenv';
import { sendWhatsAppMessage } from '../Utils/WatiHelper.js';
import { Logger } from './Logger.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

dotenv.config();

const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const worker = new Worker(
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
  { connection: { url: process.env.REDIS_CLOUD_URL } }
);

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

// Process call reminder jobs (existing functionality)
async function processCallReminder(job) {
  const meta = {
    jobId: job?.id,
    type: job?.data?.type || 'call_reminder',
    phone: job?.data?.phone,
    meetingTime: job?.data?.meetingTime,
    inviteeEmail: job?.data?.inviteeEmail
  };
  console.log('[Worker] Processing job', meta);

  const phone = job?.data?.phone;
  if (!phone) {
    Logger.error('[Worker] Missing phone in job data; aborting call', meta);
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

  try {
    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_FROM,
      url: `https://api.flashfirejobs.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`
    });

    console.log('📞 Call initiated.', { sid: call?.sid, status: call?.status, to: phone });
  } catch (error) {
    Logger.error('[Worker] Twilio call failed', {
      jobId: job?.id,
      phone,
      error: error?.message,
      code: error?.code,
      moreInfo: error?.moreInfo
    });
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

import { Worker } from 'bullmq';
import Twilio from 'twilio';
import dotenv from 'dotenv';
import { sendWhatsAppMessage } from '../Utils/WatiHelper.js';
import { Logger } from './Logger.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { callQueue, getRedisUrl } from './queue.js'; // Import getRedisUrl
import { isEventPresent } from './GoogleCalendarHelper.js';
import { DiscordConnect } from './DiscordConnect.js';
import Redis from 'ioredis';

dotenv.config();

console.log('\n📞 ========================================');
console.log('📞 [CallWorker] Initializing Call Reminder Worker');
console.log('📞 ========================================\n');

// Create dedicated Redis connection for this worker
const redisUrl = getRedisUrl();
let workerConnection = null;

if (redisUrl) {
  console.log('🔄 [CallWorker] Creating dedicated Redis connection...');
  workerConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    reconnectOnError: (err) => !err.message.includes('READONLY')
  });

  workerConnection.on('connect', () => console.log('✅ [CallWorker] Dedicated Redis connection established'));
  workerConnection.on('error', (err) => console.error('❌ [CallWorker] Redis error:', err.message));

  workerConnection.once('ready', async () => {
    try {
      const maxmemoryPolicy = await workerConnection.config('GET', 'maxmemory-policy');
      const policy = maxmemoryPolicy[1];

      if (policy && policy !== 'noeviction') {
        console.warn('\n⚠️  IMPORTANT! Eviction policy is', policy, '. It should be "noeviction"');

        try {
          await workerConnection.config('SET', 'maxmemory-policy', 'noeviction');
          console.log('✅ Successfully set Redis eviction policy to "noeviction"');
        } catch (setError) {
          console.warn('⚠️  Could not set eviction policy automatically:', setError.message);
        }
      } else {
        console.log('✅ Redis eviction policy is correctly set to "noeviction"');
      }
    } catch (error) {
      if (error.message && (error.message.includes('NOPERM') || error.message.includes('permission') || error.message.includes('not allowed'))) {
        console.log('ℹ️  [CallWorker] Redis eviction policy check skipped (managed Redis service - no admin permissions)');
      } else {
        console.warn('⚠️  Could not check Redis eviction policy:', error.message);
      }
    }
  });
}

const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const worker = new Worker(
  'callQueue',
  async (job) => {
    const { type } = job.data;

    console.log('\n📥 ========================================');
    console.log(`📥 [CallWorker] Job Received: ${job.id}`);
    console.log('📥 ========================================');
    console.log(`📌 Job Type: ${type || 'call_reminder'}`);
    console.log(`📌 Job Data:`, JSON.stringify(job.data, null, 2));
    console.log('========================================\n');

    try {
      if (type === 'payment_reminder') {
        console.log('💰 [CallWorker] Processing payment reminder...');
        await processPaymentReminder(job);
      } else {
        console.log('📞 [CallWorker] Processing call reminder...');
        await processCallReminder(job);
      }
    } catch (err) {
      Logger.error(`Job processing failed: ${job.id}`, {
        error: err.message,
        stack: err.stack,
        jobData: job.data
      });
      console.error(`💥 ========================================`);
      console.error(`💥 [CallWorker] Job Failed: ${job?.id}`);
      console.error(`💥 Error: ${err.message}`);
      console.error(`💥 ========================================\n`);
      throw err; // important so BullMQ marks job as failed
    }
  },
  { connection: workerConnection }
);

// Track worker lifecycle with detailed logs
console.log('✅ [CallWorker] Worker connected to Redis successfully!');
console.log('👂 [CallWorker] Listening for jobs on "callQueue"...\n');

worker.on("completed", (job) => {
  console.log('\n🎉 ========================================');
  console.log(`🎉 [CallWorker] Job Completed: ${job.id}`);
  console.log('🎉 ========================================\n');
});

worker.on("failed", async (job, err) => {
  console.error('\n💥 ========================================');
  console.error(`💥 [CallWorker] Job Failed: ${job?.id}`);
  console.error('💥 Error:', err.message);
  console.error('💥 ========================================\n');

  // Send detailed failure notification to Discord
  if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL && job?.data) {
    try {
      // Get queue statistics
      let queueStats = {};
      try {
        if (callQueue) {
          queueStats = {
            waiting: await callQueue.getWaitingCount() || 0,
            active: await callQueue.getActiveCount() || 0,
            completed: await callQueue.getCompletedCount() || 0,
            failed: await callQueue.getFailedCount() || 0,
            delayed: await callQueue.getDelayedCount() || 0
          };
        }
      } catch (statsError) {
        console.warn('Could not fetch queue stats:', statsError.message);
      }

      const failureReport = `
💥 **Job Failed - Final Failure Report**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 **Call Information:**
• Job ID: ${job?.id || 'N/A'}
• Phone: ${job.data?.phone || 'N/A'}
• Meeting Time: ${job.data?.meetingTime || 'N/A'}
• Invitee Email: ${job.data?.inviteeEmail || 'N/A'}
• Event Start: ${job.data?.eventStartISO || 'N/A'}

❌ **Failure Details:**
• Error: ${err?.message || 'Unknown error'}
• Error Type: ${err?.name || 'Unknown'}
• Attempts Made: ${job?.attemptsMade || 0}
• Max Attempts: ${job?.opts?.attempts || 3}
• Failed After: ${job?.attemptsMade || 0} retries

📊 **Queue Statistics:**
• Waiting: ${queueStats.waiting || 0}
• Active: ${queueStats.active || 0}
• Delayed: ${queueStats.delayed || 0}
• Completed: ${queueStats.completed || 0}
• Failed: ${queueStats.failed || 0}
• **Total Calls: ${(queueStats.waiting || 0) + (queueStats.active || 0) + (queueStats.delayed || 0) + (queueStats.completed || 0) + (queueStats.failed || 0)}**

⏰ **Failure Time:**
• Failed At: ${new Date().toISOString()}
• Failed At (Local): ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();

      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        failureReport
      );
    } catch (discordError) {
      console.error('Failed to send Discord notification:', discordError.message);
    }
  }
});

worker.on("error", (err) => {
  console.error('\n⚠️  [CallWorker] Worker error:', err.message);
});

worker.on("ioredis:close", () => {
  console.warn('\n⚠️  [CallWorker] Redis connection closed!');
});

worker.on("ioredis:reconnecting", () => {
  console.log('\n🔄 [CallWorker] Reconnecting to Redis...');
});

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
  console.log('\n🔍 [CallWorker] Starting call reminder processing...');

  // Support both 'phone' and 'phoneNumber' fields for backward compatibility
  const phone = job?.data?.phone || job?.data?.phoneNumber;
  const meetingTime = job?.data?.meetingTime || job?.data?.announceTimeText;

  const meta = {
    jobId: job?.id,
    type: job?.data?.type || 'call_reminder',
    phone: phone,
    meetingTime: meetingTime,
    inviteeEmail: job?.data?.inviteeEmail
  };

  console.log('📋 [CallWorker] Job Details:');
  console.log('   • Job ID:', meta.jobId);
  console.log('   • Phone:', meta.phone);
  console.log('   • Meeting Time:', meta.meetingTime);
  console.log('   • Invitee Email:', meta.inviteeEmail);
  console.log('   • Raw Job Data:', JSON.stringify(job.data, null, 2));

  if (!phone) {
    console.error('❌ [CallWorker] Missing phone number - aborting call');
    console.error('   • Available fields:', Object.keys(job?.data || {}));
    Logger.error('[Worker] Missing phone in job data; aborting call', meta);
    return;
  }

  console.log('✅ [CallWorker] Phone number found:', phone);

  const phoneRegex = /^\+?[1-9]\d{9,14}$/;
  if (!phoneRegex.test(phone)) {
    console.error('❌ [CallWorker] Invalid phone format (must be E.164):', phone);
    Logger.error('[Worker] Invalid E.164 phone format; aborting call', { ...meta, phone });
    return;
  }

  console.log('✅ [CallWorker] Phone format validated (E.164)');

  if (!process.env.TWILIO_FROM) {
    console.error('❌ [CallWorker] TWILIO_FROM not configured - aborting call');
    Logger.error('[Worker] TWILIO_FROM not configured; aborting call');
    return;
  }

  console.log('✅ [CallWorker] Twilio FROM number configured:', process.env.TWILIO_FROM);

  // Pre-call Google Calendar presence check (optional, env-driven)
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const shouldCheck = Boolean(calendarId) && job?.data?.force !== true;
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
    const meetingTimeForCall = meetingTime || job.data.meetingTime || job.data.announceTimeText || 'your meeting';

    Logger.info('[Worker] Attempting to create Twilio call', {
      jobId: job?.id,
      phone,
      meetingTime: meetingTimeForCall,
      inviteeEmail: job.data.inviteeEmail
    });

    console.log('\n📞 [CallWorker] Initiating Twilio call...');
    console.log('   → To:', phone);
    console.log('   → From:', process.env.TWILIO_FROM);
    console.log('   → Meeting Time:', meetingTimeForCall);

    const call = await client.calls.create({
      to: phone,
      from: process.env.TWILIO_FROM,
      url: `https://api.flashfirejobs.com/twilio-ivr?meetingTime=${encodeURIComponent(meetingTimeForCall)}`
    });

    console.log('\n✅ [CallWorker] Call initiated successfully!');
    console.log('   • Call SID:', call?.sid);
    console.log('   • Status:', call?.status);
    console.log('   • To:', phone);
    console.log('========================================\n');

    // Send success notification to Discord with call details
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      const successDetails = `
✅ **Call Initiated Successfully**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 **Call Details:**
• Call SID: ${call?.sid || 'N/A'}
• Status: ${call?.status || 'N/A'}
• To: ${phone || 'N/A'}
• From: ${process.env.TWILIO_FROM || 'N/A'}
• Meeting Time: ${job.data?.meetingTime || 'N/A'}
• Invitee Email: ${job.data?.inviteeEmail || 'N/A'}

📋 **Job Information:**
• Job ID: ${job?.id || 'N/A'}
• Event Start: ${job.data?.eventStartISO || 'N/A'}

⏰ **Timing:**
• Initiated At: ${new Date().toISOString()}
• Initiated At (Local): ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();

      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        successDetails
      );
    }
  } catch (error) {
    console.error('\n❌ [CallWorker] Twilio call FAILED!');
    console.error('   • Job ID:', job?.id);
    console.error('   • Phone:', phone);
    console.error('   • Error:', error?.message);
    console.error('   • Code:', error?.code);
    console.error('   • More Info:', error?.moreInfo);
    console.error('========================================\n');

    Logger.error('[Worker] Twilio call failed', {
      jobId: job?.id,
      phone,
      error: error?.message,
      code: error?.code,
      moreInfo: error?.moreInfo
    });

    // Send detailed Discord notification if configured
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      const failureDetails = `
**Call Failed - Detailed Report**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 **Call Details:**
• Job ID: ${job?.id || 'N/A'}
• Phone: ${phone || 'N/A'}
• Meeting Time: ${job.data?.meetingTime || 'N/A'}
• Invitee Email: ${job.data?.inviteeEmail || 'N/A'}
• Event Start: ${job.data?.eventStartISO || 'N/A'}

❌ **Error Information:**
• Error Message: ${error?.message || 'Unknown error'}
• Error Code: ${error?.code || 'N/A'}
• More Info: ${error?.moreInfo || 'N/A'}
• Error Type: ${error?.name || 'Unknown'}

⏰ **Timing:**
• Failed At: ${new Date().toISOString()}
• Failed At (Local): ${new Date().toLocaleString()}

🔄 **Retry Information:**
• Attempt: ${job?.attemptsMade || 0} / ${job?.opts?.attempts || 3}
• Will Retry: ${job?.opts?.attempts > (job?.attemptsMade || 0) ? 'Yes' : 'No'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();

      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        failureDetails
      );
    }
    throw error;
  }
}

worker.on("completed", (job) => {
  console.log('\n🎉 ========================================');
  console.log(`🎉 [CallWorker] Job Completed: ${job.id}`);
  console.log('🎉 ========================================\n');
});

worker.on("failed", async (job, err) => {
  console.error('\n💥 ========================================');
  console.error(`💥 [CallWorker] Job Failed: ${job?.id}`);
  console.error('💥 Error:', err.message);
  console.error('💥 ========================================\n');

  // Send detailed failure notification to Discord
  if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL && job?.data) {
    try {
      // Get queue statistics
      let queueStats = {};
      try {
        if (callQueue) {
          queueStats = {
            waiting: await callQueue.getWaitingCount() || 0,
            active: await callQueue.getActiveCount() || 0,
            completed: await callQueue.getCompletedCount() || 0,
            failed: await callQueue.getFailedCount() || 0,
            delayed: await callQueue.getDelayedCount() || 0
          };
        }
      } catch (statsError) {
        console.warn('Could not fetch queue stats:', statsError.message);
      }

      const failureReport = `
**Job Failed - Final Failure Report**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 **Call Information:**
• Job ID: ${job?.id || 'N/A'}
• Phone: ${job.data?.phone || 'N/A'}
• Meeting Time: ${job.data?.meetingTime || 'N/A'}
• Invitee Email: ${job.data?.inviteeEmail || 'N/A'}
• Event Start: ${job.data?.eventStartISO || 'N/A'}

❌ **Failure Details:**
• Error: ${err?.message || 'Unknown error'}
• Error Type: ${err?.name || 'Unknown'}
• Attempts Made: ${job?.attemptsMade || 0}
• Max Attempts: ${job?.opts?.attempts || 3}
• Failed After: ${job?.attemptsMade || 0} retries

📊 **Queue Statistics:**
• Waiting: ${queueStats.waiting || 0}
• Active: ${queueStats.active || 0}
• Delayed: ${queueStats.delayed || 0}
• Completed: ${queueStats.completed || 0}
• Failed: ${queueStats.failed || 0}
• **Total Calls: ${(queueStats.waiting || 0) + (queueStats.active || 0) + (queueStats.delayed || 0) + (queueStats.completed || 0) + (queueStats.failed || 0)}**

⏰ **Failure Time:**
• Failed At: ${new Date().toISOString()}
• Failed At (Local): ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      `.trim();

      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        failureReport
      );
    } catch (discordError) {
      console.error('Failed to send Discord notification:', discordError.message);
    }
  }
});

worker.on("error", (err) => {
  console.error('\n⚠️  [CallWorker] Worker error:', err.message);
});

worker.on("ioredis:close", () => {
  console.warn('\n⚠️  [CallWorker] Redis connection closed!');
});

worker.on("ioredis:reconnecting", () => {
  console.log('\n🔄 [CallWorker] Reconnecting to Redis...');
});

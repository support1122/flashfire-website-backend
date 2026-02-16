// import express from 'express';
// import Routes from './Routes.js';
// import Connection from './Utils/ConnectDB.js';
// import cors from 'cors';
// import 'dotenv/config';
// import { callQueue } from './Utils/queue.js';
// import Twilio from 'twilio';
// import { DateTime } from 'luxon';
// import { Worker } from 'bullmq';
// import { DiscordConnect } from './Utils/DiscordConnect.js';
// import TwilioReminder from './Controllers/TwilioReminder.js';

// // -------------------- Express Setup --------------------
// const app = express();
// const allowedOrigins = [
//   "https://flashfire-frontend-hoisted.vercel.app", // your frontend
//   "http://localhost:5173",
//   "https://www.flashfirejobs.com"
// ];

// app.use(
//   cors({
//     origin: allowedOrigins,
//     methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
//     credentials: true,
//   })
// );

// // ✅ Handle preflight requests for all routes
// // app.options("*", cors());
// // app.use(cors());
// app.use(express.json());
// app.use(express.urlencoded({ extended: false }));


// // -------------------- Discord Utility --------------------
// export const DiscordConnectForMeet = async (message) => {
//   const webhookURL = process.env.DISCORD_MEET_WEB_HOOK_URL;
//   try {
//     const response = await fetch(webhookURL, {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ content: `🚨 App Update: ${message}` }),
//     });

//     if (!response.ok) throw new Error(`Failed to send: ${response.statusText}`);

//     console.log('✅ Message sent to Discord!');
//   } catch (error) {
//     console.error('❌ Error sending message:', error);
//   }
// };



// app.post("/call-status", async (req, res) => {
//   const { CallSid, CallStatus, To, From, AnsweredBy, Timestamp } = req.body;

//   try {
//     console.log(`📞 Call Update: SID=${CallSid}, To=${To}, Status=${CallStatus}, AnsweredBy=${AnsweredBy}`);

//     const msg = `
// 📞 **Call Status Update**
// - To: ${To}
// - From: ${From}
// - Status: ${CallStatus}
// - Answered By: ${AnsweredBy || "Unknown"}
// - At: ${Timestamp || new Date().toISOString()}
// SID: ${CallSid}
//     `;

//     await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, msg);

//     res.status(200).send("✅ Call status received");
//   } catch (error) {
//     console.error("❌ Error in /call-status:", error);
//     res.status(500).send("Server Error");
//   }
// });

// // -------------------- Calendly Webhook --------------------
// app.post('/calendly-webhook', async (req, res) => {
//   const { event, payload } = req.body;

//   try {
//     if (event === "invitee.created") {
//       console.log("📥 Calendly Webhook Received:", JSON.stringify(payload, null, 2));

//       // ✅ Calculate meeting start in UTC
//       const meetingStart = new Date(payload?.scheduled_event?.start_time);
//       const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

//       if (delay < 0) {
//         console.log('⚠ Meeting is too soon to schedule calls.');
//         return res.status(400).json({ error: 'Meeting too soon to schedule call' });
//       }

//       // ✅ Convert to different time zones
//       const meetingStartUTC = DateTime.fromISO(payload?.scheduled_event?.start_time, { zone: 'utc' });
//       const meetingTimeUS = meetingStartUTC.setZone('America/New_York').toFormat('ff');
//       const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

//       // ✅ Extract details
//       const inviteeName = payload?.invitee?.name || payload?.name;
//       const inviteeEmail = payload?.invitee?.email || payload?.email;
//       let inviteePhone = payload?.questions_and_answers?.find(q =>
//   q.question.trim().toLowerCase() === 'phone number'
// )?.answer || null;

// if (inviteePhone) {
//   // Remove spaces and any non-digit except leading +
//   inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
// }
//       const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
//       const bookedAt = new Date(req.body?.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

//       // ✅ Prepare booking details for Discord
//       const bookingDetails = {
//         "Invitee Name": inviteeName,
//         "Invitee Email": inviteeEmail,
//         "Invitee Phone": inviteePhone || 'Not Provided',
//         "Google Meet Link": meetLink,
//         "Meeting Time (Client US)": meetingTimeUS,
//         "Meeting Time (Team India)": meetingTimeIndia,
//         "Booked At": bookedAt
//       };

//       console.log("📅 New Calendly Booking:", bookingDetails);

//       // ✅ Send to Discord
//       await DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2));

//       // ✅ Validate phone numbers

//       const phoneRegex = /^\+?[1-9]\d{9,14}$/;
//       let scheduledJobs = [];

//       if (inviteePhone && phoneRegex.test(inviteePhone)) {
//         await callQueue.add('callUser', {
//           phone: inviteePhone,
//           meetingTime: meetingTimeIndia,// meetingTimeUS,
//           role: 'client'
//         }, { delay });
//         scheduledJobs.push(`Client: ${inviteePhone}`);
//         console.log(`📞 Valid phone, scheduled: ${inviteePhone}`);
//         const scheduledMessage =`Reminder Call Scheduled For ${inviteePhone}-${inviteeName} for meeting scheduled on ${meetingTimeIndia} (IST).Reminder 10 minutes before Start of meeting.`
//         await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, scheduledMessage);
//       } else {
//         console.log("⚠ No valid phone number provided by invitee.");
//         await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
//           `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
//         );
//       }

//       console.log(`✅ Scheduled calls: ${scheduledJobs.join(', ')}`);
//       DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`✅ Scheduled calls: ${scheduledJobs.join(', ')}` )

//       return res.status(200).json({
//         message: 'Webhook received & calls scheduled',
//         bookingDetails,
//         scheduledCalls: scheduledJobs
//       });
//     }

//     return res.status(200).json({ message: 'Ignored non-invitee event' });

//   } catch (error) {
//     console.error('❌ Error processing Calendly webhook:', error);
//     res.status(500).json({ error: 'Internal Server Error' });
//   }
// });
// app.post("/twilio-ivr", TwilioReminder);
// // -------------------- Worker Setup --------------------
// const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
   

// new Worker(
//   'callQueue',
//   async (job) => {
//     console.log(`[Worker] Processing job for ${job.data.phone}`);

//     try {
//       const call = await client.calls.create({
//         to: job.data.phone,
//         from: process.env.TWILIO_FROM, // must be a Twilio voice-enabled number
//         url: `https://api.flashfirejobs.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`,
//         statusCallback: 'https://api.flashfirejobs.com/call-status',
//         statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
//         method: 'POST', // optional (Twilio defaults to POST for Calls API)
//       });

//       console.log(`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}`);
//       DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}` )
//     } catch (error) {
//       console.error(`[Worker] ❌ Twilio call failed for ${job.data.phone}:`, error.message);
//       await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`❌ Twilio call failed for ${job.data.phone}. Error: ${error.message}`);
//     }
//   },
//   { connection: { url: process.env.UPSTASH_REDIS_URL } }
// );

// // -------------------- Base Route --------------------
// app.get("/", (req, res) => {
//   res.send("FlashFire API is up and running 🚀");
// });

// // -------------------- Routes & DB --------------------
// Routes(app);
// Connection();

// // -------------------- Start Server --------------------
// const PORT = process.env.PORT;
// if (!PORT) throw new Error('❌ process.env.PORT is not set. This is required for Render deployment.');

// app.listen(PORT || 4001, () => {
//   console.log('✅ Server is live at port:', PORT || 4001);
// });



import { handleCalendlyWebhook } from './Controllers/CalendlyWebhookController.js';
import express from 'express';
import Routes from './Routes.js';
import Connection from './Utils/ConnectDB.js';
import cors from 'cors';
import 'dotenv/config';
// Import callQueue - may be null if Redis is not available
// Primary call scheduling is handled by MongoDB-based CallScheduler
// BullMQ is only used as backup
import { callQueue } from './Utils/queue.js';
import Twilio from 'twilio';
import { DateTime } from 'luxon';
import { Logger } from './Utils/Logger.js';
import { basicFraudCheck } from './Utils/FraudScreening.js';
import { DiscordConnect } from './Utils/DiscordConnect.js';
import TwilioReminder from './Controllers/TwilioReminder.js';
import { CampaignBookingModel } from './Schema_Models/CampaignBooking.js';
import { UserModel } from './Schema_Models/User.js';
import { CampaignModel } from './Schema_Models/Campaign.js';
import { initGeoIp, getClientIp, detectCountryFromIp } from './Utils/GeoIP.js';
// DISABLED: Redis workers causing "Too many requests" rate limiting issues
// Using MongoDB-based JobScheduler instead for email and WhatsApp campaigns
// import emailWorker from './Utils/emailWorker.js';
// import whatsappWorker from './Utils/whatsappWorker.js';
// import './Utils/worker.js'; // Import worker to start it (handles callQueue jobs)
// import { redisConnection } from './Utils/queue.js'; // Import shared ioredis connection

import { startJobScheduler, getJobSchedulerStats } from './Utils/JobScheduler.js';
import { scheduleCall, cancelCall, startScheduler, getSchedulerStats, getUpcomingCalls } from './Utils/CallScheduler.js';
import { startWhatsAppReminderScheduler } from './Utils/WhatsAppReminderScheduler.js';
import { scheduleDiscordMeetReminder, startDiscordMeetReminderScheduler } from './Utils/DiscordMeetReminderScheduler.js';
import { getRescheduleLinkForBooking } from './Utils/CalendlyAPIHelper.js';
import watiService from './Utils/WatiService.js';
import compression from 'compression';
import { rateLimitMiddleware } from './Middlewares/RateLimiter.js';

// -------------------- Express Setup --------------------
const app = express();
// Respect proxy headers like X-Forwarded-For when deployed behind proxies (Render/NGINX/Cloudflare)
app.set('trust proxy', true);
const allowedOrigins = [
  "https://flashfire-frontend-hoisted.vercel.app", // your frontend
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5174/",
  "https://www.flashfirejobs.com",
  "https://flashfirejobs.com"
];

// Permissive CORS in production (allows all origins/headers). Safe with credentials when origin: true
app.use(
  cors({
    origin: true, // reflect request origin
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

// ✅ Handle preflight requests for all routes
// Handle preflight for any path (Express 5: avoid "*" pattern)
app.options(/.*/, cors({ origin: true, credentials: true }));
// app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6
}));




// -------------------- Discord Utility --------------------
export const DiscordConnectForMeet = async (message) => {
  const webhookURL = process.env.DISCORD_MEET_WEB_HOOK_URL;
  try {
    const response = await fetch(webhookURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `🚨 App Update: ${message}` }),
    });

    if (!response.ok) throw new Error(`Failed to send: ${response.statusText}`);

    console.log('✅ Message sent to Discord!');
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
};



// GET handler for /call-status (for testing/debugging)
app.get("/call-status", async (req, res) => {
  const discordWebhookConfigured = !!process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  const webhookUrlPreview = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL 
    ? `${process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL.substring(0, 30)}...` 
    : 'Not configured';

  // Check queue status
  let queueStatus = { available: false, waiting: 0, active: 0, completed: 0, failed: 0 };
  try {
    if (callQueue) {
      const waiting = await callQueue.getWaitingCount();
      const active = await callQueue.getActiveCount();
      const completed = await callQueue.getCompletedCount();
      const failed = await callQueue.getFailedCount();
      queueStatus = { available: true, waiting, active, completed, failed };
    }
  } catch (error) {
    console.error('Error checking queue status:', error);
  }

  res.status(200).json({
    message: "✅ Call Status Webhook Endpoint is active",
    endpoint: "/call-status",
    method: "POST (for Twilio webhooks)",
    status: "operational",
    discordWebhook: {
      configured: discordWebhookConfigured,
      urlPreview: webhookUrlPreview
    },
    queue: queueStatus,
    twilio: {
      fromNumber: process.env.TWILIO_FROM ? 'Configured' : 'Not configured',
      accountSid: process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'Not configured'
    },
    note: "This endpoint accepts POST requests from Twilio. Use POST method to send call status updates."
  });
});

// Diagnostic endpoint to check call system health
app.get("/api/call-system-status", async (req, res) => {
  try {
    const status = {
      timestamp: new Date().toISOString(),
      discord: {
        webhookConfigured: !!process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        urlPreview: process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL 
          ? `${process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL.substring(0, 40)}...` 
          : 'NOT CONFIGURED ⚠️'
      },
      twilio: {
        fromNumber: process.env.TWILIO_FROM || 'NOT CONFIGURED ⚠️',
        accountSid: process.env.TWILIO_ACCOUNT_SID ? 'Configured' : 'NOT CONFIGURED ⚠️',
        authToken: process.env.TWILIO_AUTH_TOKEN ? 'Configured' : 'NOT CONFIGURED ⚠️'
      },
      redis: {
        connected: !!redisConnection
      },
      queue: {
        available: !!callQueue
      }
    };

    // Get queue stats if available
    if (callQueue) {
      try {
        status.queue.waiting = await callQueue.getWaitingCount();
        status.queue.active = await callQueue.getActiveCount();
        status.queue.completed = await callQueue.getCompletedCount();
        status.queue.failed = await callQueue.getFailedCount();
      } catch (error) {
        status.queue.error = error.message;
      }
    }

    // Check recent bookings with call jobs
    try {
      const recentBookings = await CampaignBookingModel.find({
        reminderCallJobId: { $exists: true, $ne: null },
        bookingStatus: 'scheduled'
      })
      .sort({ bookingCreatedAt: -1 })
      .limit(5)
      .select('clientName clientPhone reminderCallJobId scheduledEventStartTime bookingCreatedAt')
      .lean();

      status.recentBookings = recentBookings.map(b => ({
        clientName: b.clientName,
        clientPhone: b.clientPhone,
        jobId: b.reminderCallJobId,
        meetingTime: b.scheduledEventStartTime,
        bookedAt: b.bookingCreatedAt
      }));
    } catch (error) {
      status.recentBookingsError = error.message;
    }

    res.status(200).json(status);
  } catch (error) {
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});


app.post("/api/debug/test-call", async (req, res) => {
  try {
    const { phone, meetingTime, email } = req.body || {};

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: phone (E.164 format, e.g. +19135551234)",
      });
    }

    if (!callQueue) {
      return res.status(500).json({
        success: false,
        error: "callQueue is not initialized. Check Redis connection.",
      });
    }

    if (!process.env.TWILIO_FROM || !process.env.TWILIO_ACCOUNT_SID) {
      return res.status(500).json({
        success: false,
        error: "Twilio environment variables are not fully configured.",
        twilio: {
          fromNumber: process.env.TWILIO_FROM || "NOT CONFIGURED",
          accountSid: process.env.TWILIO_ACCOUNT_SID ? "Configured" : "NOT CONFIGURED",
        },
      });
    }

    // Use a simple regex to validate E.164-like numbers
    const phoneRegex = /^\+?[1-9]\d{9,14}$/;
    if (!phoneRegex.test(phone)) {
      return res.status(400).json({
        success: false,
        error: "Invalid phone format. Use E.164 (e.g. +19135551234).",
      });
    }

    // Build a fake "meeting time" 10 minutes from now if not provided
    const eventStart = meetingTime
      ? DateTime.fromISO(meetingTime)
      : DateTime.now().plus({ minutes: 10 });

    const meetingTimeIndia = eventStart.setZone("Asia/Kolkata").toFormat("ff");

    // Small delay so you can see the job queued before it fires
    const delayMs = 5_000;

    const job = await callQueue.add(
      "callUser",
      {
        type: "call_reminder",
        phone,
        phoneNumber: phone, // Include both for compatibility with all workers
        meetingTime: meetingTimeIndia,
        inviteeEmail: email || null,
        eventStartISO: eventStart.toISO(),
        force: true,        // ⬅ bypass calendar presence check for debug
        source: "debug_api" // ⬅ mark as coming from debug endpoint
      },
      {
        delay: delayMs,
        removeOnComplete: true,
        removeOnFail: 10,
      }
    );

    const summary = {
      jobId: job.id,
      phone,
      meetingTimeIST: meetingTimeIndia,
      delayMs,
    };

    Logger.info("🧪 Enqueued debug test-call job", summary);

    // Fetch all scheduled calls (waiting and delayed jobs)
    let allScheduledCalls = [];
    try {
      const waitingJobs = await callQueue.getWaiting();
      const delayedJobs = await callQueue.getDelayed();
      const activeJobs = await callQueue.getActive();
      
      // Create sets of job IDs for quick lookup
      const delayedJobIds = new Set(delayedJobs.map(j => j.id));
      const activeJobIds = new Set(activeJobs.map(j => j.id));
      const waitingJobIds = new Set(waitingJobs.map(j => j.id));
      
      // Combine all jobs and remove duplicates by job ID
      const allJobsMap = new Map();
      [...waitingJobs, ...delayedJobs, ...activeJobs].forEach((job) => {
        if (!allJobsMap.has(job.id)) {
          allJobsMap.set(job.id, job);
        }
      });
      const allJobs = Array.from(allJobsMap.values());
      
      allScheduledCalls = allJobs.map((job) => {
        const jobData = job.data || {};
        
        // Calculate scheduled time
        let scheduledFor = null;
        if (job.timestamp) {
          scheduledFor = new Date(job.timestamp + (job.opts?.delay || 0)).toISOString();
        } else if (job.opts?.delay) {
          scheduledFor = new Date(Date.now() + job.opts.delay).toISOString();
        }
        
        // Determine status
        let status = 'unknown';
        if (activeJobIds.has(job.id)) {
          status = 'active';
        } else if (delayedJobIds.has(job.id)) {
          status = 'delayed';
        } else if (waitingJobIds.has(job.id)) {
          status = 'waiting';
        }
        
        return {
          jobId: job.id,
          phone: jobData.phone || 'N/A',
          email: jobData.inviteeEmail || jobData.email || null,
          meetingTime: jobData.meetingTime || 'N/A',
          scheduledFor: scheduledFor,
          scheduledForLocal: scheduledFor ? new Date(scheduledFor).toLocaleString() : 'N/A',
          status: status,
          source: jobData.source || jobData.type || 'unknown',
          delayMs: job.opts?.delay || 0,
        };
      }).sort((a, b) => {
        // Sort by scheduled time (earliest first)
        if (a.scheduledFor && b.scheduledFor) {
          return new Date(a.scheduledFor) - new Date(b.scheduledFor);
        }
        if (a.scheduledFor && !b.scheduledFor) return -1;
        if (!a.scheduledFor && b.scheduledFor) return 1;
        return 0;
      });
    } catch (error) {
      Logger.error("Error fetching scheduled calls", {
        error: error.message,
      });
    }

    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `🧪 **Debug Test Call Job Created**\n- Phone: ${phone}\n- Meeting Time (IST): ${meetingTimeIndia}\n- Delay: ${Math.round(
          delayMs / 1000
        )}s\n- Job ID: ${job.id}`
      );
    }

    res.status(200).json({
      success: true,
      message: "Debug call job enqueued. Watch Discord and /call-status for logs.",
      data: summary,
      allScheduledCalls: {
        total: allScheduledCalls.length,
        calls: allScheduledCalls,
        summary: {
          waiting: allScheduledCalls.filter(c => c.status === 'waiting').length,
          delayed: allScheduledCalls.filter(c => c.status === 'delayed').length,
          active: allScheduledCalls.filter(c => c.status === 'active').length,
        }
      },
    });
  } catch (error) {
    Logger.error("Error in /api/debug/test-call", {
      error: error.message,
      stack: error.stack,
    });

    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      await DiscordConnect(
        process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `❌ Error in /api/debug/test-call: ${error.message}`
      );
    }

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

function buildCallSummaryMessage(scheduledCall, meetingInfo, To, From, CallSid) {
  let summary = `✅ **Call Status Update (MongoDB Scheduler)**\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  
  // Add all status updates from history
  if (scheduledCall.statusHistory && scheduledCall.statusHistory.length > 0) {
    scheduledCall.statusHistory.forEach((statusUpdate, index) => {
      const statusDate = statusUpdate.timestamp ? new Date(statusUpdate.timestamp).toUTCString() : 'Unknown';
      
      summary += `\n🚨 **App Update: ${statusUpdate.status}**\n`;
      summary += `📞 **To:** ${To}\n`;
      summary += `👤 **From:** ${From}\n`;
      
      if (meetingInfo.inviteeName && meetingInfo.inviteeName !== 'Unknown') {
        summary += `👤 **Name:** ${meetingInfo.inviteeName}\n`;
      }
      
      summary += `👤 **Status:** ${statusUpdate.status}\n`;
      summary += `👤 **Answered By:** ${statusUpdate.answeredBy || 'Unknown'}\n`;
      
      if (statusUpdate.duration) {
        summary += `⏱️ **Duration:** ${statusUpdate.duration} seconds\n`;
      }
      
      summary += `👤 **Call SID:** ${CallSid}\n`;
      summary += `👤 **Timestamp:** ${statusDate}\n`;
      
      if (meetingInfo.inviteeEmail && meetingInfo.inviteeEmail !== 'Unknown') {
        summary += `📧 **Email:** ${meetingInfo.inviteeEmail}\n`;
      }
      
      if (meetingInfo.meetingTime && meetingInfo.meetingTime !== 'Unknown') {
        summary += `📆 **Meeting:** ${meetingInfo.meetingTime}\n`;
      }
      
      summary += `🎫 **Twilio SID:** ${CallSid}\n`;
      
      // Add separator between statuses (except for last one)
      if (index < scheduledCall.statusHistory.length - 1) {
        summary += `\n`;
      }
    });
  }
  
  summary += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  
  return summary;
}

// POST handler for /call-status (Twilio webhook)
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus, To, From, AnsweredBy, Timestamp, CallDuration } = req.body;

  try {
    // Log the raw request for debugging
    console.log(`📞 Call Status Webhook Received:`, {
      CallSid,
      CallStatus,
      To,
      From,
      AnsweredBy,
      Timestamp,
      CallDuration,
      receivedAt: new Date().toISOString()
    });

    Logger.info('📞 Call Status Update received from Twilio', {
      CallSid,
      CallStatus,
      To,
      From,
      AnsweredBy,
      Timestamp,
      CallDuration
    });

    let scheduledCall = null;
    let meetingInfo = {};
    let isFinalStatus = false;
    try {
      const { ScheduledCallModel } = await import('./Schema_Models/ScheduledCall.js');
      scheduledCall = await ScheduledCallModel.findOne({ twilioCallSid: CallSid });
      
      if (scheduledCall) {
        meetingInfo = {
          inviteeName: scheduledCall.inviteeName || 'Unknown',
          inviteeEmail: scheduledCall.inviteeEmail || 'Unknown',
          meetingTime: scheduledCall.meetingTime || 'Unknown'
        };
        
        // Track status history
        const statusTimestamp = Timestamp ? new Date(Timestamp) : new Date();
        const statusUpdate = {
          status: CallStatus,
          answeredBy: AnsweredBy || 'Unknown',
          timestamp: statusTimestamp,
          duration: CallDuration ? parseInt(CallDuration) : null,
          rawData: req.body
        };
        
        // Determine if this is a final status
        const finalStatuses = ['completed', 'busy', 'failed', 'no-answer', 'canceled'];
        isFinalStatus = finalStatuses.includes(CallStatus);
        
        // Update scheduled call with status history
        const statusMap = {
          'completed': 'completed',
          'busy': 'failed',
          'failed': 'failed',
          'no-answer': 'failed',
          'canceled': 'cancelled'
        };
        
        const updateData = {
          $push: { statusHistory: statusUpdate }
        };
        
        if (statusMap[CallStatus]) {
          updateData.status = statusMap[CallStatus];
          if (CallStatus === 'completed') {
            updateData.completedAt = new Date();
          }
        }
        
        await ScheduledCallModel.updateOne(
          { _id: scheduledCall._id },
          updateData
        );
        
        // Reload to get updated status history
        scheduledCall = await ScheduledCallModel.findById(scheduledCall._id);
      }
    } catch (lookupError) {
      console.warn('Could not lookup scheduled call:', lookupError.message);
    }

    // Format timestamp
    const statusTimestamp = Timestamp ? new Date(Timestamp).toISOString() : new Date().toISOString();
    const statusDate = Timestamp ? new Date(Timestamp).toUTCString() : new Date().toUTCString();

    // Build Discord message with real status information
    let msg = `🚨 **App Update: ${CallStatus}**\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📞 **To:** ${To}\n`;
    msg += `👤 **From:** ${From}\n`;
    
    if (meetingInfo.inviteeName && meetingInfo.inviteeName !== 'Unknown') {
      msg += `👤 **Name:** ${meetingInfo.inviteeName}\n`;
    }
    
    msg += `👤 **Status:** ${CallStatus}\n`;
    msg += `👤 **Answered By:** ${AnsweredBy || 'Unknown'}\n`;
    
    if (CallDuration) {
      msg += `⏱️ **Duration:** ${CallDuration} seconds\n`;
    }
    
    msg += `👤 **Call SID:** ${CallSid}\n`;
    msg += `👤 **Timestamp:** ${statusDate}\n`;
    
    if (meetingInfo.inviteeEmail && meetingInfo.inviteeEmail !== 'Unknown') {
      msg += `📧 **Email:** ${meetingInfo.inviteeEmail}\n`;
    }
    
    if (meetingInfo.meetingTime && meetingInfo.meetingTime !== 'Unknown') {
      msg += `📆 **Meeting:** ${meetingInfo.meetingTime}\n`;
    }
    
    msg += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    // Send Discord notification if configured
    const discordWebhookUrl = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    if (discordWebhookUrl) {
      Logger.info('Sending call status to Discord', { CallSid, CallStatus, hasWebhook: !!discordWebhookUrl });
      await DiscordConnect(discordWebhookUrl, msg);
      console.log('✅ Discord notification sent for call status');
      
      // If this is a final status, send comprehensive summary message
      if (isFinalStatus && scheduledCall && scheduledCall.statusHistory && scheduledCall.statusHistory.length > 0) {
        const summaryMsg = buildCallSummaryMessage(scheduledCall, meetingInfo, To, From, CallSid);
        await DiscordConnect(discordWebhookUrl, summaryMsg);
        console.log('✅ Discord summary notification sent for call completion');
      }
    } else {
      console.warn("⚠️ DISCORD_REMINDER_CALL_WEBHOOK_URL not configured. Discord notification skipped.");
      Logger.warn('Discord webhook URL not configured - skipping notification', { CallSid, CallStatus });
    }

    res.status(200).send("✅ Call status received");
  } catch (error) {
    console.error("❌ Error in /call-status:", error);
    Logger.error('Error processing call status webhook', { error: error.message, stack: error.stack });
    res.status(500).send("Server Error");
  }
});

// -------------------- Calendly Webhook --------------------
app.post('/calendly-webhook', rateLimitMiddleware({ points: 100, duration: 60 }), handleCalendlyWebhook);
app.post("/twilio-ivr", TwilioReminder);
// -------------------- Worker Setup --------------------
// Worker is now handled in Utils/worker.js to avoid duplicate connections
// This reduces Redis connection count and prevents "Too many requests" errors

// -------------------- Base Route --------------------
app.get("/", (req, res) => {
  res.send("FlashFire API is up and running 🚀");
});

// -------------------- GeoIP Route --------------------
app.get('/api/geo', (req, res) => {
  try {
    // Allow test overrides in dev: ?debugIp=1.2.3.4 or env FORCE_TEST_IP
    let ip = req.query?.debugIp || process.env.FORCE_TEST_IP || getClientIp(req);
    console.log('[GeoAPI] Incoming /api/geo request');
    console.log('[GeoAPI] Headers of interest:', {
      'cf-connecting-ip': req.headers['cf-connecting-ip'],
      'x-real-ip': req.headers['x-real-ip'],
      'x-forwarded-for': req.headers['x-forwarded-for'],
      remoteAddress: req.connection?.remoteAddress || req.socket?.remoteAddress
    });
    console.log('[GeoAPI] Resolved client IP:', ip);
    const geo = detectCountryFromIp(ip);
    console.log('[GeoAPI] Result:', geo);
    return res.json({
      success: true,
      countryCode: geo.countryCode,
      country: geo.country,
      ip: ip || undefined,
      detectionMethod: 'ip-geolocation'
    });
  } catch (error) {
    console.error('Geo detection error:', error);
    return res.json({
      success: false,
      countryCode: 'US',
      country: 'United States',
      detectionMethod: 'fallback'
    });
  }
});

// -------------------- Routes & DB --------------------
Routes(app);
Connection();

// -------------------- Start Server --------------------
const PORT = process.env.PORT;
if (!PORT) throw new Error('❌ process.env.PORT is not set. This is required for Render deployment.');

app.listen(PORT || 4001, async () => {
  console.log('✅ Server is live at port:', PORT || 4001);
  
  const { startCronScheduler } = await import('./Utils/cronScheduler.js');
  startCronScheduler();
  
  console.log('🚀 [Server] Starting MongoDB-based Call Scheduler...');
  startScheduler();
  startWhatsAppReminderScheduler(); // Start WhatsApp reminder scheduler
  startDiscordMeetReminderScheduler(); // Start Discord 2-minute meeting reminder scheduler
  
  // NEW: Start MongoDB-based Job Scheduler for email and WhatsApp campaigns
  // This replaces Redis/BullMQ workers with time-spreading and rate limiting
  console.log('🚀 [Server] Starting MongoDB-based Job Scheduler (replaces Redis workers)...');
  startJobScheduler();
  console.log('✅ [Server] Job Scheduler started - emails: 3 concurrent max, messages spread over 1 hour');
  
  try {
    await watiService.refreshTemplatesCache();
    console.log('✅ [Server] WATI template cache pre-warmed');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to pre-warm WATI template cache:', error.message);
  }

  try {
    const { ensureDefaultCampaigns } = await import('./Scripts/seedDefaultCampaigns.js');
    await ensureDefaultCampaigns();
    console.log('✅ [Server] Default UTM campaigns (whatsapp, instagram) ensured');
  } catch (error) {
    console.warn('⚠️ [Server] Failed to seed default campaigns:', error.message);
  }
});

// Initialize GeoIP after server startup
initGeoIp();

// -------------------- Scheduler API Endpoints --------------------
// Get scheduler stats
app.get('/api/scheduler/stats', async (req, res) => {
  try {
    const stats = await getSchedulerStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get upcoming calls
app.get('/api/scheduler/upcoming', async (req, res) => {
  try {
    const calls = await getUpcomingCalls(20);
    res.json({ success: true, calls });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// -------------------- Job Scheduler API Endpoints (Email/WhatsApp) --------------------
// Get job scheduler stats (MongoDB-based, replaces Redis)
app.get('/api/job-scheduler/stats', async (req, res) => {
  try {
    const stats = await getJobSchedulerStats();
    res.json({ success: true, ...stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});












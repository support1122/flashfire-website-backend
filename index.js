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



import express from 'express';
import Routes from './Routes.js';
import Connection from './Utils/ConnectDB.js';
import cors from 'cors';
import 'dotenv/config';
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
import emailWorker from './Utils/emailWorker.js';
import whatsappWorker from './Utils/whatsappWorker.js';
import './Utils/worker.js'; // Import worker to start it (handles callQueue jobs)
import { redisConnection } from './Utils/queue.js'; // Import shared ioredis connection
import { scheduleCall, cancelCall, startScheduler, getSchedulerStats, getUpcomingCalls } from './Utils/CallScheduler.js'; // MongoDB-based scheduler
import { startWhatsAppReminderScheduler } from './Utils/WhatsAppReminderScheduler.js'; // WhatsApp reminder scheduler
import { getRescheduleLinkForBooking } from './Utils/CalendlyAPIHelper.js';

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


const sentDiscordFingerprints = new Map();
const DISCORD_DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toLowerCase();
}

function buildDiscordFingerprint(details) {
  const parts = [
    normalizeString(details["Campaign ID"]),
    normalizeString(details["Invitee Name"]),
    normalizeString(details["Invitee Email"]),
    normalizeString(details["Invitee Phone"]),
    normalizeString(details["Google Meet Link"]),
    normalizeString(details["Meeting Time (Client US)"]),
    normalizeString(details["Meeting Time (Team India)"]),
    normalizeString(details["Booked At"]),
    normalizeString(details["UTM Source"]),
    normalizeString(details["UTM Medium"]),
    normalizeString(details["UTM Campaign"]),
    normalizeString(details["Database Status"])
  ];
  return parts.join('|');
}

function isDuplicateDiscord(details) {
  const now = Date.now();
  // Cleanup old entries
  for (const [key, ts] of sentDiscordFingerprints.entries()) {
    if (now - ts > DISCORD_DEDUP_TTL_MS) sentDiscordFingerprints.delete(key);
  }
  const fp = buildDiscordFingerprint(details);
  if (sentDiscordFingerprints.has(fp)) return true;
  sentDiscordFingerprints.set(fp, now);
  return false;
}


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
app.post('/calendly-webhook', async (req, res) => {
  const { event, payload } = req.body;
  Logger.info('Calendly webhook received', { event });
  Logger.info('Full Calendly webhook payload', { 
    event, 
    payload: JSON.stringify(payload, null, 2) 
  });
  
  try {
    if (event === "invitee.canceled") {
      // FIXED: Extract from payload directly (not payload.invitee) based on Calendly webhook structure
      const inviteePhone = payload?.questions_and_answers?.find(q =>
        q.question.trim().toLowerCase() === 'phone number'
      )?.answer?.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '') || null;
      const inviteeEmail = payload?.email || null;
      const inviteeName = payload?.name || 'Unknown';

      // Remove old reminder call job from BOTH schedulers
      let callCancelled = false;
      let whatsappCancelled = false;
      
      if (inviteeEmail || inviteePhone) {
        try {
          const existingBooking = await CampaignBookingModel.findOne({ clientEmail: inviteeEmail })
            .sort({ bookingCreatedAt: -1 });
          
          const meetingStartISO = existingBooking?.scheduledEventStartTime || existingBooking?.bookingCreatedAt;
          
          // Cancel in MongoDB scheduler (PRIMARY)
          if (inviteePhone && meetingStartISO) {
            const cancelResult = await cancelCall({
              phoneNumber: inviteePhone,
              meetingStartISO: meetingStartISO
            });
            if (cancelResult?.success) {
              callCancelled = true;
              Logger.info('Cancelled call in MongoDB scheduler', { callId: cancelResult.callId });
            }
            
            // Also cancel WhatsApp reminder
            const { cancelWhatsAppReminder } = await import('./Utils/WhatsAppReminderScheduler.js');
            const cancelWhatsAppResult = await cancelWhatsAppReminder({
              phoneNumber: inviteePhone,
              meetingStartISO: meetingStartISO
            });
            if (cancelWhatsAppResult?.success) {
              whatsappCancelled = true;
              Logger.info('Cancelled WhatsApp reminder', { reminderId: cancelWhatsAppResult.reminderId });
            }
          }
          
          // Cancel in BullMQ scheduler (BACKUP)
          if (existingBooking?.reminderCallJobId && callQueue) {
            const oldJobId = existingBooking.reminderCallJobId;
            try {
              const oldJob = await callQueue.getJob(oldJobId);
              if (oldJob) {
                await oldJob.remove();
                Logger.info('Removed call job from BullMQ', { jobId: oldJobId });
                callCancelled = true; // Mark as cancelled if BullMQ job existed
              }
            } catch (bullmqError) {
              Logger.warn('Could not remove BullMQ job (may not exist)', { error: bullmqError.message });
            }
          }
          
          // Send detailed Discord notification
          const discordMsg = `🗑️ **Meeting Cancelled - Reminders Cancelled**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 **Name:** ${inviteeName}\n` +
            `📧 **Email:** ${inviteeEmail}\n` +
            `📞 **Phone:** ${inviteePhone || 'Not Provided'}\n` +
            `📅 **Meeting Time:** ${existingBooking?.scheduledEventStartTime ? new Date(existingBooking.scheduledEventStartTime).toUTCString() : 'Not Available'}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ **Call Reminder:** ${callCancelled ? 'Cancelled' : 'Not Found'}\n` +
            `✅ **WhatsApp Reminder:** ${whatsappCancelled ? 'Cancelled' : 'Not Found'}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
          
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, discordMsg);
          
        } catch (error) {
          Logger.error('Failed to cancel reminders', { 
            error: error.message, 
            phone: inviteePhone,
            email: inviteeEmail 
          });
          const message = `🗑️ **Error in Cancelling Reminders**\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `� **Email:** ${inviteeEmail}\n` +
            `📞 **Phone:** ${inviteePhone || 'Not Provided'}\n` +
            `� **Meeting Time:** ${existingBooking?.scheduledEventStartTime ? new Date(existingBooking.scheduledEventStartTime).toUTCString() : 'Not Available'}\n` +
            `�👤 **Error:** ${error.message}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, message);
        }
      }

      // Update booking status to canceled
      if (inviteeEmail) {
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          { 
            bookingStatus: 'canceled',
            canceledAt: new Date()
          },
          { sort: { bookingCreatedAt: -1 } }
        );
      }

      return res.status(200).json({ message: 'Invitee canceled, job removed' });
    }

    // ==================== HANDLE RESCHEDULED EVENTS ====================
    if (event === "invitee.rescheduled") {
      Logger.info('Processing rescheduled meeting');
      
      const { old_invitee, new_invitee } = payload;
      Logger.info('Rescheduled event payload structure', {
        hasOldInvitee: !!old_invitee,
        hasNewInvitee: !!new_invitee,
        oldInviteeKeys: old_invitee ? Object.keys(old_invitee) : [],
        newInviteeKeys: new_invitee ? Object.keys(new_invitee) : [],
        oldRescheduleUrl: old_invitee?.reschedule_url,
        newRescheduleUrl: new_invitee?.reschedule_url
      });
      
      const inviteeEmail = new_invitee?.email || old_invitee?.email;
      
      let inviteePhone = new_invitee?.questions_and_answers?.find(q =>
        q.question.trim().toLowerCase() === 'phone number'
      )?.answer || null;

      if (!inviteePhone) {
        inviteePhone = old_invitee?.questions_and_answers?.find(q =>
          q.question.trim().toLowerCase() === 'phone number'
        )?.answer || null;
      }

      if (inviteePhone) {
        inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
      }

      const oldStartTime = old_invitee?.scheduled_event?.start_time;
      const newStartTime = new_invitee?.scheduled_event?.start_time;
      
      Logger.info('Meeting rescheduled', { 
        email: inviteeEmail, 
        phone: inviteePhone,
        oldTime: oldStartTime,
        newTime: newStartTime 
      });

      if (inviteeEmail) {
        try {
          const existingBooking = await CampaignBookingModel.findOne({ clientEmail: inviteeEmail })
            .sort({ bookingCreatedAt: -1 });
          
          // Cancel old call reminder from BullMQ
          if (existingBooking?.reminderCallJobId && callQueue) {
            const oldJobId = existingBooking.reminderCallJobId;
            const oldJob = await callQueue.getJob(oldJobId);
            
            if (oldJob) {
              await oldJob.remove();
              Logger.info('Removed old reminder call job from queue', { 
                jobId: oldJobId, 
                phone: inviteePhone 
              });
            } else {
              Logger.warn('Old job not found in queue (may have already executed)', { 
                jobId: oldJobId, 
                phone: inviteePhone 
              });
            }
          }
          
          // Cancel MongoDB-based call reminder
          if (inviteePhone && oldStartTime) {
            const { cancelCall } = await import('./Utils/CallScheduler.js');
            const cancelResult = await cancelCall({
              phoneNumber: inviteePhone,
              meetingStartISO: oldStartTime
            });
            if (cancelResult.success) {
              Logger.info('Cancelled old MongoDB call reminder', { callId: cancelResult.callId });
            }
          }
          
          // Cancel old WhatsApp reminder
          if (inviteePhone && oldStartTime) {
            const { cancelWhatsAppReminder } = await import('./Utils/WhatsAppReminderScheduler.js');
            const cancelWhatsAppResult = await cancelWhatsAppReminder({
              phoneNumber: inviteePhone,
              meetingStartISO: oldStartTime
            });
            if (cancelWhatsAppResult.success) {
              Logger.info('Cancelled old WhatsApp reminder', { reminderId: cancelWhatsAppResult.reminderId });
            }
          }
          
          if (existingBooking?.reminderCallJobId || (inviteePhone && oldStartTime)) {
            await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
              `🗑️ Cancelled old reminders for rescheduled meeting. Email: ${inviteeEmail}, Phone: ${inviteePhone}`
            );
          } else {
            Logger.warn('No reminderCallJobId found in database for this booking', { 
              email: inviteeEmail 
            });
          }
        } catch (error) {
          Logger.error('Failed to remove old reminders', { 
            error: error.message, 
            phone: inviteePhone,
            email: inviteeEmail 
          });
        }
      }

      const newMeetingStart = new Date(newStartTime);
      const newDelay = newMeetingStart.getTime() - Date.now() - (10 * 60 * 1000);

      if (newDelay < 0) {
        Logger.warn('Rescheduled meeting is too soon for reminder call', { newStartTime });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠️ Rescheduled meeting too soon (${inviteeEmail}). Cannot schedule reminder call.`
        );
        return res.status(200).json({ message: 'Rescheduled meeting too soon for call' });
      }

      const newMeetingStartUTC = DateTime.fromISO(newStartTime, { zone: 'utc' });
      const newMeetingTimeIndia = newMeetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

      const inviteeName = new_invitee?.name || old_invitee?.name;
      const meetLink = new_invitee?.scheduled_event?.location?.join_url || 
                       old_invitee?.scheduled_event?.location?.join_url || 
                       'Not Provided';
      
      // FIXED: Use payload.reschedule_url only (not nested invitee)
      const newRescheduleLink = payload?.reschedule_url || null;
      Logger.info('Reschedule link extraction', {
        newRescheduleLink,
        hasNewRescheduleLink: !!newRescheduleLink,
        topLevelRescheduleUrl: payload?.reschedule_url,
        nestedRescheduleUrl: new_invitee?.reschedule_url,
        source: payload?.reschedule_url ? 'payload.reschedule_url' : (new_invitee?.reschedule_url ? 'new_invitee.reschedule_url' : 'NOT FOUND'),
        newInviteeStructure: new_invitee ? Object.keys(new_invitee) : [],
        payloadKeys: Object.keys(payload || {})
      });

      // Extract invitee_timezone from rescheduled webhook payload
      const newInviteeTimezone = new_invitee?.timezone || payload?.timezone || null;
      
      Logger.info('Extracted invitee timezone from rescheduled webhook', {
        newInviteeTimezone,
        hasNewInviteeTimezone: !!newInviteeTimezone,
        newInviteeKeys: new_invitee ? Object.keys(new_invitee) : []
      });

      if (inviteeEmail) {
        const updateData = { 
          bookingStatus: 'rescheduled',
          rescheduledFrom: oldStartTime,
          rescheduledTo: newStartTime,
          rescheduledAt: new Date(),
          scheduledEventStartTime: newStartTime,
          $inc: { rescheduledCount: 1 }
        };
        
        // ✅ FIXED: Always update reschedule link if available
        if (newRescheduleLink) {
          updateData.calendlyRescheduleLink = newRescheduleLink;
          Logger.info('Updating booking with reschedule link', { 
            email: inviteeEmail,
            rescheduleLink: newRescheduleLink
          });
        } else {
          Logger.warn('No reschedule link in webhook - Calendly may not be providing it', {
            email: inviteeEmail,
            eventType: event
          });
        }
        
        // ✅ Update invitee_timezone if available in rescheduled webhook
        if (newInviteeTimezone) {
          updateData.inviteeTimezone = newInviteeTimezone;
          Logger.info('Updating booking with invitee timezone from rescheduled webhook', { 
            email: inviteeEmail,
            inviteeTimezone: newInviteeTimezone
          });
        }
        
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          updateData,
          { sort: { bookingCreatedAt: -1 } }
        );
        Logger.info('Updated booking with reschedule info', { 
          email: inviteeEmail,
          newRescheduleLink: newRescheduleLink ? 'saved' : 'not available'
        });
      }

      // Schedule NEW reminder call
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      if (inviteePhone && phoneRegex.test(inviteePhone)) {
        if (inviteePhone.startsWith("+91")) {
          Logger.info('Skipping India number for rescheduled meeting', { phone: inviteePhone });
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
            `🔁 Rescheduled but skipping India number: ${inviteePhone}`
          );
          return res.status(200).json({ message: 'Rescheduled but skipped India number' });
        }

        const newMeetLink = new_invitee?.scheduled_event?.location?.join_url || 
                           old_invitee?.scheduled_event?.location?.join_url || 
                           'Not Provided';
        
        // ✅ FIXED: Use reschedule link with proper fallback
        const rescheduleLinkForReminder = newRescheduleLink || 
                                         old_invitee?.reschedule_url || 
                                         'https://calendly.com/flashfirejobs';
        
        Logger.info('Using reschedule link for reminder', {
          link: rescheduleLinkForReminder,
          source: newRescheduleLink ? 'new_invitee' : (old_invitee?.reschedule_url ? 'old_invitee' : 'default')
        });
        
        const newEndTime = new_invitee?.scheduled_event?.end_time || 
                          old_invitee?.scheduled_event?.end_time || null;

        // Get booking to pass bookingId in metadata
        const rescheduledBooking = await CampaignBookingModel.findOne({ clientEmail: inviteeEmail })
          .sort({ bookingCreatedAt: -1 });

        // Schedule MongoDB call (primary)
        const mongoRescheduleResult = await scheduleCall({
          phoneNumber: inviteePhone,
          meetingStartISO: newStartTime,
          meetingTime: newMeetingTimeIndia,
          inviteeName,
          inviteeEmail,
          source: 'reschedule',
          meetingLink: newMeetLink !== 'Not Provided' ? newMeetLink : null,
          rescheduleLink: rescheduleLinkForReminder,
          metadata: {
            bookingId: rescheduledBooking?.bookingId,
            rescheduledFrom: oldStartTime,
            rescheduledTo: newStartTime,
            meetingEndISO: newEndTime,
            inviteeTimezone: newInviteeTimezone // ✅ Pass invitee_timezone to CallScheduler
          }
        });

        if (mongoRescheduleResult.success) {
          console.log('✅ [MongoDB Scheduler] Rescheduled call and WhatsApp reminder scheduled:', mongoRescheduleResult.callId);
        }

        // BullMQ backup
        const uniqueJobId = `${inviteePhone}_${newStartTime}`;
        
        const newJob = await callQueue.add(
          'callUser',
          {
            phone: inviteePhone,
            phoneNumber: inviteePhone,
            meetingTime: newMeetingTimeIndia,
            role: 'client',
            inviteeEmail,
            eventStartISO: newStartTime,
          },
          {
            jobId: uniqueJobId,
            delay: newDelay,
            removeOnComplete: true,
            removeOnFail: 100,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 60000
            }
          }
        );

        // Update database with new job ID
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          { 
            reminderCallJobId: mongoRescheduleResult.callId || newJob.id.toString(),
            bookingStatus: 'scheduled'
          },
          { sort: { bookingCreatedAt: -1 } }
        );

        console.log('\n🔁 ========================================');
        console.log('🔁 [API] Meeting Rescheduled - New Call Job Created!');
        console.log('🔁 ========================================');
        console.log('   • New Job ID:', newJob.id);
        console.log('   • Unique Job ID:', uniqueJobId);
        console.log('   • Phone:', inviteePhone);
        console.log('   • Name:', inviteeName);
        console.log('   • Old Time:', DateTime.fromISO(oldStartTime, { zone: 'utc' }).setZone('Asia/Kolkata').toFormat('ff'));
        console.log('   • New Time:', newMeetingTimeIndia);
        console.log('   • Reschedule Link:', rescheduleLinkForReminder);
        console.log('   • New Delay:', Math.round(newDelay / 1000), 'seconds');
        console.log('========================================\n');

        Logger.info('Scheduled NEW reminder call for rescheduled meeting', { 
          phone: inviteePhone, 
          newDelayMs: newDelay,
          newMeetingTime: newMeetingTimeIndia,
          jobId: newJob.id,
          uniqueJobId,
          rescheduleLink: rescheduleLinkForReminder,
          retryAttempts: 3
        });

        const rescheduleMessage = `🔁 **Meeting Rescheduled**
- Client: ${inviteeName} (${inviteeEmail})
- Phone: ${inviteePhone}
- Old Time: ${DateTime.fromISO(oldStartTime, { zone: 'utc' }).setZone('Asia/Kolkata').toFormat('ff')} (IST)
- New Time: ${newMeetingTimeIndia} (IST)
- Reschedule Link: ${rescheduleLinkForReminder}
- Reminder Call: Scheduled 10 minutes before new time
- Job ID: ${newJob.id}
- Unique ID: ${uniqueJobId}`;

        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, rescheduleMessage);
      } else {
        Logger.warn('No valid phone for rescheduled meeting', { phone: inviteePhone });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠️ Rescheduled meeting but no valid phone: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
        );
      }

      return res.status(200).json({
        message: 'Rescheduled meeting processed successfully',
        oldTime: oldStartTime,
        newTime: newStartTime,
        reminderScheduled: !!inviteePhone,
        rescheduleLink: newRescheduleLink || 'Not provided by Calendly'
      });
    }

    // ==================== HANDLE CREATED EVENTS ====================
    if (event === "invitee.created") {
      Logger.info('Calendly payload received');

      const inviteeName = payload?.invitee?.name || payload?.name;
      const inviteeEmail = payload?.invitee?.email || payload?.email;
      let inviteePhone = payload?.questions_and_answers?.find(q =>
        q.question.trim().toLowerCase() === 'phone number'
      )?.answer || null;

      if (inviteePhone) {
        inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
      }

      const meetingStart = new Date(payload?.scheduled_event?.start_time);
      
      if (isNaN(meetingStart.getTime())) {
        Logger.error('Invalid meeting start time received from Calendly', {
          startTime: payload?.scheduled_event?.start_time,
          inviteeEmail
        });
        return res.status(400).json({ 
          error: 'Invalid meeting start time',
          message: 'Could not parse meeting start time from Calendly webhook'
        });
      }

      const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);
      
      const callExecutionTime = new Date(Date.now() + delay);
      const meetingTimeFormatted = meetingStart.toISOString();
      const callTimeFormatted = callExecutionTime.toISOString();

      Logger.info('📅 Meeting scheduled - calculating call delay', {
        inviteeName,
        inviteeEmail,
        meetingStart: meetingTimeFormatted,
        currentTime: new Date().toISOString(),
        delayMs: delay,
        delayMinutes: Math.round(delay / 60000),
        callWillExecuteAt: callTimeFormatted,
        callWillExecuteInMinutes: Math.round(delay / 60000)
      });

      if (delay < 0) {
        const minutesUntilMeeting = Math.round(-delay / 60000);
        Logger.warn('⚠️ Meeting is too soon to schedule calls - skipping reminder', { 
          inviteeName,
          inviteeEmail,
          meetingStart: meetingTimeFormatted,
          delayMs: delay,
          meetingInMinutes: minutesUntilMeeting
        });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠️ Meeting too soon for reminder call: ${inviteeName || 'Unknown'} (${inviteeEmail || 'Unknown'}). Meeting in ${minutesUntilMeeting} minutes.`
        );
      }

      const meetingStartUTC = DateTime.fromISO(payload?.scheduled_event?.start_time, { zone: 'utc' });
      const meetingTimeUS = meetingStartUTC.setZone('America/New_York').toFormat('ff');
      const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');
      const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
      const bookedAt = new Date(req.body?.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      
      // ✅ CRITICAL: Extract and log reschedule link (FIXED: use payload.reschedule_url only)
      let rescheduleLink = payload?.reschedule_url || null;
      
      Logger.info('Reschedule link from invitee.created webhook', {
        rescheduleLink,
        hasRescheduleLink: !!rescheduleLink,
        topLevelRescheduleUrl: payload?.reschedule_url,
        inviteeUri: payload?.invitee?.uri,
        inviteeKeys: payload?.invitee ? Object.keys(payload.invitee) : [],
        payloadKeys: Object.keys(payload || {})
      });
      
      // If reschedule link is not in webhook, try fetching from Calendly API
      if (!rescheduleLink && payload?.invitee?.uri) {
        try {
          const { fetchRescheduleLinkFromCalendly } = await import('./Utils/CalendlyAPIHelper.js');
          const fetchedLink = await fetchRescheduleLinkFromCalendly(payload.invitee.uri);
          if (fetchedLink) {
            rescheduleLink = fetchedLink;
            console.log('✅ [Calendly Webhook] Fetched reschedule link from Calendly API:', rescheduleLink);
          }
        } catch (error) {
          console.warn('⚠️ [Calendly Webhook] Could not fetch reschedule link from API:', error.message);
        }
      }

      // Extract UTM parameters
      const utmSource = payload?.tracking?.utm_source || 'direct';
      const utmMedium = payload?.tracking?.utm_medium || null;
      const utmCampaign = payload?.tracking?.utm_campaign || null;
      const utmContent = payload?.tracking?.utm_content || null;
      const utmTerm = payload?.tracking?.utm_term || null;

      const anythingToKnow = payload?.questions_and_answers?.find(q =>
        q.question.toLowerCase().includes('anything') || 
        q.question.toLowerCase().includes('prepare')
      )?.answer || null;

      const scheduledStartISO = payload?.scheduled_event?.start_time;
      const duplicateQuery = {
        scheduledEventStartTime: scheduledStartISO,
        $or: [
          { clientEmail: inviteeEmail },
          inviteePhone ? { clientPhone: inviteePhone } : null,
          meetLink && meetLink !== 'Not Provided' ? { calendlyMeetLink: meetLink } : null,
        ].filter(Boolean)
      };
      const existingBooking = await CampaignBookingModel.findOne(duplicateQuery);

      if (existingBooking) {
        Logger.warn('🔄 Duplicate booking detected - already exists in database', {
          email: inviteeEmail,
          phone: inviteePhone,
          meetLink,
          existingBookingId: existingBooking.bookingId,
          existingTime: existingBooking.scheduledEventStartTime
        });
        return res.status(200).json({
          message: 'Duplicate booking detected and suppressed',
          duplicate: true,
          existingBookingId: existingBooking.bookingId
        });
      }

      // Find campaign by UTM source
      let campaignId = null;
      let campaign = await CampaignModel.findOne({ utmSource });
      
      if (campaign) {
        campaignId = campaign.campaignId;
        Logger.info('✅ Campaign found for booking', { campaignId, utmSource });
      } else {
        Logger.warn('⚠️ No campaign found for UTM source - Creating virtual campaign', { utmSource });
        
        try {
          const virtualCampaign = new CampaignModel({
            campaignName: utmSource,
            utmSource: utmSource,
            utmMedium: utmMedium || 'direct',
            utmCampaign: utmCampaign || 'calendly_direct',
            generatedUrl: `https://calendly.com/feedback-flashfire/30min?utm_source=${utmSource}&utm_medium=${utmMedium || 'direct'}`,
            baseUrl: 'https://calendly.com/feedback-flashfire/30min',
            isActive: true
          });
          
          await virtualCampaign.save();
          campaignId = virtualCampaign.campaignId;
          
          Logger.info('✅ Virtual campaign created', {
            campaignId,
            utmSource,
            campaignName: virtualCampaign.campaignName
          });
        } catch (error) {
          Logger.error('❌ Failed to create virtual campaign', { error: error.message, utmSource });
        }
      }

      // Extract invitee_timezone from webhook payload
      const inviteeTimezone = payload?.invitee?.timezone || payload?.timezone || null;
      
      Logger.info('Extracted invitee timezone from webhook', {
        inviteeTimezone,
        hasInviteeTimezone: !!inviteeTimezone,
        inviteeKeys: payload?.invitee ? Object.keys(payload.invitee) : []
      });

      // Create booking object
      const newBooking = new CampaignBookingModel({
        campaignId,
        utmSource: utmSource || 'direct',
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        clientName: inviteeName,
        clientEmail: inviteeEmail,
        clientPhone: inviteePhone,
        calendlyEventUri: payload?.scheduled_event?.uri,
        calendlyInviteeUri: payload?.invitee?.uri,
        calendlyMeetLink: meetLink,
        calendlyRescheduleLink: rescheduleLink, // ✅ Save reschedule link
        scheduledEventStartTime: payload?.scheduled_event?.start_time,
        scheduledEventEndTime: payload?.scheduled_event?.end_time,
        inviteeTimezone: inviteeTimezone, // ✅ Save invitee timezone from webhook
        anythingToKnow,
        questionsAndAnswers: payload?.questions_and_answers,
        visitorId: null,
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.connection.remoteAddress,
        bookingStatus: 'scheduled'
      });

      await newBooking.save();

      // Mark user as booked
      try {
        const escapedEmail = inviteeEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        await UserModel.updateOne(
          { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
          { $set: { booked: true } }
        );
        Logger.info('✅ User marked as booked:', { email: inviteeEmail });
      } catch (userUpdateError) {
        Logger.warn('⚠️ Failed to update user booked status:', { 
          email: inviteeEmail, 
          error: userUpdateError.message 
        });
      }

      Logger.info('✅ Booking saved', {
        bookingId: newBooking.bookingId,
        campaignId: newBooking.campaignId,
        utmSource: newBooking.utmSource,
        clientName: newBooking.clientName,
        clientEmail: newBooking.clientEmail,
        clientPhone: newBooking.clientPhone,
        calendlyMeetLink: newBooking.calendlyMeetLink,
        rescheduleLink: newBooking.calendlyRescheduleLink // ✅ Log reschedule link
      });

      // Prepare booking details for Discord
      const bookingDetails = {
        "Booking ID": newBooking.bookingId,
        "Campaign ID": newBooking.campaignId || 'N/A',
        "Invitee Name": inviteeName,
        "Invitee Email": inviteeEmail,
        "Invitee Phone": inviteePhone || 'Not Provided',
        "Google Meet Link": meetLink,
        "Reschedule Link": rescheduleLink || 'Not Provided', // ✅ Include in Discord
        "Meeting Time (Client US)": meetingTimeUS,
        "Meeting Time (Team India)": meetingTimeIndia,
        "Booked At": bookedAt,
        "UTM Source": utmSource,
        "UTM Medium": utmMedium || 'N/A',
        "UTM Campaign": utmCampaign || 'N/A',
        "Database Status": "✅ SAVED"
      };

      if (payload.tracking.utm_source !== 'webpage_visit' && payload.tracking.utm_source !== null && payload.tracking.utm_source !== 'direct') {
        const utmData = {
          clientName: inviteeName,
          clientEmail: inviteeEmail,
          clientPhone: inviteePhone || 'Not Provided',
          utmSource: payload?.tracking?.utm_source,
        };
        await fetch('https://clients-tracking-backend.onrender.com/api/track/utm-campaign-lead', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(utmData)
        });
        console.log('✅ UTM campaign lead tracked to external service:', utmData);
      }

      Logger.info('New Calendly booking', bookingDetails);

      if (!isDuplicateDiscord(bookingDetails)) {
        await DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2));
      } else {
        Logger.warn('Duplicate Discord message suppressed (fingerprint match)', {
          inviteeEmail,
          inviteePhone,
          scheduledStartISO
        });
      }

      // Validate phone numbers
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      let scheduledJobs = [];
      
      if (inviteePhone && inviteePhone.startsWith("+91")) {
        Logger.info('Skipping India number', { phone: inviteePhone });
        if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, `Skipping India number: ${inviteePhone}`);
        }
        return res.status(200).json({ message: 'Skipped India number' });
      }

      // Schedule call if delay is positive
      if (inviteePhone && phoneRegex.test(inviteePhone) && delay > 0) {
        const meetingLink = meetLink && meetLink !== 'Not Provided' ? meetLink : null;
        let rescheduleLinkForReminder = newBooking?.calendlyRescheduleLink || rescheduleLink;
        
        if (!rescheduleLinkForReminder && newBooking?.calendlyInviteeUri) {
          try {
            const fetchedLink = await getRescheduleLinkForBooking(newBooking);
            if (fetchedLink) {
              rescheduleLinkForReminder = fetchedLink;
              console.log('✅ [Calendly Webhook] Fetched reschedule link for reminder from API:', rescheduleLinkForReminder);
            }
          } catch (error) {
            console.warn('⚠️ [Calendly Webhook] Could not fetch reschedule link for reminder:', error.message);
          }
        }
        
        // Fallback to default
        if (!rescheduleLinkForReminder) {
          rescheduleLinkForReminder = 'https://calendly.com/flashfirejobs';
          Logger.warn('Using default reschedule link - Calendly did not provide one', {
            bookingId: newBooking.bookingId
          });
        }
        
        const meetingEndTime = payload?.scheduled_event?.end_time || null;
        
        const mongoResult = await scheduleCall({
          phoneNumber: inviteePhone,
          meetingStartISO: payload?.scheduled_event?.start_time,
          meetingTime: meetingTimeIndia,
          inviteeName,
          inviteeEmail,
          source: 'calendly',
          meetingLink: meetingLink,
          rescheduleLink: rescheduleLinkForReminder,
          metadata: {
            bookingId: newBooking?.bookingId,
            eventUri: payload?.scheduled_event?.uri,
            inviteeTimezone: inviteeTimezone, // ✅ Pass invitee_timezone to CallScheduler
            meetingEndISO: meetingEndTime
          }
        });

        if (mongoResult.success) {
          console.log('✅ [MongoDB Scheduler] Call scheduled successfully:', mongoResult.callId);
          scheduledJobs.push(`Client: ${inviteePhone} (MongoDB)`);
          
          // Update booking with call ID
          if (newBooking?.bookingId) {
            await CampaignBookingModel.findOneAndUpdate(
              { bookingId: newBooking.bookingId },
              { reminderCallJobId: mongoResult.callId }
            );
          }
        } else {
          console.warn('⚠️ [MongoDB Scheduler] Failed to schedule:', mongoResult.error);
        }

        // BullMQ Backup
        try {
          const uniqueJobId = `${inviteePhone}_${payload?.scheduled_event?.start_time}`;
          
          const existingJob = callQueue ? await callQueue.getJob(uniqueJobId) : null;
          if (existingJob) {
            Logger.info('BullMQ job already exists - skipping', { jobId: uniqueJobId });
          } else if (callQueue) {
            const job = await callQueue.add(
              'callUser',
              {
                phone: inviteePhone,
                phoneNumber: inviteePhone,
                meetingTime: meetingTimeIndia,
                role: 'client',
                inviteeEmail,
                eventStartISO: payload?.scheduled_event?.start_time,
              },
              {
                jobId: uniqueJobId,
                delay,
                removeOnComplete: true,
                removeOnFail: 100,
                attempts: 3,
                backoff: { type: 'exponential', delay: 60000 }
              }
            );
            console.log('✅ [BullMQ Backup] Also scheduled in BullMQ:', job.id);
          }
        } catch (bullmqError) {
          console.warn('⚠️ [BullMQ Backup] Failed (MongoDB will handle it):', bullmqError.message);
        }
          
        const callExecutionTime = new Date(Date.now() + delay);
        const meetingTimeUTC = new Date(payload?.scheduled_event?.start_time);
        const timeDifference = meetingTimeUTC.getTime() - callExecutionTime.getTime();
        const minutesDifference = Math.round(timeDifference / 60000);

        console.log('\n📞 ========================================');
        console.log('📞 [API] Call Reminder Scheduled!');
        console.log('📞 ========================================');
        console.log('   • MongoDB Call ID:', mongoResult.callId);
        console.log('   • Phone:', inviteePhone);
        console.log('   • Name:', inviteeName);
        console.log('   • Email:', inviteeEmail);
        console.log('   • Meeting Time (IST):', meetingTimeIndia);
        console.log('   • Reschedule Link:', rescheduleLinkForReminder);
        console.log('   • Delay:', Math.round(delay / 60000), 'minutes');
        console.log('========================================\n');
          
        Logger.info('Call scheduled via MongoDB scheduler', { 
          phone: inviteePhone, 
          delayMinutes: Math.round(delay / 60000), 
          callId: mongoResult.callId,
          rescheduleLink: rescheduleLinkForReminder,
          retryAttempts: 3
        });
        
        const scheduledMessage = `📞 **Reminder Call Scheduled!**\n• MongoDB Call ID: ${mongoResult.callId}\n• Client: ${inviteeName} (${inviteePhone})\n• Meeting: ${meetingTimeIndia} (IST)\n• Reschedule Link: ${rescheduleLinkForReminder}\n• Reminder: 10 minutes before meeting`;
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, scheduledMessage);
        
      } else if (delay <= 0) {
        Logger.warn('Skipping call scheduling - meeting too soon or invalid phone', {
          phone: inviteePhone,
          delayMs: delay,
          hasValidPhone: inviteePhone && phoneRegex.test(inviteePhone)
        });
      } else {
        Logger.warn('No valid phone number provided by invitee', { phone: inviteePhone });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
        );
      }

      Logger.info('Scheduled calls summary', { jobs: scheduledJobs, count: scheduledJobs.length });
      const discordWebhookUrl = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
      if (discordWebhookUrl) {
        await DiscordConnect(discordWebhookUrl, `✅ Scheduled calls: ${scheduledJobs.join(', ')}`);
      } else {
        Logger.warn('Discord webhook URL not configured');
      }

      return res.status(200).json({
        message: 'Webhook received & calls scheduled',
        bookingDetails,
        scheduledCalls: scheduledJobs,
        rescheduleLink: rescheduleLink || 'Not provided by Calendly'
      });
    }

    return res.status(200).json({ message: 'Ignored non-invitee event' });

  } catch (error) {
    console.error('❌ Error processing Calendly webhook:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
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















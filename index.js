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

// POST handler for /call-status (Twilio webhook)
app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus, To, From, AnsweredBy, Timestamp } = req.body;

  try {
    // Log the raw request for debugging
    console.log(`📞 Call Status Webhook Received:`, {
      CallSid,
      CallStatus,
      To,
      From,
      AnsweredBy,
      Timestamp,
      receivedAt: new Date().toISOString()
    });

    Logger.info('📞 Call Status Update received from Twilio', {
      CallSid,
      CallStatus,
      To,
      From,
      AnsweredBy,
      Timestamp
    });

    // Get queue statistics for context
    let queueStats = {};
    try {
      const { callQueue } = await import('./Utils/queue.js');
      queueStats = {
        waiting: await callQueue?.getWaitingCount() || 0,
        active: await callQueue?.getActiveCount() || 0,
        completed: await callQueue?.getCompletedCount() || 0,
        failed: await callQueue?.getFailedCount() || 0,
        delayed: await callQueue?.getDelayedCount() || 0
      };
    } catch (statsError) {
      console.warn('Could not fetch queue stats:', statsError.message);
    }

    const totalCalls = (queueStats.waiting || 0) + (queueStats.active || 0) + (queueStats.delayed || 0) + (queueStats.completed || 0) + (queueStats.failed || 0);

    const msg = `
📞 **Call Status Update**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📞 **Call Details:**
• To: ${To}
• From: ${From}
• Status: ${CallStatus}
• Answered By: ${AnsweredBy || "Unknown"}
• Call SID: ${CallSid}
• Timestamp: ${Timestamp || new Date().toISOString()}

📊 **Queue Statistics:**
• Waiting: ${queueStats.waiting || 0}
• Active: ${queueStats.active || 0}
• Delayed: ${queueStats.delayed || 0}
• Completed: ${queueStats.completed || 0}
• Failed: ${queueStats.failed || 0}
• **Total Calls: ${totalCalls}**

⏰ **Update Time:**
• Received At: ${new Date().toISOString()}
• Received At (Local): ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `.trim();

    // Send Discord notification if configured
    const discordWebhookUrl = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    if (discordWebhookUrl) {
      Logger.info('Sending call status to Discord', { CallSid, CallStatus, hasWebhook: !!discordWebhookUrl });
      await DiscordConnect(discordWebhookUrl, msg);
      console.log('✅ Discord notification sent for call status');
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
  try {
    if (event === "invitee.canceled") {
      const inviteePhone = payload?.invitee?.questions_and_answers?.find(q =>
        q.question.trim().toLowerCase() === 'phone number'
      )?.answer?.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '') || null;
      const inviteeEmail = payload?.invitee?.email || payload?.email;

      // Remove old reminder call job from BOTH schedulers
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
            if (cancelResult.success) {
              Logger.info('Cancelled call in MongoDB scheduler', { callId: cancelResult.callId });
            }
            
            // Also cancel WhatsApp reminder
            const { cancelWhatsAppReminder } = await import('./Utils/WhatsAppReminderScheduler.js');
            const cancelWhatsAppResult = await cancelWhatsAppReminder({
              phoneNumber: inviteePhone,
              meetingStartISO: meetingStartISO
            });
            if (cancelWhatsAppResult.success) {
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
              }
            } catch (bullmqError) {
              Logger.warn('Could not remove BullMQ job (may not exist)', { error: bullmqError.message });
            }
          }
          
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
            `🗑️ **Reminders Cancelled**\nEmail: ${inviteeEmail}\nPhone: ${inviteePhone}\nReason: Meeting cancelled\n✅ Call reminder cancelled\n✅ WhatsApp reminder cancelled`
          );
          
        } catch (error) {
          Logger.error('Failed to cancel reminders', { 
            error: error.message, 
            phone: inviteePhone,
            email: inviteeEmail 
          });
        }
      }

      // Update booking status to canceled
      if (inviteeEmail) {
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          { bookingStatus: 'canceled' },
          { sort: { bookingCreatedAt: -1 } }
        );
      }

      return res.status(200).json({ message: 'Invitee canceled, job removed' });
    }

    // ==================== HANDLE RESCHEDULED EVENTS ====================
    if (event === "invitee.rescheduled") {
      Logger.info('Processing rescheduled meeting');
      
      const inviteeEmail = payload?.new_invitee?.email || payload?.old_invitee?.email;
      let inviteePhone = payload?.new_invitee?.questions_and_answers?.find(q =>
        q.question.trim().toLowerCase() === 'phone number'
      )?.answer || null;

      if (inviteePhone) {
        inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
      }

      const oldStartTime = payload?.old_invitee?.scheduled_event?.start_time;
      const newStartTime = payload?.new_invitee?.scheduled_event?.start_time;
      
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
          
          // Cancel old call reminder
          if (existingBooking?.reminderCallJobId) {
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
            
            // Also cancel MongoDB-based call reminder
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

      // 2. Calculate new delay for rescheduled meeting
      const newMeetingStart = new Date(newStartTime);
      const newDelay = newMeetingStart.getTime() - Date.now() - (10 * 60 * 1000);

      if (newDelay < 0) {
        Logger.warn('Rescheduled meeting is too soon for reminder call', { newStartTime });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠️ Rescheduled meeting too soon (${inviteeEmail}). Cannot schedule reminder call.`
        );
        return res.status(200).json({ message: 'Rescheduled meeting too soon for call' });
      }

      // 3. Convert times to different zones
      const newMeetingStartUTC = DateTime.fromISO(newStartTime, { zone: 'utc' });
      const newMeetingTimeUS = newMeetingStartUTC.setZone('America/New_York').toFormat('ff');
      const newMeetingTimeIndia = newMeetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

      // 4. Extract additional details
      const inviteeName = payload?.new_invitee?.name || payload?.old_invitee?.name;
      const meetLink = payload?.new_invitee?.scheduled_event?.location?.join_url || 
                       payload?.old_invitee?.scheduled_event?.location?.join_url || 'Not Provided';
      
      // Extract new reschedule link from rescheduled invitee
      const newRescheduleLink = payload?.new_invitee?.reschedule_url || null;

      // 5. Update database with reschedule info including new reschedule link
      if (inviteeEmail) {
        const updateData = { 
          bookingStatus: 'rescheduled',
          rescheduledFrom: oldStartTime,
          rescheduledTo: newStartTime,
          rescheduledAt: new Date(),
          scheduledEventStartTime: newStartTime,
          $inc: { rescheduledCount: 1 }
        };
        
        // Update reschedule link if available
        if (newRescheduleLink) {
          updateData.calendlyRescheduleLink = newRescheduleLink;
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

      // 6. Schedule NEW reminder call
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      if (inviteePhone && phoneRegex.test(inviteePhone)) {
        if (inviteePhone.startsWith("+91")) {
          Logger.info('Skipping India number for rescheduled meeting', { phone: inviteePhone });
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
            `🔁 Rescheduled but skipping India number: ${inviteePhone}`
          );
          return res.status(200).json({ message: 'Rescheduled but skipped India number' });
        }

        const newMeetLink = payload?.new_invitee?.scheduled_event?.location?.join_url || 
                           payload?.old_invitee?.scheduled_event?.location?.join_url || 
                           'Not Provided';
        // Use the new reschedule link (already saved to DB above) or fallback
        const rescheduleLinkForReminder = newRescheduleLink || 
                                         payload?.old_invitee?.reschedule_url || 
                                         'https://calendly.com/flashfirejobs';
        const newEndTime = payload?.new_invitee?.scheduled_event?.end_time || 
                          payload?.old_invitee?.scheduled_event?.end_time || null;

        // Get booking to pass bookingId in metadata
        const rescheduledBooking = await CampaignBookingModel.findOne({ clientEmail: inviteeEmail })
          .sort({ bookingCreatedAt: -1 });

        // Schedule MongoDB call (primary) - this will also schedule WhatsApp reminder
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
            meetingEndISO: newEndTime
          }
        });

        if (mongoRescheduleResult.success) {
          console.log('✅ [MongoDB Scheduler] Rescheduled call and WhatsApp reminder scheduled:', mongoRescheduleResult.callId);
        }

        // ✅ Use unique jobId: phone + meeting time to prevent collisions (BullMQ backup)
        const uniqueJobId = `${inviteePhone}_${newStartTime}`;
        
        const newJob = await callQueue.add(
          'callUser',
          {
            phone: inviteePhone,
            phoneNumber: inviteePhone, // Include both for compatibility with all workers
            meetingTime: newMeetingTimeIndia,
            role: 'client',
            inviteeEmail,
            eventStartISO: newStartTime,
          },
          {
            jobId: uniqueJobId,  // ✅ Unique: phone + meeting time
            delay: newDelay,
            removeOnComplete: true,
            removeOnFail: 100,
            attempts: 3,  // ✅ Retry failed calls up to 3 times
            backoff: {
              type: 'exponential',
              delay: 60000  // 1 minute, 2 minutes, 4 minutes
            }
          }
        );

        // Update database with new job ID
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          { 
            reminderCallJobId: mongoRescheduleResult.callId || newJob.id.toString(),
            bookingStatus: 'scheduled'  // Reset to scheduled after successful reschedule
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
        console.log('   • New Delay:', Math.round(newDelay / 1000), 'seconds');
        console.log('   • Will execute at:', new Date(Date.now() + newDelay).toLocaleString());
        console.log('   • Retry attempts: 3 (exponential backoff)');
        console.log('========================================\n');

        Logger.info('Scheduled NEW reminder call for rescheduled meeting', { 
          phone: inviteePhone, 
          newDelayMs: newDelay,
          newMeetingTime: newMeetingTimeIndia,
          jobId: newJob.id,
          uniqueJobId,
          retryAttempts: 3
        });

        const rescheduleMessage = `🔁 **Meeting Rescheduled**
- Client: ${inviteeName} (${inviteeEmail})
- Phone: ${inviteePhone}
- Old Time: ${DateTime.fromISO(oldStartTime, { zone: 'utc' }).setZone('Asia/Kolkata').toFormat('ff')} (IST)
- New Time: ${newMeetingTimeIndia} (IST)
- Reminder Call: Scheduled 10 minutes before new time
- Job ID: ${newJob.id}
- Unique ID: ${uniqueJobId}
- Retries: 3 attempts`;

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
        reminderScheduled: !!inviteePhone
      });
    }
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

      // ✅ Calculate meeting start in UTC
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

      // ✅ CRITICAL: Validate delay before scheduling
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
          `⚠️ Meeting too soon for reminder call: ${inviteeName || 'Unknown'} (${inviteeEmail || 'Unknown'}). Meeting in ${minutesUntilMeeting} minutes. Cannot schedule 10-minute reminder.`
        );
        // Continue processing booking but skip call scheduling
        // Don't return - still save booking to database
      }

      // ✅ Convert to different time zones
      const meetingStartUTC = DateTime.fromISO(payload?.scheduled_event?.start_time, { zone: 'utc' });
      const meetingTimeUS = meetingStartUTC.setZone('America/New_York').toFormat('ff');
      const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');
      const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
      const bookedAt = new Date(req.body?.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      
      // ✅ Extract reschedule link from Calendly webhook
      // According to Calendly API docs, reschedule_url is in payload.invitee.reschedule_url
      const rescheduleLink = payload?.invitee?.reschedule_url || null;

      // ✅ Extract UTM parameters
      const utmSource = payload?.tracking?.utm_source || 'direct';
      const utmMedium = payload?.tracking?.utm_medium || null;
      const utmCampaign = payload?.tracking?.utm_campaign || null;
      const utmContent = payload?.tracking?.utm_content || null;
      const utmTerm = payload?.tracking?.utm_term || null;

      // ✅ Extract "anything to know" field
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

      // ✅ NOT A DUPLICATE - Save DIRECTLY to database (same place as Discord)
      // Find campaign by UTM source
      let campaignId = null;
      let campaign = await CampaignModel.findOne({ utmSource });
      
      if (campaign) {
        campaignId = campaign.campaignId;
        Logger.info('✅ Campaign found for booking', { campaignId, utmSource });
      } else {
        // No campaign found - this is a direct Calendly booking
        // Create a virtual campaign WITHOUT auto-generated numbers
        Logger.warn('⚠️ No campaign found for UTM source - Creating virtual campaign for direct booking', { utmSource });
        
        try {
          const virtualCampaign = new CampaignModel({
            campaignName: utmSource, // Just use the UTM source as name (no "Direct Calendly:" prefix or numbers)
            utmSource: utmSource,
            utmMedium: utmMedium || 'direct',
            utmCampaign: utmCampaign || 'calendly_direct',
            generatedUrl: `https://calendly.com/feedback-flashfire/30min?utm_source=${utmSource}&utm_medium=${utmMedium || 'direct'}`,
            baseUrl: 'https://calendly.com/feedback-flashfire/30min',
            isActive: true
          });
          
          await virtualCampaign.save();
          campaignId = virtualCampaign.campaignId;
          
          Logger.info('✅ Virtual campaign created for direct Calendly booking', {
            campaignId,
            utmSource,
            campaignName: virtualCampaign.campaignName
          });
        } catch (error) {
          Logger.error('❌ Failed to create virtual campaign', { error: error.message, utmSource });
        }
      }

      // Create booking object directly here (where Discord data is)
      const newBooking = new CampaignBookingModel({
        campaignId,
        utmSource: utmSource || 'direct',
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        clientName: inviteeName,           // Same as Discord
        clientEmail: inviteeEmail,         // Same as Discord
        clientPhone: inviteePhone,         // Same as Discord
        calendlyEventUri: payload?.scheduled_event?.uri,
        calendlyInviteeUri: payload?.invitee?.uri,
        calendlyMeetLink: meetLink,        // Same as Discord
        calendlyRescheduleLink: rescheduleLink, // Save reschedule link from Calendly
        scheduledEventStartTime: payload?.scheduled_event?.start_time,
        scheduledEventEndTime: payload?.scheduled_event?.end_time,
        anythingToKnow,
        questionsAndAnswers: payload?.questions_and_answers,
        visitorId: null,
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip || req.connection.remoteAddress,
        bookingStatus: 'scheduled'
      });

      // Save to database
      await newBooking.save();

      // Mark user as booked in UserModel since they now have a booking
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
        // Don't fail the whole request if user update fails
      }

      Logger.info('✅ Booking saved DIRECTLY in Discord webhook handler', {
        bookingId: newBooking.bookingId,
        campaignId: newBooking.campaignId,
        utmSource: newBooking.utmSource,
        clientName: newBooking.clientName,
        clientEmail: newBooking.clientEmail,
        clientPhone: newBooking.clientPhone,
        calendlyMeetLink: newBooking.calendlyMeetLink
      });

      // ✅ Prepare booking details for Discord (same data that was saved)
      const bookingDetails = {
        "Booking ID": newBooking.bookingId,           // NEW!
        "Campaign ID": newBooking.campaignId || 'N/A', // NEW!
        "Invitee Name": inviteeName,
        "Invitee Email": inviteeEmail,
        "Invitee Phone": inviteePhone || 'Not Provided',
        "Google Meet Link": meetLink,
        "Meeting Time (Client US)": meetingTimeUS,
        "Meeting Time (Team India)": meetingTimeIndia,
        "Booked At": bookedAt,
        "UTM Source" : utmSource,
        "UTM Medium": utmMedium || 'N/A',
        "UTM Campaign": utmCampaign || 'N/A',
        "Database Status": "✅ SAVED"                  // NEW!
      };

       if(payload.tracking.utm_source !== 'webpage_visit' && payload.tracking.utm_source !== null && payload.tracking.utm_source !== 'direct'){
        const utmData ={
          clientName : inviteeName,
          clientEmail : inviteeEmail,
          clientPhone : inviteePhone || 'Not Provided',
          utmSource : payload?.tracking?.utm_source ,
        }
        await fetch('https://clients-tracking-backend.onrender.com/api/track/utm-campaign-lead',{
          method:'POST',
          headers:{
            'Content-Type':'application/json'          
                  },
          body:JSON.stringify(utmData)
        })
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

      // -------------------- Fraud Screening --------------------
      // const screening = basicFraudCheck({
      //   email: inviteeEmail,
      //   name: inviteeName,
      //   utmSource: payload?.tracking?.utm_source
      // });
      // if (screening.flagged) {
      //   Logger.warn('Booking flagged by fraud screening, skipping call', { email: inviteeEmail, reasons: screening.reasons });
      //   await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, `Fraud screening flagged booking. Email: ${inviteeEmail}. Reasons: ${screening.reasons.join(', ')}`);
      //   return res.status(200).json({ message: 'Booking flagged by fraud screening. Call not scheduled.', reasons: screening.reasons });
      // }

      // ✅ Validate phone numbers

      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      let scheduledJobs = [];
      if (inviteePhone && inviteePhone.startsWith("+91")) {
  Logger.info('Skipping India number', { phone: inviteePhone });
  if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
    await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`Skipping India number: ${inviteePhone}` );
  }
  return res.status(200).json({ message: 'Skipped India number' });
}


      // ✅ Only schedule call if delay is positive (meeting is in future)
      if (inviteePhone && phoneRegex.test(inviteePhone) && delay > 0) {
          
          // ============================================================
          // 🔥 PRIMARY: MongoDB-based Scheduler (RELIABLE - No Redis issues)
          // ============================================================
          const meetingLink = meetLink && meetLink !== 'Not Provided' ? meetLink : null;
          // Use reschedule link from booking record (saved from webhook) or fallback
          const rescheduleLinkForReminder = newBooking?.calendlyRescheduleLink || rescheduleLink || 'https://calendly.com/flashfirejobs';
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

          // ============================================================
          // 🔄 BACKUP: BullMQ Scheduler (if Redis is available)
          // ============================================================
          try {
            const uniqueJobId = `${inviteePhone}_${payload?.scheduled_event?.start_time}`;
            
            // Check if BullMQ job already exists
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
            
          // Calculate execution times for verification
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
          console.log('   • Meeting Time (UTC):', meetingTimeUTC.toISOString());
          console.log('   • Delay:', Math.round(delay / 60000), 'minutes');
          console.log('   • Call Will Execute At:', callExecutionTime.toISOString());
          console.log('   • Time Between Call & Meeting:', minutesDifference, 'minutes');
          console.log('   • ✅ Primary: MongoDB Scheduler (RELIABLE)');
          console.log('   • 🔄 Backup: BullMQ (if Redis works)');
          console.log('========================================\n');
            
          Logger.info('Call scheduled via MongoDB scheduler', { 
            phone: inviteePhone, 
            delayMinutes: Math.round(delay / 60000), 
            callId: mongoResult.callId,
            retryAttempts: 3
          });
          
          // Send Discord notification
          const scheduledMessage = `📞 **Reminder Call Scheduled!**\n• MongoDB Call ID: ${mongoResult.callId}\n• Client: ${inviteeName} (${inviteePhone})\n• Meeting: ${meetingTimeIndia} (IST)\n• Reminder: 10 minutes before meeting\n• Primary: MongoDB Scheduler ✅\n• Backup: BullMQ 🔄`;
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
        Logger.warn('Discord webhook URL not configured - skipping scheduled calls summary');
      }

      return res.status(200).json({
        message: 'Webhook received & calls scheduled',
        bookingDetails,
        scheduledCalls: scheduledJobs
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















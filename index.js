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
import TwilioReminder from './Controllers/TwilioReminder.js';
import { CampaignBookingModel } from './Schema_Models/CampaignBooking.js';
import { UserModel } from './Schema_Models/User.js';
import { CampaignModel } from './Schema_Models/Campaign.js';
import { initGeoIp, getClientIp, detectCountryFromIp } from './Utils/GeoIP.js';
import emailWorker from './Utils/emailWorker.js';
import whatsappWorker from './Utils/whatsappWorker.js';
import './Utils/worker.js'; // Import worker to start it (handles callQueue jobs)
import redisConnection from './Utils/redisConnection.js';

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



app.post("/call-status", async (req, res) => {
  const { CallSid, CallStatus, To, From, AnsweredBy, Timestamp } = req.body;

  try {
    console.log(`📞 Call Update: SID=${CallSid}, To=${To}, Status=${CallStatus}, AnsweredBy=${AnsweredBy}`);

    const msg = `
📞 **Call Status Update**
- To: ${To}
- From: ${From}
- Status: ${CallStatus}
- Answered By: ${AnsweredBy || "Unknown"}
- At: ${Timestamp || new Date().toISOString()}
SID: ${CallSid}
    `;

    await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, msg);

    res.status(200).send("✅ Call status received");
  } catch (error) {
    console.error("❌ Error in /call-status:", error);
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

      // Remove old reminder call job - Get jobId from database
      if (inviteeEmail) {
        try {
          const existingBooking = await CampaignBookingModel.findOne({ clientEmail: inviteeEmail })
            .sort({ bookingCreatedAt: -1 });
          
          if (existingBooking?.reminderCallJobId) {
            const oldJobId = existingBooking.reminderCallJobId;
            const oldJob = await callQueue.getJob(oldJobId);
            
            if (oldJob) {
              await oldJob.remove();
              Logger.info('Removed reminder call job from queue', { 
                jobId: oldJobId, 
                phone: inviteePhone 
              });
              await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
                `🗑️ Removed reminder call job for canceled meeting. Email: ${inviteeEmail}, Phone: ${inviteePhone}`
              );
            } else {
              Logger.warn('Job not found in queue (may have already executed)', { 
                jobId: oldJobId, 
                phone: inviteePhone 
              });
            }
          } else {
            Logger.warn('No reminderCallJobId found in database for this booking', { 
              email: inviteeEmail 
            });
          }
        } catch (error) {
          Logger.error('Failed to remove call job', { 
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
          
          if (existingBooking?.reminderCallJobId) {
            const oldJobId = existingBooking.reminderCallJobId;
            const oldJob = await callQueue.getJob(oldJobId);
            
            if (oldJob) {
              await oldJob.remove();
              Logger.info('Removed old reminder call job from queue', { 
                jobId: oldJobId, 
                phone: inviteePhone 
              });
              await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
                `🗑️ Removed old reminder call job for rescheduled meeting. Email: ${inviteeEmail}, Phone: ${inviteePhone}`
              );
            } else {
              Logger.warn('Old job not found in queue (may have already executed)', { 
                jobId: oldJobId, 
                phone: inviteePhone 
              });
            }
          } else {
            Logger.warn('No reminderCallJobId found in database for this booking', { 
              email: inviteeEmail 
            });
          }
        } catch (error) {
          Logger.error('Failed to remove old call job', { 
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

      // 5. Update database with reschedule info
      if (inviteeEmail) {
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          { 
            bookingStatus: 'rescheduled',
            rescheduledFrom: oldStartTime,
            rescheduledTo: newStartTime,
            rescheduledAt: new Date(),
            scheduledEventStartTime: newStartTime,
            $inc: { rescheduledCount: 1 }
          },
          { sort: { bookingCreatedAt: -1 } }
        );
        Logger.info('Updated booking with reschedule info', { email: inviteeEmail });
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

        const newJob = await callQueue.add(
          'callUser',
          {
            phone: inviteePhone,
            meetingTime: newMeetingTimeIndia,
            role: 'client',
            inviteeEmail,
            eventStartISO: newStartTime,
          },
          {
            jobId: inviteePhone,
            delay: newDelay,
            removeOnComplete: true,
            removeOnFail: 100
          }
        );

        // Update database with new job ID
        await CampaignBookingModel.findOneAndUpdate(
          { clientEmail: inviteeEmail },
          { 
            reminderCallJobId: newJob.id.toString(),
            bookingStatus: 'scheduled'  // Reset to scheduled after successful reschedule
          },
          { sort: { bookingCreatedAt: -1 } }
        );

        Logger.info('Scheduled NEW reminder call for rescheduled meeting', { 
          phone: inviteePhone, 
          newDelayMs: newDelay,
          newMeetingTime: newMeetingTimeIndia,
          jobId: newJob.id
        });

        const rescheduleMessage = `🔁 **Meeting Rescheduled**
- Client: ${inviteeName} (${inviteeEmail})
- Phone: ${inviteePhone}
- Old Time: ${DateTime.fromISO(oldStartTime, { zone: 'utc' }).setZone('Asia/Kolkata').toFormat('ff')} (IST)
- New Time: ${newMeetingTimeIndia} (IST)
- Reminder Call: Scheduled 10 minutes before new time
- Job ID: ${newJob.id}`;

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

      // ✅ Calculate meeting start in UTC
      const meetingStart = new Date(payload?.scheduled_event?.start_time);
      const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

      if (delay < 0) {
        Logger.warn('Meeting is too soon to schedule calls', { start: meetingStart.toISOString() });
      }

      // ✅ Convert to different time zones
      const meetingStartUTC = DateTime.fromISO(payload?.scheduled_event?.start_time, { zone: 'utc' });
      const meetingTimeUS = meetingStartUTC.setZone('America/New_York').toFormat('ff');
      const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');

      // ✅ Extract details
      const inviteeName = payload?.invitee?.name || payload?.name;
      const inviteeEmail = payload?.invitee?.email || payload?.email;
      let inviteePhone = payload?.questions_and_answers?.find(q =>
  q.question.trim().toLowerCase() === 'phone number'
)?.answer || null;

if (inviteePhone) {
  // Remove spaces and any non-digit except leading +
  inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
}
      const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
      const bookedAt = new Date(req.body?.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

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
  DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`Skipping India number: ${inviteePhone}` );
  return res.status(200).json({ message: 'Skipped India number' });
}


      if (inviteePhone && phoneRegex.test(inviteePhone)) {
        const job = await callQueue.add(
  'callUser',
  {
    phone: inviteePhone,
    meetingTime: meetingTimeIndia, // meetingTimeUS
    role: 'client',
    inviteeEmail,
    eventStartISO: payload?.scheduled_event?.start_time,
  },
  {
     jobId: inviteePhone,   // 🔑 use phone as jobId
    delay,
    removeOnComplete: true,  // ✅ deletes job when done
    removeOnFail: 100        // ✅ keep last 100 failed jobs only
  }
);

        // Store the job ID in the booking record
        await CampaignBookingModel.findOneAndUpdate(
          { bookingId: newBooking.bookingId },
          { reminderCallJobId: job.id.toString() }
        );

        scheduledJobs.push(`Client: ${inviteePhone}`);
        Logger.info('Valid phone, scheduled call', { phone: inviteePhone, delayMs: delay, jobId: job.id });
        const scheduledMessage =`Reminder Call Scheduled For ${inviteePhone}-${inviteeName} for meeting scheduled on ${meetingTimeIndia} (IST).Reminder 10 minutes before Start of meeting.`
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, scheduledMessage);
      } else {
        Logger.warn('No valid phone number provided by invitee', { phone: inviteePhone });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
        );
      }

      Logger.info('Scheduled calls summary', { jobs: scheduledJobs });
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`✅ Scheduled calls: ${scheduledJobs.join(', ')}` )

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

app.listen(PORT || 4001, () => {
  console.log('✅ Server is live at port:', PORT || 4001);
});

// Initialize GeoIP after server startup
initGeoIp();















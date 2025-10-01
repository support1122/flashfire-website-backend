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
import { Worker } from 'bullmq';
import { DiscordConnect } from './Utils/DiscordConnect.js';
import { Logger } from './Utils/Logger.js';
import { basicFraudCheck } from './Utils/FraudScreening.js';
import { isEventPresent } from './Utils/GoogleCalendarHelper.js';
import TwilioReminder from './Controllers/TwilioReminder.js';
import { CampaignBookingModel } from './Schema_Models/CampaignBooking.js';
import { CampaignModel } from './Schema_Models/Campaign.js';

// -------------------- Express Setup --------------------
const app = express();
const allowedOrigins = [
  "https://flashfire-frontend-hoisted.vercel.app", // your frontend
  "http://localhost:5173",
  "https://www.flashfirejobs.com",
  "https://flashfirejobs.com"
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// ✅ Handle preflight requests for all routes
// app.options("*", cors());
// app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));


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

      if (inviteePhone) {
        // remove by jobId = phone (we'll schedule jobs with phone as jobId below)
        await callQueue.removeJobs(inviteePhone);
        console.log(`🗑 Removed scheduled job for canceled invitee: ${inviteePhone}`);
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `🗑 Removed scheduled job for canceled meeting. Phone: ${inviteePhone}`
        );
      }
      return res.status(200).json({ message: 'Invitee canceled, job removed' });
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

      // ✅ Check for duplicate BEFORE saving and sending to Discord
      const existingBooking = await CampaignBookingModel.findOne({
        clientEmail: inviteeEmail,
        scheduledEventStartTime: payload?.scheduled_event?.start_time
      });

      if (existingBooking) {
        // ⚠️ Duplicate found - Don't save, don't send to Discord
        Logger.warn('🔄 Duplicate booking detected - already exists in database', {
          email: inviteeEmail,
          bookingId: existingBooking.bookingId,
          existingTime: existingBooking.scheduledEventStartTime
        });

        // Send duplicate notification to Discord
        const duplicateMessage = {
          "⚠️ Status": "DUPLICATE BOOKING DISCARDED",
          "Invitee Name": inviteeName,
          "Invitee Email": inviteeEmail,
          "Meeting Time": meetingTimeIndia,
          "Reason": "Booking already exists in database",
          "Existing Booking ID": existingBooking.bookingId,
          "UTM Source": utmSource
        };
        
        await DiscordConnectForMeet(JSON.stringify(duplicateMessage, null, 2));

        return res.status(200).json({
          message: 'Duplicate booking detected and discarded',
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

      // ✅ Send to Discord (only if not duplicate)
      await DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2));

      // -------------------- Fraud Screening --------------------
      const screening = basicFraudCheck({
        email: inviteeEmail,
        name: inviteeName,
        utmSource: payload?.tracking?.utm_source
      });
      if (screening.flagged) {
        Logger.warn('Booking flagged by fraud screening, skipping call', { email: inviteeEmail, reasons: screening.reasons });
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, `Fraud screening flagged booking. Email: ${inviteeEmail}. Reasons: ${screening.reasons.join(', ')}`);
        return res.status(200).json({ message: 'Booking flagged by fraud screening. Call not scheduled.', reasons: screening.reasons });
      }

      // ✅ Validate phone numbers

      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      let scheduledJobs = [];
      if (inviteePhone && inviteePhone.startsWith("+91")) {
  Logger.info('Skipping India number', { phone: inviteePhone });
  DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`Skipping India number: ${inviteePhone}` );
  return res.status(200).json({ message: 'Skipped India number' });
}


      if (inviteePhone && phoneRegex.test(inviteePhone)) {
        await callQueue.add(
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

        scheduledJobs.push(`Client: ${inviteePhone}`);
        Logger.info('Valid phone, scheduled call', { phone: inviteePhone, delayMs: delay });
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
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
   

new Worker(
  'callQueue',
  async (job) => {
    console.log(`[Worker] Processing job for ${job.data.phone}`);

    try {
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
          await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
            `Skipping call. Event not found in calendar window for ${job.data.phone} (${job.data.inviteeEmail || 'unknown email'}).`);
          return;
        }
      }

      const call = await client.calls.create({
        to: job.data.phone,
        from: process.env.TWILIO_FROM, // must be a Twilio voice-enabled number
        url: `https://api.flashfirejobs.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`,
        machineDetection: 'Enable', // basic AMD to avoid leaving awkward messages
        // machineDetectionTimeout: 5, // optional: shorter detection window
        statusCallback: 'https://api.flashfirejobs.com/call-status',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        method: 'POST', // optional (Twilio defaults to POST for Calls API)
      });

      console.log(`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}`);
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}` )
    } catch (error) {
      console.error(`[Worker] ❌ Twilio call failed for ${job.data.phone}:`, error.message);
      await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`❌ Twilio call failed for ${job.data.phone}. Error: ${error.message}`);
    }
  },
  { connection: { url: process.env.REDIS_CLOUD_URL } }
);

// -------------------- Base Route --------------------
app.get("/", (req, res) => {
  res.send("FlashFire API is up and running 🚀");
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















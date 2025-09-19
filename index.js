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

// -------------------- Express Setup --------------------
const app = express();
const allowedOrigins = [
  "https://flashfire-frontend-hoisted.vercel.app", // your frontend
  "http://localhost:5173",
  "https://www.flashfirejobs.com"
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

  try {
    if (event === "invitee.created") {
      console.log("📥 Calendly Webhook Received:", JSON.stringify(payload, null, 2));

      // ✅ Calculate meeting start in UTC
      const meetingStart = new Date(payload?.scheduled_event?.start_time);
      const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

      if (delay < 0) {
        console.log('⚠ Meeting is too soon to schedule calls.');
        return res.status(400).json({ error: 'Meeting too soon to schedule call' });
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

      // ✅ Prepare booking details for Discord
      const bookingDetails = {
        "Invitee Name": inviteeName,
        "Invitee Email": inviteeEmail,
        "Invitee Phone": inviteePhone || 'Not Provided',
        "Google Meet Link": meetLink,
        "Meeting Time (Client US)": meetingTimeUS,
        "Meeting Time (Team India)": meetingTimeIndia,
        "Booked At": bookedAt
      };

      console.log("📅 New Calendly Booking:", bookingDetails);

      // ✅ Send to Discord
      await DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2));

      // ✅ Validate phone numbers

      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      let scheduledJobs = [];

      if (inviteePhone && phoneRegex.test(inviteePhone)) {
        await callQueue.add('callUser', {
          phone: inviteePhone,
          meetingTime: meetingTimeIndia,// meetingTimeUS,
          role: 'client'
        }, { delay });
        scheduledJobs.push(`Client: ${inviteePhone}`);
        console.log(`📞 Valid phone, scheduled: ${inviteePhone}`);
        const scheduledMessage =`Reminder Call Scheduled For ${inviteePhone}-${inviteeName} for meeting scheduled on ${meetingTimeIndia} (IST).Reminder 10 minutes before Start of meeting.`
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, scheduledMessage);
      } else {
        console.log("⚠ No valid phone number provided by invitee.");
        await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
          `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
        );
      }

      console.log(`✅ Scheduled calls: ${scheduledJobs.join(', ')}`);
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

// -------------------- Worker Setup --------------------
const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

new Worker(
  'callQueue',
  async (job) => {
    console.log(`[Worker] Processing job for ${job.data.phone}`);

    try {
      const call = await client.calls.create({
        to: job.data.phone,
        from: process.env.TWILIO_FROM, // must be a Twilio voice-enabled number
        url: `https://flashfire-backend-hoisted.onrender.com/twilio-ivr?meetingTime=${encodeURIComponent(job.data.meetingTime)}`,
        statusCallback: 'https://flashfire-backend-hoisted.onrender.com/call-status',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        // method: 'POST', // optional (Twilio defaults to POST for Calls API)
      });

      console.log(`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}`);
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`[Worker] ✅ Call initiated. SID: ${call.sid} Status: ${call.status}` )
    } catch (error) {
      console.error(`[Worker] ❌ Twilio call failed for ${job.data.phone}:`, error.message);
      await DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,`❌ Twilio call failed for ${job.data.phone}. Error: ${error.message}`);
    }
  },
  { connection: { url: process.env.UPSTASH_REDIS_URL } }
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

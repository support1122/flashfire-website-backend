
import express from 'express';
import Routes from './Routes.js';
import Connection from './Utils/ConnectDB.js';
import cors from 'cors';
import 'dotenv/config';
import { callQueue } from './Utils/queue.js';
import Twilio from 'twilio';
import {DateTime} from 'luxon';

const app = express();
app.use(cors());
app.use(express.json());


export const DiscordConnect = async (message) => {
const webhookURL = process.env.DISCORD_MEET_WEB_HOOK_URL;
  try {
    const response = await fetch(webhookURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: `🚨 App Update: ${message}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send: ${response.statusText}`);
    }

    console.log('✅ Message sent to Discord!');
  } catch (error) {
    console.error('❌ Error sending message:', error);
  }
};

// const twilioIVR = async (req, res) => {
//   try {
//     const meetingTime = req.query.meetingTime;
//     const twiml = new Twilio.twiml.VoiceResponse();

//     const gather = twiml.gather({
//       numDigits: 1,
//       action: '/twilio/response',
//       method: 'POST'
//     });

//     gather.say(`Hello! This is a reminder for your meeting with FlashFire scheduled at ${meetingTime}`);

//     twiml.say('Thank you. Goodbye.');
//     res.type('text/xml');
//     res.send(twiml.toString());
    
//   } catch (error) {
//     console.log(error)
//   }
  
// }
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
      const inviteePhone = payload?.questions_and_answers?.find(q =>
        q.question.trim().toLowerCase() === 'phone number'
      )?.answer || null;

      const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
      const bookedAt = new Date(req.body?.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

      // const teamMemberPhone = process.env.TEAM_MEMBER_PHONE || '+91XXXXXXXXXX';

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
      await DiscordConnect(JSON.stringify(bookingDetails, null, 2));

      // ✅ Validate phone numbers
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      let scheduledJobs = [];

      if (inviteePhone && phoneRegex.test(inviteePhone)) {
        await callQueue.add('callUser', {
          phone: inviteePhone,
          meetingTime: meetingTimeUS, // Send US time in the IVR message
          role: 'client'
        }, { delay });
        scheduledJobs.push(`Client: ${inviteePhone}`);
      } else {
        console.log("⚠ No valid phone number provided by invitee.");
        await DiscordConnect(`⚠ No valid phone for client: ${inviteeName} (${inviteeEmail})`);
      }

      // if (teamMemberPhone && phoneRegex.test(teamMemberPhone)) {
      //   await callQueue.add('callUser', {
      //     phone: teamMemberPhone,
      //     meetingTime: meetingTimeIndia, // Send India time in the IVR message
      //     role: 'team'
      //   }, { delay });
      //   scheduledJobs.push(`Team: ${teamMemberPhone}`);
      // } else {
      //   console.log("⚠ Team member phone is invalid.");
      // }

      console.log(`✅ Scheduled calls: ${scheduledJobs.join(', ')}`);

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

// app.post('/calendly-webhook', async (req, res) => {

//   const { event, payload } = req.body;
//   console.log("req.body-->",req.body);
//   console.log('meet link', req.body.payload?.scheduled_event?.location)
//   try {
//     if (event === "invitee.created") {
//     const { invitee, event: eventData, questions_and_answers} = payload;
// //extracted detail and storing in booking Details..
//     const bookingDetails = {
//       "Invitee Name": payload?.name,
//       "Invitee Email": payload?.email,
//       "GoogleMeet Link": payload?.scheduled_event?.location?.join_url,
//       "EventStart Time": new Date(payload?.scheduled_event?.start_time).toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'}),
//       "Booked At":new Date(req.body?.created_at).toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'})
//     };

//     console.log("📅 New Calendly Booking:");
//     console.log(bookingDetails);
//     //Sending meeting details to Discord..
//     await DiscordConnect(JSON.stringify(bookingDetails,null,2));

//     return res.status(200).json({message : 'Webhook received',
//                         bookingDetails
//                     });
//   }

//   } catch (error) {
//     console.log('something went wrong...,',error);
//   } 
// });

app.get("/", (req, res) => {
  res.send("FlashFire API is up and running 🚀");
});

// Routes
Routes(app);

// Connect to MongoDB
Connection();

// ✅ Use only Render's dynamic port (no fallback)
const PORT = process.env.PORT;

if (!PORT) {
  throw new Error('❌ process.env.PORT is not set. This is required for Render deployment.');
}

app.listen(PORT, () => {
  console.log('✅ Server is live at port:', PORT);
});




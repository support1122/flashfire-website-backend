// import express from 'express';
// import Routes from "./Routes.js";
// import Connection from './Utils/ConnectDB.js'
// import cors from 'cors'

//     const app = express();

//     app.use(express.json());
//     app.use(cors());
// //routes..
//     Routes(app);
// //connection to MongoDB..
//     Connection();

//     const PORT = 8086;
//     app.listen(PORT,()=>{
//         console.log('server is live at port :', PORT);
//     })


// import express from 'express';
// import Routes from './Routes.js';
// import Connection from './Utils/ConnectDB.js';
// import cors from 'cors';

// const app = express();

// app.use(express.json());
// app.use(cors());

// // Routes
// Routes(app);

// // Connect to MongoDB
// Connection();

// // ✅ Use Render's dynamic port
// const PORT = process.env.PORT || 8086;
// app.listen(PORT, () => {
//   console.log('server is live at port :', PORT);
// });


import express from 'express';
import Routes from './Routes.js';
import Connection from './Utils/ConnectDB.js';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());


export const DiscordConnect = async (message) => {
const webhookURL = process.env.DISCORD_WEB_HOOK_URL;
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
app.post('/calendly-webhook', async (req, res) => {

  const { event, payload } = req.body;
  console.log("req.body-->",req.body);
  console.log('meet link', req.body.payload?.scheduled_event?.location)
  try {
    if (event === "invitee.created") {
    const { invitee, event: eventData, questions_and_answers} = payload;
//extracted detail and storing in booking Details..
    const bookingDetails = {
      "Invitee Name": payload?.name,
      "Invitee Email": payload?.email,
      "GoogleMeet Link": payload?.scheduled_event?.location?.join_url,
      "EventStart Time": new Date(payload?.scheduled_event?.start_time).toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'}),
      "Booked At":new Date(req.body?.created_at).toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'})
    };

    console.log("📅 New Calendly Booking:");
    console.log(bookingDetails);
    //Sending meeting details to Discord..
    await DiscordConnect(JSON.stringify(bookingDetails,null,2));

    return res.status(200).json({message : 'Webhook received',
                        bookingDetails
                    });
  }

  } catch (error) {
    console.log('something went wrong...,',error);
  } 
});

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




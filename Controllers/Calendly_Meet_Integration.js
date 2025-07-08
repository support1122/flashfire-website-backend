// import dotenv from 'dotenv'
// dotenv.config();

// export default async function Calendly_Meet_Integration(req, res ) {
//     try {
//         const { event, payload } = req.body;
//           console.log("req.body-->",req.body);
//           console.log('meet link', req.body.payload?.scheduled_event?.location)
//             if (event === "invitee.created") {
//                 const { invitee, event: eventData, questions_and_answers} = payload;
//         //extracted detail and storing in booking Details..
//                 const bookingDetails = {
//                 "Invitee Name": payload?.name,
//                 "Invitee Email": payload?.email,
//                 "GoogleMeet Link": payload?.scheduled_event?.location?.join_url,
//                 "EventStart Time": new Date(payload?.scheduled_event?.start_time).toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'}),
//                 "Booked At":new Date(req.body?.created_at).toLocaleString('en-IN',{timeZone : 'Asia/Kolkata'})
//                 };
        
//             console.log("📅 New Calendly Booking:");
//             console.log(bookingDetails);
//             //Sending meeting details to Discord..
//             await DiscordConnect(JSON.stringify(bookingDetails,null,2));
        
//             return res.status(200).json({message : 'Webhook received',
//                                 bookingDetails                    
//                             });
//           }        
//     } catch (error) {
//         console.log(error);
//     }
    
// }
// const DiscordConnect = async (message) => {
//     const webhookURL = process.env.DISCORD_MEET_WEB_HOOK_URL;
//     try {
//         const response = await fetch(webhookURL, {
//         method: 'POST',
//         headers: {
//             'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({
//             content: `🚨 App Update: ${message}`,
//         }),
//         });

//         if (!response.ok) {
//         throw new Error(`Failed to send: ${response.statusText}`);
//         }
//         console.log('✅ Message sent to Discord!');
//     } catch (error) {
//         console.error('❌ Error sending message:', error);
//   }
// }


import dotenv from 'dotenv';
dotenv.config();

export default async function Calendly_Meet_Integration(req, res) {
    try {
        const { event, payload, created_at } = req.body;

        console.log("🔔 Incoming Calendly Webhook:", req.body);

        // Only proceed for new invitee booking
        if (event !== "invitee.created") return res.sendStatus(200);

        const name = payload?.name;
        const email = payload?.email;

        // Extract phone number from questions
        const mobile = payload?.questions_and_answers?.find(q =>
            q.question.toLowerCase().includes("phone") || q.question.toLowerCase().includes("mobile")
        )?.answer;

        // Extract meet link and times
        const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Available';
        const eventStartTime = new Date(payload?.scheduled_event?.start_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const bookedAt = new Date(created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

        // Format for Discord
        const bookingDetails = {
            "👤 Invitee Name": name,
            "📧 Invitee Email": email,
            "📱 Invitee Phone": mobile,
            "📅 Event Start Time": eventStartTime,
            "🔗 Google Meet Link": meetLink,
            "⏱️ Booked At": bookedAt
        };

        console.log("📨 Sending to Discord:", bookingDetails);

        await DiscordConnect(JSON.stringify(bookingDetails, null, 2));

        return res.status(200).json({
            message: '✅ Calendly webhook received and sent to Discord.',
            bookingDetails
        });

    } catch (error) {
        console.error("❌ Error in Calendly_Meet_Integration:", error);
        return res.status(500).json({ message: "Internal Server Error in Calendly webhook handler" });
    }
}

// Send to Discord function
const DiscordConnect = async (message) => {
    const webhookURL = process.env.DISCORD_MEET_WEB_HOOK_URL;
    try {
        const response = await fetch(webhookURL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                content: `📢 New Calendly Booking:\n\n${message}`
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to send: ${response.statusText}`);
        }

        console.log('✅ Message sent to Discord!');
    } catch (error) {
        console.error('❌ Error sending to Discord:', error);
    }
};

import dotenv from 'dotenv'
dotenv.config();

export default async function Calendly_Meet_Integration(req, res ) {
    try {
        const { event, payload } = req.body;
          console.log("req.body-->",req.body);
          console.log('meet link', req.body.payload?.scheduled_event?.location)
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
        console.log(error);
    }
    
}
const DiscordConnect = async (message) => {
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
}
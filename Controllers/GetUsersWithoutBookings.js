import { UserModel } from "../Schema_Models/User.js";
import { CampaignBookingModel } from "../Schema_Models/CampaignBooking.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";


export default async function GetUsersWithoutBookings(req, res) {
    try {
        const allUsers = await UserModel.find({}).select('email fullName phone countryCode createdAt workAuthorization booked').lean();
        
        const bookedEmails = await CampaignBookingModel.distinct('clientEmail');
        
        const bookedEmailsLower = bookedEmails.map(email => email?.toLowerCase()).filter(Boolean);
        
        const usersWithoutBookings = allUsers.filter(user => {
            const userEmailLower = user.email?.toLowerCase();
            if (!userEmailLower || userEmailLower === 'not specified') {
                return false;
            }
            if (user.booked) {
                return false;
            }
            if (user.workAuthorization?.toLowerCase() !== 'yes') {
                return false;
            }
            return !bookedEmailsLower.includes(userEmailLower);
        });
        
        const emails = usersWithoutBookings.map(user => user.email).filter(Boolean);
        
        const uniqueEmails = [];
        const seenEmails = new Set();
        
        for (const email of emails) {
            const emailLower = email.toLowerCase();
            if (!seenEmails.has(emailLower)) {
                seenEmails.add(emailLower);
                uniqueEmails.push(email);
            }
        }
        
        const responseData = uniqueEmails;
        
        // const discordMessage = {
        //     "Message": "Users Without Bookings",
        //     "Total Users Signed Up": allUsers.length,
        //     "Users Who Booked Meetings": bookedEmails.length,
        //     "Users Without Bookings": usersWithoutBookings.length,
        //     "Details": usersWithoutBookings.slice(0, 10).map(user => ({
        //         "Name": user.fullName,
        //         "Email": user.email,
        //         "Phone": user.phone,
        //         "Signed Up": new Date(user.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
        //     }))
        // };
        
        //  if (usersWithoutBookings.length > 0) {
        //     try {
        //         await DiscordConnect(process.env.DISCORD_WEB_HOOK_URL || process.env.DISCORD_MEET_WEB_HOOK_URL, JSON.stringify(discordMessage, null, 2));
        //     } catch (discordError) {
        //         console.error('Failed to send Discord notification:', discordError);
        //     }
        // }
        
        return res.status(200).json({
            success: true,
            message: `Found ${uniqueEmails.length} users who signed up but haven't booked a meeting`,
            data: responseData
        });
        
    } catch (error) {
        console.error('Error in GetUsersWithoutBookings controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


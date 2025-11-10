import { UserModel } from "../Schema_Models/User.js";
import { CampaignBookingModel } from "../Schema_Models/CampaignBooking.js";
import { DiscordConnect } from "../Utils/DiscordConnect.js";


export default async function GetUsersWithoutBookings(req, res) {
    try {
        const allUsers = await UserModel.find({}).select('email fullName phone countryCode createdAt workAuthorization').lean();
        
        const bookedEmails = await CampaignBookingModel.distinct('clientEmail');
        
        const bookedEmailsLower = bookedEmails.map(email => email?.toLowerCase()).filter(Boolean);
        
        const usersWithoutBookings = allUsers.filter(user => {
            const userEmailLower = user.email?.toLowerCase();
            if (!userEmailLower || userEmailLower === 'not specified') {
                return false;
            }
            return !bookedEmailsLower.includes(userEmailLower);
        });
        
        const responseData = {
            totalUsers: allUsers.length,
            totalBookedUsers: bookedEmails.length,
            usersWithoutBookings: usersWithoutBookings.length,
            users: usersWithoutBookings.map(user => ({
                email: user.email,
                fullName: user.fullName,
                phone: user.phone,
                countryCode: user.countryCode,
                workAuthorization: user.workAuthorization,
                signedUpAt: user.createdAt
            }))
        };
        
        const discordMessage = {
            "Message": "Users Without Bookings",
            "Total Users Signed Up": allUsers.length,
            "Users Who Booked Meetings": bookedEmails.length,
            "Users Without Bookings": usersWithoutBookings.length,
            "Details": usersWithoutBookings.slice(0, 10).map(user => ({
                "Name": user.fullName,
                "Email": user.email,
                "Phone": user.phone,
                "Signed Up": new Date(user.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            }))
        };
        
         if (usersWithoutBookings.length > 0) {
            try {
                await DiscordConnect(process.env.DISCORD_WEB_HOOK_URL || process.env.DISCORD_MEET_WEB_HOOK_URL, JSON.stringify(discordMessage, null, 2));
            } catch (discordError) {
                console.error('Failed to send Discord notification:', discordError);
            }
        }
        
        return res.status(200).json({
            success: true,
            message: `Found ${usersWithoutBookings.length} users who signed up but haven't booked a meeting`,
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


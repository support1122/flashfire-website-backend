import { UserModel } from "../Schema_Models/User.js";
import { CampaignBookingModel } from "../Schema_Models/CampaignBooking.js";

export default async function GetUsersWithoutBookingsDetailed(req, res) {
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
        
        // Remove duplicates by email
        const seenEmails = new Set();
        const uniqueUsers = [];
        
        for (const user of usersWithoutBookings) {
            const emailLower = user.email?.toLowerCase();
            if (emailLower && !seenEmails.has(emailLower)) {
                seenEmails.add(emailLower);
                uniqueUsers.push({
                    email: user.email,
                    fullName: user.fullName || 'Not Provided',
                    phone: user.phone || 'Not Provided',
                    countryCode: user.countryCode || '+1',
                    createdAt: user.createdAt,
                    workAuthorization: user.workAuthorization || 'Not Specified',
                });
            }
        }
        
        return res.status(200).json({
            success: true,
            message: `Found ${uniqueUsers.length} users who signed up but haven't booked a meeting`,
            data: uniqueUsers
        });
        
    } catch (error) {
        console.error('Error in GetUsersWithoutBookingsDetailed controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


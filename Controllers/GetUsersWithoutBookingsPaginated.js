import { UserModel } from "../Schema_Models/User.js";
import { CampaignBookingModel } from "../Schema_Models/CampaignBooking.js";

export default async function GetUsersWithoutBookingsPaginated(req, res) {
    try {
        const {
            page = 1,
            limit = 50,
            search,
            fromDate,
            toDate
        } = req.query;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const bookedEmails = await CampaignBookingModel.distinct('clientEmail');
        const bookedEmailsLower = bookedEmails.map(email => email?.toLowerCase()).filter(Boolean);

        let userQuery = {
            booked: { $ne: true },
            workAuthorization: 'yes'
        };

        if (search) {
            userQuery.$or = [
                { fullName: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } }
            ];
        }

        if (fromDate || toDate) {
            userQuery.createdAt = {};
            if (fromDate) {
                const from = new Date(fromDate);
                from.setHours(0, 0, 0, 0);
                userQuery.createdAt.$gte = from;
            }
            if (toDate) {
                const to = new Date(toDate);
                to.setHours(23, 59, 59, 999);
                userQuery.createdAt.$lte = to;
            }
        }

        const allUsers = await UserModel.find(userQuery)
            .select('email fullName phone countryCode createdAt workAuthorization booked')
            .lean();

        const usersWithoutBookings = allUsers.filter(user => {
            const userEmailLower = user.email?.toLowerCase();
            if (!userEmailLower || userEmailLower === 'not specified') {
                return false;
            }
            return !bookedEmailsLower.includes(userEmailLower);
        });

        const seenEmails = new Set();
        const uniqueUsers = [];

        for (const user of usersWithoutBookings) {
            const emailLower = user.email?.toLowerCase();
            if (emailLower && !seenEmails.has(emailLower)) {
                seenEmails.add(emailLower);
                uniqueUsers.push({
                    email: user.email,
                    fullName: user.fullName || 'Not Provided',
                    phone: user.phone || 'Not Specified',
                    countryCode: user.countryCode || '+1',
                    createdAt: user.createdAt,
                    workAuthorization: user.workAuthorization || 'Not Specified',
                });
            }
        }

        const total = uniqueUsers.length;
        const paginatedUsers = uniqueUsers.slice(skip, skip + limitNum);

        return res.status(200).json({
            success: true,
            data: paginatedUsers,
            pagination: {
                page: pageNum,
                limit: limitNum,
                total,
                pages: Math.ceil(total / limitNum)
            }
        });

    } catch (error) {
        console.error('Error in GetUsersWithoutBookingsPaginated controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}

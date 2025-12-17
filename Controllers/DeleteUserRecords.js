import { UserModel } from '../Schema_Models/User.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

export default async function DeleteUserRecords(req, res) {
    try {
        const { email } = req.params;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required'
            });
        }

        const emailLower = email.toLowerCase().trim();

        // Find user to get details before deletion
        const user = await UserModel.findOne({ email: emailLower });
        const bookings = await CampaignBookingModel.find({ clientEmail: emailLower });

        if (!user && bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No records found for this email'
            });
        }

        // Delete all records
        const deletionResults = {
            userDeleted: false,
            bookingsDeleted: 0,
            userDetails: null,
            bookingDetails: []
        };

        // Delete user if exists
        if (user) {
            deletionResults.userDetails = {
                name: user.fullName || 'Unknown',
                email: user.email,
                phone: user.phone || 'Not Specified'
            };
            const userResult = await UserModel.deleteMany({ email: emailLower });
            deletionResults.userDeleted = userResult.deletedCount > 0;
        }

        // Delete all bookings for this email
        if (bookings.length > 0) {
            deletionResults.bookingDetails = bookings.map(booking => ({
                bookingId: booking.bookingId,
                clientName: booking.clientName,
                scheduledTime: booking.scheduledEventStartTime
            }));
            const bookingResult = await CampaignBookingModel.deleteMany({ clientEmail: emailLower });
            deletionResults.bookingsDeleted = bookingResult.deletedCount;
        }

        return res.status(200).json({
            success: true,
            message: `Successfully deleted all records for ${emailLower}`,
            data: deletionResults
        });

    } catch (error) {
        console.error('Error deleting user records:', error);
        return res.status(500).json({
            success: false,
            message: 'Server error occurred',
            error: error.message
        });
    }
}

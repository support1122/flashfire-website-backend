import { EmailCampaignModel } from "../Schema_Models/EmailCampaign.js";
import { CampaignBookingModel } from "../Schema_Models/CampaignBooking.js";

export default async function GetCampaignDetails(req, res) {
    try {
        const { campaignId, userEmail } = req.params;

        if (!campaignId) {
            return res.status(400).json({
                success: false,
                message: "Campaign ID is required"
            });
        }

        // Get full campaign details
        const campaign = await EmailCampaignModel.findById(campaignId).lean();

        if (!campaign) {
            return res.status(404).json({
                success: false,
                message: "Campaign not found"
            });
        }

        // Find the user's email entry in the campaign
        const userEmailLower = userEmail?.toLowerCase();
        const userSuccessfulEntry = campaign.successfulEmails?.find(
            e => e.email?.toLowerCase() === userEmailLower
        );
        const userFailedEntry = campaign.failedEmails?.find(
            e => e.email?.toLowerCase() === userEmailLower
        );

        const userEntry = userSuccessfulEntry || userFailedEntry;
        const emailSentAt = userSuccessfulEntry?.sentAt || userFailedEntry?.failedAt || campaign.createdAt;

        // Get all campaigns for this user to find the next email (for time window)
        const allUserCampaigns = await EmailCampaignModel.find({
            $or: [
                { 'successfulEmails.email': { $regex: new RegExp(`^${userEmailLower}$`, 'i') } },
                { 'failedEmails.email': { $regex: new RegExp(`^${userEmailLower}$`, 'i') } }
            ]
        })
            .sort({ createdAt: 1 })
            .lean();

        // Find the next campaign after this one
        let nextCampaignSentAt = null;
        const currentIndex = allUserCampaigns.findIndex(c => c._id.toString() === campaignId);
        if (currentIndex >= 0 && currentIndex < allUserCampaigns.length - 1) {
            const nextCampaign = allUserCampaigns[currentIndex + 1];
            const nextSuccessful = nextCampaign.successfulEmails?.find(
                e => e.email?.toLowerCase() === userEmailLower
            );
            const nextFailed = nextCampaign.failedEmails?.find(
                e => e.email?.toLowerCase() === userEmailLower
            );
            nextCampaignSentAt = nextSuccessful?.sentAt || nextFailed?.failedAt || nextCampaign.createdAt;
        }

        // Check if user booked a meeting after this email
        // Time window: from this email sent time to next email sent time (or now if no next email)
        const timeWindowStart = new Date(emailSentAt);
        const timeWindowEnd = nextCampaignSentAt ? new Date(nextCampaignSentAt) : new Date();

        const bookingsAfterEmail = await CampaignBookingModel.find({
            clientEmail: userEmailLower,
            bookingCreatedAt: {
                $gte: timeWindowStart,
                $lt: timeWindowEnd
            }
        })
            .sort({ bookingCreatedAt: 1 })
            .lean();

        // Prepare response
        const response = {
            campaign: {
                _id: campaign._id,
                templateName: campaign.templateName,
                domainName: campaign.domainName,
                templateId: campaign.templateId,
                provider: campaign.provider || 'sendgrid',
                status: campaign.status,
                total: campaign.total,
                success: campaign.success,
                failed: campaign.failed,
                createdAt: campaign.createdAt,
            },
            userEmailDetails: {
                email: userEmail,
                status: userSuccessfulEntry ? 'SUCCESS' : 'FAILED',
                sentAt: emailSentAt,
                error: userFailedEntry?.error || null,
            },
            timeWindow: {
                start: timeWindowStart,
                end: timeWindowEnd,
                hasNextEmail: !!nextCampaignSentAt,
                nextEmailDate: nextCampaignSentAt,
            },
            bookingsAfterEmail: bookingsAfterEmail.map(booking => ({
                bookingId: booking.bookingId,
                clientName: booking.clientName,
                clientEmail: booking.clientEmail,
                scheduledEventStartTime: booking.scheduledEventStartTime,
                bookingCreatedAt: booking.bookingCreatedAt,
                bookingStatus: booking.bookingStatus,
                calendlyMeetLink: booking.calendlyMeetLink,
            })),
            bookingCount: bookingsAfterEmail.length,
            bookedAfterEmail: bookingsAfterEmail.length > 0,
        };

        return res.status(200).json({
            success: true,
            data: response
        });

    } catch (error) {
        console.error('Error in GetCampaignDetails controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


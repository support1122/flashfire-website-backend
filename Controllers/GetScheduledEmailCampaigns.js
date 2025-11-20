import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';

export default async function GetScheduledEmailCampaigns(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const campaigns = await ScheduledEmailCampaignModel.find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const total = await ScheduledEmailCampaignModel.countDocuments();

        return res.status(200).json({
            success: true,
            data: campaigns,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: skip + limit < total
            }
        });

    } catch (error) {
        console.error('[GetScheduledEmailCampaigns] Error:', {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


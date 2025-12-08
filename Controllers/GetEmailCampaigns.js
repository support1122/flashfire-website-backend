import { EmailCampaignModel } from "../Schema_Models/EmailCampaign.js";

export default async function GetEmailCampaigns(req, res) {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const campaigns = await EmailCampaignModel.find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

            
        const total = await EmailCampaignModel.countDocuments();

        const formattedCampaigns = campaigns.map(campaign => ({
            _id: campaign._id,
            templateName: campaign.templateName,
            domainName: campaign.domainName,
            templateId: campaign.templateId,
            total: campaign.total,
            success: campaign.success,
            failed: campaign.failed,
            status: campaign.status,
            createdAt: campaign.createdAt,
            successfulEmails: campaign.successfulEmails,
            failedEmails: campaign.failedEmails
        }));

        return res.status(200).json({
            success: true,
            data: formattedCampaigns,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: skip + limit < total
            }
        });

    } catch (error) {
        console.error('Error in GetEmailCampaigns controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


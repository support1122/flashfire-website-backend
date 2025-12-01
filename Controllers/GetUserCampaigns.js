import { EmailCampaignModel } from "../Schema_Models/EmailCampaign.js";

export default async function GetUserCampaigns(req, res) {
    try {
        const { email } = req.params;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email parameter is required"
            });
        }

        // Find all campaigns where this email appears in successfulEmails or failedEmails
        const campaigns = await EmailCampaignModel.find({
            $or: [
                { 'successfulEmails.email': { $regex: new RegExp(`^${email}$`, 'i') } },
                { 'failedEmails.email': { $regex: new RegExp(`^${email}$`, 'i') } }
            ]
        })
            .sort({ createdAt: -1 })
            .select('templateName domainName templateId provider status createdAt successfulEmails failedEmails')
            .lean();

        // Filter to only include campaigns where this specific email was sent
        const userCampaigns = campaigns
            .map(campaign => {
                const successful = campaign.successfulEmails?.find(e => e.email?.toLowerCase() === email.toLowerCase());
                const failed = campaign.failedEmails?.find(e => e.email?.toLowerCase() === email.toLowerCase());
                
                if (successful || failed) {
                    return {
                        _id: campaign._id,
                        templateName: campaign.templateName,
                        domainName: campaign.domainName,
                        templateId: campaign.templateId,
                        provider: campaign.provider || 'sendgrid',
                        status: successful ? 'success' : 'failed',
                        sentAt: successful?.sentAt || failed?.failedAt || campaign.createdAt,
                        createdAt: campaign.createdAt
                    };
                }
                return null;
            })
            .filter(Boolean);

        return res.status(200).json({
            success: true,
            data: userCampaigns,
            count: userCampaigns.length
        });

    } catch (error) {
        console.error('Error in GetUserCampaigns controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


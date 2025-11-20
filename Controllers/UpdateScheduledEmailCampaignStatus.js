import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';

export default async function UpdateScheduledEmailCampaignStatus(req, res) {
    try {
        const { campaignId } = req.params;
        const { status } = req.body;

        if (!status) {
            return res.status(400).json({
                success: false,
                message: 'Status is required'
            });
        }

        const validStatuses = ['active', 'paused', 'completed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        const campaign = await ScheduledEmailCampaignModel.findById(campaignId);
        if (!campaign) {
            return res.status(404).json({
                success: false,
                message: 'Campaign not found'
            });
        }

        // Don't allow changing status if campaign is already completed
        if (campaign.status === 'completed') {
            return res.status(400).json({
                success: false,
                message: 'Cannot change status of a completed campaign'
            });
        }

        const oldStatus = campaign.status;
        campaign.status = status;

        campaign.logs.push({
            timestamp: new Date(),
            level: 'info',
            message: `Campaign status changed from ${oldStatus} to ${status}`,
            details: {
                oldStatus,
                newStatus: status,
                changedAt: new Date()
            }
        });

        await campaign.save();

        return res.status(200).json({
            success: true,
            message: `Campaign status updated to ${status}`,
            data: {
                campaignId: campaign._id,
                status: campaign.status,
                previousStatus: oldStatus
            }
        });

    } catch (error) {
        console.error('[UpdateScheduledEmailCampaignStatus] Error:', {
            error: error.message,
            stack: error.stack,
            timestamp: new Date().toISOString()
        });
        return res.status(500).json({
            success: false,
            message: 'Server error occurred',
            error: error.message
        });
    }
}


import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
import { UserModel } from "../Schema_Models/User.js";
import { EmailCampaignModel } from "../Schema_Models/EmailCampaign.js";

dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

export default async function ResendEmailCampaign(req, res) {
    try {
        const { campaignId, emailIds } = req.body;

        if (!campaignId || !emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Campaign ID and email IDs are required"
            });
        }

        const campaign = await EmailCampaignModel.findById(campaignId);
        if (!campaign) {
            return res.status(404).json({
                success: false,
                message: "Campaign not found"
            });
        }

        const senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL;
        if (!senderEmail) {
            return res.status(500).json({
                success: false,
                message: "Sender email not configured"
            });
        }

        const results = {
            successful: [],
            failed: []
        };

        for (const email of emailIds) {
            const trimmedEmail = email.trim();
            if (!trimmedEmail) continue;

            try {
                const msg = {
                    to: trimmedEmail,
                    from: senderEmail,
                    templateId: campaign.templateId,
                    dynamicTemplateData: {
                        domain: campaign.domainName
                    }
                };

                await sgMail.send(msg);
                results.successful.push({
                    email: trimmedEmail,
                    sentAt: new Date()
                });

                // Note: We don't set booked: true here anymore
                // The booked field should only be set when a booking actually exists in CampaignBooking database

            } catch (error) {
                console.error(`Failed to resend email to ${trimmedEmail}:`, error);
                results.failed.push({
                    email: trimmedEmail,
                    error: error.message,
                    failedAt: new Date()
                });
            }
        }

        const emailsToResend = emailIds.map(e => e.trim().toLowerCase());
        const updatedSuccessfulEmails = [
            ...campaign.successfulEmails.filter(e => !emailsToResend.includes(e.email.toLowerCase())),
            ...results.successful
        ];
        const updatedFailedEmails = [
            ...campaign.failedEmails.filter(f => !emailsToResend.includes(f.email.toLowerCase())),
            ...results.failed
        ];

        const newSuccess = updatedSuccessfulEmails.length;
        const newFailed = updatedFailedEmails.length;
        const newTotal = newSuccess + newFailed;

        let status = 'SUCCESS';
        if (newFailed > 0 && newSuccess > 0) {
            status = 'PARTIAL';
        } else if (newFailed > 0 && newSuccess === 0) {
            status = 'FAILED';
        }

        await EmailCampaignModel.findByIdAndUpdate(campaignId, {
            success: newSuccess,
            failed: newFailed,
            total: newTotal,
            successfulEmails: updatedSuccessfulEmails,
            failedEmails: updatedFailedEmails,
            status
        });

        return res.status(200).json({
            success: true,
            message: `Resent ${results.successful.length} emails successfully, ${results.failed.length} failed`,
            data: {
                totalSent: results.successful.length,
                totalFailed: results.failed.length,
                successful: results.successful.map(r => r.email),
                failed: results.failed
            }
        });

    } catch (error) {
        console.error('Error in ResendEmailCampaign controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


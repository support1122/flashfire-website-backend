import sgMail from "@sendgrid/mail";
import dotenv from "dotenv";
import { UserModel } from "../Schema_Models/User.js";
import { EmailCampaignModel } from "../Schema_Models/EmailCampaign.js";

dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

export default async function SendEmailCampaign(req, res) {
    try {
        
        const { domainName, templateName, templateId, emailIds, senderEmail: requestSenderEmail } = req.body;

        if (!domainName || !templateId || !emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Domain name, template ID, and email IDs are required"
            });
        }

        // Determine sender email with priority:
        // 1. Explicit senderEmail from request
        // 2. If domainName is provided, construct: elizabeth@${domainName}
        // 3. Default: elizabeth@flashfirehq.com
        // 4. Fallback to env variable
        let senderEmail;
        if (requestSenderEmail) {
            senderEmail = requestSenderEmail;
        } else {
            const stepDomainName = domainName || process.env.DOMAIN_NAME || null;
            if (stepDomainName) {
                senderEmail = `elizabeth@${stepDomainName}`;
            } else {
                senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
            }
        }

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
                    templateId: templateId,
                    dynamicTemplateData: {
                        domain: domainName
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
                console.error(`Failed to send email to ${trimmedEmail}:`, error);
                results.failed.push({
                    email: trimmedEmail,
                    error: error.message,
                    failedAt: new Date()
                });
            }
        }

        let status = 'SUCCESS';
        if (results.failed.length > 0 && results.successful.length > 0) {
            status = 'PARTIAL';
        } else if (results.failed.length > 0 && results.successful.length === 0) {
            status = 'FAILED';
        }

        const campaignLog = new EmailCampaignModel({
            templateName: templateName || '',
            domainName,
            templateId,
            provider: 'sendgrid',
            total: emailIds.length,
            success: results.successful.length,
            failed: results.failed.length,
            successfulEmails: results.successful,
            failedEmails: results.failed,
            status
        });

        await campaignLog.save();

        return res.status(200).json({
            success: true,
            message: `Campaign sent successfully. ${results.successful.length} emails sent, ${results.failed.length} failed`,
            data: {
                campaignId: campaignLog._id,
                totalSent: results.successful.length,
                totalFailed: results.failed.length,
                successful: results.successful.map(r => r.email),
                failed: results.failed
            }
        });

    } catch (error) {
        console.error('Error in SendEmailCampaign controller:', error);
        return res.status(500).json({
            success: false,
            message: "Server error occurred",
            error: error.message
        });
    }
}


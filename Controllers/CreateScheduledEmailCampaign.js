import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { getIST730PM } from '../Utils/cronScheduler.js';
import { DateTime } from 'luxon';

const DAY_GAPS = [0, 4, 3, 7, 14];
const IST_TIMEZONE = 'Asia/Kolkata';

function calculateSendDates(startDate) {
    const dates = [];
    let currentDate = DateTime.fromJSDate(startDate).setZone(IST_TIMEZONE);
    
    let cumulativeDays = 0;
    for (let i = 0; i < DAY_GAPS.length; i++) {
        cumulativeDays += DAY_GAPS[i];
        const targetDate = currentDate.plus({ days: cumulativeDays });
        const sendDate = getIST730PM(targetDate.toJSDate());
        
        dates.push({
            day: cumulativeDays,
            scheduledDate: sendDate,
            status: 'pending',
            sentCount: 0,
            failedCount: 0,
            skippedCount: 0,
            jobIds: []
        });
    }
    
    return dates;
}

export default async function CreateScheduledEmailCampaign(req, res) {
    try {
        const { templateName, domainName, templateId, emailIds, senderEmail: requestSenderEmail } = req.body;

        if (!templateName || !domainName || !templateId || !emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Template name, domain name, template ID, and email IDs are required"
            });
        }

        const uniqueEmails = [...new Set(emailIds.map(e => e.trim().toLowerCase()).filter(Boolean))];
        
        if (uniqueEmails.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid email addresses provided"
            });
        }

        const startDate = new Date();
        const sendSchedule = calculateSendDates(startDate);

        const campaign = new ScheduledEmailCampaignModel({
            campaignName: `${templateName} - ${new Date().toISOString().split('T')[0]}`,
            templateName,
            domainName,
            templateId,
            recipientEmails: uniqueEmails,
            totalRecipients: uniqueEmails.length,
            sendSchedule,
            status: 'active',
            startedAt: startDate,
            logs: [{
                timestamp: new Date(),
                level: 'info',
                message: `Scheduled email campaign created with ${uniqueEmails.length} recipients`,
                details: {
                    templateName,
                    domainName,
                    templateId,
                    sendSchedule: sendSchedule.map(s => ({
                        day: s.day,
                        scheduledDate: s.scheduledDate
                    }))
                }
            }]
        });

        if (requestSenderEmail) {
            campaign.senderEmail = requestSenderEmail;
        }

        await campaign.save();

        return res.status(200).json({
            success: true,
            message: `Scheduled email campaign created successfully. ${uniqueEmails.length} recipients will receive emails on ${sendSchedule.length} scheduled dates.`,
            data: {
                campaignId: campaign._id,
                totalRecipients: uniqueEmails.length,
                sendSchedule: sendSchedule.map(s => ({
                    day: s.day,
                    scheduledDate: s.scheduledDate,
                    status: s.status
                })),
                status: campaign.status
            }
        });

    } catch (error) {
        console.error('[CreateScheduledEmailCampaign] Error:', {
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


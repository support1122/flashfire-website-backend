import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { emailQueue } from '../Utils/queue.js';
import { DateTime } from 'luxon';

const SEND_TIME_HOUR = 19;
const SEND_TIME_MINUTE = 30;

const DAY_GAPS = [0, 4, 3, 7, 14];

function calculateSendDates(startDate) {
    const dates = [];
    let currentDate = DateTime.fromJSDate(startDate).setZone('America/New_York');
    
    let cumulativeDays = 0;
    for (let i = 0; i < DAY_GAPS.length; i++) {
        cumulativeDays += DAY_GAPS[i];
        const sendDate = currentDate.plus({ days: cumulativeDays })
            .set({ hour: SEND_TIME_HOUR, minute: SEND_TIME_MINUTE, second: 0, millisecond: 0 });
        
        dates.push({
            day: cumulativeDays,
            scheduledDate: sendDate.toJSDate(),
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
        const { templateName, domainName, templateId, emailIds } = req.body;

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

        await campaign.save();

        for (let i = 0; i < sendSchedule.length; i++) {
            const scheduleItem = sendSchedule[i];
            const delay = scheduleItem.scheduledDate.getTime() - Date.now();
            
            if (delay < 0) {
                campaign.logs.push({
                    timestamp: new Date(),
                    level: 'warning',
                    message: `Send date ${scheduleItem.day} is in the past, skipping`,
                    details: { day: scheduleItem.day, scheduledDate: scheduleItem.scheduledDate }
                });
                continue;
            }

            const job = await emailQueue.add(
                'send-scheduled-emails',
                {
                    campaignId: campaign._id.toString(),
                    sendDay: scheduleItem.day,
                    scheduledDate: scheduleItem.scheduledDate,
                    templateName,
                    domainName,
                    templateId,
                    recipientEmails: uniqueEmails
                },
                {
                    delay,
                    attempts: 3,
                    backoff: {
                        type: 'exponential',
                        delay: 60000
                    }
                }
            );

            campaign.sendSchedule[i].jobIds.push(job.id);
            campaign.logs.push({
                timestamp: new Date(),
                level: 'info',
                message: `Scheduled email job created for day ${scheduleItem.day}`,
                details: {
                    jobId: job.id,
                    scheduledDate: scheduleItem.scheduledDate,
                    delayMs: delay
                }
            });
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


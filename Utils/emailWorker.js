import { Worker } from 'bullmq';
import dotenv from 'dotenv';
import sgMail from '@sendgrid/mail';
import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { EmailCampaignModel } from '../Schema_Models/EmailCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

dotenv.config();

sgMail.setApiKey(process.env.SENDGRID_API_KEY_1);

const senderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL;

async function checkUserHasBooking(email) {
    try {
        const booking = await CampaignBookingModel.findOne({
            clientEmail: email.toLowerCase(),
            bookingStatus: { $in: ['scheduled', 'completed'] }
        }).lean();
        
        return !!booking;
    } catch (error) {
        console.error(`[EmailWorker] Error checking booking for ${email}:`, error.message);
        return false;
    }
}

async function sendEmail(email, templateId, domainName, templateName) {
    try {
        const msg = {
            to: email,
            from: senderEmail,
            templateId: templateId,
            dynamicTemplateData: {
                domain: domainName
            }
        };

        await sgMail.send(msg);
        return { success: true };
    } catch (error) {
        return { 
            success: false, 
            error: error.message || 'Unknown error',
            response: error.response?.body || null
        };
    }
}

let emailWorker;

// ONLY create worker if UPSTASH_REDIS_URL is configured
if (!process.env.UPSTASH_REDIS_URL) {
    console.warn('[EmailWorker] ⚠️ UPSTASH_REDIS_URL not configured. Email campaigns will not work.');
    emailWorker = null;
} else {
    try {
        emailWorker = new Worker(
        'emailQueue',
        async (job) => {
        const {
            campaignId,
            sendDay,
            scheduledDate,
            templateName,
            domainName,
            templateId,
            recipientEmails
        } = job.data;

        console.log(`[EmailWorker] Processing job ${job.id} for campaign ${campaignId}, day ${sendDay}`);

        const campaign = await ScheduledEmailCampaignModel.findById(campaignId);
        if (!campaign) {
            throw new Error(`Campaign ${campaignId} not found`);
        }

        // Check if campaign is paused or cancelled - if so, skip sending emails
        if (campaign.status === 'paused' || campaign.status === 'cancelled') {
            console.log(`[EmailWorker] Campaign ${campaignId} is ${campaign.status}, skipping email send for day ${sendDay}`);
            
            const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === sendDay);
            if (scheduleIndex !== -1) {
                campaign.sendSchedule[scheduleIndex].status = 'skipped';
                campaign.sendSchedule[scheduleIndex].skippedCount = recipientEmails.length;
                campaign.sendSchedule[scheduleIndex].completedAt = new Date();
            }
            
            campaign.logs.push({
                timestamp: new Date(),
                level: 'warning',
                message: `Skipped email send for day ${sendDay} - campaign is ${campaign.status}`,
                details: { 
                    jobId: job.id, 
                    sendDay, 
                    campaignStatus: campaign.status,
                    recipientCount: recipientEmails.length
                }
            });
            await campaign.save();
            
            return {
                success: true,
                sendDay,
                successful: 0,
                failed: 0,
                skipped: recipientEmails.length,
                reason: `Campaign is ${campaign.status}`
            };
        }

        const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === sendDay);
        if (scheduleIndex === -1) {
            throw new Error(`Schedule for day ${sendDay} not found`);
        }

        campaign.sendSchedule[scheduleIndex].status = 'processing';
        campaign.logs.push({
            timestamp: new Date(),
            level: 'info',
            message: `Starting email send for day ${sendDay}`,
            details: { jobId: job.id, recipientCount: recipientEmails.length }
        });
        await campaign.save();

        const results = {
            successful: [],
            failed: [],
            skipped: []
        };

        for (const email of recipientEmails) {
            const trimmedEmail = email.trim().toLowerCase();
            if (!trimmedEmail) continue;

            const hasBooking = await checkUserHasBooking(trimmedEmail);
            
            if (hasBooking) {
                results.skipped.push({
                    email: trimmedEmail,
                    reason: 'User has booking',
                    skippedAt: new Date()
                });
                campaign.logs.push({
                    timestamp: new Date(),
                    level: 'info',
                    message: `Skipped ${trimmedEmail} - user has booking`,
                    details: { email: trimmedEmail, sendDay }
                });
                continue;
            }

            const sendResult = await sendEmail(trimmedEmail, templateId, domainName, templateName);
            
            if (sendResult.success) {
                results.successful.push({
                    email: trimmedEmail,
                    sentAt: new Date(),
                    sendDay,
                    scheduledSendDate: scheduledDate
                });
            } else {
                results.failed.push({
                    email: trimmedEmail,
                    error: sendResult.error,
                    failedAt: new Date(),
                    sendDay,
                    scheduledSendDate: scheduledDate
                });
                campaign.logs.push({
                    timestamp: new Date(),
                    level: 'error',
                    message: `Failed to send email to ${trimmedEmail}`,
                    details: { 
                        email: trimmedEmail, 
                        error: sendResult.error,
                        sendDay,
                        response: sendResult.response
                    }
                });
            }
        }

        const emailCampaign = new EmailCampaignModel({
            templateName,
            domainName,
            templateId,
            provider: 'sendgrid',
            total: recipientEmails.length,
            success: results.successful.length,
            failed: results.failed.length,
            successfulEmails: results.successful,
            failedEmails: results.failed,
            status: results.failed.length === 0 ? 'SUCCESS' : (results.successful.length > 0 ? 'PARTIAL' : 'FAILED'),
            isScheduled: true,
            scheduledCampaignId: campaign._id
        });
        await emailCampaign.save();

        campaign.sendSchedule[scheduleIndex].status = 'completed';
        campaign.sendSchedule[scheduleIndex].sentCount = results.successful.length;
        campaign.sendSchedule[scheduleIndex].failedCount = results.failed.length;
        campaign.sendSchedule[scheduleIndex].skippedCount = results.skipped.length;
        campaign.sendSchedule[scheduleIndex].completedAt = new Date();

        const allCompleted = campaign.sendSchedule.every(s => s.status === 'completed');
        if (allCompleted) {
            campaign.status = 'completed';
            campaign.completedAt = new Date();
        }

        campaign.logs.push({
            timestamp: new Date(),
            level: 'success',
            message: `Completed email send for day ${sendDay}`,
            details: {
                sendDay,
                successful: results.successful.length,
                failed: results.failed.length,
                skipped: results.skipped.length,
                emailCampaignId: emailCampaign._id
            }
        });

        await campaign.save();

        console.log(`[EmailWorker] Completed job ${job.id} for day ${sendDay}: ${results.successful.length} sent, ${results.failed.length} failed, ${results.skipped.length} skipped`);

        return {
            success: true,
            sendDay,
            successful: results.successful.length,
            failed: results.failed.length,
            skipped: results.skipped.length
        };

    },
    {
        connection: { url: process.env.UPSTASH_REDIS_URL },
        concurrency: 5
    }
    );

        emailWorker.on('completed', (job) => {
            console.log(`[EmailWorker] Job ${job.id} completed`);
        });

        emailWorker.on('failed', (job, err) => {
            console.error(`[EmailWorker] Job ${job.id} failed:`, err.message);
            
            if (job?.data?.campaignId) {
                ScheduledEmailCampaignModel.findById(job.data.campaignId).then(campaign => {
                    if (campaign) {
                        const scheduleIndex = campaign.sendSchedule.findIndex(s => s.day === job.data.sendDay);
                        if (scheduleIndex !== -1) {
                            campaign.sendSchedule[scheduleIndex].status = 'failed';
                        }
                        campaign.logs.push({
                            timestamp: new Date(),
                            level: 'error',
                            message: `Job ${job.id} failed`,
                            details: {
                                jobId: job.id,
                                sendDay: job.data.sendDay,
                                error: err.message,
                                stack: err.stack
                            }
                        });
                        campaign.save();
                    }
                }).catch(error => {
                    console.error(`[EmailWorker] Error updating campaign after failure:`, error.message);
                });
            }
        });

        console.log('[EmailWorker] ✅ Email worker started and listening for jobs');
    } catch (error) {
        console.warn('[EmailWorker] ⚠️ Could not start email worker - Redis connection failed');
        console.warn('[EmailWorker] Email campaigns will not be processed automatically');
        console.warn('[EmailWorker] Error:', error.message);
        emailWorker = null;
    }
}

export default emailWorker;


import { Worker } from 'bullmq';
import dotenv from 'dotenv';
import sgMail from '@sendgrid/mail';
import { ScheduledEmailCampaignModel } from '../Schema_Models/ScheduledEmailCampaign.js';
import { EmailCampaignModel } from '../Schema_Models/EmailCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getRedisUrl, createRedisOptions, createRedisClient } from './queue.js';

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

async function sendEmail(email, templateId, domainName, templateName, customSenderEmail = null) {
    try {
        // Determine sender email with priority:
        // 1. Custom senderEmail passed to function
        // 2. If domainName is provided, construct: elizabeth@${domainName}
        // 3. Default: elizabeth@flashfirehq.com
        // 4. Fallback to env variable
        let finalSenderEmail;
        if (customSenderEmail) {
            finalSenderEmail = customSenderEmail;
        } else {
            const stepDomainName = domainName || process.env.DOMAIN_NAME || null;
            if (stepDomainName) {
                finalSenderEmail = `elizabeth@${stepDomainName}`;
            } else {
                finalSenderEmail = process.env.SENDER_EMAIL || process.env.SENDGRID_FROM_EMAIL || 'elizabeth@flashfirehq.com';
            }
        }

        const msg = {
            to: email,
            from: finalSenderEmail,
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

console.log('\n📧 ========================================');
console.log('📧 [EmailWorker] Initializing Email Worker');
console.log('📧 ========================================\n');

const REDIS_URL = getRedisUrl();
let emailWorker;
let workerConnection = null;

if (!REDIS_URL) {
    console.error('❌ [EmailWorker] No Redis URL configured!');
    console.warn('⚠️  [EmailWorker] Email worker disabled');
} else {
    console.log('🔄 [EmailWorker] Creating dedicated Redis connection...');

    workerConnection = createRedisClient(REDIS_URL, 'EmailWorker');

    if (workerConnection) {
        workerConnection.on('connect', () => console.log('✅ [EmailWorker] Dedicated Redis connection established'));
        workerConnection.on('ready', () => console.log('✅ [EmailWorker] ioredis ready to accept commands'));
        // workerConnection.on('error', (err) => console.error('❌ [EmailWorker] Redis error:', err.message)); 
        // Note: createRedisClient might already log invalid URL, but connection errors are good to log here too.
        // Actually the original code had connection listeners.
        // Let's keep them attached to the instance returned by createRedisClient.

        workerConnection.on('error', (err) => console.error('❌ [EmailWorker] Redis error:', err.message));
        workerConnection.on('close', () => console.warn('⚠️  [EmailWorker] Redis connection closed'));
        workerConnection.on('reconnecting', (delay) => console.log(`🔄 [EmailWorker] Redis reconnecting in ${delay}ms...`));
    }
}

// ONLY create worker if Connection is available
if (!workerConnection) {
    console.warn('[EmailWorker] ⚠️ Redis connection not available. Email campaigns will not work.');
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
                    recipientEmails,
                    senderEmail: jobSenderEmail
                } = job.data;

                console.log('\n📥 ========================================');
                console.log(`📥 [EmailWorker] Job Received: ${job.id}`);
                console.log('📥 ========================================');
                console.log(`📌 Campaign ID: ${campaignId}`);
                console.log(`📌 Send Day: ${sendDay}`);
                console.log(`📌 Template: ${templateName}`);
                console.log(`📌 Recipients: ${recipientEmails?.length || 0}`);
                console.log('========================================\n');

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

                    const sendResult = await sendEmail(trimmedEmail, templateId, domainName, templateName, jobSenderEmail);

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
                connection: workerConnection,
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

        emailWorker.on('completed', (job) => {
            console.log(`\n🎉 ========================================`);
            console.log(`🎉 [EmailWorker] Job Completed: ${job.id}`);
            console.log(`🎉 ========================================\n`);
        });

        emailWorker.on('failed', (job, err) => {
            console.error(`\n💥 ========================================`);
            console.error(`💥 [EmailWorker] Job Failed: ${job?.id}`);
            console.error(`💥 Error: ${err.message}`);
            console.error(`💥 ========================================\n`);
        });

        emailWorker.on('active', (job) => {
            console.log(`⚡ [EmailWorker] Job Active: ${job.id}`);
        });

        emailWorker.on('stalled', (jobId) => {
            console.warn(`⚠️ [EmailWorker] Job Stalled: ${jobId}`);
        });

        emailWorker.on('error', (err) => {
            console.error('❌ [EmailWorker] Worker error:', err.message);
        });

        emailWorker.on('ready', () => {
            console.log('✅ [EmailWorker] Worker connected to Redis successfully!');
            console.log('👂 [EmailWorker] Listening for jobs on "emailQueue"...');
        });

        emailWorker.on('close', () => {
            console.warn('⚠️ [EmailWorker] Worker connection closed');
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


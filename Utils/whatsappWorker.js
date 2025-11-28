import { Worker } from 'bullmq';
import dotenv from 'dotenv';
import WatiService from './WatiService.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

dotenv.config();

/**
 * Check if user has a completed or scheduled booking
 */
async function checkUserHasBooking(mobileNumber) {
    try {
        // Normalize mobile number for comparison
        const normalizedMobile = mobileNumber.replace(/\D/g, '');
        
        const booking = await CampaignBookingModel.findOne({
            clientPhone: { $regex: normalizedMobile, $options: 'i' },
            bookingStatus: { $in: ['scheduled', 'completed'] }
        }).lean();
        
        return !!booking;
    } catch (error) {
        console.error(`[WhatsAppWorker] Error checking booking for ${mobileNumber}:`, error.message);
        return false;
    }
}

/**
 * Send WhatsApp message using WATI
 */
async function sendWhatsAppMessage(mobileNumber, templateName, parameters, campaignId) {
    try {
        const result = await WatiService.sendTemplateMessage({
            mobileNumber,
            templateName,
            parameters,
            campaignId
        });

        return result;
    } catch (error) {
        return { 
            success: false, 
            error: error.message || 'Unknown error'
        };
    }
}

let whatsappWorker;

try {
    whatsappWorker = new Worker(
    'whatsappQueue',
    async (job) => {
        const {
            campaignId,
            sendDay,
            scheduledDate,
            templateName,
            parameters,
            recipientMobiles
        } = job.data;

        console.log(`[WhatsAppWorker] Processing job ${job.id} for campaign ${campaignId}, day ${sendDay}`);

        const campaign = await WhatsAppCampaignModel.findOne({ campaignId });
        if (!campaign) {
            throw new Error(`Campaign ${campaignId} not found`);
        }

        // Check if campaign is completed or failed - skip if so
        if (campaign.status === 'COMPLETED' || campaign.status === 'FAILED') {
            console.log(`[WhatsAppWorker] Campaign ${campaignId} is ${campaign.status}, skipping message send for day ${sendDay}`);
            return {
                success: true,
                sendDay,
                successful: 0,
                failed: 0,
                skipped: recipientMobiles.length,
                reason: `Campaign is ${campaign.status}`
            };
        }

        // Update campaign status to IN_PROGRESS
        campaign.status = 'IN_PROGRESS';
        await campaign.save();

        let successfulSends = 0;
        let failedSends = 0;

        // Process each recipient
        for (const mobile of recipientMobiles) {
            try {
                // Check if user has booked - skip if already booked (for follow-up campaigns)
                const hasBooking = await checkUserHasBooking(mobile);
                if (hasBooking && templateName.toLowerCase().includes('follow')) {
                    console.log(`[WhatsAppWorker] User ${mobile} already has booking, skipping follow-up`);
                    
                    // Update message status to skipped
                    const messageIndex = campaign.messageStatuses.findIndex(m => m.mobileNumber === mobile);
                    if (messageIndex !== -1) {
                        campaign.messageStatuses[messageIndex].status = 'sent'; // Mark as sent to avoid retry
                        campaign.messageStatuses[messageIndex].errorMessage = 'User already booked';
                    }
                    
                    successfulSends++; // Count as success to not retry
                    continue;
                }

                // Send WhatsApp message
                const result = await sendWhatsAppMessage(mobile, templateName, parameters, campaignId);

                // Update message status
                const messageIndex = campaign.messageStatuses.findIndex(m => m.mobileNumber === mobile);
                
                if (result.success) {
                    successfulSends++;
                    if (messageIndex !== -1) {
                        campaign.messageStatuses[messageIndex].status = 'sent';
                        campaign.messageStatuses[messageIndex].sentAt = new Date();
                        campaign.messageStatuses[messageIndex].watiResponse = result.data;
                    }
                    console.log(`[WhatsAppWorker] ✅ Sent to ${mobile}`);
                } else {
                    failedSends++;
                    if (messageIndex !== -1) {
                        campaign.messageStatuses[messageIndex].status = 'failed';
                        campaign.messageStatuses[messageIndex].errorMessage = result.error;
                    }
                    console.log(`[WhatsAppWorker] ❌ Failed to send to ${mobile}: ${result.error}`);
                }

                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));

            } catch (error) {
                failedSends++;
                console.error(`[WhatsAppWorker] Error processing ${mobile}:`, error.message);
                
                // Update message status
                const messageIndex = campaign.messageStatuses.findIndex(m => m.mobileNumber === mobile);
                if (messageIndex !== -1) {
                    campaign.messageStatuses[messageIndex].status = 'failed';
                    campaign.messageStatuses[messageIndex].errorMessage = error.message;
                }
            }
        }

        // Update campaign statistics
        campaign.successCount += successfulSends;
        campaign.failedCount += failedSends;

        // Determine final campaign status
        if (failedSends === 0 && successfulSends > 0) {
            campaign.status = 'COMPLETED';
        } else if (successfulSends === 0 && failedSends > 0) {
            campaign.status = 'FAILED';
        } else if (successfulSends > 0 && failedSends > 0) {
            campaign.status = 'PARTIAL';
        } else {
            campaign.status = 'COMPLETED'; // All skipped
        }

        campaign.completedAt = new Date();
        await campaign.save();

        console.log(`[WhatsAppWorker] Completed job ${job.id}. Success: ${successfulSends}, Failed: ${failedSends}`);

        return {
            success: true,
            sendDay,
            successful: successfulSends,
            failed: failedSends,
            skipped: 0
        };
    },
    {
        connection: {
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT || 6379,
        },
        limiter: {
            max: 10, // Process max 10 jobs
            duration: 1000, // per second
        },
    }
);

    whatsappWorker.on('completed', (job) => {
        console.log(`[WhatsAppWorker] Job ${job.id} completed successfully`);
    });

    whatsappWorker.on('failed', (job, err) => {
        console.error(`[WhatsAppWorker] Job ${job.id} failed:`, err.message);
    });

    console.log('[WhatsAppWorker] ✅ WhatsApp worker started and listening for jobs');
} catch (error) {
    console.warn('[WhatsAppWorker] ⚠️ Could not start WhatsApp worker - Redis connection failed');
    console.warn('[WhatsAppWorker] WhatsApp campaigns will not be processed automatically');
    console.warn('[WhatsAppWorker] Error:', error.message);
    whatsappWorker = null;
}

export default whatsappWorker;


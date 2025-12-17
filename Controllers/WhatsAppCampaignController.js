import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import WatiService from '../Utils/WatiService.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { redisConnection } from '../Utils/queue.js'; // Import shared ioredis connection

dotenv.config();

// Initialize Bull MQ Queue for WhatsApp messages - ONLY if Redis configured
let whatsappQueue = null;

if (redisConnection) {
  whatsappQueue = new Queue('whatsappQueue', {
    connection: redisConnection,
  });
  console.log('✅ [WhatsAppController] WhatsAppQueue connected to Redis using ioredis');
} else {
  console.warn('[WhatsAppController] ⚠️ REDIS_CLOUD_URL not configured. Queue unavailable.');
}

// ==================== GET WATI TEMPLATES ====================
export const getWatiTemplates = async (req, res) => {
  try {
    const result = await WatiService.getTemplates();

    if (result.success) {
      return res.status(200).json({
        success: true,
        templates: result.templates
      });
    } else {
      return res.status(500).json({
        success: false,
        message: result.error || 'Failed to fetch templates'
      });
    }
  } catch (error) {
    console.error('Error fetching WATI templates:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
};

// ==================== GET MOBILE NUMBERS BY BOOKING STATUS ====================
export const getMobileNumbersByStatus = async (req, res) => {
  try {
    const { status } = req.query;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status parameter is required'
      });
    }

    const bookings = await CampaignBookingModel.find({
      bookingStatus: status,
      clientPhone: { $exists: true, $ne: null, $ne: '' }
    }).select('clientPhone clientName').lean();

    // Extract unique mobile numbers
    const uniqueMobiles = [...new Set(bookings.map(b => b.clientPhone).filter(Boolean))];

    return res.status(200).json({
      success: true,
      data: uniqueMobiles,
      count: uniqueMobiles.length
    });
  } catch (error) {
    console.error('Error fetching mobile numbers:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch mobile numbers',
      error: error.message
    });
  }
};

// ==================== CREATE WHATSAPP CAMPAIGN ====================
export const createWhatsAppCampaign = async (req, res) => {
  try {
    const {
      templateName,
      templateId,
      mobileNumbers,
      parameters = []
    } = req.body;

    // Validation
    if (!templateName || !mobileNumbers || !Array.isArray(mobileNumbers) || mobileNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Template name and mobile numbers are required'
      });
    }

    // Parse mobile numbers from comma-separated string or array
    let mobilesArray = [];
    if (typeof mobileNumbers === 'string') {
      mobilesArray = mobileNumbers.split(',').map(m => m.trim()).filter(Boolean);
    } else {
      mobilesArray = mobileNumbers;
    }

    // Remove duplicates
    const uniqueMobiles = [...new Set(mobilesArray)];

    // Determine if this is a no-show template (send immediately)
    const isNoShowTemplate = templateName.toLowerCase().includes('no show') || 
                              templateName.toLowerCase().includes('noshow') ||
                              templateName.toLowerCase().includes('mark as no show');

    // Create campaign
    const campaign = await WhatsAppCampaignModel.create({
      templateName,
      templateId,
      mobileNumbers: uniqueMobiles,
      parameters,
      totalRecipients: uniqueMobiles.length,
      status: isNoShowTemplate ? 'IN_PROGRESS' : 'SCHEDULED',
      isScheduled: !isNoShowTemplate
    });

    // Initialize message statuses
    if (isNoShowTemplate) {
      // Send immediately
      campaign.messageStatuses = uniqueMobiles.map(mobile => ({
        mobileNumber: mobile,
        status: 'pending',
        sendDay: 0
      }));
      await campaign.save();

      // Add job to queue (immediate send)
      if (!whatsappQueue) {
        campaign.status = 'FAILED';
        campaign.errorMessage = 'Queue service unavailable. UPSTASH_REDIS_URL not configured.';
        await campaign.save();
        
        return res.status(503).json({
          success: false,
          message: 'WhatsApp campaign created but queue service is unavailable. Please configure UPSTASH_REDIS_URL.',
          campaign: {
            campaignId: campaign.campaignId,
            status: campaign.status
          }
        });
      }

      try {
        await whatsappQueue.add(
          `whatsapp-campaign-${campaign.campaignId}-day-0`,
          {
            campaignId: campaign.campaignId,
            sendDay: 0,
            scheduledDate: new Date(),
            templateName,
            parameters,
            recipientMobiles: uniqueMobiles
          },
          {
            jobId: `${campaign.campaignId}-day-0`,
            removeOnComplete: true,
            removeOnFail: false
          }
        );
      } catch (queueError) {
        console.error('Failed to add job to queue:', queueError.message);
        campaign.status = 'FAILED';
        campaign.errorMessage = 'Queue service unavailable. Please configure Redis.';
        await campaign.save();
        
        return res.status(503).json({
          success: false,
          message: 'WhatsApp campaign created but queue service is unavailable. Please contact support.',
          campaign: {
            campaignId: campaign.campaignId,
            status: campaign.status
          }
        });
      }

      return res.status(201).json({
        success: true,
        message: `WhatsApp campaign created and sending to ${uniqueMobiles.length} recipients immediately`,
        campaign: {
          campaignId: campaign.campaignId,
          status: campaign.status,
          totalRecipients: campaign.totalRecipients
        }
      });
    } else {
      // Schedule for 3 days (0, 1, 2)
      const messageStatuses = [];
      const sendDays = [0, 1, 2]; // Today, Tomorrow, Day after tomorrow

      for (const day of sendDays) {
        for (const mobile of uniqueMobiles) {
          const scheduledDate = new Date();
          scheduledDate.setDate(scheduledDate.getDate() + day);
          
          messageStatuses.push({
            mobileNumber: mobile,
            status: day === 0 ? 'pending' : 'scheduled',
            sendDay: day,
            scheduledSendDate: scheduledDate
          });
        }
      }

      campaign.messageStatuses = messageStatuses;
      await campaign.save();

      // Add jobs to queue for each day
      if (!whatsappQueue) {
        campaign.status = 'FAILED';
        campaign.errorMessage = 'Queue service unavailable. UPSTASH_REDIS_URL not configured.';
        await campaign.save();
        
        return res.status(503).json({
          success: false,
          message: 'WhatsApp campaign created but queue service is unavailable. Please configure UPSTASH_REDIS_URL.',
          campaign: {
            campaignId: campaign.campaignId,
            status: campaign.status
          }
        });
      }

      const { getIST730PM } = await import('../Utils/cronScheduler.js');
      
      const now = new Date();
      let earliestScheduledDate = null;

      for (const day of sendDays) {
        const targetDate = new Date(now);
        targetDate.setDate(targetDate.getDate() + day);
        const scheduledDate = getIST730PM(targetDate);

        if (!earliestScheduledDate || scheduledDate < earliestScheduledDate) {
          earliestScheduledDate = scheduledDate;
        }

        for (const mobile of uniqueMobiles) {
          const existingStatus = campaign.messageStatuses.find(
            m => m.mobileNumber === mobile && m.sendDay === day
          );

          if (!existingStatus) {
            campaign.messageStatuses.push({
              mobileNumber: mobile,
              status: day === 0 ? 'pending' : 'scheduled',
              sendDay: day,
              scheduledSendDate: scheduledDate
            });
          } else {
            existingStatus.scheduledSendDate = scheduledDate;
            if (day === 0) {
              existingStatus.status = 'pending';
            } else {
              existingStatus.status = 'scheduled';
            }
          }
        }
      }

      campaign.scheduledFor = earliestScheduledDate;
      campaign.status = 'SCHEDULED';
      await campaign.save();

      return res.status(201).json({
        success: true,
        message: `WhatsApp campaign created and scheduled for ${uniqueMobiles.length} recipients over 3 days`,
        campaign: {
          campaignId: campaign.campaignId,
          status: campaign.status,
          totalRecipients: campaign.totalRecipients,
          scheduledDays: sendDays
        }
      });
    }
  } catch (error) {
    console.error('Error creating WhatsApp campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create campaign',
      error: error.message
    });
  }
};

// ==================== GET ALL CAMPAIGNS ====================
export const getAllWhatsAppCampaigns = async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const campaigns = await WhatsAppCampaignModel.find()
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();

    const total = await WhatsAppCampaignModel.countDocuments();

    // Calculate success/failed for each campaign
    const campaignsWithDetails = campaigns.map(campaign => {
      const successfulMessages = campaign.messageStatuses?.filter(m => m.status === 'sent').length || 0;
      const failedMessages = campaign.messageStatuses?.filter(m => m.status === 'failed').length || 0;

      return {
        ...campaign,
        successfulMessages,
        failedMessages,
        pendingMessages: campaign.totalRecipients - successfulMessages - failedMessages
      };
    });

    return res.status(200).json({
      success: true,
      data: campaignsWithDetails,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        hasMore: skip + campaigns.length < total
      }
    });
  } catch (error) {
    console.error('Error fetching WhatsApp campaigns:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch campaigns',
      error: error.message
    });
  }
};

// ==================== GET SCHEDULED CAMPAIGNS ====================
export const getScheduledWhatsAppCampaigns = async (req, res) => {
  try {
    const campaigns = await WhatsAppCampaignModel.find({
      status: { $in: ['SCHEDULED', 'IN_PROGRESS'] },
      isScheduled: true
    })
      .sort({ createdAt: -1 })
      .lean();

    // Add scheduling details
    const campaignsWithSchedule = campaigns.map(campaign => {
      const schedules = [];
      
      // Group message statuses by sendDay
      const dayGroups = {};
      campaign.messageStatuses?.forEach(msg => {
        if (!dayGroups[msg.sendDay]) {
          dayGroups[msg.sendDay] = {
            day: msg.sendDay,
            scheduledDate: msg.scheduledSendDate,
            sent: 0,
            pending: 0,
            failed: 0
          };
        }
        
        if (msg.status === 'sent') dayGroups[msg.sendDay].sent++;
        else if (msg.status === 'failed') dayGroups[msg.sendDay].failed++;
        else dayGroups[msg.sendDay].pending++;
      });

      return {
        ...campaign,
        sendSchedule: Object.values(dayGroups).sort((a, b) => a.day - b.day)
      };
    });

    return res.status(200).json({
      success: true,
      data: campaignsWithSchedule
    });
  } catch (error) {
    console.error('Error fetching scheduled campaigns:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch scheduled campaigns',
      error: error.message
    });
  }
};

// ==================== SEND CAMPAIGN NOW ====================
export const sendWhatsAppCampaignNow = async (req, res) => {
  try {
    const { campaignId } = req.params;

    const campaign = await WhatsAppCampaignModel.findOne({ campaignId });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Find pending/scheduled messages
    const pendingMessages = campaign.messageStatuses.filter(
      msg => msg.status === 'pending' || msg.status === 'scheduled'
    );

    if (pendingMessages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No pending messages to send'
      });
    }

    // Group pending messages by sendDay to send them intelligently
    const dayGroups = {};
    pendingMessages.forEach(msg => {
      if (!dayGroups[msg.sendDay]) {
        dayGroups[msg.sendDay] = [];
      }
      dayGroups[msg.sendDay].push(msg.mobileNumber);
    });

    // Get the next day to send (lowest sendDay with pending messages)
    const nextDay = Math.min(...Object.keys(dayGroups).map(Number));
    const mobilesToSend = dayGroups[nextDay];

    console.log(`Sending campaign ${campaignId} Day ${nextDay} to ${mobilesToSend.length} recipients`);

    const { executeWhatsAppCampaign } = await import('../Utils/cronScheduler.js');
    
    campaign.status = 'IN_PROGRESS';
    await campaign.save();
    
    await executeWhatsAppCampaign(campaign);

    return res.status(200).json({
      success: true,
      message: `Sending ${mobilesToSend.length} messages for Day ${nextDay}`,
      data: {
        campaignId: campaign.campaignId,
        day: nextDay,
        recipientCount: mobilesToSend.length
      }
    });
  } catch (error) {
    console.error('Error sending campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to send campaign',
      error: error.message
    });
  }
};


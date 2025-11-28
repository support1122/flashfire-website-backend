import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import WatiService from '../Utils/WatiService.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

dotenv.config();

// Initialize Bull MQ Queue for WhatsApp messages
const whatsappQueue = new Queue('whatsappQueue', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  },
});

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
      for (const day of sendDays) {
        const scheduledDate = new Date();
        scheduledDate.setDate(scheduledDate.getDate() + day);
        
        // Schedule for 10 AM IST
        scheduledDate.setHours(10, 0, 0, 0);

        const delay = day === 0 ? 0 : scheduledDate.getTime() - Date.now();

        await whatsappQueue.add(
          `whatsapp-campaign-${campaign.campaignId}-day-${day}`,
          {
            campaignId: campaign.campaignId,
            sendDay: day,
            scheduledDate,
            templateName,
            parameters,
            recipientMobiles: uniqueMobiles
          },
          {
            jobId: `${campaign.campaignId}-day-${day}`,
            delay: delay > 0 ? delay : 0,
            removeOnComplete: true,
            removeOnFail: false
          }
        );
      }

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


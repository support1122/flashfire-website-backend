import { Queue } from 'bullmq';
import dotenv from 'dotenv';
import WatiService from '../Utils/WatiService.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { redisConnection } from '../Utils/queue.js';
import { scheduleWhatsAppBatch } from '../Utils/JobScheduler.js';
import { getIST10AM } from '../Utils/cronScheduler.js';

dotenv.config();

let whatsappQueue = null;
if (redisConnection) {
  whatsappQueue = new Queue('whatsappQueue', { connection: redisConnection });
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
    const { status, fromDate, toDate } = req.query;

    if (!status) {
      return res.status(400).json({
        success: false,
        message: 'Status parameter is required'
      });
    }

    const query = {
      bookingStatus: status,
      clientPhone: { $exists: true, $ne: null, $ne: '' }
    };

    // Optional date range filter on meeting start time
    if (fromDate || toDate) {
      query.scheduledEventStartTime = {};
      if (fromDate) {
        const from = new Date(fromDate);
        from.setHours(0, 0, 0, 0);
        query.scheduledEventStartTime.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        query.scheduledEventStartTime.$lte = to;
      }
    }

    const bookings = await CampaignBookingModel.find(query)
      .select('clientPhone clientName scheduledEventStartTime')
      .lean();

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

export const getWhatsAppCampaignById = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const campaign = await WhatsAppCampaignModel.findOne({ campaignId }).lean();
    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }
    const recipients = (campaign.messageStatuses || []).map(m => ({
      contactId: m.mobileNumber,
      mobileNumber: m.mobileNumber,
      status: m.status?.toUpperCase?.() || 'PENDING'
    }));
    return res.status(200).json({
      success: true,
      data: {
        ...campaign,
        recipients
      }
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch campaign',
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
      parameters = [],
      scheduledAt
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

    // Optional custom schedule datetime
    let scheduledDate = null;
    if (scheduledAt) {
      const parsed = new Date(scheduledAt);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid scheduledAt value'
        });
      }
      scheduledDate = parsed;
      const now = new Date();
      if (scheduledDate < now) {
        scheduledDate = now;
      }
    }

    // Create campaign
    const campaign = await WhatsAppCampaignModel.create({
      templateName,
      templateId,
      mobileNumbers: uniqueMobiles,
      parameters,
      totalRecipients: uniqueMobiles.length,
      status: isNoShowTemplate && !scheduledDate ? 'IN_PROGRESS' : 'SCHEDULED',
      isScheduled: !!scheduledDate || !isNoShowTemplate
    });

    const params = Array.isArray(parameters) ? parameters : [];

    if (scheduledDate) {
      const now = new Date();
      const delayMs = Math.max(0, scheduledDate.getTime() - now.getTime());
      campaign.messageStatuses = uniqueMobiles.map((mobile) => ({
        mobileNumber: mobile,
        status: delayMs === 0 ? 'pending' : 'scheduled',
        sendDay: 0,
        scheduledSendDate: scheduledDate
      }));
      campaign.scheduledFor = scheduledDate;
      campaign.status = delayMs === 0 ? 'IN_PROGRESS' : 'SCHEDULED';
      campaign.isScheduled = true;
      await campaign.save();

      const scheduleResult = await scheduleWhatsAppBatch({
        mobileNumbers: uniqueMobiles,
        templateName,
        templateId: templateId || undefined,
        parameters: params,
        scheduledStartTime: scheduledDate,
        campaignId: campaign.campaignId,
        metadata: { sendDay: 0 }
      });
      if (!scheduleResult.success) {
        campaign.status = 'FAILED';
        campaign.errorMessage = scheduleResult.error || 'Failed to schedule batch';
        await campaign.save();
        return res.status(500).json({
          success: false,
          message: campaign.errorMessage,
          campaign: { campaignId: campaign.campaignId, status: campaign.status }
        });
      }

      return res.status(201).json({
        success: true,
        message: `WhatsApp campaign scheduled for ${scheduledDate.toISOString()}`,
        campaign: {
          campaignId: campaign.campaignId,
          status: campaign.status,
          totalRecipients: campaign.totalRecipients,
          scheduledAt: scheduledDate
        }
      });
    }

    if (isNoShowTemplate) {
      campaign.messageStatuses = uniqueMobiles.map(mobile => ({
        mobileNumber: mobile,
        status: 'pending',
        sendDay: 0
      }));
      campaign.status = 'IN_PROGRESS';
      await campaign.save();

      const scheduleResult = await scheduleWhatsAppBatch({
        mobileNumbers: uniqueMobiles,
        templateName,
        templateId: templateId || undefined,
        parameters: params,
        scheduledStartTime: new Date(),
        campaignId: campaign.campaignId,
        metadata: { sendDay: 0 }
      });
      if (!scheduleResult.success) {
        campaign.status = 'FAILED';
        campaign.errorMessage = scheduleResult.error || 'Failed to schedule batch';
        await campaign.save();
        return res.status(500).json({
          success: false,
          message: campaign.errorMessage,
          campaign: { campaignId: campaign.campaignId, status: campaign.status }
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
    }

    const sendDays = [0, 1, 2];
    const now = new Date();
    const messageStatuses = [];
    for (const day of sendDays) {
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + day);
      const scheduledSendDate = day === 0 ? now : getIST10AM(targetDate);
      for (const mobile of uniqueMobiles) {
        messageStatuses.push({
          mobileNumber: mobile,
          status: day === 0 ? 'pending' : 'scheduled',
          sendDay: day,
          scheduledSendDate
        });
      }
    }
    campaign.messageStatuses = messageStatuses;
    campaign.scheduledFor = getIST10AM(now);
    campaign.status = 'SCHEDULED';
    campaign.isScheduled = true;
    await campaign.save();

    const day0Start = new Date();
    const day1Start = getIST10AM(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const day2Start = getIST10AM(new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000));

    const r0 = await scheduleWhatsAppBatch({
      mobileNumbers: uniqueMobiles,
      templateName,
      templateId: templateId || undefined,
      parameters: params,
      scheduledStartTime: day0Start,
      campaignId: campaign.campaignId,
      metadata: { sendDay: 0 }
    });
    const r1 = await scheduleWhatsAppBatch({
      mobileNumbers: uniqueMobiles,
      templateName,
      templateId: templateId || undefined,
      parameters: params,
      scheduledStartTime: day1Start,
      campaignId: campaign.campaignId,
      metadata: { sendDay: 1 }
    });
    const r2 = await scheduleWhatsAppBatch({
      mobileNumbers: uniqueMobiles,
      templateName,
      templateId: templateId || undefined,
      parameters: params,
      scheduledStartTime: day2Start,
      campaignId: campaign.campaignId,
      metadata: { sendDay: 2 }
    });

    if (!r0.success || !r1.success || !r2.success) {
      const err = r0.error || r1.error || r2.error || 'Failed to schedule batches';
      campaign.status = 'FAILED';
      campaign.errorMessage = err;
      await campaign.save();
      return res.status(500).json({
        success: false,
        message: err,
        campaign: { campaignId: campaign.campaignId, status: campaign.status }
      });
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


import { CampaignModel } from '../Schema_Models/Campaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import crypto from 'crypto';

// ==================== CREATE CAMPAIGN ====================
export const createCampaign = async (req, res) => {
  try {
    const { campaignName, utmMedium, utmCampaign, utmContent, utmTerm } = req.body;

    if (!campaignName) {
      return res.status(400).json({ 
        success: false, 
        message: 'Campaign name is required' 
      });
    }

    // Generate a unique UTM source from campaign name
    const baseUtmSource = campaignName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    
    // Add random suffix to ensure uniqueness
    const utmSource = `${baseUtmSource}_${Date.now().toString().slice(-6)}`;

    // Build the URL with UTM parameters
    // Use environment variable for base URL (for local testing vs production)
    const baseUrl = process.env.CAMPAIGN_BASE_URL || process.env.BASE_URL || 'https://www.flashfirejobs.com';
    const urlParams = new URLSearchParams();
    urlParams.append('utm_source', utmSource);
    if (utmMedium) urlParams.append('utm_medium', utmMedium);
    if (utmCampaign) urlParams.append('utm_campaign', utmCampaign);
    if (utmContent) urlParams.append('utm_content', utmContent);
    if (utmTerm) urlParams.append('utm_term', utmTerm);

    const generatedUrl = `${baseUrl}?${urlParams.toString()}`;

    // Create campaign
    const campaign = new CampaignModel({
      campaignName,
      utmSource,
      utmMedium: utmMedium || 'campaign',
      utmCampaign,
      utmContent,
      utmTerm,
      generatedUrl,
      baseUrl
    });

    await campaign.save();

    return res.status(201).json({
      success: true,
      message: 'Campaign created successfully',
      data: {
        campaignId: campaign.campaignId,
        campaignName: campaign.campaignName,
        utmSource: campaign.utmSource,
        generatedUrl: campaign.generatedUrl,
        createdAt: campaign.createdAt
      }
    });

  } catch (error) {
    console.error('Error creating campaign:', error);
    
    // Handle duplicate utm_source error
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Campaign with similar name already exists. Please try a different name.'
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Failed to create campaign',
      error: error.message
    });
  }
};

// ==================== GET ALL CAMPAIGNS ====================
export const getAllCampaigns = async (req, res) => {
  try {
    const { active } = req.query;
    
    let query = {};
    if (active !== undefined) {
      query.isActive = active === 'true';
    }

    const campaigns = await CampaignModel.find(query)
      .sort({ createdAt: -1 })
      .select('-__v'); // Include pageVisits for filtering

    // Enhance with booking counts
    const campaignsWithStats = await Promise.all(
      campaigns.map(async (campaign) => {
        const bookingCount = await CampaignBookingModel.countDocuments({
          utmSource: campaign.utmSource
        });

        return {
          ...campaign.toObject(),
          totalBookings: bookingCount,
          uniqueVisitorsCount: campaign.uniqueVisitors.length
        };
      })
    );

    return res.status(200).json({
      success: true,
      count: campaignsWithStats.length,
      data: campaignsWithStats
    });

  } catch (error) {
    console.error('Error fetching campaigns:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch campaigns',
      error: error.message
    });
  }
};

// ==================== GET CAMPAIGN BY ID ====================
export const getCampaignById = async (req, res) => {
  try {
    const { campaignId } = req.params;

    const campaign = await CampaignModel.findOne({ campaignId });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Get bookings for this campaign
    const bookings = await CampaignBookingModel.find({
      utmSource: campaign.utmSource
    }).sort({ bookingCreatedAt: -1 });

    return res.status(200).json({
      success: true,
      data: {
        campaign: campaign.toObject(),
        bookings,
        stats: {
          totalClicks: campaign.totalClicks,
          totalButtonClicks: campaign.totalButtonClicks || 0,
          uniqueVisitors: campaign.uniqueVisitors.length,
          totalBookings: bookings.length,
          conversionRate: campaign.uniqueVisitors.length > 0 
            ? ((bookings.length / campaign.uniqueVisitors.length) * 100).toFixed(2) 
            : 0
        }
      }
    });

  } catch (error) {
    console.error('Error fetching campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch campaign details',
      error: error.message
    });
  }
};

// ==================== TRACK PAGE VISIT ====================
export const trackPageVisit = async (req, res) => {
  try {
    const { utmSource, visitorId, userAgent, ipAddress, referrer, pageUrl } = req.body;

    if (!utmSource) {
      return res.status(400).json({
        success: false,
        message: 'utm_source is required'
      });
    }

    const campaign = await CampaignModel.findOne({ utmSource });

    if (!campaign) {
      // Campaign doesn't exist, but don't fail - just log it
      console.log(`Page visit tracked for non-existent campaign: ${utmSource}`);
      return res.status(200).json({
        success: true,
        message: 'Visit tracked (campaign not found in system)'
      });
    }

    // Generate visitor ID if not provided (browser fingerprint or sessionId)
    const finalVisitorId = visitorId || crypto.randomBytes(16).toString('hex');

    // Add page visit
    campaign.pageVisits.push({
      visitorId: finalVisitorId,
      timestamp: new Date(),
      userAgent,
      ipAddress,
      referrer,
      pageUrl
    });

    // Increment total clicks
    campaign.totalClicks += 1;

    // Add to unique visitors if not already present
    if (!campaign.uniqueVisitors.includes(finalVisitorId)) {
      campaign.uniqueVisitors.push(finalVisitorId);
    }

    campaign.updatedAt = new Date();
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: 'Page visit tracked successfully',
      data: {
        campaignName: campaign.campaignName,
        totalClicks: campaign.totalClicks,
        uniqueVisitors: campaign.uniqueVisitors.length,
        visitorId: finalVisitorId
      }
    });

  } catch (error) {
    console.error('Error tracking page visit:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to track page visit',
      error: error.message
    });
  }
};

// ==================== TRACK BUTTON CLICK ====================
export const trackButtonClick = async (req, res) => {
  try {
    const { utmSource, visitorId, buttonText, buttonLocation, buttonType, pageUrl, userAgent, ipAddress } = req.body;

    if (!utmSource || !buttonText || !buttonLocation) {
      return res.status(400).json({
        success: false,
        message: 'utm_source, buttonText, and buttonLocation are required'
      });
    }

    const campaign = await CampaignModel.findOne({ utmSource });

    if (!campaign) {
      // Campaign doesn't exist, but don't fail - just log it
      console.log(`Button click tracked for non-existent campaign: ${utmSource}`);
      return res.status(200).json({
        success: true,
        message: 'Button click tracked (campaign not found in system)'
      });
    }

    // Generate visitor ID if not provided
    const finalVisitorId = visitorId || crypto.randomBytes(16).toString('hex');

    // Add button click
    campaign.buttonClicks.push({
      visitorId: finalVisitorId,
      timestamp: new Date(),
      buttonText,
      buttonLocation,
      buttonType: buttonType || 'cta',
      pageUrl,
      userAgent,
      ipAddress
    });

    // Increment total button clicks
    campaign.totalButtonClicks = (campaign.totalButtonClicks || 0) + 1;

    // Also increment total clicks (for backward compatibility)
    campaign.totalClicks += 1;

    // Add to unique visitors if not already present
    if (!campaign.uniqueVisitors.includes(finalVisitorId)) {
      campaign.uniqueVisitors.push(finalVisitorId);
    }

    campaign.updatedAt = new Date();
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: 'Button click tracked successfully',
      data: {
        campaignName: campaign.campaignName,
        totalButtonClicks: campaign.totalButtonClicks,
        totalClicks: campaign.totalClicks,
        visitorId: finalVisitorId
      }
    });

  } catch (error) {
    console.error('Error tracking button click:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to track button click',
      error: error.message
    });
  }
};

// ==================== UPDATE CAMPAIGN ====================
export const updateCampaign = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { campaignName, isActive, utmMedium, utmCampaign, utmContent, utmTerm } = req.body;

    const campaign = await CampaignModel.findOne({ campaignId });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Update allowed fields
    if (campaignName !== undefined) campaign.campaignName = campaignName;
    if (isActive !== undefined) campaign.isActive = isActive;
    if (utmMedium !== undefined) {
      campaign.utmMedium = utmMedium;
      // Regenerate URL
      const urlParams = new URLSearchParams();
      urlParams.append('utm_source', campaign.utmSource);
      urlParams.append('utm_medium', utmMedium);
      if (campaign.utmCampaign) urlParams.append('utm_campaign', campaign.utmCampaign);
      if (campaign.utmContent) urlParams.append('utm_content', campaign.utmContent);
      if (campaign.utmTerm) urlParams.append('utm_term', campaign.utmTerm);
      campaign.generatedUrl = `${campaign.baseUrl}?${urlParams.toString()}`;
    }
    if (utmCampaign !== undefined) campaign.utmCampaign = utmCampaign;
    if (utmContent !== undefined) campaign.utmContent = utmContent;
    if (utmTerm !== undefined) campaign.utmTerm = utmTerm;

    campaign.updatedAt = new Date();
    await campaign.save();

    return res.status(200).json({
      success: true,
      message: 'Campaign updated successfully',
      data: campaign
    });

  } catch (error) {
    console.error('Error updating campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update campaign',
      error: error.message
    });
  }
};

// ==================== DELETE CAMPAIGN ====================
export const deleteCampaign = async (req, res) => {
  try {
    const { campaignId } = req.params;

    const campaign = await CampaignModel.findOneAndDelete({ campaignId });

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Campaign deleted successfully',
      data: { campaignId: campaign.campaignId, campaignName: campaign.campaignName }
    });

  } catch (error) {
    console.error('Error deleting campaign:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete campaign',
      error: error.message
    });
  }
};

// ==================== GET CAMPAIGN STATISTICS ====================
export const getCampaignStatistics = async (req, res) => {
  try {
    const totalCampaigns = await CampaignModel.countDocuments();
    const activeCampaigns = await CampaignModel.countDocuments({ isActive: true });
    const totalBookings = await CampaignBookingModel.countDocuments();
    
    const allCampaigns = await CampaignModel.find();
    const totalClicks = allCampaigns.reduce((sum, camp) => sum + camp.totalClicks, 0);
    const totalUniqueVisitors = allCampaigns.reduce((sum, camp) => sum + camp.uniqueVisitors.length, 0);

    return res.status(200).json({
      success: true,
      data: {
        totalCampaigns,
        activeCampaigns,
        totalClicks,
        totalUniqueVisitors,
        totalBookings,
        averageConversionRate: totalUniqueVisitors > 0 
          ? ((totalBookings / totalUniqueVisitors) * 100).toFixed(2) 
          : 0
      }
    });

  } catch (error) {
    console.error('Error fetching campaign statistics:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
};


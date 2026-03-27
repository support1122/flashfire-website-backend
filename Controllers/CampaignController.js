import { CampaignModel } from '../Schema_Models/Campaign.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import crypto from 'crypto';

function buildCampaignGeneratedUrl(baseUrl, utmSource, utmMedium, utmCampaign, utmContent, utmTerm) {
  const urlParams = new URLSearchParams();
  urlParams.set('utm_source', utmSource);
  urlParams.set('utm_medium', utmMedium || 'campaign');
  if (utmCampaign) urlParams.append('utm_campaign', utmCampaign);
  if (utmContent) urlParams.append('utm_content', utmContent);
  if (utmTerm) urlParams.append('utm_term', utmTerm);
  const path = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${path}/?${urlParams.toString()}`;
}

// ==================== CREATE CAMPAIGN ====================
export const createCampaign = async (req, res) => {
  try {
    const { campaignName, utmSource: explicitUtmSource, utmMedium, utmCampaign, utmContent, utmTerm } = req.body;

    if (!campaignName && !explicitUtmSource) {
      return res.status(400).json({
        success: false,
        message: 'Campaign name or utmSource is required'
      });
    }

    const baseUrl = 'https://www.flashfirejobs.com';
    const resolvedMedium = utmMedium || 'campaign';
    let utmSource;
    let displayName;

    if (explicitUtmSource && typeof explicitUtmSource === 'string' && /^[a-z0-9_-]+$/i.test(explicitUtmSource.trim())) {
      utmSource = explicitUtmSource.trim().toLowerCase();
      displayName = (campaignName && campaignName.trim()) || utmSource;
    } else {
      const name = (campaignName || '').trim();
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Campaign name is required'
        });
      }
      const baseUtmSource = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      utmSource = `${baseUtmSource}_${Date.now().toString().slice(-6)}`;
      displayName = name;
    }

    const baseUtmForSuffix = utmSource;
    const baseDisplayForSuffix = displayName;
    let finalUtmSource = utmSource;
    let finalDisplayName = displayName;
    let n = 0;

    let campaign;
    let saved = false;
    for (let saveAttempt = 0; saveAttempt < 30; saveAttempt++) {
      while (await CampaignModel.exists({ utmSource: finalUtmSource })) {
        n += 1;
        finalUtmSource = `${baseUtmForSuffix}-${n}`;
        finalDisplayName = `${baseDisplayForSuffix}-${n}`;
      }

      const generatedUrl = buildCampaignGeneratedUrl(
        baseUrl,
        finalUtmSource,
        resolvedMedium,
        utmCampaign,
        utmContent,
        utmTerm
      );

      campaign = new CampaignModel({
        campaignName: finalDisplayName,
        utmSource: finalUtmSource,
        utmMedium: resolvedMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        generatedUrl,
        baseUrl
      });

      try {
        await campaign.save();
        saved = true;
        break;
      } catch (saveErr) {
        if (saveErr.code !== 11000) throw saveErr;
        n += 1;
        finalUtmSource = `${baseUtmForSuffix}-${n}`;
        finalDisplayName = `${baseDisplayForSuffix}-${n}`;
      }
    }

    if (!saved || !campaign) {
      return res.status(409).json({
        success: false,
        message: 'Campaign could not be created with a unique link. Please try again.'
      });
    }

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

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'Campaign could not be created with a unique link. Please try again.'
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
    const { active, fromDate, toDate } = req.query;

    let query = {};
    if (active !== undefined) {
      query.isActive = active === 'true';
    }

    let startDate = fromDate ? new Date(fromDate) : null;
    let endDate = toDate ? new Date(toDate) : null;
    if (startDate) startDate.setHours(0, 0, 0, 0);
    if (endDate) endDate.setHours(23, 59, 59, 999);
    const hasDateFilter = startDate && endDate && !isNaN(startDate.getTime()) && !isNaN(endDate.getTime());

    let campaignsWithStats;

    if (hasDateFilter) {
      // Use aggregation for date-filtered counts (reduces response payload)
      const dateCond = {
        $and: [
          { $gte: ['$$v.timestamp', startDate] },
          { $lte: ['$$v.timestamp', endDate] }
        ]
      };

      const filteredVisits = {
        $filter: {
          input: { $ifNull: ['$pageVisits', []] },
          as: 'v',
          cond: dateCond
        }
      };
      const filteredClicks = {
        $filter: {
          input: { $ifNull: ['$buttonClicks', []] },
          as: 'v',
          cond: dateCond
        }
      };

      const pipeline = [
        { $match: query },
        { $sort: { createdAt: -1 } },
        {
          $project: {
            campaignId: 1,
            campaignName: 1,
            utmSource: 1,
            utmMedium: 1,
            utmCampaign: 1,
            utmContent: 1,
            utmTerm: 1,
            generatedUrl: 1,
            baseUrl: 1,
            totalClicks: 1,
            totalButtonClicks: 1,
            uniqueVisitors: 1,
            isActive: 1,
            createdAt: 1,
            updatedAt: 1,
            createdBy: 1,
            filteredClicks: { $size: filteredVisits },
            filteredButtonClicks: { $size: filteredClicks },
            filteredUniqueVisitors: {
              $size: { $setUnion: [{ $map: { input: filteredVisits, as: 'f', in: '$$f.visitorId' } }] }
            }
          }
        }
      ];

      const utmSources = await CampaignModel.find(query).select('utmSource').lean().then((c) => c.map((x) => x.utmSource));

      const [campaigns, bookingCounts] = await Promise.all([
        CampaignModel.aggregate(pipeline).allowDiskUse(true),
        CampaignBookingModel.aggregate([
          {
            $match: {
              utmSource: { $in: utmSources },
              bookingCreatedAt: { $gte: startDate, $lte: endDate }
            }
          },
          { $group: { _id: '$utmSource', count: { $sum: 1 } } }
        ]).allowDiskUse(true)
      ]);

      const countMap = Object.fromEntries(bookingCounts.map((b) => [b._id, b.count]));

      campaignsWithStats = campaigns.map((campaign) => ({
        ...campaign,
        totalBookings: countMap[campaign.utmSource] || 0,
        uniqueVisitorsCount: campaign.filteredUniqueVisitors ?? 0,
        totalClicks: campaign.filteredClicks ?? 0,
        totalButtonClicks: campaign.filteredButtonClicks ?? 0
      }));
    } else {
      // Standard path: exclude heavy fields, single aggregation for bookings
      const campaigns = await CampaignModel.find(query)
        .sort({ createdAt: -1 })
        .select('-__v -pageVisits -buttonClicks')
        .lean();

      const utmSources = campaigns.map((c) => c.utmSource);
      const bookingCounts = await CampaignBookingModel.aggregate([
        { $match: { utmSource: { $in: utmSources } } },
        { $group: { _id: '$utmSource', count: { $sum: 1 } } }
      ]);
      const countMap = Object.fromEntries(bookingCounts.map((b) => [b._id, b.count]));

      campaignsWithStats = campaigns.map((campaign) => ({
        ...campaign,
        totalBookings: countMap[campaign.utmSource] || 0,
        uniqueVisitorsCount: campaign.uniqueVisitors?.length ?? 0
      }));
    }

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

    const campaign = await CampaignModel.findOne({ campaignId }).lean();

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Get bookings for this campaign
    const bookings = await CampaignBookingModel.find({
      utmSource: campaign.utmSource
    }).sort({ bookingCreatedAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      data: {
        campaign,
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
      campaign.generatedUrl = buildCampaignGeneratedUrl(
        campaign.baseUrl || 'https://www.flashfirejobs.com',
        campaign.utmSource,
        utmMedium,
        campaign.utmCampaign,
        campaign.utmContent,
        campaign.utmTerm
      );
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
    
    const allCampaigns = await CampaignModel.find().lean();
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


import { PageVisitModel } from '../Schema_Models/PageVisit.js';
import crypto from 'crypto';

// ==================== TRACK ALL PAGE VISITS (Real-Time) ====================
export const trackAllPageVisits = async (req, res) => {
  try {
    const { 
      visitorId, 
      pageUrl, 
      userAgent, 
      ipAddress, 
      referrer,
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      sessionId,
      metadata
    } = req.body;

    // Validate required fields
    if (!pageUrl) {
      return res.status(400).json({
        success: false,
        message: 'pageUrl is required'
      });
    }

    // Get IP from request if not provided
    const finalIpAddress = ipAddress || 
      req.ip || 
      req.connection.remoteAddress || 
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      req.headers['x-real-ip'] ||
      null;
    
    // Generate visitor ID if not provided
    const finalVisitorId = visitorId || crypto.randomBytes(16).toString('hex');
    
    // Generate session ID if not provided
    const finalSessionId = sessionId || crypto.randomBytes(16).toString('hex');

    // Get referrer from headers if not provided
    const finalReferrer = referrer || req.headers['referer'] || req.headers['referrer'] || null;

    // Create page visit document
    const pageVisit = new PageVisitModel({
      visitorId: finalVisitorId,
      timestamp: new Date(),
      pageUrl,
      userAgent: userAgent || req.headers['user-agent'] || null,
      ipAddress: finalIpAddress,
      referrer: finalReferrer,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      sessionId: finalSessionId,
      metadata: metadata || {}
    });

    // Save to database (real-time)
    await pageVisit.save();

    return res.status(200).json({
      success: true,
      message: 'Page visit tracked successfully',
      data: {
        visitorId: finalVisitorId,
        sessionId: finalSessionId,
        timestamp: pageVisit.timestamp,
        countryCode: pageVisit.countryCode,
        countryName: pageVisit.countryName,
        trafficSource: pageVisit.trafficSource
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

// ==================== GET REAL-TIME STATS ====================
export const getRealTimeStats = async (req, res) => {
  try {
    const { hours = 1 } = req.query; // Default: last 1 hour
    
    const startTime = new Date(Date.now() - hours * 60 * 60 * 1000);
    
    // Get unique visitors in time range
    const uniqueVisitors = await PageVisitModel.distinct('visitorId', {
      timestamp: { $gte: startTime }
    });
    
    // Get total page views
    const totalPageViews = await PageVisitModel.countDocuments({
      timestamp: { $gte: startTime }
    });
    
    // Get traffic by source
    const trafficBySource = await PageVisitModel.aggregate([
      {
        $match: {
          timestamp: { $gte: startTime }
        }
      },
      {
        $group: {
          _id: '$trafficSource',
          count: { $sum: 1 },
          uniqueVisitors: { $addToSet: '$visitorId' }
        }
      },
      {
        $project: {
          _id: 0,
          source: '$_id',
          totalVisits: '$count',
          uniqueVisitors: { $size: '$uniqueVisitors' }
        }
      }
    ]);
    
    return res.status(200).json({
      success: true,
      data: {
        timeRange: `${hours} hour(s)`,
        startTime,
        endTime: new Date(),
        totalPageViews,
        uniqueVisitors: uniqueVisitors.length,
        trafficBySource
      }
    });
    
  } catch (error) {
    console.error('Error getting real-time stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get real-time stats',
      error: error.message
    });
  }
};

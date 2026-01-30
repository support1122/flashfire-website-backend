import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaIncentiveConfigModel } from '../Schema_Models/BdaIncentiveConfig.js';

// Current plan prices (fallback when basePriceUsd not in DB). Admin can override via BdaIncentiveConfig.basePriceUsd.
const PLAN_CATALOG = {
  PRIME: { price: 99 },
  IGNITE: { price: 199 },
  PROFESSIONAL: { price: 349 },
  EXECUTIVE: { price: 599 }
};

export const getAvailableLeads = async (req, res) => {
  try {
    const bookings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] },
      $or: [
        { 'claimedBy.email': { $exists: false } },
        { 'claimedBy.email': null }
      ]
    })
      .sort({ scheduledEventStartTime: -1 })
      .select('bookingId clientName clientEmail clientPhone scheduledEventStartTime bookingStatus paymentPlan')
      .lean();

    return res.status(200).json({
      success: true,
      data: bookings
    });
  } catch (error) {
    console.error('Error fetching available leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch available leads',
      error: error.message
    });
  }
};

export const getLeadByEmail = async (req, res) => {
  try {
    const { email } = req.params;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const booking = await CampaignBookingModel.findOne({
      clientEmail: email.toLowerCase().trim(),
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
    })
      .sort({ scheduledEventStartTime: -1 })
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found or not available for claiming'
      });
    }

    return res.status(200).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error('Error fetching lead by email:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch lead',
      error: error.message
    });
  }
};

export const claimLead = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const email = req.crmUser?.email;
    const name = req.crmUser?.name;

    if (!email || !name) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: 'Booking ID is required'
      });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    if (!['paid', 'scheduled', 'completed'].includes(booking.bookingStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Only leads with status paid, scheduled, or completed can be claimed'
      });
    }

    if (booking.claimedBy && booking.claimedBy.email) {
      return res.status(400).json({
        success: false,
        message: 'This lead has already been claimed by another BDA'
      });
    }

    booking.claimedBy = {
      email,
      name,
      claimedAt: new Date()
    };

    const paymentPlan = req.body?.paymentPlan;
    if (paymentPlan && paymentPlan.name) {
      const amountPaid = Number(paymentPlan.price);
      if (amountPaid <= 0 || Number.isNaN(amountPaid)) {
        return res.status(400).json({
          success: false,
          message: 'Amount paid by client must be greater than 0'
        });
      }
      const allowed = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];
      const name = String(paymentPlan.name).toUpperCase();
      if (allowed.includes(name)) {
        booking.paymentPlan = {
          name,
          price: amountPaid,
          currency: paymentPlan.currency || 'USD',
          displayPrice: paymentPlan.displayPrice || `$${amountPaid}`,
          selectedAt: new Date()
        };
      }
    }

    await booking.save();

    return res.status(200).json({
      success: true,
      message: 'Lead claimed successfully',
      data: booking
    });
  } catch (error) {
    console.error('Error claiming lead:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to claim lead',
      error: error.message
    });
  }
};

export const updateLeadDetails = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const email = req.crmUser?.email;

    if (!email) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    const {
      clientName,
      clientPhone,
      scheduledEventStartTime,
      paymentPlan,
      meetingNotes,
      anythingToKnow
    } = req.body;

    const booking = await CampaignBookingModel.findOne({ bookingId });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Lead not found'
      });
    }

    if (booking.claimedBy && booking.claimedBy.email !== email) {
      return res.status(403).json({
        success: false,
        message: 'You can only update leads claimed by you'
      });
    }

    if (clientName) booking.clientName = clientName;
    if (clientPhone !== undefined) booking.clientPhone = clientPhone;
    if (scheduledEventStartTime) booking.scheduledEventStartTime = new Date(scheduledEventStartTime);
    if (paymentPlan) {
      const name = String(paymentPlan.name || '').toUpperCase();
      const allowed = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];
      const amountPaid = Number(paymentPlan.price);
      if (allowed.includes(name)) {
        if (amountPaid <= 0 || Number.isNaN(amountPaid)) {
          return res.status(400).json({
            success: false,
            message: 'Amount paid by client must be greater than 0'
          });
        }
        booking.paymentPlan = {
          name,
          price: amountPaid,
          currency: paymentPlan.currency || 'USD',
          displayPrice: paymentPlan.displayPrice || `$${amountPaid}`,
          selectedAt: new Date()
        };
      }
    }
    if (meetingNotes !== undefined) booking.meetingNotes = meetingNotes;
    if (anythingToKnow !== undefined) booking.anythingToKnow = anythingToKnow;

    await booking.save();

    return res.status(200).json({
      success: true,
      message: 'Lead details updated successfully',
      data: booking
    });
  } catch (error) {
    console.error('Error updating lead details:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update lead details',
      error: error.message
    });
  }
};

export const getBdaAnalysis = async (req, res) => {
  try {
    const { fromDate, toDate, status, planName, bdaEmail } = req.query;

    const matchBase = {};

    const validStatuses = ['paid', 'scheduled', 'completed'];
    if (status && status !== 'all') {
      matchBase.bookingStatus = status;
    } else {
      matchBase.bookingStatus = { $in: validStatuses };
    }

    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;
    if (normalizedPlanName && normalizedPlanName !== 'ALL') {
      matchBase['paymentPlan.name'] = normalizedPlanName;
    }

    if (fromDate || toDate) {
      matchBase.scheduledEventStartTime = {};
      if (fromDate) {
        const from = new Date(fromDate);
        from.setHours(0, 0, 0, 0);
        matchBase.scheduledEventStartTime.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        matchBase.scheduledEventStartTime.$lte = to;
      }
    }

    const totalLeads = await CampaignBookingModel.countDocuments(matchBase);

    const claimedMatch = {
      ...matchBase,
      'claimedBy.email': { $exists: true, $ne: null }
    };

    const claimedLeads = await CampaignBookingModel.countDocuments(claimedMatch);

    const unclaimedLeads = totalLeads - claimedLeads;

    const performanceMatch = { ...claimedMatch };
    if (bdaEmail) {
      performanceMatch['claimedBy.email'] = bdaEmail.toLowerCase().trim();
    }

    const bdaPerformance = await CampaignBookingModel.aggregate([
      {
        $match: {
          ...performanceMatch
        }
      },
      {
        $group: {
          _id: '$claimedBy.email',
          name: { $first: '$claimedBy.name' },
          totalClaimed: { $sum: 1 },
          paid: {
            $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] }
          },
          scheduled: {
            $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] }
          },
          completed: {
            $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] }
          },
          totalRevenue: {
            $sum: {
              $cond: [
                { $eq: ['$bookingStatus', 'paid'] },
                { $ifNull: ['$paymentPlan.price', 0] },
                0
              ]
            }
          }
        }
      },
      {
        $sort: { totalClaimed: -1 }
      }
    ]);

    const paidBookings = await CampaignBookingModel.find({
      ...performanceMatch,
      bookingStatus: 'paid',
      'paymentPlan.name': { $in: ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'] },
      'paymentPlan.price': { $gt: 0 }
    })
      .select('claimedBy.email paymentPlan.name paymentPlan.price')
      .lean();

    const incentiveRows = await BdaIncentiveConfigModel.find({}).lean();
    const configByPlan = new Map();
    incentiveRows.forEach((r) => {
      configByPlan.set(r.planName, {
        basePriceUsd: r.basePriceUsd != null ? r.basePriceUsd : (PLAN_CATALOG[r.planName]?.price ?? 0),
        incentivePerLeadInr: r.incentivePerLeadInr != null ? r.incentivePerLeadInr : 0
      });
    });

    const incentiveByBda = new Map();
    for (const b of paidBookings) {
      const email = b.claimedBy?.email;
      if (!email) continue;
      const planName = b.paymentPlan?.name;
      const amountPaid = Number(b.paymentPlan?.price);
      if (!planName || !amountPaid || amountPaid <= 0) continue;
      const config = configByPlan.get(planName);
      if (!config) continue;
      const currentPlanPrice = config.basePriceUsd > 0 ? config.basePriceUsd : (PLAN_CATALOG[planName]?.price ?? 1);
      const paymentRatio = Math.min(1, amountPaid / currentPlanPrice);
      const prorated = config.incentivePerLeadInr * paymentRatio;
      incentiveByBda.set(email, (incentiveByBda.get(email) ?? 0) + prorated);
    }

    bdaPerformance.forEach((bda) => {
      bda.totalIncentiveInr = incentiveByBda.get(bda._id) ?? 0;
    });

    const statusBreakdown = await CampaignBookingModel.aggregate([
      {
        $match: {
          ...matchBase
        }
      },
      {
        $group: {
          _id: '$bookingStatus',
          count: { $sum: 1 }
        }
      }
    ]);

    const statusMap = {
      paid: 0,
      scheduled: 0,
      completed: 0
    };

    statusBreakdown.forEach(item => {
      statusMap[item._id] = item.count;
    });

    return res.status(200).json({
      success: true,
      data: {
        overview: {
          totalLeads,
          claimedLeads,
          unclaimedLeads
        },
        statusBreakdown: statusMap,
        bdaPerformance
      }
    });
  } catch (error) {
    console.error('Error fetching BDA analysis:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch BDA analysis',
      error: error.message
    });
  }
};

export const getMyClaimedLeads = async (req, res) => {
  try {
    const email = req.crmUser?.email;

    if (!email) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    const { page = 1, limit = 50, fromDate, toDate, status, planName } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (pageNum - 1) * limitNum;

    const match = {
      'claimedBy.email': email,
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
    };

    if (fromDate) {
      const start = new Date(fromDate);
      start.setUTCHours(0, 0, 0, 0);
      match['claimedBy.claimedAt'] = match['claimedBy.claimedAt'] || {};
      match['claimedBy.claimedAt'].$gte = start;
    }
    if (toDate) {
      const end = new Date(toDate);
      end.setUTCHours(23, 59, 59, 999);
      match['claimedBy.claimedAt'] = match['claimedBy.claimedAt'] || {};
      match['claimedBy.claimedAt'].$lte = end;
    }
    if (status && ['paid', 'scheduled', 'completed'].includes(status)) {
      match.bookingStatus = status;
    }
    if (planName && ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'].includes(String(planName).toUpperCase())) {
      match['paymentPlan.name'] = String(planName).toUpperCase();
    }

    const paidMatch = { ...match, bookingStatus: 'paid', 'paymentPlan.name': { $in: ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'] }, 'paymentPlan.price': { $gt: 0 } };

    const [bookings, total, incentiveRows, paidBookings] = await Promise.all([
      CampaignBookingModel.find(match)
        .sort({ 'claimedBy.claimedAt': -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments(match),
      BdaIncentiveConfigModel.find({}).lean(),
      CampaignBookingModel.find(paidMatch).select('paymentPlan').lean()
    ]);

    const configByPlan = new Map();
    incentiveRows.forEach((r) => {
      configByPlan.set(r.planName, {
        basePriceUsd: r.basePriceUsd != null ? r.basePriceUsd : (PLAN_CATALOG[r.planName]?.price ?? 0),
        incentivePerLeadInr: r.incentivePerLeadInr != null ? r.incentivePerLeadInr : 0
      });
    });
    let totalIncentivesForFilter = 0;
    for (const b of paidBookings) {
      const planName = b.paymentPlan?.name;
      const amountPaid = Number(b.paymentPlan?.price);
      if (!planName || !amountPaid || amountPaid <= 0) continue;
      const config = configByPlan.get(planName);
      if (!config) continue;
      const currentPlanPrice = config.basePriceUsd > 0 ? config.basePriceUsd : (PLAN_CATALOG[planName]?.price ?? 1);
      const paymentRatio = Math.min(1, amountPaid / currentPlanPrice);
      totalIncentivesForFilter += config.incentivePerLeadInr * paymentRatio;
    }

    return res.status(200).json({
      success: true,
      data: bookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(Math.max(0, total) / limitNum)
      },
      totalIncentivesForFilter
    });
  } catch (error) {
    console.error('Error fetching my claimed leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch claimed leads',
      error: error.message
    });
  }
};

export const getBdaLeadsByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    const bookings = await CampaignBookingModel.find({
      'claimedBy.email': email.toLowerCase().trim(),
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
    })
      .sort({ 'claimedBy.claimedAt': -1 })
      .lean();

    const bdaInfo = bookings.length > 0 ? {
      email: bookings[0].claimedBy.email,
      name: bookings[0].claimedBy.name,
      claimedAt: bookings[0].claimedBy.claimedAt
    } : null;

    return res.status(200).json({
      success: true,
      data: {
        bda: bdaInfo,
        leads: bookings
      }
    });
  } catch (error) {
    console.error('Error fetching BDA leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch BDA leads',
      error: error.message
    });
  }
};

export const getMyBdaPerformance = async (req, res) => {
  try {
    const email = req.crmUser?.email;

    if (!email) {
      return res.status(401).json({
        success: false,
        message: 'User authentication required'
      });
    }

    const {
      fromDate,
      toDate,
      status,
      plan,
      page = 1,
      limit = 50
    } = req.query;

    const matchConditions = {
      'claimedBy.email': email.toLowerCase().trim(),
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
    };

    if (fromDate || toDate) {
      matchConditions['claimedBy.claimedAt'] = {};
      if (fromDate) {
        matchConditions['claimedBy.claimedAt'].$gte = new Date(fromDate);
      }
      if (toDate) {
        const toDateEnd = new Date(toDate);
        toDateEnd.setHours(23, 59, 59, 999);
        matchConditions['claimedBy.claimedAt'].$lte = toDateEnd;
      }
    }

    if (status && status !== 'all') {
      matchConditions.bookingStatus = status;
    }

    if (plan && plan !== 'all') {
      matchConditions['paymentPlan.name'] = plan;
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const [bookings, total] = await Promise.all([
      CampaignBookingModel.find(matchConditions)
        .sort({ 'claimedBy.claimedAt': -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments(matchConditions)
    ]);

    const overview = await CampaignBookingModel.aggregate([
      {
        $match: {
          'claimedBy.email': email.toLowerCase().trim(),
          bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
        }
      },
      {
        $group: {
          _id: null,
          totalClaimed: { $sum: 1 },
          paid: {
            $sum: { $cond: [{ $eq: ['$bookingStatus', 'paid'] }, 1, 0] }
          },
          scheduled: {
            $sum: { $cond: [{ $eq: ['$bookingStatus', 'scheduled'] }, 1, 0] }
          },
          completed: {
            $sum: { $cond: [{ $eq: ['$bookingStatus', 'completed'] }, 1, 0] }
          },
          totalRevenue: {
            $sum: {
              $cond: [
                { $eq: ['$bookingStatus', 'paid'] },
                { $ifNull: ['$paymentPlan.price', 0] },
                0
              ]
            }
          }
        }
      }
    ]);

    const statusBreakdown = await CampaignBookingModel.aggregate([
      {
        $match: {
          'claimedBy.email': email.toLowerCase().trim(),
          bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
        }
      },
      {
        $group: {
          _id: '$bookingStatus',
          count: { $sum: 1 }
        }
      }
    ]);

    const planBreakdown = await CampaignBookingModel.aggregate([
      {
        $match: {
          'claimedBy.email': email.toLowerCase().trim(),
          bookingStatus: { $in: ['paid', 'scheduled', 'completed'] },
          'paymentPlan.name': { $exists: true }
        }
      },
      {
        $group: {
          _id: '$paymentPlan.name',
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ['$bookingStatus', 'paid'] },
                { $ifNull: ['$paymentPlan.price', 0] },
                0
              ]
            }
          }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    const monthlyTrend = await CampaignBookingModel.aggregate([
      {
        $match: {
          'claimedBy.email': email.toLowerCase().trim(),
          bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$claimedBy.claimedAt' },
            month: { $month: '$claimedBy.claimedAt' }
          },
          count: { $sum: 1 },
          revenue: {
            $sum: {
              $cond: [
                { $eq: ['$bookingStatus', 'paid'] },
                { $ifNull: ['$paymentPlan.price', 0] },
                0
              ]
            }
          }
        }
      },
      {
        $sort: { '_id.year': -1, '_id.month': -1 }
      },
      {
        $limit: 12
      }
    ]);

    const statusMap = {
      paid: 0,
      scheduled: 0,
      completed: 0
    };

    statusBreakdown.forEach(item => {
      statusMap[item._id] = item.count;
    });

    const overviewData = overview[0] || {
      totalClaimed: 0,
      paid: 0,
      scheduled: 0,
      completed: 0,
      totalRevenue: 0
    };

    return res.status(200).json({
      success: true,
      data: {
        overview: overviewData,
        statusBreakdown: statusMap,
        planBreakdown,
        monthlyTrend,
        leads: bookings,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching BDA performance:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch BDA performance',
      error: error.message
    });
  }
};

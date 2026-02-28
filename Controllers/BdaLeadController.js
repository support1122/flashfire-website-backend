import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaIncentiveConfigModel } from '../Schema_Models/BdaIncentiveConfig.js';
import { BdaClaimApprovalModel } from '../Schema_Models/BdaClaimApproval.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { sendBdaClaimApprovalEmail } from '../Utils/SendGridHelper.js';
import crypto from 'crypto';

// Current plan prices (fallback when basePriceUsd not in DB). Admin can override via BdaIncentiveConfig.basePriceUsd.
const PLAN_CATALOG = {
  PRIME: { price: 99 },
  IGNITE: { price: 199 },
  PROFESSIONAL: { price: 349 },
  EXECUTIVE: { price: 599 }
};

/** Compute prorated incentive (INR) for one line. configByPlan: Map(planName -> { basePriceUsd, incentivePerLeadInr }). */
function incentiveForLine(configByPlan, planName, amount, _currency) {
  if (!planName || !amount || amount <= 0) return 0;
  const config = configByPlan.get(planName);
  if (!config) return 0;
  const base = config.basePriceUsd > 0 ? config.basePriceUsd : (PLAN_CATALOG[planName]?.price ?? 1);
  const ratio = Math.min(1, amount / base);
  return config.incentivePerLeadInr * ratio;
}

/** Total incentive (INR) for a paid booking: from paymentBreakdown (sum per line) or single paymentPlan. */
function incentiveForBooking(configByPlan, booking) {
  if (Array.isArray(booking.paymentBreakdown) && booking.paymentBreakdown.length > 0) {
    return booking.paymentBreakdown.reduce(
      (sum, line) => sum + incentiveForLine(configByPlan, line.planName, line.amount, line.currency),
      0
    );
  }
  const planName = booking.paymentPlan?.name;
  const amount = Number(booking.paymentPlan?.price);
  return incentiveForLine(configByPlan, planName, amount);
}

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
    const paymentBreakdown = req.body?.paymentBreakdown;
    const allowed = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];

    if (Array.isArray(paymentBreakdown) && paymentBreakdown.length > 0) {
      const lines = [];
      let totalAmount = 0;
      for (const line of paymentBreakdown) {
        const planKey = String(line.planName || '').toUpperCase();
        const amount = Number(line.amount);
        if (!allowed.includes(planKey) || amount <= 0 || Number.isNaN(amount)) continue;
        lines.push({
          planName: planKey,
          amount,
          currency: line.currency || 'USD'
        });
        totalAmount += amount;
      }
      if (lines.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Payment breakdown must have at least one valid line (plan + amount > 0)'
        });
      }
      booking.paymentBreakdown = lines;
      const currency = lines[0].currency || 'USD';
      const symbol = currency === 'CAD' ? 'CA$' : '$';
      booking.paymentPlan = {
        name: lines[0].planName,
        price: totalAmount,
        currency,
        displayPrice: paymentPlan?.displayPrice || `${symbol}${totalAmount}`,
        selectedAt: new Date()
      };
    } else if (paymentPlan && paymentPlan.name) {
      const amountPaid = Number(paymentPlan.price);
      if (amountPaid <= 0 || Number.isNaN(amountPaid)) {
        return res.status(400).json({
          success: false,
          message: 'Amount paid by client must be greater than 0'
        });
      }
      const planKey = String(paymentPlan.name).toUpperCase();
      if (allowed.includes(planKey)) {
        booking.paymentPlan = {
          name: planKey,
          price: amountPaid,
          currency: paymentPlan.currency || 'USD',
          displayPrice: paymentPlan.displayPrice || `$${amountPaid}`,
          selectedAt: new Date()
        };
        booking.paymentBreakdown = undefined;
      }
    }

    await booking.save();

    const existingPending = await BdaClaimApprovalModel.findOne({
      bookingId: booking.bookingId,
      status: 'pending'
    }).lean();

    let approval = existingPending;
    if (!approval) {
      const created = await BdaClaimApprovalModel.create({
        bookingId: booking.bookingId,
        bdaEmail: email,
        bdaName: name,
        clientName: booking.clientName,
        clientEmail: booking.clientEmail,
        clientPhone: booking.clientPhone,
        paymentPlan: booking.paymentPlan
          ? {
              name: booking.paymentPlan.name,
              price: booking.paymentPlan.price,
              currency: booking.paymentPlan.currency,
              displayPrice: booking.paymentPlan.displayPrice
            }
          : null,
        status: 'pending'
      });
      approval = created.toObject();
    }

    let approvalStatus = 'pending';

    try {
      const admins = await CrmUserModel.find({
        isActive: true,
        permissions: { $in: ['bda_admin'] }
      })
        .select('email')
        .lean();
      const recipients = admins
        .map((u) => String(u.email || '').trim())
        .filter((e) => e);
      await sendBdaClaimApprovalEmail(recipients, approval, booking);
    } catch (emailError) {
      console.error('Error sending BDA claim approval email:', emailError);
    }

    const bookingObject = booking.toObject();
    bookingObject.bdaApprovalStatus = approvalStatus;

    return res.status(200).json({
      success: true,
      message: 'Lead claimed successfully',
      data: bookingObject
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
      paymentBreakdown,
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
    const allowed = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];
    if (Array.isArray(paymentBreakdown) && paymentBreakdown.length > 0) {
      const lines = [];
      let totalAmount = 0;
      for (const line of paymentBreakdown) {
        const planKey = String(line.planName || '').toUpperCase();
        const amount = Number(line.amount);
        if (!allowed.includes(planKey) || amount <= 0 || Number.isNaN(amount)) continue;
        lines.push({
          planName: planKey,
          amount,
          currency: line.currency || 'USD'
        });
        totalAmount += amount;
      }
      if (lines.length > 0) {
        booking.paymentBreakdown = lines;
        const currency = lines[0].currency || 'USD';
        const symbol = currency === 'CAD' ? 'CA$' : '$';
        booking.paymentPlan = {
          name: lines[0].planName,
          price: totalAmount,
          currency,
          displayPrice: paymentPlan?.displayPrice || `${symbol}${totalAmount}`,
          selectedAt: new Date()
        };
      }
    } else if (paymentPlan) {
      const name = String(paymentPlan.name || '').toUpperCase();
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
        booking.paymentBreakdown = undefined;
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

    // Filter by claimed date (only if dates are provided and not empty)
    if ((fromDate && fromDate.trim()) || (toDate && toDate.trim())) {
      matchBase['claimedBy.claimedAt'] = {};
      if (fromDate && fromDate.trim()) {
        const from = new Date(fromDate);
        from.setUTCHours(0, 0, 0, 0);
        matchBase['claimedBy.claimedAt'].$gte = from;
      }
      if (toDate && toDate.trim()) {
        const to = new Date(toDate);
        to.setUTCHours(23, 59, 59, 999);
        matchBase['claimedBy.claimedAt'].$lte = to;
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

    // Get all paid bookings first to check approval status
    const allPaidBookings = await CampaignBookingModel.find({
      ...performanceMatch,
      bookingStatus: 'paid'
    })
      .select('bookingId claimedBy.email claimedBy.name paymentPlan')
      .lean();

    // Get approval statuses for all paid bookings
    const paidBookingIds = allPaidBookings.map((b) => b.bookingId);
    const approvals = paidBookingIds.length
      ? await BdaClaimApprovalModel.find({
          bookingId: { $in: paidBookingIds },
          status: 'approved'
        })
        .lean()
      : [];

    const approvedBookingIds = new Set(approvals.map((a) => String(a.bookingId)));

    // Only count paid + approved leads
    const approvedPaidBookings = allPaidBookings.filter((b) => 
      approvedBookingIds.has(String(b.bookingId))
    );

    // Calculate performance metrics for approved + paid leads only
    const bdaPerformanceMap = new Map();
    
    approvedPaidBookings.forEach((b) => {
      const email = b.claimedBy?.email;
      if (!email) return;
      
      if (!bdaPerformanceMap.has(email)) {
        bdaPerformanceMap.set(email, {
          _id: email,
          name: b.claimedBy?.name || '',
          totalClaimed: 0,
          paid: 0,
          scheduled: 0,
          completed: 0,
          totalRevenue: 0
        });
      }
      
      const bda = bdaPerformanceMap.get(email);
      bda.totalClaimed += 1;
      bda.paid += 1;
      bda.totalRevenue += b.paymentPlan?.price || 0;
    });

    const bdaPerformance = Array.from(bdaPerformanceMap.values())
      .sort((a, b) => b.totalClaimed - a.totalClaimed);

    // Calculate incentives only for approved + paid bookings
    const approvedPaidBookingsForIncentive = approvedPaidBookings.filter((b) => 
      b.paymentPlan?.name && ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'].includes(b.paymentPlan.name) &&
      (b.paymentPlan?.price || 0) > 0
    );

    const incentiveRows = await BdaIncentiveConfigModel.find({}).lean();
    const configByPlan = new Map();
    incentiveRows.forEach((r) => {
      configByPlan.set(r.planName, {
        basePriceUsd: r.basePriceUsd != null ? r.basePriceUsd : (PLAN_CATALOG[r.planName]?.price ?? 0),
        incentivePerLeadInr: r.incentivePerLeadInr != null ? r.incentivePerLeadInr : 0
      });
    });

    const incentiveByBda = new Map();
    for (const b of approvedPaidBookingsForIncentive) {
      const email = b.claimedBy?.email;
      if (!email) continue;
      const inc = incentiveForBooking(configByPlan, b);
      if (inc > 0) incentiveByBda.set(email, (incentiveByBda.get(email) ?? 0) + inc);
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

    // Only get paid leads (Total Claimed = Paid + Approved)
    const match = {
      'claimedBy.email': email,
      bookingStatus: 'paid'
    };

    // Filter by claimed date (only if dates are provided and not empty)
    if (fromDate && fromDate.trim()) {
      const start = new Date(fromDate);
      start.setUTCHours(0, 0, 0, 0);
      match['claimedBy.claimedAt'] = match['claimedBy.claimedAt'] || {};
      match['claimedBy.claimedAt'].$gte = start;
    }
    if (toDate && toDate.trim()) {
      const end = new Date(toDate);
      end.setUTCHours(23, 59, 59, 999);
      match['claimedBy.claimedAt'] = match['claimedBy.claimedAt'] || {};
      match['claimedBy.claimedAt'].$lte = end;
    }
    if (planName && ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'].includes(String(planName).toUpperCase())) {
      match['paymentPlan.name'] = String(planName).toUpperCase();
    }

    const bookings = await CampaignBookingModel.find(match)
      .sort({ 'claimedBy.claimedAt': -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const bookingIds = bookings.map((b) => b.bookingId);

    // Get ALL approval statuses (approved, rejected, pending)
    const filteredApprovals = bookingIds.length
      ? await BdaClaimApprovalModel.find({
          bookingId: { $in: bookingIds },
          bdaEmail: email.toLowerCase().trim()
        })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const approvalByBookingId = new Map();
    filteredApprovals.forEach((a) => {
      if (!approvalByBookingId.has(a.bookingId)) {
        approvalByBookingId.set(a.bookingId, { status: a.status, approvalId: String(a._id) });
      }
    });

    // Include ALL leads (approved + rejected) with proper status
    const enrichedBookings = bookings.map((b) => {
      const entry = approvalByBookingId.get(b.bookingId) || null;
      if (entry) {
        return { ...b, bdaApprovalStatus: entry.status, bdaApprovalId: entry.approvalId };
      }
      // If no approval record, it might be pending
      return { ...b, bdaApprovalStatus: null };
    });

    // Calculate total count for pagination (all leads - approved + rejected)
    const total = await CampaignBookingModel.countDocuments(match);

    // Calculate incentives only for approved + paid bookings (exclude rejected)
    const approvedPaidBookings = enrichedBookings.filter((b) => 
      b.bdaApprovalStatus === 'approved' &&
      b.paymentPlan?.name && ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'].includes(b.paymentPlan.name) &&
      (b.paymentPlan?.price || 0) > 0
    );

    const incentiveRows = await BdaIncentiveConfigModel.find({}).lean();
    const configByPlan = new Map();
    incentiveRows.forEach((r) => {
      configByPlan.set(r.planName, {
        basePriceUsd: r.basePriceUsd != null ? r.basePriceUsd : (PLAN_CATALOG[r.planName]?.price ?? 0),
        incentivePerLeadInr: r.incentivePerLeadInr != null ? r.incentivePerLeadInr : 0
      });
    });
    let totalIncentivesForFilter = 0;
    for (const b of approvedPaidBookings) {
      totalIncentivesForFilter += incentiveForBooking(configByPlan, b);
    }

    return res.status(200).json({
      success: true,
      data: enrichedBookings,
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

/**
 * Admin only: remove claim from a lead (revert claim). Lead becomes unclaimed and can be claimed again.
 */
export const adminUnclaimLead = async (req, res) => {
  try {
    const { bookingId } = req.params;

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

    if (!booking.claimedBy || !booking.claimedBy.email) {
      return res.status(400).json({
        success: false,
        message: 'This lead is not claimed by any BDA'
      });
    }

    booking.claimedBy = { email: null, name: null, claimedAt: null };
    await booking.save();

    return res.status(200).json({
      success: true,
      message: 'Lead unclaimed successfully. It can be claimed again by any BDA.',
      data: { bookingId, clientName: booking.clientName, clientEmail: booking.clientEmail }
    });
  } catch (error) {
    console.error('Error unclaiming lead (admin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to unclaim lead',
      error: error.message
    });
  }
};

export const getBdaLeadsByEmail = async (req, res) => {
  try {
    const { email } = req.params;
    const { fromDate, toDate } = req.query;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Only get paid leads
    const matchQuery = {
      'claimedBy.email': email.toLowerCase().trim(),
      bookingStatus: 'paid'
    };

    // Filter by claimed date (only if dates are provided and not empty)
    if ((fromDate && fromDate.trim()) || (toDate && toDate.trim())) {
      matchQuery['claimedBy.claimedAt'] = {};
      if (fromDate && fromDate.trim()) {
        const from = new Date(fromDate);
        from.setUTCHours(0, 0, 0, 0);
        matchQuery['claimedBy.claimedAt'].$gte = from;
      }
      if (toDate && toDate.trim()) {
        const to = new Date(toDate);
        to.setUTCHours(23, 59, 59, 999);
        matchQuery['claimedBy.claimedAt'].$lte = to;
      }
    }

    const bookings = await CampaignBookingModel.find(matchQuery)
      .sort({ 'claimedBy.claimedAt': -1 })
      .lean();
    
    const bookingIds = bookings.map((b) => b.bookingId);
    let enriched = [];
    
    if (bookingIds.length) {
      // Get ALL approval statuses (approved, rejected, pending)
      const approvals = await BdaClaimApprovalModel.find({
        bookingId: { $in: bookingIds },
        bdaEmail: email.toLowerCase().trim()
      })
        .sort({ createdAt: -1 })
        .lean();
      
      const approvalByBookingId = new Map();
      approvals.forEach((a) => {
        if (!approvalByBookingId.has(a.bookingId)) {
          approvalByBookingId.set(a.bookingId, { status: a.status, approvalId: String(a._id) });
        }
      });
      
      // Include ALL leads (approved + rejected) with proper status
      enriched = bookings.map((b) => {
        const entry = approvalByBookingId.get(b.bookingId) || null;
        return entry ? { ...b, bdaApprovalStatus: entry.status, bdaApprovalId: entry.approvalId } : { ...b, bdaApprovalStatus: null };
      });
    }

    const bdaInfo = enriched.length > 0 ? {
      email: enriched[0].claimedBy.email,
      name: enriched[0].claimedBy.name,
      claimedAt: enriched[0].claimedBy.claimedAt
    } : null;

    return res.status(200).json({
      success: true,
      data: {
        bda: bdaInfo,
        leads: enriched
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

export const getPendingBdaApprovalsForCrm = async (req, res) => {
  try {
    const approvals = await BdaClaimApprovalModel.find({ status: 'pending' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const bookingIds = approvals.map((a) => a.bookingId);
    const bookings = await CampaignBookingModel.find({ bookingId: { $in: bookingIds } })
      .select('bookingId clientName clientEmail clientPhone paymentPlan')
      .lean();
    const bookingMap = new Map();
    bookings.forEach((b) => {
      bookingMap.set(b.bookingId, b);
    });

    const data = approvals.map((a) => {
      const booking = bookingMap.get(a.bookingId) || {};
      return {
        approvalId: String(a._id),
        bookingId: a.bookingId,
        bdaEmail: a.bdaEmail,
        bdaName: a.bdaName,
        clientName: a.clientName || booking.clientName || '',
        clientEmail: a.clientEmail || booking.clientEmail || '',
        clientPhone: a.clientPhone || booking.clientPhone || '',
        paymentPlan: a.paymentPlan || booking.paymentPlan || null,
        createdAt: a.createdAt
      };
    });

    return res.status(200).json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Error fetching pending BDA approvals for CRM:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch pending approvals',
      error: error.message
    });
  }
};

function computeApprovalToken(approvalId, bookingId) {
  const secret =
    process.env.CRM_JWT_SECRET ||
    process.env.CRM_ADMIN_PASSWORD ||
    'dev_only_insecure_crm_jwt_secret';
  const payload = `${approvalId}:${bookingId}`;
  return crypto.createHash('sha256').update(payload + secret).digest('hex');
}

async function applyBdaApprovalAction(approvalId, action) {
  const approval = await BdaClaimApprovalModel.findById(approvalId);
  if (!approval) {
    return { ok: false, reason: 'not_found' };
  }
  if (approval.status !== 'pending') {
    return { ok: false, reason: 'already_processed', status: approval.status };
  }
  const booking = await CampaignBookingModel.findOne({ bookingId: approval.bookingId });
  if (!booking) {
    approval.status = 'denied';
    await approval.save();
    return { ok: false, reason: 'booking_missing' };
  }
  if (action === 'approve') {
    approval.status = 'approved';
    await approval.save();
    return { ok: true, approval, booking };
  }
  if (action === 'deny') {
    booking.claimedBy = { email: null, name: null, claimedAt: null };
    await booking.save();
    approval.status = 'denied';
    await approval.save();
    return { ok: true, approval, booking };
  }
  return { ok: false, reason: 'invalid_action' };
}

export const handleBdaApprovalEmailAction = async (req, res) => {
  try {
    const approvalId = String(req.params.approvalId || '').trim();
    const token = String(req.query.token || '').trim();
    const action = String(req.query.action || '').trim();
    if (!approvalId || !token || !action) {
      return res.status(400).send('Invalid approval link');
    }
    const approval = await BdaClaimApprovalModel.findById(approvalId).lean();
    if (!approval) {
      return res.status(404).send('Approval not found');
    }
    const expected = computeApprovalToken(String(approval._id), approval.bookingId);
    if (token !== expected) {
      return res.status(403).send('Invalid or expired approval token');
    }
    const result = await applyBdaApprovalAction(approvalId, action);
    if (!result.ok) {
      if (result.reason === 'already_processed') {
        return res.redirect(302, (process.env.CRM_FRONTEND_URL || 'https://flashfire-crm.vercel.app') + '/admin/analysis');
      }
      return res.status(400).send('Unable to process approval');
    }
    return res.redirect(302, (process.env.CRM_FRONTEND_URL || 'https://flashfire-crm.vercel.app') + '/admin/analysis');
  } catch (error) {
    console.error('Error handling BDA approval email action:', error);
    return res.status(500).send('Server error');
  }
};

export const adminResolveBdaApproval = async (req, res) => {
  try {
    const approvalId = String(req.params.approvalId || '').trim();
    const actionRaw = String(req.body?.action || '').trim();
    if (!approvalId || !actionRaw) {
      return res.status(400).json({
        success: false,
        message: 'approvalId and action are required'
      });
    }
    const allowed = ['approved', 'denied'];
    if (!allowed.includes(actionRaw)) {
      return res.status(400).json({
        success: false,
        message: `Invalid action. Must be one of: ${allowed.join(', ')}`
      });
    }
    const mappedAction = actionRaw === 'approved' ? 'approve' : 'deny';
    const result = await applyBdaApprovalAction(approvalId, mappedAction);
    if (!result.ok) {
      return res.status(400).json({
        success: false,
        message: 'Unable to process approval',
        reason: result.reason || null
      });
    }
    return res.status(200).json({
      success: true,
      data: {
        approvalId,
        status: mappedAction === 'approve' ? 'approved' : 'denied',
        bookingId: result.booking?.bookingId || null
      }
    });
  } catch (error) {
    console.error('Error resolving BDA approval (admin):', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to resolve approval',
      error: error.message
    });
  }
};

/**
 * Admin endpoint: Get all clients with their claim dates and statuses
 * Returns all claimed bookings with client info, claim date, booking status, and approval status
 */
export const getAllClientsWithClaimInfo = async (req, res) => {
  try {
    const { page = 1, limit = 100, bdaEmail, status, fromDate, toDate } = req.query;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(500, Math.max(1, parseInt(limit) || 100));
    const skip = (pageNum - 1) * limitNum;

    const match = {
      'claimedBy.email': { $exists: true, $ne: null },
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
    };

    if (bdaEmail) {
      match['claimedBy.email'] = bdaEmail.toLowerCase().trim();
    }

    if (status && ['paid', 'scheduled', 'completed'].includes(status)) {
      match.bookingStatus = status;
    }

    if (fromDate || toDate) {
      match['claimedBy.claimedAt'] = {};
      if (fromDate) {
        const start = new Date(fromDate);
        start.setUTCHours(0, 0, 0, 0);
        match['claimedBy.claimedAt'].$gte = start;
      }
      if (toDate) {
        const end = new Date(toDate);
        end.setUTCHours(23, 59, 59, 999);
        match['claimedBy.claimedAt'].$lte = end;
      }
    }

    const [bookings, total] = await Promise.all([
      CampaignBookingModel.find(match)
        .select('bookingId clientName clientEmail clientPhone claimedBy bookingStatus paymentPlan bdaApprovalStatus')
        .sort({ 'claimedBy.claimedAt': -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments(match)
    ]);

    // Get approval statuses for all bookings
    const bookingIds = bookings.map((b) => b.bookingId);
    const approvals = bookingIds.length
      ? await BdaClaimApprovalModel.find({
          bookingId: { $in: bookingIds }
        })
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const approvalByBookingId = new Map();
    approvals.forEach((a) => {
      if (!approvalByBookingId.has(a.bookingId)) {
        approvalByBookingId.set(a.bookingId, a.status);
      }
    });

    // Format response with clear claim date and status information
    const clients = bookings.map((booking) => {
      const approvalStatus = approvalByBookingId.get(booking.bookingId) || null;
      
      return {
        bookingId: booking.bookingId,
        clientName: booking.clientName || '',
        clientEmail: booking.clientEmail || '',
        clientPhone: booking.clientPhone || '',
        claimedBy: {
          email: booking.claimedBy?.email || '',
          name: booking.claimedBy?.name || '',
          claimedAt: booking.claimedBy?.claimedAt || null
        },
        claimDate: booking.claimedBy?.claimedAt || null, // Easy access to claim date
        bookingStatus: booking.bookingStatus || '', // paid, scheduled, completed
        approvalStatus: approvalStatus || null, // pending, approved, denied
        paymentPlan: booking.paymentPlan || null
      };
    });

    return res.status(200).json({
      success: true,
      data: clients,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(Math.max(0, total) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching all clients with claim info:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch clients with claim information',
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

    // Base match: only paid leads (Total Claimed = Paid + Approved)
    const baseMatch = {
      'claimedBy.email': email.toLowerCase().trim(),
      bookingStatus: 'paid'
    };

    // Filter by claimed date (only if dates are provided and not empty)
    if ((fromDate && fromDate.trim()) || (toDate && toDate.trim())) {
      baseMatch['claimedBy.claimedAt'] = {};
      if (fromDate && fromDate.trim()) {
        const from = new Date(fromDate);
        from.setUTCHours(0, 0, 0, 0);
        baseMatch['claimedBy.claimedAt'].$gte = from;
      }
      if (toDate && toDate.trim()) {
        const to = new Date(toDate);
        to.setUTCHours(23, 59, 59, 999);
        baseMatch['claimedBy.claimedAt'].$lte = to;
      }
    }

    if (plan && plan !== 'all') {
      baseMatch['paymentPlan.name'] = plan;
    }

    // Get all paid bookings first
    const allPaidBookings = await CampaignBookingModel.find(baseMatch)
      .select('bookingId')
      .lean();

    // Get ALL approval statuses (approved, rejected, pending) for all paid bookings
    const paidBookingIds = allPaidBookings.map((b) => b.bookingId);
    const allApprovals = paidBookingIds.length
      ? await BdaClaimApprovalModel.find({
          bookingId: { $in: paidBookingIds },
          bdaEmail: email.toLowerCase().trim()
        })
        .lean()
      : [];

    const approvedBookingIds = new Set(
      allApprovals.filter((a) => a.status === 'approved').map((a) => String(a.bookingId))
    );

    // Get approved booking IDs for stats calculation
    const approvedPaidBookingIds = allPaidBookings
      .filter((b) => approvedBookingIds.has(String(b.bookingId)))
      .map((b) => b.bookingId);

    // Show ALL leads (approved + rejected) but only count approved in stats
    const matchConditions = {
      ...baseMatch
    };

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const [bookings, totalAll] = await Promise.all([
      CampaignBookingModel.find(matchConditions)
        .sort({ 'claimedBy.claimedAt': -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments(matchConditions)
    ]);

    // Get approval info for ALL bookings (approved + rejected)
    const bookingIds = bookings.map((b) => b.bookingId);
    const bookingApprovals = bookingIds.length
      ? await BdaClaimApprovalModel.find({
          bookingId: { $in: bookingIds },
          bdaEmail: email.toLowerCase().trim()
        })
        .lean()
      : [];
    const approvalMap = new Map();
    bookingApprovals.forEach((a) => {
      if (!approvalMap.has(a.bookingId)) {
        approvalMap.set(a.bookingId, { status: a.status, approvalId: String(a._id) });
      }
    });
    const enrichedBookings = bookings.map((b) => {
      const entry = approvalMap.get(b.bookingId) || null;
      return entry ? { ...b, bdaApprovalStatus: entry.status, bdaApprovalId: entry.approvalId } : { ...b, bdaApprovalStatus: null };
    });

    // Total count for pagination: all leads (approved + rejected)
    const total = totalAll;

    // Calculate overview stats (only approved + paid leads count in stats)
    const overviewMatch = approvedPaidBookingIds.length > 0
      ? {
          'claimedBy.email': email.toLowerCase().trim(),
          bookingStatus: 'paid',
          bookingId: { $in: approvedPaidBookingIds }
        }
      : {
          'claimedBy.email': email.toLowerCase().trim(),
          bookingStatus: 'paid',
          bookingId: { $in: [] }
        };

    const overview = await CampaignBookingModel.aggregate([
      {
        $match: overviewMatch
      },
      {
        $group: {
          _id: null,
          totalClaimed: { $sum: 1 },
          paid: { $sum: 1 }, // All are paid
          scheduled: { $sum: 0 },
          completed: { $sum: 0 },
          totalRevenue: {
            $sum: { $ifNull: ['$paymentPlan.price', 0] }
          }
        }
      }
    ]);

    const statusBreakdown = [
      { _id: 'paid', count: approvedPaidBookingIds.length },
      { _id: 'scheduled', count: 0 },
      { _id: 'completed', count: 0 }
    ];

    const planBreakdown = await CampaignBookingModel.aggregate([
      {
        $match: overviewMatch
      },
      {
        $group: {
          _id: '$paymentPlan.name',
          count: { $sum: 1 },
          revenue: {
            $sum: { $ifNull: ['$paymentPlan.price', 0] }
          }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);

    const monthlyTrend = await CampaignBookingModel.aggregate([
      {
        $match: overviewMatch
      },
      {
        $group: {
          _id: {
            year: { $year: '$claimedBy.claimedAt' },
            month: { $month: '$claimedBy.claimedAt' }
          },
          count: { $sum: 1 },
          revenue: {
            $sum: { $ifNull: ['$paymentPlan.price', 0] }
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
        leads: enrichedBookings,
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

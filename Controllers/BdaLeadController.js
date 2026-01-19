import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

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

    if (booking.claimedBy && booking.claimedBy.email) {
      if (paymentPlan) {
        return res.status(403).json({
          success: false,
          message: 'Cannot change payment plan or amount for claimed leads'
        });
      }
    }

    if (clientName) booking.clientName = clientName;
    if (clientPhone !== undefined) booking.clientPhone = clientPhone;
    if (scheduledEventStartTime) booking.scheduledEventStartTime = new Date(scheduledEventStartTime);
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
    const totalLeads = await CampaignBookingModel.countDocuments({
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
    });

    const claimedLeads = await CampaignBookingModel.countDocuments({
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] },
      'claimedBy.email': { $exists: true, $ne: null }
    });

    const unclaimedLeads = totalLeads - claimedLeads;

    const bdaPerformance = await CampaignBookingModel.aggregate([
      {
        $match: {
          bookingStatus: { $in: ['paid', 'scheduled', 'completed'] },
          'claimedBy.email': { $exists: true, $ne: null }
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

    const statusBreakdown = await CampaignBookingModel.aggregate([
      {
        $match: {
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

    const { page = 1, limit = 50 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const [bookings, total] = await Promise.all([
      CampaignBookingModel.find({
        'claimedBy.email': email,
        bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
      })
        .sort({ 'claimedBy.claimedAt': -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments({
        'claimedBy.email': email,
        bookingStatus: { $in: ['paid', 'scheduled', 'completed'] }
      })
    ]);

    return res.status(200).json({
      success: true,
      data: bookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
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

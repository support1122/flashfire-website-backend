import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';

// ==================== SAVE CALENDLY BOOKING WITH UTM ====================
export const saveCalendlyBooking = async (bookingData) => {
  try {
    const {
      utmSource,
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      clientName,
      clientEmail,
      clientPhone,
      calendlyEventUri,
      calendlyInviteeUri,
      calendlyMeetLink,
      scheduledEventStartTime,
      scheduledEventEndTime,
      anythingToKnow,
      questionsAndAnswers,
      visitorId,
      userAgent,
      ipAddress
    } = bookingData;

    // Find the campaign
    let campaignId = null;
    if (utmSource) {
      const campaign = await CampaignModel.findOne({ utmSource });
      if (campaign) {
        campaignId = campaign.campaignId;
      }
    }

    // Create booking record
    const booking = new CampaignBookingModel({
      campaignId,
      utmSource: utmSource || 'direct',
      utmMedium,
      utmCampaign,
      utmContent,
      utmTerm,
      clientName,
      clientEmail,
      clientPhone,
      calendlyEventUri,
      calendlyInviteeUri,
      calendlyMeetLink,
      scheduledEventStartTime,
      scheduledEventEndTime,
      anythingToKnow,
      questionsAndAnswers,
      visitorId,
      userAgent,
      ipAddress,
      bookingStatus: 'scheduled'
    });

    await booking.save();

    console.log('✅ Calendly booking saved with UTM data:', {
      bookingId: booking.bookingId,
      utmSource: booking.utmSource,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientPhone: booking.clientPhone,
      calendlyMeetLink: booking.calendlyMeetLink,
      scheduledEventStartTime: booking.scheduledEventStartTime,
      bookingStatus: booking.bookingStatus
    });

    console.log('📊 Full booking object saved to database:', JSON.stringify({
      bookingId: booking.bookingId,
      campaignId: booking.campaignId,
      utmSource: booking.utmSource,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientPhone: booking.clientPhone,
      calendlyMeetLink: booking.calendlyMeetLink,
      scheduledEventStartTime: booking.scheduledEventStartTime,
      bookingCreatedAt: booking.bookingCreatedAt
    }, null, 2));

    return {
      success: true,
      data: booking
    };

  } catch (error) {
    console.error('❌ Error saving Calendly booking:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

// ==================== GET ALL BOOKINGS ====================
export const getAllBookings = async (req, res) => {
  try {
    const { utmSource, status, limit = 100, skip = 0 } = req.query;

    let query = {};
    if (utmSource) query.utmSource = utmSource;
    if (status) query.bookingStatus = status;

    const bookings = await CampaignBookingModel.find(query)
      .sort({ bookingCreatedAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await CampaignBookingModel.countDocuments(query);

    return res.status(200).json({
      success: true,
      count: bookings.length,
      total,
      data: bookings
    });

  } catch (error) {
    console.error('Error fetching bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

// ==================== GET BOOKING BY ID ====================
export const getBookingById = async (req, res) => {
  try {
    const { bookingId } = req.params;

    const booking = await CampaignBookingModel.findOne({ bookingId });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Get campaign details if available
    let campaignDetails = null;
    if (booking.campaignId) {
      const campaign = await CampaignModel.findOne({ campaignId: booking.campaignId });
      if (campaign) {
        campaignDetails = {
          campaignName: campaign.campaignName,
          campaignId: campaign.campaignId
        };
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        booking: booking.toObject(),
        campaign: campaignDetails
      }
    });

  } catch (error) {
    console.error('Error fetching booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch booking details',
      error: error.message
    });
  }
};

// ==================== UPDATE BOOKING STATUS ====================
export const updateBookingStatus = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { status } = req.body;

    const validStatuses = ['scheduled', 'completed', 'canceled', 'rescheduled', 'no-show'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    const booking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { bookingStatus: status },
      { new: true }
    );

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Booking status updated successfully',
      data: booking
    });

  } catch (error) {
    console.error('Error updating booking status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update booking status',
      error: error.message
    });
  }
};

// ==================== GET BOOKINGS BY EMAIL ====================
export const getBookingsByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    const bookings = await CampaignBookingModel.find({ 
      clientEmail: email.toLowerCase() 
    }).sort({ bookingCreatedAt: -1 });

    return res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings
    });

  } catch (error) {
    console.error('Error fetching bookings by email:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

// ==================== EXPORT BOOKINGS FOR MICROSERVICE ====================
export const exportBookingsForMicroservice = async (req, res) => {
  try {
    const { syncedOnly = false, limit = 1000 } = req.query;

    let query = {};
    if (syncedOnly === 'true') {
      query.syncedToMicroservice = false;
    }

    const bookings = await CampaignBookingModel.find(query)
      .sort({ bookingCreatedAt: -1 })
      .limit(parseInt(limit))
      .lean();

    // Format for export
    const exportData = bookings.map(booking => ({
      bookingId: booking.bookingId,
      utmSource: booking.utmSource,
      utmMedium: booking.utmMedium,
      utmCampaign: booking.utmCampaign,
      clientName: booking.clientName,
      clientEmail: booking.clientEmail,
      clientPhone: booking.clientPhone,
      meetLink: booking.calendlyMeetLink,
      scheduledTime: booking.scheduledEventStartTime,
      bookingDate: booking.bookingCreatedAt,
      status: booking.bookingStatus
    }));

    return res.status(200).json({
      success: true,
      count: exportData.length,
      data: exportData,
      exportedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error exporting bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to export bookings',
      error: error.message
    });
  }
};

// ==================== MARK AS SYNCED ====================
export const markBookingsAsSynced = async (req, res) => {
  try {
    const { bookingIds } = req.body;

    if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'bookingIds array is required'
      });
    }

    const result = await CampaignBookingModel.updateMany(
      { bookingId: { $in: bookingIds } },
      { 
        syncedToMicroservice: true,
        syncedAt: new Date()
      }
    );

    return res.status(200).json({
      success: true,
      message: `${result.modifiedCount} bookings marked as synced`,
      modifiedCount: result.modifiedCount
    });

  } catch (error) {
    console.error('Error marking bookings as synced:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to mark bookings as synced',
      error: error.message
    });
  }
};

// ==================== FRONTEND CAPTURE (BACKUP TO WEBHOOK) ====================
export const captureFrontendBooking = async (req, res) => {
  try {
    const bookingData = req.body;

    console.log('📱 Frontend booking capture received:', {
      email: bookingData.clientEmail,
      name: bookingData.clientName,
      utmSource: bookingData.utmSource
    });

    // Check if booking already exists (from webhook)
    const existingBooking = await CampaignBookingModel.findOne({
      clientEmail: bookingData.clientEmail,
      scheduledEventStartTime: bookingData.scheduledEventStartTime
    });

    if (existingBooking) {
      console.log('ℹ️ Booking already exists (webhook captured it first), skipping duplicate');
      return res.status(200).json({
        success: true,
        message: 'Booking already captured by webhook',
        duplicate: true,
        bookingId: existingBooking.bookingId
      });
    }

    // Save booking using the existing function
    const result = await saveCalendlyBooking(bookingData);

    if (result.success) {
      return res.status(201).json({
        success: true,
        message: 'Booking captured successfully from frontend',
        data: result.data
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to save booking',
        error: result.error
      });
    }

  } catch (error) {
    console.error('❌ Error capturing frontend booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to capture booking',
      error: error.message
    });
  }
};


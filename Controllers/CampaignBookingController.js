import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';
import { UserModel } from '../Schema_Models/User.js';
import { callQueue } from '../Utils/queue.js';
import { DateTime } from 'luxon';
import { triggerWorkflow } from './WorkflowController.js';

// ==================== SAVE CALENDLY BOOKING WITH UTM ====================
export const saveCalendlyBooking = async (bookingData) => {
  try {
    let {
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

    if ((!clientName || clientName.trim() === '') || (!clientEmail || clientEmail.trim() === '')) {
      console.log('⚠️ Missing client name or email, searching for existing Calendly booking...');

      const findQuery = {};
      if (utmSource) {
        findQuery.utmSource = utmSource;
      }
      if (scheduledEventStartTime) {
        findQuery.scheduledEventStartTime = scheduledEventStartTime;
      }
      if (calendlyMeetLink && calendlyMeetLink !== 'Not Provided') {
        findQuery.calendlyMeetLink = calendlyMeetLink;
      }
      if (clientPhone) {
        findQuery.clientPhone = clientPhone;
      }

      if (Object.keys(findQuery).length > 0) {
        const existingBooking = await CampaignBookingModel.findOne(findQuery)
          .sort({ bookingCreatedAt: -1 })
          .limit(1);

        if (existingBooking) {
          console.log('✅ Found existing Calendly booking, using its data to fill missing fields');
          // Use Calendly data to fill in missing fields
          if (!clientName || clientName.trim() === '') {
            clientName = existingBooking.clientName || 'Unknown Client';
          }
          if (!clientEmail || clientEmail.trim() === '') {
            clientEmail = existingBooking.clientEmail || `unknown_${Date.now()}@calendly.placeholder`;
          }
          if (!clientPhone && existingBooking.clientPhone) {
            clientPhone = existingBooking.clientPhone;
          }
          if (!calendlyMeetLink && existingBooking.calendlyMeetLink) {
            calendlyMeetLink = existingBooking.calendlyMeetLink;
          }
          if (!calendlyEventUri && existingBooking.calendlyEventUri) {
            calendlyEventUri = existingBooking.calendlyEventUri;
          }
          if (!calendlyInviteeUri && existingBooking.calendlyInviteeUri) {
            calendlyInviteeUri = existingBooking.calendlyInviteeUri;
          }
        }
      }
    }

    // Use defaults if still empty after checking existing bookings
    if (!clientName || clientName.trim() === '') {
      clientName = 'Unknown Client';
      console.log('⚠️ Using default client name: Unknown Client');
    }
    if (!clientEmail || clientEmail.trim() === '') {
      clientEmail = `unknown_${Date.now()}@calendly.placeholder`;
      console.log('⚠️ Using default client email:', clientEmail);
    }

    // Find the campaign
    let campaignId = null;
    if (utmSource) {
      const campaign = await CampaignModel.findOne({ utmSource });
      if (campaign) {
        campaignId = campaign.campaignId;
      } else {
        // Get or create default "Calendly" campaign for direct bookings
        let defaultCampaign = await CampaignModel.findOne({ utmSource: 'calendly_direct' });

        if (!defaultCampaign) {
          // Create default Calendly campaign if it doesn't exist
          defaultCampaign = new CampaignModel({
            campaignName: 'Calendly Direct Bookings',
            utmSource: 'calendly_direct',
            utmMedium: 'calendly',
            utmCampaign: 'direct_booking',
            generatedUrl: 'https://www.flashfirejobs.com?utm_source=calendly_direct&utm_medium=calendly&utm_campaign=direct_booking',
            baseUrl: 'https://www.flashfirejobs.com',
            createdBy: 'system'
          });
          await defaultCampaign.save();
          console.log('✅ Created default Calendly campaign', { campaignId: defaultCampaign.campaignId });
        }

        campaignId = defaultCampaign.campaignId;
        console.log('✅ Assigned booking to default Calendly campaign', { campaignId });
      }
    }

    // Final duplicate check before saving (safety net)
    const finalDuplicateCheck = {
      $or: []
    };

    if (clientEmail && clientEmail.trim() !== '' && !clientEmail.includes('@calendly.placeholder')) {
      finalDuplicateCheck.$or.push({
        clientEmail: clientEmail.trim().toLowerCase(),
        scheduledEventStartTime: scheduledEventStartTime
      });
    }

    if (scheduledEventStartTime && calendlyMeetLink && calendlyMeetLink !== 'Not Provided') {
      finalDuplicateCheck.$or.push({
        scheduledEventStartTime: scheduledEventStartTime,
        calendlyMeetLink: calendlyMeetLink
      });
    }

    if (finalDuplicateCheck.$or.length > 0) {
      const existingDuplicate = await CampaignBookingModel.findOne(finalDuplicateCheck);
      if (existingDuplicate) {
        console.log('⚠️ Duplicate booking detected before save, returning existing booking');
        return {
          success: true,
          data: existingDuplicate,
          duplicate: true
        };
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
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
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

    // Mark user as booked in UserModel since they now have a booking
    try {
      const escapedEmail = booking.clientEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await UserModel.updateOne(
        { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
        { $set: { booked: true } }
      );
      console.log('✅ User marked as booked:', { email: booking.clientEmail });
    } catch (userUpdateError) {
      console.warn('⚠️ Failed to update user booked status:', {
        email: booking.clientEmail,
        error: userUpdateError.message
      });
      // Don't fail the whole request if user update fails
    }

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

export const getAllBookingsPaginated = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      status,
      utmSource,
      search,
      fromDate,
      toDate,
      type = 'all'
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let query = {};

    if (status && status !== 'all') {
      query.bookingStatus = status;
    }

    if (utmSource && utmSource !== 'all') {
      query.utmSource = utmSource;
    }

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

    if (search) {
      query.$or = [
        { clientName: { $regex: search, $options: 'i' } },
        { clientEmail: { $regex: search, $options: 'i' } },
        { utmSource: { $regex: search, $options: 'i' } }
      ];
    }

    query.scheduledEventStartTime = query.scheduledEventStartTime || { $exists: true, $ne: null };

    const total = await CampaignBookingModel.countDocuments(query);

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        utmContent: 1,
        utmTerm: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        reminderCallJobId: 1,
        paymentReminders: 1,
        rescheduledCount: 1,
        whatsappReminderSent: 1
      })
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

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
    console.error('Error fetching paginated bookings:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings',
      error: error.message
    });
  }
};

export const getMeetingsBookedToday = async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const query = {
      scheduledEventStartTime: {
        $gte: today,
        $lt: tomorrow
      }
    };

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        reminderCallJobId: 1,
        paymentReminders: 1,
        rescheduledCount: 1,
        whatsappReminderSent: 1
      })
      .sort({ scheduledEventStartTime: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: bookings,
      count: bookings.length
    });

  } catch (error) {
    console.error('Error fetching meetings booked today:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meetings booked today',
      error: error.message
    });
  }
};

export const getAllBookings = async (req, res) => {
  try {
    const { utmSource, status } = req.query;

    let query = {};
    if (utmSource) query.utmSource = utmSource;
    if (status) query.bookingStatus = status;

    const bookings = await CampaignBookingModel.find(query)
      .select({
        bookingId: 1,
        campaignId: 1,
        utmSource: 1,
        utmMedium: 1,
        utmCampaign: 1,
        utmContent: 1,
        utmTerm: 1,
        clientName: 1,
        clientEmail: 1,
        clientPhone: 1,
        calendlyMeetLink: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
        meetingNotes: 1,
        anythingToKnow: 1
      })
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 })
      .limit(5000)
      .lean();

    const total = bookings.length;

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

    // Trigger workflows for specific status changes
    const workflowTriggerStatuses = ['completed', 'canceled', 'rescheduled', 'no-show'];
    if (workflowTriggerStatuses.includes(status)) {
      try {
        const workflowResult = await triggerWorkflow(bookingId, status);
        if (workflowResult.success && workflowResult.triggered) {
          console.log(`✅ Workflows triggered for booking ${bookingId} with status ${status}`);
        }
      } catch (workflowError) {
        console.error('Error triggering workflows:', workflowError);
        // Don't fail the status update if workflow trigger fails
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Booking status updated successfully',
      data: booking,
      workflowTriggered: workflowTriggerStatuses.includes(status)
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

// ==================== RESCHEDULE BOOKING ====================
export const rescheduleBooking = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { newTime } = req.body;

    if (!newTime) {
      return res.status(400).json({
        success: false,
        message: 'newTime (ISO string) is required',
      });
    }

    const parsedTime = new Date(newTime);
    if (Number.isNaN(parsedTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid date provided for newTime',
      });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found',
      });
    }

    // Remove existing reminder call job if present
    if (booking.reminderCallJobId) {
      try {
        const existingJob = await callQueue.getJob(booking.reminderCallJobId);
        if (existingJob) {
          await existingJob.remove();
        }
      } catch (error) {
        console.error('Error removing previous reminder call job:', error);
      }
      booking.reminderCallJobId = null;
    }

    const rescheduledFrom = booking.scheduledEventStartTime;
    booking.rescheduledFrom = rescheduledFrom || null;
    booking.rescheduledTo = parsedTime;
    booking.rescheduledAt = new Date();
    booking.rescheduledCount = (booking.rescheduledCount || 0) + 1;
    booking.scheduledEventStartTime = parsedTime;

    // Attempt to schedule new reminder call 10 minutes before meeting
    const phone = booking.clientPhone?.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '') || null;
    const delayMs = parsedTime.getTime() - Date.now() - 10 * 60 * 1000;
    if (phone && delayMs > 0) {
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      if (phoneRegex.test(phone) && !phone.startsWith('+91')) {
        try {
          // Validate required data before adding job
          if (!phone || !booking.clientEmail || !parsedTime) {
            console.error('Missing required data for call job in CampaignBookingController', {
              phone,
              email: booking.clientEmail,
              meetingTime: parsedTime
            });
            return;
          }

          const meetingStartUTC = DateTime.fromJSDate(parsedTime, { zone: 'utc' });
          const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');
          
          if (!meetingTimeIndia) {
            console.error('Failed to format meeting time', { parsedTime });
            return;
          }

          const job = await callQueue.add(
            'callUser',
            {
              phone,
              phoneNumber: phone, // Include both for compatibility with all workers
              meetingTime: meetingTimeIndia,
              role: 'client',
              inviteeEmail: booking.clientEmail,
              eventStartISO: parsedTime.toISOString(),
            },
            {
              jobId: phone,
              delay: delayMs,
              removeOnComplete: true,
              removeOnFail: 100,
            }
          );
          booking.reminderCallJobId = job.id.toString();
          console.log('✅ Call job scheduled from CampaignBookingController', {
            jobId: job.id,
            phone,
            meetingTime: meetingTimeIndia
          });
        } catch (error) {
          console.error('Error scheduling new reminder job:', error);
        }
      }
    }

    booking.bookingStatus = 'scheduled';
    await booking.save();

    return res.status(200).json({
      success: true,
      message: 'Booking rescheduled successfully',
      data: booking.toObject(),
    });
  } catch (error) {
    console.error('Error rescheduling booking:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reschedule booking',
      error: error.message,
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

    // Build query to check if booking already exists (from webhook)
    // Check by multiple criteria since frontend might send empty email/name
    const duplicateQuery = {
      $or: []
    };

    // If email is provided, check by email and scheduled time
    if (bookingData.clientEmail && bookingData.clientEmail.trim() !== '') {
      duplicateQuery.$or.push({
        clientEmail: bookingData.clientEmail,
        scheduledEventStartTime: bookingData.scheduledEventStartTime
      });
    }

    // Also check by UTM source and scheduled time (for when email is empty)
    if (bookingData.utmSource && bookingData.scheduledEventStartTime) {
      duplicateQuery.$or.push({
        utmSource: bookingData.utmSource,
        scheduledEventStartTime: bookingData.scheduledEventStartTime
      });
    }

    // Check by meet link if available
    if (bookingData.calendlyMeetLink && bookingData.calendlyMeetLink !== 'Not Provided') {
      duplicateQuery.$or.push({
        calendlyMeetLink: bookingData.calendlyMeetLink
      });
    }

    // If we have query criteria, check for duplicates
    if (duplicateQuery.$or.length > 0) {
      const existingBooking = await CampaignBookingModel.findOne(duplicateQuery);

      if (existingBooking) {
        console.log('ℹ️ Booking already exists (webhook captured it first), skipping duplicate');
        return res.status(200).json({
          success: true,
          message: 'Booking already captured by webhook',
          duplicate: true,
          bookingId: existingBooking.bookingId
        });
      }
    }

    // Save booking using the existing function (it will handle missing data)
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

// ==================== UPDATE BOOKING NOTES ====================
export const updateBookingNotes = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { notes } = req.body;

    const booking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { meetingNotes: notes },
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
      message: 'Booking notes updated successfully',
      data: booking
    });

  } catch (error) {
    console.error('Error updating booking notes:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update booking notes',
      error: error.message
    });
  }
};

// ==================== CREATE BOOKING MANUALLY ====================
export const createBookingManually = async (req, res) => {
  try {
    const {
      clientName,
      clientEmail,
      clientPhone,
      scheduledEventStartTime,
      utmSource,
      utmMedium,
      utmCampaign,
      bookingStatus,
      calendlyMeetLink,
      anythingToKnow,
      meetingNotes
    } = req.body;

    // Validation
    if (!clientName || !clientEmail || !clientPhone || !scheduledEventStartTime) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: clientName, clientEmail, clientPhone, scheduledEventStartTime'
      });
    }

    // Find or create campaign
    let campaignId = null;
    if (utmSource) {
      const campaign = await CampaignModel.findOne({ utmSource });
      if (campaign) {
        campaignId = campaign.campaignId;
      }
    }

    // Create booking
    const newBooking = new CampaignBookingModel({
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
      clientPhone: clientPhone.trim(),
      scheduledEventStartTime: new Date(scheduledEventStartTime),
      scheduledEventEndTime: new Date(new Date(scheduledEventStartTime).getTime() + 30 * 60000), // 30 min default
      utmSource: utmSource || 'MANUAL',
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      campaignId: campaignId,
      bookingStatus: bookingStatus || 'scheduled',
      calendlyMeetLink: calendlyMeetLink || null,
      anythingToKnow: anythingToKnow || null,
      meetingNotes: meetingNotes || null,
      bookingCreatedAt: new Date()
    });

    await newBooking.save();

    console.log('✅ Booking created manually:', newBooking.bookingId);

    return res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      booking: newBooking
    });
  } catch (error) {
    console.error('❌ Error creating booking manually:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create booking',
      error: error.message
    });
  }
};



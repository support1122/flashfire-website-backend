import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';
import { UserModel } from '../Schema_Models/User.js';
import { callQueue } from '../Utils/queue.js';
import { DateTime } from 'luxon';
import { triggerWorkflow, cancelScheduledWorkflows } from './WorkflowController.js';
import { cancelWhatsAppRemindersForClient } from '../Utils/WhatsAppReminderScheduler.js';
import { cancelDiscordMeetRemindersForMeeting } from '../Utils/DiscordMeetReminderScheduler.js';
import { cancelCall } from '../Utils/CallScheduler.js';
import { Logger } from '../Utils/Logger.js';

const PLAN_CATALOG = {
  PRIME: { price: 99, currency: 'USD', displayPrice: '$99' },
  IGNITE: { price: 199, currency: 'USD', displayPrice: '$199' },
  PROFESSIONAL: { price: 349, currency: 'USD', displayPrice: '$349' },
  EXECUTIVE: { price: 599, currency: 'USD', displayPrice: '$599' },
};

const MQL_STATUSES = ['scheduled', 'rescheduled', 'no-show', 'canceled', 'ignored'];
const SQL_STATUSES = ['completed'];
const CONVERTED_STATUSES = ['paid'];

function getQualificationFromStatus(bookingStatus) {
  if (CONVERTED_STATUSES.includes(bookingStatus)) return 'Converted';
  if (SQL_STATUSES.includes(bookingStatus)) return 'SQL';
  return 'MQL';
}

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
      type = 'all',
      planName
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let query = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;

    if (status && status !== 'all') {
      query.bookingStatus = status;
    }

    if (utmSource && utmSource !== 'all') {
      query.utmSource = utmSource;
    }

    if (normalizedPlanName && normalizedPlanName !== 'ALL') {
      query['paymentPlan.name'] = normalizedPlanName;
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
        googleMeetUrl: 1,
        meetingVideoUrl: 1,
        scheduledEventStartTime: 1,
        scheduledEventEndTime: 1,
        bookingCreatedAt: 1,
        bookingStatus: 1,
      paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
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
      paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
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

export const getMeetingsByDate = async (req, res) => {
  try {
    const { date, fromDate, toDate } = req.query;
    
    // Support both single date and date range
    let startDate, endDate;
    
    if (fromDate && toDate) {
      // Date range mode
      startDate = new Date(fromDate);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(toDate);
      endDate.setHours(23, 59, 59, 999);
    } else if (date) {
      // Single date mode (backward compatibility)
      startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + 1);
      endDate.setHours(0, 0, 0, 0);
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either date parameter (YYYY-MM-DD) or fromDate and toDate parameters (YYYY-MM-DD) are required'
      });
    }

    const query = {
      scheduledEventStartTime: {
        $gte: startDate,
        $lte: endDate
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
      paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1,
        reminderCallJobId: 1,
        paymentReminders: 1,
        rescheduledCount: 1,
        whatsappReminderSent: 1
      })
      .sort({ scheduledEventStartTime: 1 })
      .lean();

    // Calculate breakdown by status
    const breakdown = {
      booked: bookings.filter(b => b.bookingStatus === 'scheduled' || !b.bookingStatus).length,
      cancelled: bookings.filter(b => b.bookingStatus === 'canceled').length,
      noShow: bookings.filter(b => b.bookingStatus === 'no-show').length,
      completed: bookings.filter(b => b.bookingStatus === 'completed').length,
      rescheduled: bookings.filter(b => b.bookingStatus === 'rescheduled').length,
      total: bookings.length
    };

    return res.status(200).json({
      success: true,
      data: bookings,
      count: bookings.length,
      breakdown,
      dateRange: fromDate && toDate ? { fromDate, toDate } : { date }
    });

  } catch (error) {
    console.error('Error fetching meetings by date:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meetings by date',
      error: error.message
    });
  }
};

export const getAllBookings = async (req, res) => {
  try {
    const { utmSource, status, planName } = req.query;

    let query = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;
    if (utmSource) query.utmSource = utmSource;
    if (status) query.bookingStatus = status;
    if (normalizedPlanName) {
      query['paymentPlan.name'] = normalizedPlanName;
    }

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
        paymentPlan: 1,
        meetingNotes: 1,
        anythingToKnow: 1,
        firefliesTranscriptId: 1
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
    const { status, plan, planDetails } = req.body;

    const validStatuses = ['scheduled', 'completed', 'canceled', 'rescheduled', 'no-show', 'paid', 'ignored'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
      });
    }

    // Get booking before update to access client details
    const existingBooking = await CampaignBookingModel.findOne({ bookingId });
    if (!existingBooking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    let paymentPlanUpdate = null;
    let planDetailsUpdate = null;

    // Handle planDetails for finalkk template (can be sent with any status)
    if (planDetails) {
      planDetailsUpdate = {
        days: planDetails.days || 7,
        updatedAt: new Date()
      };
    }

    if (status === 'paid') {
      const normalizedPlanName = plan?.name ? String(plan.name).toUpperCase() : null;
      if (!normalizedPlanName || !PLAN_CATALOG[normalizedPlanName]) {
        return res.status(400).json({
          success: false,
          message: 'A valid plan is required when marking a booking as paid'
        });
      }
      const amountPaid = plan?.price != null ? Number(plan.price) : PLAN_CATALOG[normalizedPlanName].price;
      if (amountPaid <= 0 || Number.isNaN(amountPaid)) {
        return res.status(400).json({
          success: false,
          message: 'Amount paid by client must be greater than 0'
        });
      }

      const catalogPlan = PLAN_CATALOG[normalizedPlanName];
      paymentPlanUpdate = {
        name: normalizedPlanName,
        price: amountPaid,
        currency: plan?.currency || catalogPlan.currency,
        displayPrice: plan?.displayPrice || `$${amountPaid}`,
        selectedAt: new Date()
      };
    }

    const updatePayload = {
      bookingStatus: status
    };

    if (paymentPlanUpdate) {
      updatePayload.paymentPlan = paymentPlanUpdate;
    }

    // Store planDetails for finalkk template execution
    if (planDetailsUpdate) {
      updatePayload.planDetails = planDetailsUpdate;
    }
    
    // Also update paymentPlan if plan is provided (for completed status with finalkk)
    if (plan && !paymentPlanUpdate) {
      const normalizedPlanName = plan?.name ? String(plan.name).toUpperCase() : null;
      if (normalizedPlanName && PLAN_CATALOG[normalizedPlanName]) {
        const catalogPlan = PLAN_CATALOG[normalizedPlanName];
        updatePayload.paymentPlan = {
          name: normalizedPlanName,
          price: plan?.price ?? catalogPlan.price,
          currency: plan?.currency || catalogPlan.currency,
          displayPrice: plan?.displayPrice || catalogPlan.displayPrice,
          selectedAt: new Date()
        };
      }
    }

    // Update booking status
    const booking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { $set: updatePayload },
      { new: true }
    );

    // If status changed to "paid", cancel all scheduled reminders for this client
    if (status === 'paid') {
      try {
        const cancellationResults = {
          whatsappReminders: { cancelled: 0 },
          discordMeetReminders: { cancelled: 0 },
          callReminders: { cancelled: 0 },
          paymentReminders: { cancelled: 0 },
          scheduledWorkflows: { cancelled: 0 }
        };

        // Cancel WhatsApp reminders
        if (existingBooking.clientEmail || existingBooking.clientPhone) {
          const whatsappResult = await cancelWhatsAppRemindersForClient({
            clientEmail: existingBooking.clientEmail,
            phoneNumber: existingBooking.clientPhone,
            meetingStartISO: existingBooking.scheduledEventStartTime
          });

          if (whatsappResult.success && whatsappResult.cancelledCount > 0) {
            cancellationResults.whatsappReminders.cancelled = whatsappResult.cancelledCount;
            Logger.info('WhatsApp reminders cancelled for paid booking', {
              bookingId,
              clientEmail: existingBooking.clientEmail,
              cancelledCount: whatsappResult.cancelledCount
            });
          }
        }

        // Cancel Discord BDA meeting alert (3-min "I'm in" reminder)
        if (existingBooking.scheduledEventStartTime) {
          try {
            const discordResult = await cancelDiscordMeetRemindersForMeeting({
              meetingStartISO: existingBooking.scheduledEventStartTime,
              clientEmail: existingBooking.clientEmail,
              clientName: existingBooking.clientName || null,
            });
            if (discordResult.success && discordResult.cancelledCount > 0) {
              cancellationResults.discordMeetReminders.cancelled = discordResult.cancelledCount;
              Logger.info('Discord meet reminders cancelled for paid booking', {
                bookingId,
                clientEmail: existingBooking.clientEmail,
                cancelledCount: discordResult.cancelledCount
              });
            }
          } catch (discordError) {
            Logger.warn('Error cancelling Discord meet reminders for paid booking', {
              bookingId,
              error: discordError.message
            });
          }
        }

        // Cancel call reminders (if reminderCallJobId exists)
        if (existingBooking.reminderCallJobId && callQueue) {
          try {
            const callJob = await callQueue.getJob(existingBooking.reminderCallJobId);
            if (callJob) {
              await callJob.remove();
              cancellationResults.callReminders.cancelled = 1;
              Logger.info('Call reminder job cancelled for paid booking', {
                bookingId,
                jobId: existingBooking.reminderCallJobId
              });
            }
          } catch (callError) {
            Logger.warn('Could not cancel call reminder job (may not exist)', {
              bookingId,
              jobId: existingBooking.reminderCallJobId,
              error: callError.message
            });
          }
        }

        // Also try to cancel via CallScheduler if phone and meeting time are available
        if (existingBooking.clientPhone && existingBooking.scheduledEventStartTime) {
          try {
            const callCancelResult = await cancelCall({
              phoneNumber: existingBooking.clientPhone,
              meetingStartISO: existingBooking.scheduledEventStartTime
            });
            if (callCancelResult.success) {
              cancellationResults.callReminders.cancelled += 1;
            }
          } catch (callError) {
            Logger.warn('Error cancelling call via CallScheduler', {
              bookingId,
              error: callError.message
            });
          }
        }

        // Cancel payment reminders (email reminders)
        if (existingBooking.paymentReminders && existingBooking.paymentReminders.length > 0) {
          const scheduledPaymentReminders = existingBooking.paymentReminders.filter(
            pr => pr.status === 'scheduled'
          );

          if (scheduledPaymentReminders.length > 0) {
            for (const paymentReminder of scheduledPaymentReminders) {
              try {
                // Remove job from queue
                if (paymentReminder.jobId && callQueue) {
                  const paymentJob = await callQueue.getJob(paymentReminder.jobId);
                  if (paymentJob) {
                    await paymentJob.remove();
                  }
                }

                // Update status to cancelled in database
                await CampaignBookingModel.updateOne(
                  {
                    bookingId,
                    'paymentReminders.jobId': paymentReminder.jobId
                  },
                  {
                    $set: {
                      'paymentReminders.$.status': 'cancelled'
                    }
                  }
                );

                cancellationResults.paymentReminders.cancelled += 1;
              } catch (paymentError) {
                Logger.warn('Error cancelling payment reminder', {
                  bookingId,
                  jobId: paymentReminder.jobId,
                  error: paymentError.message
                });
              }
            }

            Logger.info('Payment reminders cancelled for paid booking', {
              bookingId,
              cancelledCount: cancellationResults.paymentReminders.cancelled
            });
          }
        }

        // Cancel scheduled workflows (email and WhatsApp workflows)
        if (existingBooking.scheduledWorkflows && existingBooking.scheduledWorkflows.length > 0) {
          const scheduledWorkflows = existingBooking.scheduledWorkflows.filter(
            sw => sw.status === 'scheduled'
          );

          if (scheduledWorkflows.length > 0) {
            // Update all scheduled workflows to cancelled status
            for (const workflow of scheduledWorkflows) {
              try {
                await CampaignBookingModel.updateOne(
                  {
                    bookingId,
                    'scheduledWorkflows._id': workflow._id
                  },
                  {
                    $set: {
                      'scheduledWorkflows.$.status': 'cancelled',
                      'scheduledWorkflows.$.error': 'Cancelled: Booking status changed to paid'
                    }
                  }
                );

                cancellationResults.scheduledWorkflows.cancelled += 1;
              } catch (workflowError) {
                Logger.warn('Error cancelling scheduled workflow', {
                  bookingId,
                  workflowId: workflow.workflowId,
                  error: workflowError.message
                });
              }
            }

            Logger.info('Scheduled workflows cancelled for paid booking', {
              bookingId,
              cancelledCount: cancellationResults.scheduledWorkflows.cancelled
            });
          }
        }

        console.log(`✅ Cancelled all reminders and workflows for paid booking ${bookingId}:`, cancellationResults);
      } catch (cancellationError) {
        // Log error but don't fail the status update
        Logger.error('Error cancelling reminders and workflows for paid booking', {
          bookingId,
          error: cancellationError.message,
          stack: cancellationError.stack
        });
        console.error('⚠️ Failed to cancel reminders and workflows for paid booking:', cancellationError);
      }
    }

    // Cancel scheduled workflows when status changes to certain statuses
    // This should happen BEFORE triggering new workflows
    // Cancel workflows when moving away from workflow-triggering statuses (like 'no-show') 
    // to other statuses, so old workflows don't execute for the wrong status
    const oldStatus = existingBooking.bookingStatus;
    const statusesThatCancelWorkflows = ['completed', 'paid', 'canceled', 'scheduled', 'rescheduled'];
    
    // Cancel workflows if:
    // 1. New status is in the cancellation list AND
    // 2. Status is actually changing AND
    // 3. Old status was a workflow-triggering status (has scheduled workflows that should be cancelled)
    if (statusesThatCancelWorkflows.includes(status) && oldStatus !== status) {
      try {
        const cancelResult = await cancelScheduledWorkflows(bookingId, status, oldStatus);
        
        if (cancelResult.success && cancelResult.cancelled > 0) {
          console.log(`✅ Cancelled ${cancelResult.cancelled} scheduled workflow(s) for booking ${bookingId} due to status change from ${oldStatus} to ${status}`);
          Logger.info('Cancelled scheduled workflows due to status change', {
            bookingId,
            oldStatus,
            newStatus: status,
            cancelledCount: cancelResult.cancelled,
            clientEmail: existingBooking.clientEmail
          });
        }
      } catch (cancelError) {
        console.error('Error cancelling scheduled workflows:', cancelError);
        Logger.error('Error cancelling scheduled workflows', {
          bookingId,
          oldStatus,
          newStatus: status,
          error: cancelError.message,
          stack: cancelError.stack
        });
        // Don't fail the status update if cancellation fails
      }
    }

    // Trigger workflows for specific status changes
    const workflowTriggerStatuses = ['completed', 'canceled', 'rescheduled', 'no-show', 'paid'];
    if (workflowTriggerStatuses.includes(status)) {
      try {
        Logger.info('Triggering workflows for status change', {
          bookingId,
          status,
          clientEmail: existingBooking.clientEmail,
          source: 'status_update'
        });
        
        const workflowResult = await triggerWorkflow(bookingId, status);
        if (workflowResult.success && workflowResult.triggered) {
          console.log(`✅ Workflows triggered for booking ${bookingId} with status ${status}`);
          Logger.info('Workflows triggered successfully', {
            bookingId,
            status,
            workflowsTriggered: workflowResult.workflowsTriggered?.length || 0,
            clientEmail: existingBooking.clientEmail
          });
        } else {
          Logger.info('No workflows triggered (none configured or inactive)', {
            bookingId,
            status,
            clientEmail: existingBooking.clientEmail
          });
        }
      } catch (workflowError) {
        console.error('Error triggering workflows:', workflowError);
        Logger.error('Error triggering workflows', {
          bookingId,
          status,
          error: workflowError.message,
          stack: workflowError.stack
        });
        // Don't fail the status update if workflow trigger fails
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Booking status updated successfully',
      data: booking,
      workflowTriggered: workflowTriggerStatuses.includes(status),
      remindersCancelled: status === 'paid'
    });

  } catch (error) {
    console.error('Error updating booking status:', error);
    Logger.error('Error updating booking status', {
      bookingId: req.params.bookingId,
      status: req.body.status,
      error: error.message,
      stack: error.stack
    });
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

export const bulkCreateLeads = async (req, res) => {
  try {
    const { leads } = req.body;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Leads array is required and must not be empty'
      });
    }

    const defaultMeetingTime = new Date('2025-01-01T10:00:00Z');
    const results = {
      successful: [],
      failed: [],
      skipped: []
    };

    for (const lead of leads) {
      try {
        const { name, email, mobile } = lead;

        if (!name || !email) {
          results.failed.push({
            lead,
            error: 'Name and email are required'
          });
          continue;
        }

        const normalizedEmail = email.trim().toLowerCase();
        
        const existingBooking = await CampaignBookingModel.findOne({
          clientEmail: normalizedEmail
        });

        if (existingBooking) {
          results.skipped.push({
            email: normalizedEmail,
            reason: 'Email already exists'
          });
          continue;
        }

        const newBooking = new CampaignBookingModel({
          clientName: name.trim(),
          clientEmail: normalizedEmail,
          clientPhone: mobile && mobile.trim() ? mobile.trim() : null,
          scheduledEventStartTime: defaultMeetingTime,
          scheduledEventEndTime: new Date(defaultMeetingTime.getTime() + 30 * 60000),
          utmSource: 'CSV_IMPORT',
          utmMedium: null,
          utmCampaign: null,
          campaignId: null,
          bookingStatus: 'scheduled',
          calendlyMeetLink: null,
          anythingToKnow: null,
          meetingNotes: null,
          bookingCreatedAt: new Date()
        });

        await newBooking.save();
        results.successful.push({
          email: normalizedEmail,
          bookingId: newBooking.bookingId
        });
      } catch (error) {
        results.failed.push({
          lead,
          error: error.message
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${leads.length} leads`,
      results: {
        total: leads.length,
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      },
      details: results
    });
  } catch (error) {
    console.error('❌ Error bulk creating leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to bulk create leads',
      error: error.message
    });
  }
};

/**
 * Normalize phone number for matching (extracts last 10 digits for US numbers)
 * This allows matching +12272188477 with 2272188477
 */
function normalizePhoneForMatching(phone) {
  if (!phone) return null;
  
  // Remove all non-digit characters except leading +
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  
  // Extract last 10 digits (US phone numbers)
  // Handle formats: +12272188477, 12272188477, 2272188477
  if (cleaned.startsWith('+1') && cleaned.length >= 12) {
    // Format: +1XXXXXXXXXX -> extract last 10 digits
    return cleaned.slice(-10);
  } else if (cleaned.startsWith('1') && cleaned.length >= 11 && /^\d+$/.test(cleaned)) {
    // Format: 1XXXXXXXXXX -> extract last 10 digits
    return cleaned.slice(-10);
  } else if (cleaned.length >= 10 && /^\d+$/.test(cleaned)) {
    // Format: XXXXXXXXXX -> use last 10 digits
    return cleaned.slice(-10);
  }
  
  // For other formats, return cleaned version
  return cleaned.replace(/\D/g, '').slice(-10);
}

export const getLeadsPaginated = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      utmSource,
      search,
      fromDate,
      toDate,
      planName,
      minAmount,
      maxAmount,
      status,
      qualification
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let matchQuery = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;

    const qual = qualification ? String(qualification).toLowerCase() : null;
    if (qual === 'mql' || qual === 'sql' || qual === 'converted') {
      matchQuery.bookingStatus = {
        $in: qual === 'mql' ? MQL_STATUSES : qual === 'sql' ? SQL_STATUSES : CONVERTED_STATUSES
      };
    } else if (status && status !== 'all') {
      matchQuery.bookingStatus = status;
    }

    if (utmSource && utmSource !== 'all') {
      matchQuery.utmSource = utmSource;
    }

    if (normalizedPlanName && normalizedPlanName !== 'ALL') {
      matchQuery['paymentPlan.name'] = normalizedPlanName;
    }

    if (minAmount || maxAmount) {
      matchQuery['paymentPlan.price'] = {};
      if (minAmount) {
        matchQuery['paymentPlan.price'].$gte = parseFloat(minAmount);
      }
      if (maxAmount) {
        matchQuery['paymentPlan.price'].$lte = parseFloat(maxAmount);
      }
    }

    if (fromDate || toDate) {
      matchQuery.scheduledEventStartTime = {};
      if (fromDate) {
        const from = new Date(fromDate);
        from.setHours(0, 0, 0, 0);
        matchQuery.scheduledEventStartTime.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        matchQuery.scheduledEventStartTime.$lte = to;
      }
    }

    if (search) {
      // Trim the search term
      const trimmedSearch = search.trim();
      if (trimmedSearch) {
        // Escape special regex characters to prevent regex errors
        // This allows literal search while preventing regex injection
        const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        matchQuery.$or = [
          { clientName: { $regex: escapedSearch, $options: 'i' } },
          { clientEmail: { $regex: escapedSearch, $options: 'i' } },
          { clientPhone: { $regex: escapedSearch, $options: 'i' } },
          { utmSource: { $regex: escapedSearch, $options: 'i' } }
        ];
      }
    }

    if (!matchQuery.scheduledEventStartTime) {
      matchQuery.scheduledEventStartTime = { $exists: true, $ne: null };
    }

    const pipeline = [
      { $match: matchQuery },
      {
        $addFields: {
          groupKey: {
            $ifNull: ['$clientPhone', '$clientEmail']
          }
        }
      },
      {
        $sort: {
          scheduledEventStartTime: -1,
          bookingCreatedAt: -1
        }
      },
      {
        $group: {
          _id: '$groupKey',
          booking: { $first: '$$ROOT' },
          totalBookings: { $sum: 1 }
        }
      },
      {
        $replaceRoot: {
          newRoot: {
            $mergeObjects: ['$booking', { totalBookings: '$totalBookings' }]
          }
        }
      },
      {
        $sort: {
          scheduledEventStartTime: -1,
          bookingCreatedAt: -1
        }
      }
    ];

    if (search) {
      const trimmedSearch = search.trim();
      if (trimmedSearch) {
        const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        pipeline.splice(1, 0, {
          $match: {
            $or: [
              { clientName: { $regex: escapedSearch, $options: 'i' } },
              { clientEmail: { $regex: escapedSearch, $options: 'i' } },
              { clientPhone: { $regex: escapedSearch, $options: 'i' } },
              { utmSource: { $regex: escapedSearch, $options: 'i' } }
            ]
          }
        });
      }
    }

    const countPipeline = [
      ...pipeline.slice(0, -1),
      { $count: 'total' }
    ];

    const [countResult] = await CampaignBookingModel.aggregate(countPipeline);
    const total = countResult?.total || 0;

    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limitNum });

    const bookings = await CampaignBookingModel.aggregate(pipeline);

    const groupedMap = new Map();
    for (const booking of bookings) {
      const normalizedPhone = normalizePhoneForMatching(booking.clientPhone);
      const groupKey = normalizedPhone || booking.clientEmail;
      
      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, booking);
      } else {
        const existing = groupedMap.get(groupKey);
        const existingTime = existing.scheduledEventStartTime ? new Date(existing.scheduledEventStartTime).getTime() : 0;
        const currentTime = booking.scheduledEventStartTime ? new Date(booking.scheduledEventStartTime).getTime() : 0;
        if (currentTime > existingTime || (currentTime === existingTime && new Date(booking.bookingCreatedAt).getTime() > new Date(existing.bookingCreatedAt).getTime())) {
          groupedMap.set(groupKey, booking);
        }
      }
    }

    const finalBookings = Array.from(groupedMap.values()).sort((a, b) => {
      const aTime = a.scheduledEventStartTime ? new Date(a.scheduledEventStartTime).getTime() : 0;
      const bTime = b.scheduledEventStartTime ? new Date(b.scheduledEventStartTime).getTime() : 0;
      if (bTime !== aTime) return bTime - aTime;
      return new Date(b.bookingCreatedAt).getTime() - new Date(a.bookingCreatedAt).getTime();
    }).map((b) => ({ ...b, qualification: getQualificationFromStatus(b.bookingStatus) }));

    const baseMatchQuery = { ...matchQuery };
    delete baseMatchQuery.bookingStatus;
    const qualStatsPipeline = [
      { $match: baseMatchQuery },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      { $group: { _id: '$groupKey', bookingStatus: { $first: '$bookingStatus' } } },
      {
        $addFields: {
          qualification: {
            $cond: [
              { $in: ['$bookingStatus', CONVERTED_STATUSES] },
              'Converted',
              { $cond: [{ $in: ['$bookingStatus', SQL_STATUSES] }, 'SQL', 'MQL'] }
            ]
          }
        }
      },
      { $group: { _id: '$qualification', count: { $sum: 1 } } }
    ];
    if (search) {
      const trimmedSearch = search.trim();
      if (trimmedSearch) {
        const escapedSearch = trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        qualStatsPipeline.splice(1, 0, {
          $match: {
            $or: [
              { clientName: { $regex: escapedSearch, $options: 'i' } },
              { clientEmail: { $regex: escapedSearch, $options: 'i' } },
              { clientPhone: { $regex: escapedSearch, $options: 'i' } },
              { utmSource: { $regex: escapedSearch, $options: 'i' } }
            ]
          }
        });
      }
    }
    const qualStatsResult = await CampaignBookingModel.aggregate(qualStatsPipeline);
    const mqlCount = qualStatsResult.find((r) => r._id === 'MQL')?.count ?? 0;
    const sqlCount = qualStatsResult.find((r) => r._id === 'SQL')?.count ?? 0;
    const convertedCount = qualStatsResult.find((r) => r._id === 'Converted')?.count ?? 0;

    const statsPipeline = [
      { $match: matchQuery },
      {
        $group: {
          _id: '$paymentPlan.name',
          count: {
            $sum: {
              $cond: [
                { $and: [{ $ne: ['$paymentPlan.name', null] }, { $eq: ['$bookingStatus', 'paid'] }] },
                1,
                0
              ]
            }
          },
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
      { $match: { _id: { $ne: null } } }
    ];

    const planBreakdown = await CampaignBookingModel.aggregate(statsPipeline);
    const totalRevenue = planBreakdown.reduce((sum, plan) => sum + (plan.revenue || 0), 0);

    return res.status(200).json({
      success: true,
      data: finalBookings,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      },
      stats: {
        totalRevenue: totalRevenue || 0,
        planBreakdown: planBreakdown,
        mqlCount,
        sqlCount,
        convertedCount
      }
    });

  } catch (error) {
    console.error('Error fetching paginated leads:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch leads',
      error: error.message
    });
  }
};

export const getLeadsIds = async (req, res) => {
  try {
    const {
      utmSource,
      search,
      fromDate,
      toDate,
      planName,
      minAmount,
      maxAmount,
      status,
      qualification,
      limit = '5000'
    } = req.query;

    const limitNum = Math.min(5000, Math.max(1, parseInt(String(limit), 10) || 5000));
    let matchQuery = {};
    const normalizedPlanName = planName ? String(planName).toUpperCase() : null;
    const qual = qualification ? String(qualification).toLowerCase() : null;
    if (qual === 'mql' || qual === 'sql' || qual === 'converted') {
      matchQuery.bookingStatus = {
        $in: qual === 'mql' ? MQL_STATUSES : qual === 'sql' ? SQL_STATUSES : CONVERTED_STATUSES
      };
    } else if (status && status !== 'all') {
      matchQuery.bookingStatus = status;
    }
    if (utmSource && utmSource !== 'all') matchQuery.utmSource = utmSource;
    if (normalizedPlanName && normalizedPlanName !== 'ALL') matchQuery['paymentPlan.name'] = normalizedPlanName;
    if (minAmount || maxAmount) {
      matchQuery['paymentPlan.price'] = {};
      if (minAmount) matchQuery['paymentPlan.price'].$gte = parseFloat(minAmount);
      if (maxAmount) matchQuery['paymentPlan.price'].$lte = parseFloat(maxAmount);
    }
    if (fromDate || toDate) {
      matchQuery.scheduledEventStartTime = {};
      if (fromDate) {
        const from = new Date(fromDate);
        from.setHours(0, 0, 0, 0);
        matchQuery.scheduledEventStartTime.$gte = from;
      }
      if (toDate) {
        const to = new Date(toDate);
        to.setHours(23, 59, 59, 999);
        matchQuery.scheduledEventStartTime.$lte = to;
      }
    }
    if (search && String(search).trim()) {
      const escapedSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchQuery.$or = [
        { clientName: { $regex: escapedSearch, $options: 'i' } },
        { clientEmail: { $regex: escapedSearch, $options: 'i' } },
        { clientPhone: { $regex: escapedSearch, $options: 'i' } },
        { utmSource: { $regex: escapedSearch, $options: 'i' } }
      ];
    }
    if (!matchQuery.scheduledEventStartTime) {
      matchQuery.scheduledEventStartTime = { $exists: true, $ne: null };
    }

    const idsPipeline = [
      { $match: matchQuery },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      { $group: { _id: '$groupKey', bookingId: { $first: '$bookingId' } } },
      { $project: { bookingId: 1, _id: 0 } },
      { $limit: limitNum }
    ];
    const results = await CampaignBookingModel.aggregate(idsPipeline);
    const bookingIds = results.map((r) => r.bookingId).filter(Boolean);

    return res.status(200).json({
      success: true,
      data: { bookingIds, total: bookingIds.length }
    });
  } catch (error) {
    console.error('Error fetching lead IDs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch lead IDs',
      error: error.message
    });
  }
};

export const updateBookingAmount = async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { amount, planName } = req.body;

    const booking = await CampaignBookingModel.findOne({ bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.bookingStatus !== 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Can only update amount for paid bookings'
      });
    }

    const normalizedPlanName = planName ? String(planName).toUpperCase() : booking.paymentPlan?.name;
    if (!normalizedPlanName || !PLAN_CATALOG[normalizedPlanName]) {
      return res.status(400).json({
        success: false,
        message: 'Invalid plan name'
      });
    }

    const catalogPlan = PLAN_CATALOG[normalizedPlanName];
    const newAmount = amount ? parseFloat(amount) : catalogPlan.price;

    const paymentPlanUpdate = {
      name: normalizedPlanName,
      price: newAmount,
      currency: catalogPlan.currency,
      displayPrice: `$${newAmount}`,
      selectedAt: booking.paymentPlan?.selectedAt || new Date()
    };

    const updatedBooking = await CampaignBookingModel.findOneAndUpdate(
      { bookingId },
      { $set: { paymentPlan: paymentPlanUpdate } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      data: updatedBooking
    });

  } catch (error) {
    console.error('Error updating booking amount:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update booking amount',
      error: error.message
    });
  }
};


export const handlePaidClientFromMicroservice = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      oldEmail,
      password,
      planType,
      dashboardManager,
      amountPaid,
      currency,
      amountPaidFormatted,
      mobile // Optional: mobile number without country code
    } = req.body;

    // Validate required fields
    if (!oldEmail) {
      return res.status(400).json({
        success: false,
        message: 'oldEmail is required to match leads'
      });
    }

    if (!planType) {
      return res.status(400).json({
        success: false,
        message: 'planType is required'
      });
    }

    // Normalize plan name to match PLAN_CATALOG enum
    const normalizedPlanName = String(planType).toUpperCase();
    if (!PLAN_CATALOG[normalizedPlanName]) {
      return res.status(400).json({
        success: false,
        message: `Invalid planType. Must be one of: ${Object.keys(PLAN_CATALOG).join(', ')}`
      });
    }
    const normalizedOldEmail = oldEmail.trim().toLowerCase();

    let matchQuery = {};

    // If mobile number is provided, match by either email OR mobile
    // This ensures we match leads even if email doesn't match exactly
    if (mobile) {
      const normalizedMobile = normalizePhoneForMatching(mobile);
      if (normalizedMobile) {
        // Use $or to match by either email or mobile
        matchQuery.$or = [
          { clientEmail: normalizedOldEmail },
          { clientPhone: { $regex: normalizedMobile, $options: 'i' } }
        ];
      } else {
        // If mobile normalization failed, fall back to email only
        matchQuery.clientEmail = normalizedOldEmail;
      }
    } else {
      // If no mobile provided, match by email only
      matchQuery.clientEmail = normalizedOldEmail;
    }

    // Find all matching bookings/leads
    const matchingLeads = await CampaignBookingModel.find(matchQuery);

    if (!matchingLeads || matchingLeads.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No leads found matching oldEmail: ${oldEmail}${mobile ? ` or mobile: ${mobile}` : ''}`,
        matchedCount: 0
      });
    }

    // Prepare payment plan update
    const catalogPlan = PLAN_CATALOG[normalizedPlanName];

    // Safely parse amountPaid (may be null/undefined/empty from external systems)
    const parsedAmountPaid = amountPaid !== undefined && amountPaid !== null && amountPaid !== ''
      ? parseFloat(amountPaid)
      : NaN;
    const hasValidNumericAmount = !Number.isNaN(parsedAmountPaid) && parsedAmountPaid > 0;

    const paymentAmount = hasValidNumericAmount ? parsedAmountPaid : catalogPlan.price;
    const paymentCurrency = currency || catalogPlan.currency;

    // Some external systems may send strings like "null", "$null", "undefined"
    // Treat those as invalid and fall back to our catalog/default formatting.
    const normalizedFormatted = typeof amountPaidFormatted === 'string'
      ? amountPaidFormatted.trim()
      : '';
    const lowerFormatted = normalizedFormatted.toLowerCase();
    const isInvalidFormatted =
      !normalizedFormatted ||
      lowerFormatted === 'null' ||
      lowerFormatted === 'undefined' ||
      lowerFormatted === '$null' ||
      lowerFormatted === '$undefined';

    const displayPrice = !isInvalidFormatted
      ? normalizedFormatted
      : (catalogPlan.displayPrice || `${paymentCurrency}${paymentAmount}`);

    const paymentPlanUpdate = {
      name: normalizedPlanName,
      price: paymentAmount,
      currency: paymentCurrency,
      displayPrice: displayPrice,
      selectedAt: new Date()
    };

    // Update all matching leads to mark as paid
    const updateResult = await CampaignBookingModel.updateMany(
      matchQuery,
      {
        $set: {
          bookingStatus: 'paid',
          paymentPlan: paymentPlanUpdate
        }
      }
    );

    // Log the update
    console.log(`✅ Marked ${updateResult.modifiedCount} lead(s) as paid`, {
      oldEmail: normalizedOldEmail,
      mobile: mobile || 'not provided',
      planType: normalizedPlanName,
      amountPaid: paymentAmount,
      currency: paymentCurrency
    });

    return res.status(200).json({
      success: true,
      message: `Successfully marked ${updateResult.modifiedCount} lead(s) as paid`,
      data: {
        matchedCount: matchingLeads.length,
        updatedCount: updateResult.modifiedCount,
        oldEmail: normalizedOldEmail,
        newEmail: email || null,
        planType: normalizedPlanName,
        amountPaid: paymentAmount,
        currency: paymentCurrency,
        displayPrice: displayPrice,
        updatedLeads: matchingLeads.map(lead => ({
          bookingId: lead.bookingId,
          clientName: lead.clientName,
          clientEmail: lead.clientEmail,
          clientPhone: lead.clientPhone
        }))
      }
    });

  } catch (error) {
    console.error('❌ Error handling paid client from microservice:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process paid client webhook',
      error: error.message
    });
  }
};

export const getMeetingNotes = async (req, res) => {
  try {
    const { bookingId } = req.params;
    // Fireflies integration has been disabled.
    // This endpoint now simply returns an informative response without calling external APIs.

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
        message: 'Booking not found'
      });
    }

    return res.status(200).json({
      success: false,
      message: 'Fireflies meeting-notes integration is currently disabled. Use manual notes instead.',
      hasTranscriptId: !!booking.firefliesTranscriptId
    });
  } catch (error) {
    console.error('Error fetching meeting notes:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meeting notes',
      error: error.message
    });
  }
};

export const getMeetingLinks = async (req, res) => {
  try {
    const { fromDate, toDate, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(String(page), 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const now = new Date();
    const twoHoursMs = 2 * 60 * 60 * 1000;

    const cutoff = new Date(now.getTime() - 15 * 60 * 1000);
    const minMeetingDate = new Date('2026-02-03T00:00:00.000Z');
    let gte = minMeetingDate;
    if (fromDate) {
      const from = new Date(String(fromDate));
      from.setHours(0, 0, 0, 0);
      if (from > minMeetingDate) gte = from;
    }
    const startTimeCond = { $exists: true, $ne: null, $gte: gte };
    if (toDate) {
      const to = new Date(String(toDate));
      to.setHours(23, 59, 59, 999);
      startTimeCond.$lte = to;
    }
    const startTimeCondWithCutoff = { ...startTimeCond, $lt: cutoff };
    const match = {
      bookingStatus: { $nin: ['canceled', 'rescheduled'] },
      $or: [
        {
          scheduledEventEndTime: { $exists: true, $ne: null, $lt: now },
          scheduledEventStartTime: startTimeCond
        },
        {
          $and: [
            { $or: [{ scheduledEventEndTime: null }, { scheduledEventEndTime: { $exists: false } }] },
            { scheduledEventStartTime: startTimeCondWithCutoff }
          ]
        }
      ]
    };

    const [bookings, totalCount, bdaAbsentResult] = await Promise.all([
      CampaignBookingModel.find(
        match,
        { clientName: 1, scheduledEventStartTime: 1, scheduledEventEndTime: 1, meetingVideoUrl: 1, bookingId: 1 }
      )
        .sort({ scheduledEventStartTime: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      CampaignBookingModel.countDocuments(match),
      CampaignBookingModel.aggregate([
        { $match: match },
        {
          $addFields: {
            meetEnd: {
              $cond: {
                if: { $and: [{ $ne: ['$scheduledEventEndTime', null] }, { $ne: ['$scheduledEventEndTime', undefined] }] },
                then: { $toLong: '$scheduledEventEndTime' },
                else: { $add: [{ $toLong: '$scheduledEventStartTime' }, 15 * 60 * 1000] }
              }
            }
          }
        },
        {
          $match: {
            $expr: {
              $and: [
                { $lte: ['$meetEnd', now.getTime() - twoHoursMs] },
                { $lte: [{ $strLenCP: { $trim: { input: { $ifNull: ['$meetingVideoUrl', ''] } } } }, 0] }
              ]
            }
          }
        },
        { $count: 'bdaAbsentCount' }
      ])
    ]);
    const bdaAbsentCount = bdaAbsentResult?.[0]?.bdaAbsentCount ?? 0;

    const data = bookings.map((b) => {
      const meetEnd = b.scheduledEventEndTime
        ? new Date(b.scheduledEventEndTime).getTime()
        : b.scheduledEventStartTime
          ? new Date(b.scheduledEventStartTime).getTime() + 15 * 60 * 1000
          : null;
      const hasVideo = !!(b.meetingVideoUrl && String(b.meetingVideoUrl).trim());
      const endedOver2hAgo = meetEnd !== null && now.getTime() - meetEnd >= twoHoursMs;
      const bdaAbsent = endedOver2hAgo && !hasVideo;

      return {
        bookingId: b.bookingId,
        clientName: b.clientName || '—',
        dateOfMeet: b.scheduledEventStartTime || null,
        meetingVideoUrl: hasVideo ? b.meetingVideoUrl : null,
        bdaAbsent
      };
    });

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      bdaAbsentCount
    });
  } catch (error) {
    console.error('Error fetching meeting info:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch meeting info',
      error: error.message
    });
  }
};



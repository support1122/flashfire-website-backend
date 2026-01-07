import { Logger } from '../Utils/Logger.js';
import { sendNoShowReminder } from '../Utils/WatiHelper.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnectForMeet } from '../Utils/DiscordConnect.js';
import { cancelCall, scheduleCall } from '../Utils/CallScheduler.js';
import { cancelWhatsAppReminder, scheduleAllWhatsAppReminders } from '../Utils/WhatsAppReminderScheduler.js';
import { DateTime } from 'luxon';

/**
 * Handle Calendly webhook events
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
export const handleCalendlyWebhook = async (req, res) => {
  try {
    const { event, created_at, payload } = req.body;

    Logger.info('Received Calendly webhook', { 
      event, 
      created_at,
      payload: payload ? {
        uri: payload.uri,
        name: payload.name,
        email: payload.email,
        status: payload.status
      } : null
    });

    // Handle invitee.rescheduled events
    if (event === 'invitee.rescheduled') {
      return await handleRescheduledEvent(req, res, payload);
    }

    if (event === 'invitee.canceled') {
      return await handleCanceledEvent(req, res, payload);
    }

    // Only handle invitee_no_show events
    if (event !== 'invitee_no_show') {
      Logger.info(`Ignoring Calendly event: ${event}`);
      return res.status(200).json({ 
        success: true, 
        message: `Event ${event} received but not processed` 
      });
    }

    // Extract booking information from webhook payload
    const { invitee, event: calendlyEvent, questions_and_answers } = payload;
    
    if (!invitee || !invitee.email) {
      Logger.error('Invalid webhook payload: missing invitee information');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing invitee information in webhook payload' 
      });
    }

    // Extract client information
    const clientEmail = invitee.email;
    const clientName = invitee.name || 'Valued Client';
    const clientPhone = invitee.phone_number || null;
    
    const rescheduleUrl = payload?.reschedule_url || invitee.reschedule_url || null;
    
    Logger.info('Extracted reschedule URL from no-show webhook', { 
      rescheduleUrl,
      clientEmail,
      hasRescheduleUrl: !!rescheduleUrl,
      topLevelRescheduleUrl: payload?.reschedule_url,
      nestedRescheduleUrl: invitee.reschedule_url,
      inviteeKeys: Object.keys(invitee), // Debug: log all available keys
      payloadKeys: Object.keys(payload || {})
    });
    
    // Get UTM parameters from questions and answers
    let utmSource = null;
    let utmMedium = null;
    
    if (questions_and_answers && Array.isArray(questions_and_answers)) {
      questions_and_answers.forEach(qa => {
        if (qa.question && qa.answer) {
          if (qa.question.toLowerCase().includes('utm_source') || qa.question.toLowerCase().includes('source')) {
            utmSource = qa.answer;
          }
          if (qa.question.toLowerCase().includes('utm_medium') || qa.question.toLowerCase().includes('medium')) {
            utmMedium = qa.answer;
          }
        }
      });
    }

    // Try to find the booking in our database
    let bookingRecord = null;
    try {
      bookingRecord = await CampaignBookingModel.findOne({
        clientEmail: clientEmail,
        $or: [
          { utmSource: utmSource },
          { calendlyMeetLink: { $exists: true, $ne: null } }
        ]
      }).sort({ bookingCreatedAt: -1 }).limit(1);

      if (!bookingRecord && utmSource) {
        bookingRecord = await CampaignBookingModel.findOne({
          utmSource: utmSource
        }).sort({ bookingCreatedAt: -1 }).limit(1);
      }
    } catch (dbError) {
      Logger.error('Database error while finding booking record', { 
        error: dbError.message,
        clientEmail,
        utmSource 
      });
    }

    // Prepare booking data for WhatsApp message
    const bookingData = {
      clientName,
      clientEmail,
      clientPhone: clientPhone || bookingRecord?.clientPhone,
      bookingCreatedAt: bookingRecord?.bookingCreatedAt || new Date(),
      calendlyMeetLink: bookingRecord?.calendlyMeetLink || calendlyEvent?.uri,
      rescheduleUrl: rescheduleUrl || bookingRecord?.calendlyRescheduleLink || null,
      utmSource: utmSource || bookingRecord?.utmSource,
      utmMedium: utmMedium || bookingRecord?.utmMedium,
      bookingId: bookingRecord?._id || null
    };

    Logger.info('Prepared booking data for WhatsApp', {
      clientName,
      clientEmail,
      hasRescheduleUrl: !!bookingData.rescheduleUrl,
      rescheduleUrl: bookingData.rescheduleUrl
    });

    // Send Discord notification
    try {
      await DiscordConnectForMeet(`🚨 No-Show Alert: ${clientName} (${clientEmail}) missed their meeting. UTM Source: ${bookingData.utmSource || 'Unknown'}`);
    } catch (discordError) {
      Logger.error('Failed to send Discord notification', { error: discordError.message });
    }

    // Send WhatsApp message if phone number is available
    let whatsappSent = false;
    if (bookingData.clientPhone) {
      const whatsappResult = await sendNoShowReminder(bookingData);
      
      if (whatsappResult.success) {
        whatsappSent = true;
        Logger.info('No-show reminder sent successfully via WhatsApp', { 
          clientName, 
          clientPhone: bookingData.clientPhone,
          bookingId: bookingData.bookingId 
        });
      } else {
        Logger.error('Failed to send no-show reminder via WhatsApp', { 
          error: whatsappResult.error,
          clientName, 
          clientPhone: bookingData.clientPhone 
        });
      }
    } else {
      Logger.warn('No phone number available for WhatsApp reminder', { 
        clientName, 
        clientEmail,
        bookingId: bookingData.bookingId 
      });
    }

    // Update booking record if found
    if (bookingRecord) {
      try {
        bookingRecord.bookingStatus = 'no-show';
        bookingRecord.noShowDate = new Date();
        bookingRecord.noShowProcessed = true;
        bookingRecord.whatsappReminderSent = whatsappSent;
        if (whatsappSent) {
          bookingRecord.whatsappSentAt = new Date();
        }
        // Update reschedule URL if we got it from webhook and it's not already saved
        if (rescheduleUrl && !bookingRecord.calendlyRescheduleLink) {
          bookingRecord.calendlyRescheduleLink = rescheduleUrl;
          Logger.info('Updated booking record with reschedule URL from webhook', {
            bookingId: bookingRecord._id,
            rescheduleUrl
          });
        }
        await bookingRecord.save();
        
        Logger.info('Updated booking record with no-show status', { 
          bookingId: bookingRecord._id,
          clientEmail,
          whatsappSent 
        });
      } catch (updateError) {
        Logger.error('Failed to update booking record', { 
          error: updateError.message,
          bookingId: bookingRecord._id 
        });
      }
    }

    res.status(200).json({ 
      success: true, 
      message: 'No-show event processed successfully',
      data: {
        clientName,
        clientEmail,
        whatsappSent: whatsappSent,
        phoneAvailable: !!bookingData.clientPhone,
        bookingUpdated: !!bookingRecord,
        utmSource: bookingData.utmSource,
        rescheduleUrl: bookingData.rescheduleUrl
      }
    });

  } catch (error) {
    Logger.error('Error processing Calendly webhook', { 
      error: error.message,
      stack: error.stack,
      body: req.body 
    });

    res.status(500).json({ 
      success: false, 
      error: 'Internal server error processing webhook' 
    });
  }
};

/**
 * Test webhook endpoint
 */
export const testWebhook = async (req, res) => {
  try {
    const { sendWhatsApp } = req.query;
    
    const testData = {
      clientName: 'Test User',
      clientEmail: 'test@example.com',
      clientPhone: sendWhatsApp === 'true' ? '+1234567890' : null,
      bookingCreatedAt: new Date(),
      calendlyMeetLink: 'https://calendly.com/test',
      rescheduleUrl: 'https://calendly.com/reschedulings/test-reschedule-url',
      utmSource: 'test_source',
      utmMedium: 'test_medium'
    };

    let whatsappResult = null;
    if (sendWhatsApp === 'true') {
      whatsappResult = await sendNoShowReminder(testData);
    }

    res.status(200).json({
      success: true,
      message: 'Webhook test completed',
      data: {
        testData,
        whatsappResult
      }
    });

  } catch (error) {
    Logger.error('Error in webhook test', { 
      error: error.message,
      stack: error.stack 
    });

    res.status(500).json({ 
      success: false, 
      error: 'Webhook test failed' 
    });
  }
};

async function handleRescheduledEvent(req, res, payload) {
  try {
    // ✅ FIXED: Correct destructuring for rescheduled event
    // According to Calendly docs, rescheduled events have:
    // - old_invitee (previous booking)
    // - new_invitee (new booking)
    const { old_invitee, new_invitee } = payload;

    // Use new_invitee for current booking info
    const invitee = new_invitee || old_invitee;
    
    if (!invitee || !invitee.email) {
      Logger.error('Invalid reschedule webhook payload: missing invitee information');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing invitee information in webhook payload' 
      });
    }

    const oldStartTime = old_invitee?.scheduled_event?.start_time;
    const newStartTime = new_invitee?.scheduled_event?.start_time;
    const newEndTime = new_invitee?.scheduled_event?.end_time;

    if (!oldStartTime || !newStartTime) {
      Logger.error('Invalid reschedule webhook payload: missing scheduled event times');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing old or new scheduled event times' 
      });
    }

    const clientEmail = invitee.email;
    const clientName = invitee.name || 'Valued Client';
    const clientPhone = invitee.phone_number || null;
    
    const rescheduleUrl = payload?.reschedule_url || null;
    
    const meetLink = new_invitee?.scheduled_event?.location?.join_url || 'Not Provided';

    Logger.info('Processing rescheduled meeting', {
      clientEmail,
      clientName,
      clientPhone,
      oldStartTime,
      newStartTime,
      hasRescheduleUrl: !!rescheduleUrl,
      topLevelRescheduleUrl: payload?.reschedule_url,
      nestedRescheduleUrl: new_invitee?.reschedule_url,
      rescheduleUrl, // Log the actual URL for debugging
      newInviteeKeys: new_invitee ? Object.keys(new_invitee) : [], // Debug
      scheduledEventKeys: new_invitee?.scheduled_event ? Object.keys(new_invitee.scheduled_event) : [], // Debug
      payloadKeys: Object.keys(payload || {})
    });

    let bookingRecord = null;
    try {
      bookingRecord = await CampaignBookingModel.findOne({
        clientEmail: clientEmail
      }).sort({ bookingCreatedAt: -1 }).limit(1);
    } catch (dbError) {
      Logger.error('Database error while finding booking record for reschedule', { 
        error: dbError.message,
        clientEmail
      });
    }

    let oldCallCancelled = false;
    let oldWhatsAppCancelled = false;

    if (clientPhone && oldStartTime) {
      // Cancel old call reminder
      try {
        const cancelCallResult = await cancelCall({
          phoneNumber: clientPhone,
          meetingStartISO: oldStartTime
        });
        if (cancelCallResult.success) {
          oldCallCancelled = true;
          Logger.info('Cancelled old call reminder', {
            callId: cancelCallResult.callId,
            clientPhone,
            oldStartTime
          });
        }
      } catch (callError) {
        Logger.error('Failed to cancel old call reminder', {
          error: callError.message,
          clientPhone,
          oldStartTime
        });
      }

      // Cancel old WhatsApp reminder
      try {
        const cancelWhatsAppResult = await cancelWhatsAppReminder({
          phoneNumber: clientPhone,
          meetingStartISO: oldStartTime
        });
        if (cancelWhatsAppResult.success) {
          oldWhatsAppCancelled = true;
          Logger.info('Cancelled old WhatsApp reminder', {
            reminderId: cancelWhatsAppResult.reminderId,
            clientPhone,
            oldStartTime
          });
        }
      } catch (whatsappError) {
        Logger.error('Failed to cancel old WhatsApp reminder', {
          error: whatsappError.message,
          clientPhone,
          oldStartTime
        });
      }
    }

    // Update booking record with reschedule information
    if (bookingRecord) {
      try {
        bookingRecord.bookingStatus = 'rescheduled';
        bookingRecord.rescheduledFrom = new Date(oldStartTime);
        bookingRecord.rescheduledTo = new Date(newStartTime);
        bookingRecord.rescheduledAt = new Date();
        bookingRecord.scheduledEventStartTime = new Date(newStartTime);
        if (newEndTime) {
          bookingRecord.scheduledEventEndTime = new Date(newEndTime);
        }
        if (rescheduleUrl) {
          bookingRecord.calendlyRescheduleLink = rescheduleUrl;
          Logger.info('Updated reschedule URL from webhook', {
            bookingId: bookingRecord._id,
            rescheduleUrl
          });
        }
        if (meetLink && meetLink !== 'Not Provided') {
          bookingRecord.calendlyMeetLink = meetLink;
        }
        bookingRecord.rescheduledCount = (bookingRecord.rescheduledCount || 0) + 1;
        
        await bookingRecord.save();
        
        Logger.info('Updated booking record with reschedule information', {
          bookingId: bookingRecord._id,
          clientEmail,
          oldStartTime,
          newStartTime,
          rescheduleUrlSaved: !!rescheduleUrl
        });
      } catch (updateError) {
        Logger.error('Failed to update booking record for reschedule', {
          error: updateError.message,
          bookingId: bookingRecord?._id
        });
      }
    }

    // Schedule new reminders with new meeting time
    let newCallScheduled = false;
    let newWhatsAppScheduled = false;

    if (clientPhone && newStartTime) {
      // Validate phone number format
      const phoneRegex = /^\+?[1-9]\d{9,14}$/;
      if (!phoneRegex.test(clientPhone)) {
        Logger.warn('Invalid phone number format, skipping reminder scheduling', {
          clientPhone
        });
      } else if (clientPhone.startsWith('+91')) {
        Logger.info('Skipping India number for rescheduled meeting', {
          clientPhone
        });
      } else {
        // Calculate new meeting time in different timezones
        const newMeetingStartUTC = DateTime.fromISO(newStartTime, { zone: 'utc' });
        const newMeetingTimeIndia = newMeetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');
        
        // Format meeting date and time for WhatsApp (America/New_York timezone)
        const newMeetingDate = newMeetingStartUTC.setZone('America/New_York').toFormat('EEEE MMM d, yyyy');
        const newMeetingEndUTC = newEndTime ? DateTime.fromISO(newEndTime, { zone: 'utc' }) : newMeetingStartUTC.plus({ minutes: 15 });
        
        const startTimeET = newMeetingStartUTC.setZone('America/New_York');
        const startTimeFormatted = startTimeET.minute === 0 
          ? startTimeET.toFormat('ha').toLowerCase()
          : startTimeET.toFormat('h:mma').toLowerCase();
        
        const endTimeET = newMeetingEndUTC.setZone('America/New_York');
        const endTimeFormatted = endTimeET.minute === 0
          ? endTimeET.toFormat('ha').toLowerCase()
          : endTimeET.toFormat('h:mma').toLowerCase();
        
        const newMeetingTimeFormatted = `${startTimeFormatted} – ${endTimeFormatted}`;

        //Use reschedule URL from webhook with proper fallback chain
        const finalRescheduleLink = rescheduleUrl || 
                                   bookingRecord?.calendlyRescheduleLink || 
                                   'https://calendly.com/flashfirejobs';

        Logger.info('Using reschedule link for reminders', {
          source: rescheduleUrl ? 'webhook' : (bookingRecord?.calendlyRescheduleLink ? 'database' : 'default'),
          link: finalRescheduleLink
        });

        try {
          const scheduleCallResult = await scheduleCall({
            phoneNumber: clientPhone,
            meetingStartISO: newStartTime,
            meetingTime: newMeetingTimeIndia,
            inviteeName: clientName,
            inviteeEmail: clientEmail,
            source: 'reschedule',
            meetingLink: meetLink !== 'Not Provided' ? meetLink : null,
            rescheduleLink: finalRescheduleLink,
            metadata: {
              bookingId: bookingRecord?.bookingId,
              rescheduledFrom: oldStartTime,
              rescheduledTo: newStartTime,
              meetingEndISO: newEndTime
            }
          });

          if (scheduleCallResult.success) {
            newCallScheduled = true;
            Logger.info('Scheduled new call reminder for rescheduled meeting', {
              callId: scheduleCallResult.callId,
              clientPhone,
              newStartTime
            });

            // Update booking record with new call job ID
            if (bookingRecord && scheduleCallResult.callId) {
              bookingRecord.reminderCallJobId = scheduleCallResult.callId;
              await bookingRecord.save();
            }
          }
        } catch (callScheduleError) {
          Logger.error('Failed to schedule new call reminder', {
            error: callScheduleError.message,
            clientPhone,
            newStartTime
          });
        }

        // Note: WhatsApp reminders are now scheduled automatically by scheduleCall
        // But we keep this as a backup in case scheduleCall fails or doesn't schedule WhatsApp reminders
        // The duplicate prevention logic will prevent double-scheduling
        try {
          const whatsappResults = await scheduleAllWhatsAppReminders({
            phoneNumber: clientPhone,
            meetingStartISO: newStartTime,
            meetingTime: newMeetingTimeFormatted,
            meetingDate: newMeetingDate,
            clientName: clientName,
            clientEmail: clientEmail,
            meetingLink: meetLink !== 'Not Provided' ? meetLink : null,
            rescheduleLink: finalRescheduleLink,
            source: 'reschedule',
            metadata: {
              bookingId: bookingRecord?.bookingId,
              rescheduledFrom: oldStartTime,
              rescheduledTo: newStartTime,
              meetingEndISO: newEndTime
            }
          });

          const scheduledCount = Object.values(whatsappResults).filter(r => r.success).length;
          if (scheduledCount > 0) {
            newWhatsAppScheduled = true;
            Logger.info('Scheduled new WhatsApp reminders for rescheduled meeting', {
              scheduledCount,
              skippedCount: Object.values(whatsappResults).filter(r => r.skipped).length,
              clientPhone,
              newStartTime
            });
          }
        } catch (whatsappScheduleError) {
          Logger.error('Failed to schedule new WhatsApp reminders', {
            error: whatsappScheduleError.message,
            clientPhone,
            newStartTime
          });
        }
      }
    }
    try {
      const fullPayload = JSON.stringify(req.body, null, 2);
      const truncatedPayload = fullPayload.length > 1000 
        ? fullPayload.substring(0, 1000) + '\n... (truncated)' 
        : fullPayload;
        
      await DiscordConnectForMeet(
        `🔄 Meeting Rescheduled: ${clientName} (${clientEmail})\n` +
        `📅 Old Time: ${DateTime.fromISO(oldStartTime).toFormat('ff')}\n` +
        `📅 New Time: ${DateTime.fromISO(newStartTime).toFormat('ff')}\n` +
        `🔗 Reschedule URL: ${rescheduleUrl || 'NOT PROVIDED BY CALENDLY'}\n` +
        `❌ Old Reminders: Call ${oldCallCancelled ? '✓' : '✗'}, WhatsApp ${oldWhatsAppCancelled ? '✓' : '✗'}\n` +
        `✅ New Reminders: Call ${newCallScheduled ? '✓' : '✗'}, WhatsApp ${newWhatsAppScheduled ? '✓' : '✗'}\n\n` +
        `🔍 Webhook Payload (truncated if large):\n\`\`\`json\n${truncatedPayload}\n\`\`\``
      );
      
      // Log the full payload to server logs
      Logger.info('Full webhook payload for reschedule:', { 
        payload: req.body,
        clientEmail,
        eventId: req.body.event_id,
        rescheduleUrlFound: !!rescheduleUrl
      });
    } catch (discordError) {
      Logger.error('Failed to send Discord notification for reschedule', {
        error: discordError.message,
        clientEmail,
        eventId: req.body.event_id
      });
    }

    res.status(200).json({
      success: true,
      message: 'Rescheduled event processed successfully',
      data: {
        clientName,
        clientEmail,
        oldStartTime,
        newStartTime,
        oldCallCancelled,
        oldWhatsAppCancelled,
        newCallScheduled,
        newWhatsAppScheduled,
        rescheduleUrl // Include in response for debugging
      }
    });

  } catch (error) {
    Logger.error('Error processing rescheduled event', {
      error: error.message,
      stack: error.stack,
      payload
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error processing rescheduled event'
    });
  }
}


async function handleCanceledEvent(req, res, payload) {
  try {
    const clientEmail = payload?.email || payload?.invitee?.email || null;
    const clientName = payload?.name || payload?.invitee?.name || 'Valued Client';
    
    const clientPhone = payload?.questions_and_answers?.find(q =>
      q.question?.trim().toLowerCase() === 'phone number'
    )?.answer?.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '') || 
    payload?.invitee?.phone_number || 
    payload?.invitee?.questions_and_answers?.find(q =>
      q.question?.trim().toLowerCase() === 'phone number'
    )?.answer?.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '') || null;
    
    const canceledBy = payload?.cancellation?.canceled_by || payload?.canceled_by || 'unknown';
    const cancelReason = payload?.cancellation?.reason || payload?.cancel_reason || 'No reason provided';
    const meetingStartTime = payload?.scheduled_event?.start_time || payload?.event?.start_time || null;

    if (!clientEmail) {
      Logger.error('Invalid cancel webhook payload: missing email information');
      return res.status(400).json({ 
        success: false, 
        error: 'Missing email information in webhook payload' 
      });
    }

    Logger.info('Processing canceled meeting', {
      clientEmail,
      clientName,
      clientPhone,
      canceledBy,
      cancelReason,
      meetingStartTime
    });

    // Find the booking record
    let bookingRecord = null;
    try {
      bookingRecord = await CampaignBookingModel.findOne({
        clientEmail: clientEmail
      }).sort({ bookingCreatedAt: -1 }).limit(1);
    } catch (dbError) {
      Logger.error('Database error while finding booking record for cancellation', { 
        error: dbError.message,
        clientEmail
      });
    }

    // Get meeting start time from booking record if not in payload
    const meetingStartISO = meetingStartTime || bookingRecord?.scheduledEventStartTime || bookingRecord?.bookingCreatedAt;

    // Cancel scheduled reminders
    let callCancelled = false;
    let whatsappCancelled = false;

    if (clientPhone && meetingStartISO) {
      // Cancel call reminder
      try {
        const cancelCallResult = await cancelCall({
          phoneNumber: clientPhone,
          meetingStartISO: meetingStartISO
        });
        if (cancelCallResult.success) {
          callCancelled = true;
          Logger.info('Cancelled call reminder', {
            callId: cancelCallResult.callId,
            clientPhone,
            meetingStartISO
          });
        }
      } catch (callError) {
        Logger.error('Failed to cancel call reminder', {
          error: callError.message,
          clientPhone,
          meetingStartISO
        });
      }

      // Cancel WhatsApp reminder
      try {
        const cancelWhatsAppResult = await cancelWhatsAppReminder({
          phoneNumber: clientPhone,
          meetingStartISO: meetingStartISO
        });
        if (cancelWhatsAppResult.success) {
          whatsappCancelled = true;
          Logger.info('Cancelled WhatsApp reminder', {
            reminderId: cancelWhatsAppResult.reminderId,
            clientPhone,
            meetingStartISO
          });
        }
      } catch (whatsappError) {
        Logger.error('Failed to cancel WhatsApp reminder', {
          error: whatsappError.message,
          clientPhone,
          meetingStartISO
        });
      }
    }

    // Update booking record status to canceled
    if (bookingRecord) {
      try {
        bookingRecord.bookingStatus = 'canceled';
        bookingRecord.canceledAt = new Date();
        bookingRecord.canceledBy = canceledBy;
        bookingRecord.cancelReason = cancelReason;
        await bookingRecord.save();
        
        Logger.info('Updated booking record status to canceled', {
          bookingId: bookingRecord._id,
          clientEmail
        });
      } catch (updateError) {
        Logger.error('Failed to update booking record for cancellation', {
          error: updateError.message,
          bookingId: bookingRecord?._id
        });
      }
    }

    // Format meeting time for Discord
    let meetingTimeFormatted = 'Not Available';
    if (meetingStartISO) {
      try {
        const meetingTime = DateTime.fromISO(meetingStartISO, { zone: 'utc' });
        meetingTimeFormatted = meetingTime.toFormat('ff');
      } catch (timeError) {
        Logger.warn('Failed to format meeting time', { error: timeError.message });
      }
    }

    try {
      const discordMessage = {
        "Event": "Meeting Cancelled",
        "Invitee Name": clientName,
        "Invitee Email": clientEmail,
        "Invitee Phone": clientPhone || 'Not Provided',
        "Meeting Time": meetingTimeFormatted,
        "Cancelled By": canceledBy,
        "Cancellation Reason": cancelReason,
        "Reminders Cancelled": {
          "Call Reminder": callCancelled ? "✅ Cancelled" : "❌ Not Found",
          "WhatsApp Reminder": whatsappCancelled ? "✅ Cancelled" : "❌ Not Found"
        },
        "Booking Status": bookingRecord ? "✅ Updated to 'canceled'" : "⚠️ Booking not found"
      };

      await DiscordConnectForMeet(JSON.stringify(discordMessage, null, 2));
      
      Logger.info('Sent Discord notification for canceled meeting', {
        clientEmail,
        callCancelled,
        whatsappCancelled
      });
    } catch (discordError) {
      Logger.error('Failed to send Discord notification for cancellation', {
        error: discordError.message
      });
    }

    res.status(200).json({
      success: true,
      message: 'Canceled event processed successfully',
      data: {
        clientName,
        clientEmail,
        callCancelled,
        whatsappCancelled,
        bookingUpdated: !!bookingRecord,
        canceledBy,
        cancelReason
      }
    });

  } catch (error) {
    Logger.error('Error processing canceled event', {
      error: error.message,
      stack: error.stack,
      payload
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error processing canceled event'
    });
  }
}
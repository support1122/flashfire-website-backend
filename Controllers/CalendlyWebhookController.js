import { Logger } from '../Utils/Logger.js';
import { sendNoShowReminder } from '../Utils/WatiHelper.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';
import { UserModel } from '../Schema_Models/User.js';
import { DiscordConnect, DiscordConnectForMeet } from '../Utils/DiscordConnect.js';
import { cancelCall, scheduleCall } from '../Utils/CallScheduler.js';
import { cancelWhatsAppReminder, scheduleAllWhatsAppReminders } from '../Utils/WhatsAppReminderScheduler.js';
import { cancelDiscordMeetRemindersForMeeting, scheduleDiscordMeetReminder } from '../Utils/DiscordMeetReminderScheduler.js';
import { getRescheduleLinkForBooking } from '../Utils/CalendlyAPIHelper.js';
import { DateTime } from 'luxon';
import crypto from 'crypto';

// In-memory cache for Discord duplication check
const discordMessageCache = new Map();

/**
 * Check if a Discord message is a duplicate based on booking details
 * @param {Object} details 
 * @returns {boolean}
 */
function isDuplicateDiscord(details) {
  try {
    const uniqueString = `${details["Invitee Email"]}-${details["Meeting Time (Team India)"]}-${details["Booked At"]}`;
    const hash = crypto.createHash('md5').update(uniqueString).digest('hex');

    if (discordMessageCache.has(hash)) {
      const timestamp = discordMessageCache.get(hash);
      if (Date.now() - timestamp < 10 * 60 * 1000) { // 10 minutes cache
        return true;
      }
    }

    discordMessageCache.set(hash, Date.now());

    // Cleanup cache occasionally
    if (discordMessageCache.size > 1000) {
      for (const [key, time] of discordMessageCache.entries()) {
        if (Date.now() - time > 10 * 60 * 1000) {
          discordMessageCache.delete(key);
        }
      }
    }

    return false;
  } catch (err) {
    console.error('Error in isDuplicateDiscord:', err);
    return false;
  }
}

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

    if (event === 'invitee.created') {
      return await handleCreatedEvent(req, res, payload);
    }

    // Handle invitee.rescheduled events
    if (event === 'invitee.rescheduled') {
      return await handleRescheduledEvent(req, res, payload);
    }

    if (event === 'invitee.canceled') {
      return await handleCanceledEvent(req, res, payload);
    }

    // Only handle invitee_no_show events
    if (event === 'invitee_no_show') {
      return await handleNoShowEvent(req, res, payload);
    }

    Logger.info(`Ignoring Calendly event: ${event}`);
    return res.status(200).json({
      success: true,
      message: `Event ${event} received but not processed`
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
 * Handle invitee.created events
 */
async function handleCreatedEvent(req, res, payload) {
  Logger.info('Calendly payload received (invitee.created)');

  const inviteeName = payload?.invitee?.name || payload?.name;
  const inviteeEmail = payload?.invitee?.email || payload?.email;
  let inviteePhone = payload?.questions_and_answers?.find(q =>
    q.question.trim().toLowerCase() === 'phone number'
  )?.answer || null;

  if (inviteePhone) {
    inviteePhone = inviteePhone.replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
  }

  const meetingStart = new Date(payload?.scheduled_event?.start_time);

  if (isNaN(meetingStart.getTime())) {
    Logger.error('Invalid meeting start time received from Calendly', {
      startTime: payload?.scheduled_event?.start_time,
      inviteeEmail
    });
    return res.status(400).json({
      error: 'Invalid meeting start time',
      message: 'Could not parse meeting start time from Calendly webhook'
    });
  }

  const delay = meetingStart.getTime() - Date.now() - (10 * 60 * 1000);

  const callExecutionTime = new Date(Date.now() + delay);
  const meetingTimeFormatted = meetingStart.toISOString();
  const callTimeFormatted = callExecutionTime.toISOString();

  Logger.info('📅 Meeting scheduled - calculating call delay', {
    inviteeName,
    inviteeEmail,
    meetingStart: meetingTimeFormatted,
    currentTime: new Date().toISOString(),
    delayMs: delay,
    delayMinutes: Math.round(delay / 60000),
    callWillExecuteAt: callTimeFormatted,
    callWillExecuteInMinutes: Math.round(delay / 60000)
  });

  if (delay < 0) {
    const minutesUntilMeeting = Math.round(-delay / 60000);
    Logger.warn('⚠️ Meeting is too soon to schedule calls - skipping reminder', {
      inviteeName,
      inviteeEmail,
      meetingStart: meetingTimeFormatted,
      delayMs: delay,
      meetingInMinutes: minutesUntilMeeting
    });
    // Use optional chaining for environment variable in case it's not set
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `⚠️ Meeting too soon for reminder call: ${inviteeName || 'Unknown'} (${inviteeEmail || 'Unknown'}). Meeting in ${minutesUntilMeeting} minutes.`
      ).catch((err) => Logger.error('Discord notification failed', { error: err.message }));
    }
  }

  const meetingStartUTC = DateTime.fromISO(payload?.scheduled_event?.start_time, { zone: 'utc' });

  // Determine invitee timezone (from Calendly webhook) if available
  const inviteeTimezone = payload?.invitee?.timezone || payload?.timezone || null;

  // Use the invitee's timezone for the client-facing time (PST/ET/etc).
  // Fallback to America/Los_Angeles (PST/PDT) if Calendly doesn't send a timezone.
  const clientZone = inviteeTimezone || 'America/Los_Angeles';

  const meetingTimeUS = meetingStartUTC.setZone(clientZone).toFormat('ff');
  const meetingTimeIndia = meetingStartUTC.setZone('Asia/Kolkata').toFormat('ff');
  const meetLink = payload?.scheduled_event?.location?.join_url || 'Not Provided';
  const bookedAt = new Date(payload?.created_at || new Date()).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  // Extract and log reschedule link
  let rescheduleLink = payload?.reschedule_url || null;

  Logger.info('Reschedule link from invitee.created webhook', {
    rescheduleLink,
    hasRescheduleLink: !!rescheduleLink,
    topLevelRescheduleUrl: payload?.reschedule_url,
    inviteeUri: payload?.invitee?.uri
  });

  // If reschedule link is not in webhook, try fetching from Calendly API
  // Note: Only if payload.invitee.uri is present
  if (!rescheduleLink && payload?.invitee?.uri) {
    try {
      const { fetchRescheduleLinkFromCalendly } = await import('../Utils/CalendlyAPIHelper.js');
      const fetchedLink = await fetchRescheduleLinkFromCalendly(payload.invitee.uri);
      if (fetchedLink) {
        rescheduleLink = fetchedLink;
        console.log('✅ [Calendly Webhook] Fetched reschedule link from Calendly API:', rescheduleLink);
      }
    } catch (error) {
      console.warn('⚠️ [Calendly Webhook] Could not fetch reschedule link from API:', error.message);
    }
  }

  // Extract UTM parameters
  const utmSource = payload?.tracking?.utm_source || 'direct';
  const utmMedium = payload?.tracking?.utm_medium || null;
  const utmCampaign = payload?.tracking?.utm_campaign || null;
  const utmContent = payload?.tracking?.utm_content || null;
  const utmTerm = payload?.tracking?.utm_term || null;

  const anythingToKnow = payload?.questions_and_answers?.find(q =>
    q.question.toLowerCase().includes('anything') ||
    q.question.toLowerCase().includes('prepare')
  )?.answer || null;

  const scheduledStartISO = payload?.scheduled_event?.start_time;

  // DUPLICATE CHECK
  const duplicateQuery = {
    scheduledEventStartTime: scheduledStartISO,
    $or: [
      { clientEmail: inviteeEmail },
      inviteePhone ? { clientPhone: inviteePhone } : null,
      meetLink && meetLink !== 'Not Provided' ? { calendlyMeetLink: meetLink } : null,
    ].filter(Boolean)
  };
  const existingBooking = await CampaignBookingModel.findOne(duplicateQuery);

  if (existingBooking) {
    Logger.warn('🔄 Duplicate booking detected - already exists in database', {
      email: inviteeEmail,
      phone: inviteePhone,
      meetLink,
      existingBookingId: existingBooking.bookingId,
      existingTime: existingBooking.scheduledEventStartTime
    });
    return res.status(200).json({
      message: 'Duplicate booking detected and suppressed',
      duplicate: true,
      existingBookingId: existingBooking.bookingId
    });
  }

  // Find campaign by UTM source
  let campaignId = null;
  let campaign = await CampaignModel.findOne({ utmSource });

  if (campaign) {
    campaignId = campaign.campaignId;
    Logger.info('✅ Campaign found for booking', { campaignId, utmSource });
  } else {
    // Only warn if tracking is expected
    if (utmSource !== 'direct' && utmSource !== 'webpage_visit') {
      Logger.warn('⚠️ No campaign found for UTM source - Creating virtual campaign', { utmSource });

      try {
        const virtualCampaign = new CampaignModel({
          campaignName: utmSource,
          utmSource: utmSource,
          utmMedium: utmMedium || 'direct',
          utmCampaign: utmCampaign || 'calendly_direct',
          generatedUrl: `https://calendly.com/feedback-flashfire/30min?utm_source=${utmSource}&utm_medium=${utmMedium || 'direct'}`,
          baseUrl: 'https://calendly.com/feedback-flashfire/30min',
          isActive: true
        });

        await virtualCampaign.save();
        campaignId = virtualCampaign.campaignId;

        Logger.info('✅ Virtual campaign created', {
          campaignId,
          utmSource,
          campaignName: virtualCampaign.campaignName
        });
      } catch (error) {
        Logger.error('❌ Failed to create virtual campaign', { error: error.message, utmSource });
      }
    }
  }

  // Create booking object
  const newBooking = new CampaignBookingModel({
    campaignId,
    utmSource: utmSource || 'direct',
    utmMedium,
    utmCampaign,
    utmContent,
    utmTerm,
    clientName: inviteeName,
    clientEmail: inviteeEmail,
    clientPhone: inviteePhone,
    calendlyEventUri: payload?.scheduled_event?.uri,
    calendlyInviteeUri: payload?.invitee?.uri,
    calendlyMeetLink: meetLink,
    calendlyRescheduleLink: rescheduleLink, // ✅ Save reschedule link
    scheduledEventStartTime: payload?.scheduled_event?.start_time,
    scheduledEventEndTime: payload?.scheduled_event?.end_time,
    inviteeTimezone: inviteeTimezone, // ✅ Save invitee timezone from webhook
    anythingToKnow,
    questionsAndAnswers: payload?.questions_and_answers,
    visitorId: null,
    userAgent: req.headers['user-agent'],
    ipAddress: req.ip || req.connection.remoteAddress,
    bookingStatus: 'scheduled'
  });

  await newBooking.save();

  // Mark user as booked
  try {
    const escapedEmail = inviteeEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await UserModel.updateOne(
      { email: { $regex: new RegExp(`^${escapedEmail}$`, 'i') } },
      { $set: { booked: true } }
    );
    Logger.info('✅ User marked as booked:', { email: inviteeEmail });
  } catch (userUpdateError) {
    Logger.warn('⚠️ Failed to update user booked status:', {
      email: inviteeEmail,
      error: userUpdateError.message
    });
  }

  Logger.info('✅ Booking saved', {
    bookingId: newBooking.bookingId,
    campaignId: newBooking.campaignId,
    utmSource: newBooking.utmSource,
    clientName: newBooking.clientName,
    clientEmail: newBooking.clientEmail,
    clientPhone: newBooking.clientPhone,
    calendlyMeetLink: newBooking.calendlyMeetLink,
    googleMeetUrl: newBooking.googleMeetUrl || null,
    rescheduleLink: newBooking.calendlyRescheduleLink
  });

  // Send Facebook Conversion API event (non-blocking)
  try {
    const { sendScheduleEvent } = await import('../Services/FacebookConversionAPI.js');
    sendScheduleEvent({
      email: inviteeEmail,
      phone: inviteePhone,
      fullName: inviteeName,
      clientIp: req.ip || req.connection.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
      utmSource: utmSource || null,
      utmMedium: utmMedium || null,
      utmCampaign: utmCampaign || null,
      utmContent: utmContent || null,
      utmTerm: utmTerm || null,
      eventId: newBooking.bookingId, // Use bookingId for deduplication
      eventSourceUrl: 'https://www.flashfirejobs.com/meeting-booked',
    }).catch((error) => {
      // Log but don't fail the webhook if Conversion API fails
      Logger.warn('⚠️ Facebook Conversion API call failed (non-critical):', error.message);
    });
  } catch (importError) {
    Logger.warn('⚠️ Failed to import Facebook Conversion API service:', importError.message);
  }

  // Prepare booking details for Discord
  const bookingDetails = {
    "Booking ID": newBooking.bookingId,
    "Campaign ID": newBooking.campaignId || 'N/A',
    "Invitee Name": inviteeName,
    "Invitee Email": inviteeEmail,
    "Invitee Phone": inviteePhone || 'Not Provided',
    "Google Meet Link": meetLink,
    "Real Google Meet Link": newBooking.googleMeetUrl || meetLink,
    "Reschedule Link": rescheduleLink || 'Not Provided',
    "Meeting Time (Client US)": meetingTimeUS,
    "Meeting Time (Team India)": meetingTimeIndia,
    "Booked At": bookedAt,
    "UTM Source": utmSource,
    "UTM Medium": utmMedium || 'N/A',
    "UTM Campaign": utmCampaign || 'N/A',
    "Database Status": "✅ SAVED"
  };

  if (payload?.tracking?.utm_source !== 'webpage_visit' && payload?.tracking?.utm_source !== null && payload?.tracking?.utm_source !== 'direct') {
    try {
      const utmData = {
        clientName: inviteeName,
        clientEmail: inviteeEmail,
        clientPhone: inviteePhone || 'Not Provided',
        utmSource: payload?.tracking?.utm_source,
      };
      // Note: Assuming global fetch is available (Node 18+)
      await fetch('https://clients-tracking-backend.onrender.com/api/track/utm-campaign-lead', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(utmData)
      });
      console.log('✅ UTM campaign lead tracked to external service:', utmData);
    } catch (utmError) {
      Logger.error('Failed to track UTM lead', { error: utmError.message });
    }
  }

  Logger.info('New Calendly booking', bookingDetails);

  if (!isDuplicateDiscord(bookingDetails)) {
    DiscordConnectForMeet(JSON.stringify(bookingDetails, null, 2)).catch((err) =>
      Logger.error('Discord notification failed', { error: err.message })
    );
  } else {
    Logger.warn('Duplicate Discord message suppressed (fingerprint match)', {
      inviteeEmail,
      inviteePhone,
      scheduledStartISO
    });
  }

  // Schedule Discord "meeting in 2 minutes" reminder (independent of phone/WhatsApp logic)
  try {
    const startISO = payload?.scheduled_event?.start_time;
    if (startISO) {
      await scheduleDiscordMeetReminder({
        bookingId: newBooking.bookingId,
        clientName: inviteeName || 'Valued Client',
        clientEmail: inviteeEmail || null,
        meetingStartISO: startISO,
        meetingLink: meetLink && meetLink !== 'Not Provided' ? meetLink : null,
        inviteeTimezone,
        source: 'calendly',
        metadata: {
          campaignId: newBooking.campaignId,
          utmSource: newBooking.utmSource,
        },
      });
    } else {
      Logger.warn('No scheduled_event.start_time found in Calendly payload for Discord reminder');
    }
  } catch (discordReminderError) {
    Logger.warn('Failed to schedule Discord 2-minute meeting reminder', {
      error: discordReminderError.message,
      inviteeEmail,
    });
  }

  // Validate phone numbers
  const phoneRegex = /^\+?[1-9]\d{9,14}$/;
  let scheduledJobs = [];

  if (inviteePhone && inviteePhone.startsWith("+91")) {
    Logger.info('Skipping India number', { phone: inviteePhone });
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, `Skipping India number: ${inviteePhone}`).catch((err) =>
        Logger.error('Discord notification failed', { error: err.message })
      );
    }
    return res.status(200).json({ message: 'Skipped India number' });
  }

  // Schedule call if delay is positive
  if (inviteePhone && phoneRegex.test(inviteePhone) && delay > 0) {
    const meetingLink = meetLink && meetLink !== 'Not Provided' ? meetLink : null;
    let rescheduleLinkForReminder = newBooking?.calendlyRescheduleLink || rescheduleLink;

    if (!rescheduleLinkForReminder && newBooking?.calendlyInviteeUri) {
      try {
        const fetchedLink = await getRescheduleLinkForBooking(newBooking);
        if (fetchedLink) {
          rescheduleLinkForReminder = fetchedLink;
          console.log('✅ [Calendly Webhook] Fetched reschedule link for reminder from API:', rescheduleLinkForReminder);
        }
      } catch (error) {
        console.warn('⚠️ [Calendly Webhook] Could not fetch reschedule link for reminder:', error.message);
      }
    }

    // Fallback to default
    if (!rescheduleLinkForReminder) {
      rescheduleLinkForReminder = 'https://calendly.com/flashfirejobs';
      Logger.warn('Using default reschedule link - Calendly did not provide one', {
        bookingId: newBooking.bookingId
      });
    }

    const meetingEndTime = payload?.scheduled_event?.end_time || null;

    const mongoResult = await scheduleCall({
      phoneNumber: inviteePhone,
      meetingStartISO: payload?.scheduled_event?.start_time,
      meetingTime: meetingTimeIndia,
      inviteeName,
      inviteeEmail,
      source: 'calendly',
      meetingLink: meetingLink,
      rescheduleLink: rescheduleLinkForReminder,
      metadata: {
        bookingId: newBooking?.bookingId,
        eventUri: payload?.scheduled_event?.uri,
        inviteeTimezone: inviteeTimezone,
        meetingEndISO: meetingEndTime
      }
    });

    if (mongoResult.success) {
      console.log('✅ [MongoDB Scheduler] Call scheduled successfully:', mongoResult.callId);
      scheduledJobs.push(`Client: ${inviteePhone} (MongoDB)`);

      // Update booking with call ID
      if (newBooking?.bookingId) {
        await CampaignBookingModel.findOneAndUpdate(
          { bookingId: newBooking.bookingId },
          { reminderCallJobId: mongoResult.callId }
        );
      }
    } else {
      console.warn('⚠️ [MongoDB Scheduler] Failed to schedule:', mongoResult.error);
    }

    // Log success message to Discord
    const scheduledMessage = `📞 **Reminder Call Scheduled!**\n• MongoDB Call ID: ${mongoResult.callId}\n• Client: ${inviteeName} (${inviteePhone})\n• Meeting: ${meetingTimeIndia} (IST)\n• Reschedule Link: ${rescheduleLinkForReminder}\n• Reminder: 10 minutes before meeting`;
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, scheduledMessage).catch((err) =>
        Logger.error('Discord notification failed', { error: err.message })
      );
    }

    // Schedule WhatsApp reminders
    try {
      // WhatsApps are often scheduled via scheduleCall integration or another mechanism in this codebase.
      // We leave it to the system's call scheduler to handle WhatsApp or assume it's covered.
    } catch (err) {
      // ...
    }

    const discordWebhookUrl = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
    if (discordWebhookUrl) {
      DiscordConnect(discordWebhookUrl, `✅ Scheduled calls: ${scheduledJobs.join(', ')}`).catch((err) =>
        Logger.error('Discord notification failed', { error: err.message })
      );
    } else {
      Logger.warn('Discord webhook URL not configured');
    }

    return res.status(200).json({
      message: 'Webhook received & calls scheduled',
      bookingDetails,
      scheduledCalls: scheduledJobs,
      rescheduleLink: rescheduleLink || 'Not provided by Calendly'
    });
  } else if (delay <= 0) {
    Logger.warn('Skipping call scheduling - meeting too soon or invalid phone', {
      phone: inviteePhone,
      delayMs: delay,
      hasValidPhone: inviteePhone && phoneRegex.test(inviteePhone)
    });
    return res.status(200).json({ message: 'Meeting too soon or invalid phone, booking saved but no call scheduled.' });
  } else {
    Logger.warn('No valid phone number provided by invitee', { phone: inviteePhone });
    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
        `⚠ No valid phone for client: ${inviteeName} (${inviteeEmail}) — Got: ${inviteePhone}`
      ).catch((err) => Logger.error('Discord notification failed', { error: err.message }));
    }
    return res.status(200).json({ message: 'No valid phone, booking saved.' });
  }
}

/**
 * Handle invitee_no_show events
 */
async function handleNoShowEvent(req, res, payload) {
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
    nestedRescheduleUrl: invitee.reschedule_url
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
  // FIX: Use better lookup if possible
  let bookingRecord = null;
  try {
    const query = { clientEmail: clientEmail };
    if (calendlyEvent && calendlyEvent.uri) {
      // Ideally match by Event URI if stored
      // But we check by StartTime logic mostly.
      // Here we keep existing logic but prefer StartTime match if available
    }

    // Default to existing logic for now for no-shows, but be careful
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
}

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
      rescheduleUrl
    });

    // Correct Booking Lookup
    let bookingRecord = null;
    try {
      const query = { clientEmail: clientEmail };

      // Try to find exact match by old start time first
      // Because we want to find the meeting that WAS at oldStartTime
      query.scheduledEventStartTime = oldStartTime;

      bookingRecord = await CampaignBookingModel.findOne(query);

      if (!bookingRecord) {
        Logger.warn('Could not find booking with exact start time, falling back to latest booking', { clientEmail, oldStartTime });
        bookingRecord = await CampaignBookingModel.findOne({ clientEmail: clientEmail })
          .sort({ bookingCreatedAt: -1 }).limit(1);
      }
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

    // Cancel old Discord BDA meeting alert (3-min "I'm in" reminder) for the old time
    // ✅ Same identifier as call reminder: meeting time + clientEmail; fallback by clientName
    let oldDiscordMeetCancelled = false;
    try {
      const cancelDiscordResult = await cancelDiscordMeetRemindersForMeeting({
        meetingStartISO: oldStartTime,
        clientEmail,
        clientName,
      });
      if (cancelDiscordResult.success && cancelDiscordResult.cancelledCount > 0) {
        oldDiscordMeetCancelled = true;
        Logger.info('Cancelled old Discord meet reminder', {
          clientEmail,
          oldStartTime,
          cancelledCount: cancelDiscordResult.cancelledCount
        });
      }
    } catch (discordError) {
      Logger.error('Failed to cancel old Discord meet reminder', {
        error: discordError.message,
        clientEmail,
        oldStartTime
      });
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
          newStartTime
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
          }
        } catch (whatsappScheduleError) {
          // ...
        }
      }
    }

    // Schedule Discord "meeting in 2 minutes" reminder for NEW time
    // ✅ This ensures the new meeting gets a reminder
    try {
      if (newStartTime) {
        await scheduleDiscordMeetReminder({
          bookingId: bookingRecord?.bookingId,
          clientName: clientName || 'Valued Client',
          clientEmail: clientEmail || null,
          meetingStartISO: newStartTime,
          meetingLink: meetLink && meetLink !== 'Not Provided' ? meetLink : null,
          source: 'reschedule',
          metadata: {
            campaignId: bookingRecord?.campaignId,
            utmSource: bookingRecord?.utmSource,
            rescheduledFrom: oldStartTime
          },
        });
        Logger.info('Scheduled new Discord meet reminder for rescheduled meeting');
      }
    } catch (discordReminderError) {
      Logger.warn('Failed to schedule new Discord 2-minute meeting reminder', {
        error: discordReminderError.message,
      });
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
        `❌ Old Reminders: Call ${oldCallCancelled ? '✓' : '✗'}, WhatsApp ${oldWhatsAppCancelled ? '✓' : '✗'}, BDA Meeting Reminder ${oldDiscordMeetCancelled ? '✓' : '✗'}\n` +
        `✅ New Reminders: Call ${newCallScheduled ? '✓' : '✗'}, WhatsApp ${newWhatsAppScheduled ? '✓' : '✗'}, BDA Meeting Reminder ✓\n\n` +
        `🔍 Webhook Payload (truncated if large):\n\`\`\`json\n${truncatedPayload}\n\`\`\``
      );
    } catch (discordError) {
      // ...
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
        oldDiscordMeetCancelled
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
    // Attempt to get unique URI 
    const calendlyEventUri = payload?.scheduled_event?.uri || null;

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

    // Find the booking record CORRECTLY
    let bookingRecord = null;
    try {
      const query = { clientEmail: clientEmail };

      if (calendlyEventUri) {
        query.calendlyEventUri = calendlyEventUri;
      } else if (meetingStartTime) {
        query.scheduledEventStartTime = meetingStartTime;
      }

      // If we have specific criteria, use it
      if (query.calendlyEventUri || query.scheduledEventStartTime) {
        bookingRecord = await CampaignBookingModel.findOne(query);
      }

      // Fallback ONLY if we couldn't find exact match
      if (!bookingRecord) {
        Logger.warn('Could not find booking with exact event URI or start time, falling back to latest booking (risky)', { clientEmail });
        bookingRecord = await CampaignBookingModel.findOne({
          clientEmail: clientEmail
        }).sort({ bookingCreatedAt: -1 }).limit(1);
      }

    } catch (dbError) {
      Logger.error('Database error while finding booking record for cancellation', {
        error: dbError.message,
        clientEmail
      });
    }

    // Get meeting start time from booking record if not in payload
    // use payload's start time as primary source of truth for cancellation
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

    // Cancel Discord BDA meeting alert (3-min "I'm in" reminder) for this meeting
    // ✅ Same identifier as call reminder; fallback by clientName if no match by email
    let discordMeetCancelled = false;
    try {
      const cancelDiscordResult = await cancelDiscordMeetRemindersForMeeting({
        meetingStartISO,
        clientEmail,
        clientName,
      });
      if (cancelDiscordResult.success && cancelDiscordResult.cancelledCount > 0) {
        discordMeetCancelled = true;
        Logger.info('Cancelled Discord meet reminder for canceled meeting', {
          clientEmail,
          meetingStartISO,
          cancelledCount: cancelDiscordResult.cancelledCount
        });
      }
    } catch (discordError) {
      Logger.error('Failed to cancel Discord meet reminder for canceled meeting', {
        error: discordError.message,
        clientEmail,
        meetingStartISO
      });
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

    // Notify Discord
    const discordMsg = `🗑️ **Meeting Cancelled - Reminders Cancelled**\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 **Name:** ${clientName}\n` +
      `📧 **Email:** ${clientEmail}\n` +
      `📞 **Phone:** ${clientPhone || 'Not Provided'}\n` +
      `📅 **Meeting Time:** ${meetingTimeFormatted}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✅ **Call Reminder:** ${callCancelled ? 'Cancelled' : 'Not Found'}\n` +
      `✅ **WhatsApp Reminder:** ${whatsappCancelled ? 'Cancelled' : 'Not Found'}\n` +
      `✅ **BDA Meeting Reminder:** ${discordMeetCancelled ? 'Cancelled' : 'Not Found'}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    if (process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL) {
      DiscordConnect(process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL, discordMsg).catch((err) =>
        Logger.error('Discord notification failed', { error: err.message })
      );
    }

    res.status(200).json({
      success: true,
      message: 'Canceled event processed successfully',
      data: {
        clientName,
        clientEmail,
        callCancelled,
        whatsappCancelled,
        discordMeetCancelled
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

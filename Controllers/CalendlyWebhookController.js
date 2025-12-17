import { Logger } from '../Utils/Logger.js';
import { sendNoShowReminder } from '../Utils/WatiHelper.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnectForMeet } from '../Utils/DiscordConnect.js';

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
        // Try to find by UTM source only
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
      utmSource: utmSource || bookingRecord?.utmSource,
      utmMedium: utmMedium || bookingRecord?.utmMedium,
      bookingId: bookingRecord?._id || null
    };

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
        utmSource: bookingData.utmSource
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
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
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

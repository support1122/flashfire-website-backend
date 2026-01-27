import crypto from 'crypto';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { Logger } from '../Utils/Logger.js';

const FIREFLIES_API_KEY = process.env.FIREFLIES_API_KEY;
const WEBHOOK_SECRET = process.env.FIREFLIES_WEBHOOK_SECRET;

function verifyWebhook(req, rawBody) {
  if (!WEBHOOK_SECRET) {
    Logger.warn('Fireflies webhook secret not configured, skipping signature verification');
    return true;
  }

  const signature = req.headers['x-hub-signature'];
  if (!signature) {
    Logger.warn('Fireflies webhook missing signature header');
    return false;
  }

  const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
  hmac.update(rawBody, 'utf8');
  const computed = `sha256=${hmac.digest('hex')}`;

  return signature === computed;
}

async function getTranscriptDetails(meetingId) {
  if (!FIREFLIES_API_KEY) {
    throw new Error('Fireflies API key not configured');
  }

  const query = `
    query Transcript($transcriptId: String!) {
      transcript(id: $transcriptId) {
        id
        title
        date
        duration
        organizer_email
        participants
        transcript_url
        audio_url
        video_url
        sentences {
          speaker_name
          text
          start_time
          end_time
        }
        summary {
          overview
          action_items
          keywords
        }
      }
    }
  `;

  const variables = { transcriptId: meetingId };

  const axios = (await import('axios')).default;
  const response = await axios.post(
    'https://api.fireflies.ai/graphql',
    {
      query,
      variables
    },
    {
      headers: {
        Authorization: `Bearer ${FIREFLIES_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  if (response.data.errors) {
    throw new Error(response.data.errors[0]?.message || 'Failed to fetch transcript');
  }

  return response.data.data.transcript;
}

async function findMatchingBooking(transcriptData) {
  const { organizer_email, participants, date } = transcriptData;

  const allEmails = [organizer_email, ...(participants || [])].filter(Boolean).map(email => email.toLowerCase());

  if (allEmails.length === 0) {
    return null;
  }

  const meetingDate = date ? new Date(date) : null;
  const searchWindowStart = meetingDate ? new Date(meetingDate.getTime() - 24 * 60 * 60 * 1000) : null;
  const searchWindowEnd = meetingDate ? new Date(meetingDate.getTime() + 24 * 60 * 60 * 1000) : null;

  const query = {
    clientEmail: { $in: allEmails }
  };

  if (searchWindowStart && searchWindowEnd) {
    query.scheduledEventStartTime = {
      $gte: searchWindowStart,
      $lte: searchWindowEnd
    };
  }

  const booking = await CampaignBookingModel.findOne(query)
    .sort({ scheduledEventStartTime: -1 })
    .limit(1);

  return booking;
}

export const handleFirefliesWebhook = async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body);
    
    if (!verifyWebhook(req, rawBody)) {
      Logger.warn('Fireflies webhook signature verification failed');
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid signature' 
      });
    }

    const { meetingId, eventType, clientReferenceId } = req.body;

    Logger.info('Fireflies webhook received', { 
      meetingId, 
      eventType, 
      clientReferenceId 
    });

    if (eventType !== 'Transcription completed') {
      Logger.info(`Ignoring Fireflies event: ${eventType}`);
      return res.status(200).json({ 
        success: true, 
        message: `Event ${eventType} received but not processed` 
      });
    }

    if (!meetingId) {
      Logger.error('Fireflies webhook missing meetingId');
      return res.status(400).json({ 
        success: false, 
        message: 'Missing meetingId in webhook payload' 
      });
    }

    const transcriptData = await getTranscriptDetails(meetingId);
    
    if (!transcriptData) {
      Logger.error('Failed to fetch transcript details', { meetingId });
      return res.status(404).json({ 
        success: false, 
        message: 'Transcript not found' 
      });
    }

    let booking = await findMatchingBooking(transcriptData);

    if (!booking && clientReferenceId) {
      booking = await CampaignBookingModel.findOne({ bookingId: clientReferenceId });
    }

    if (!booking) {
      Logger.warn('No matching booking found for Fireflies transcript', {
        meetingId,
        organizer_email: transcriptData.organizer_email,
        participants: transcriptData.participants,
        clientReferenceId
      });
      return res.status(200).json({ 
        success: true, 
        message: 'Transcript received but no matching booking found',
        meetingId 
      });
    }

    booking.firefliesTranscriptId = meetingId;
    
    if (transcriptData.summary?.overview) {
      const existingNotes = booking.meetingNotes || '';
      const newNotes = transcriptData.summary.overview;
      if (!existingNotes.includes(newNotes)) {
        booking.meetingNotes = existingNotes 
          ? `${existingNotes}\n\n${newNotes}` 
          : newNotes;
      }
    }

    await booking.save();

    Logger.info('Fireflies transcript linked to booking', {
      bookingId: booking.bookingId,
      meetingId,
      clientEmail: booking.clientEmail
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Transcript processed and linked to booking',
      bookingId: booking.bookingId,
      meetingId 
    });

  } catch (error) {
    Logger.error('Error handling Fireflies webhook', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to process webhook',
      error: error.message 
    });
  }
};

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { Logger } from '../Utils/Logger.js';

function parseMeetTimeFromName(name) {
  const dateTimeMatch = name.match(/\((\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!dateTimeMatch) return null;
  const [, y, m, d, h, min] = dateTimeMatch;
  const utcOffsetMatch = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  let offsetHours = 0;
  if (utcOffsetMatch) {
    const sign = utcOffsetMatch[1] === '+' ? 1 : -1;
    const oh = parseInt(utcOffsetMatch[2], 10) || 0;
    const om = parseInt(utcOffsetMatch[3], 10) || 0;
    offsetHours = sign * (oh + om / 60);
  }
  const localDate = new Date(Date.UTC(
    parseInt(y, 10),
    parseInt(m, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(min, 10),
    0,
    0
  ));
  const utcTime = new Date(localDate.getTime() - offsetHours * 60 * 60 * 1000);
  return utcTime;
}

export const handleGoogleMeetMetadataWebhook = async (req, res) => {
  try {
    const { name, link } = req.body || {};

    if (!name || typeof name !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'name is required and must be a string'
      });
    }

    if (!link || typeof link !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'link is required and must be a string'
      });
    }

    const codeMatch = name.match(/^([a-zA-Z0-9-]+)/);
    if (!codeMatch) {
      return res.status(400).json({
        success: false,
        message: 'Could not extract Google Meet code from name'
      });
    }

    const meetCode = codeMatch[1].toLowerCase();
    const meetUrl = `https://meet.google.com/${meetCode}`;

    const meetTime = parseMeetTimeFromName(name);
    const baseMatch = {
      $or: [
        { googleMeetCode: meetCode },
        { calendlyMeetLink: { $regex: meetCode, $options: 'i' } }
      ]
    };
    const query = meetTime
      ? {
          $and: [
            baseMatch,
            {
              scheduledEventStartTime: {
                $gte: new Date(meetTime.getTime() - 2 * 60 * 60 * 1000),
                $lte: new Date(meetTime.getTime() + 2 * 60 * 60 * 1000)
              }
            }
          ]
        }
      : baseMatch;

    let booking = await CampaignBookingModel.findOne(query)
      .sort({ scheduledEventStartTime: -1, bookingCreatedAt: -1 });

    if (!booking && meetTime) {
      const windowStart = new Date(meetTime.getTime() - 2 * 60 * 60 * 1000);
      const windowEnd = new Date(meetTime.getTime() + 2 * 60 * 60 * 1000);
      const byTime = await CampaignBookingModel.find({
        scheduledEventStartTime: { $gte: windowStart, $lte: windowEnd }
      })
        .sort({ scheduledEventStartTime: 1 })
        .lean();
      if (byTime.length > 0) {
        const closest = byTime.reduce((best, b) => {
          const bestDiff = Math.abs(new Date(best.scheduledEventStartTime).getTime() - meetTime.getTime());
          const currDiff = Math.abs(new Date(b.scheduledEventStartTime).getTime() - meetTime.getTime());
          return currDiff < bestDiff ? b : best;
        });
        booking = await CampaignBookingModel.findOne({ bookingId: closest.bookingId });
        if (booking) {
          Logger.info('Google Meet metadata webhook: matched by time only (no meet code match)', {
            meetTime: meetTime.toISOString(),
            bookingId: booking.bookingId,
            clientEmail: booking.clientEmail
          });
        }
      }
    }

    if (!booking) {
      Logger.warn('Google Meet metadata webhook: no matching booking found', {
        meetCode,
        meetUrl,
        meetTime: meetTime ? meetTime.toISOString() : null,
        link
      });
      return res.status(404).json({
        success: false,
        message: 'No matching booking found for this meeting code or time'
      });
    }

    booking.googleMeetCode = meetCode;
    booking.googleMeetUrl = meetUrl;
    booking.meetingVideoUrl = link;

    await booking.save();

    Logger.info('Google Meet metadata webhook processed', {
      bookingId: booking.bookingId,
      meetCode,
      meetUrl,
      meetingVideoUrl: link
    });

    return res.status(200).json({
      success: true,
      data: {
        bookingId: booking.bookingId,
        googleMeetUrl: meetUrl,
        meetingVideoUrl: link
      }
    });
  } catch (error) {
    Logger.error('Error handling Google Meet metadata webhook', {
      error: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      success: false,
      message: 'Failed to process Google Meet metadata',
      error: error.message
    });
  }
};


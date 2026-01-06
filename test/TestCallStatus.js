import { scheduleCall } from '../Utils/CallScheduler.js';
import { scheduleWhatsAppReminder } from '../Utils/WhatsAppReminderScheduler.js';
import { DateTime } from 'luxon';

export default async function TestCallStatus(req, res) {
  try {
    const phoneNumber = '+919866855857';
    
    const now = new Date();
    const callTimeMinutes = 10;
    const meetingTimeMinutes = callTimeMinutes + 10;
    const meetingStartISO = new Date(now.getTime() + meetingTimeMinutes * 60 * 1000);
    
    const meetingStartET = DateTime.fromJSDate(meetingStartISO, { zone: 'utc' })
      .setZone('America/New_York');
    
    const meetingDateFormatted = meetingStartET.toFormat('EEEE MMM d, yyyy');
    const meetingTimeFormatted = meetingStartET.minute === 0
      ? meetingStartET.toFormat('ha').toLowerCase()
      : meetingStartET.toFormat('h:mma').toLowerCase();
    
    const meetingTime = `${meetingDateFormatted} @ ${meetingTimeFormatted}`;
    
    const callResult = await scheduleCall({
      phoneNumber: phoneNumber,
      meetingStartISO: meetingStartISO.toISOString(),
      meetingTime: meetingTime,
      inviteeName: 'Test User',
      inviteeEmail: 'test@example.com',
      source: 'debug',
      metadata: {
        testCall: true,
        testPhone: phoneNumber
      },
      meetingLink: null,
      rescheduleLink: null
    });
    
    if (!callResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Failed to schedule call',
        error: callResult.error
      });
    }
    
    const whatsappTime = new Date(meetingStartISO.getTime() - 5 * 60 * 1000);
    const whatsappTimeET = DateTime.fromJSDate(whatsappTime, { zone: 'utc' })
      .setZone('America/New_York');
    
    const whatsappDateFormatted = whatsappTimeET.toFormat('EEEE MMM d, yyyy');
    const startTimeFormatted = whatsappTimeET.minute === 0
      ? whatsappTimeET.toFormat('ha').toLowerCase()
      : whatsappTimeET.toFormat('h:mma').toLowerCase();
    
    const endTimeET = whatsappTimeET.plus({ minutes: 15 });
    const endTimeFormatted = endTimeET.minute === 0
      ? endTimeET.toFormat('ha').toLowerCase()
      : endTimeET.toFormat('h:mma').toLowerCase();
    
    const whatsappMeetingTime = `${startTimeFormatted} – ${endTimeFormatted}`;
    
    const whatsappResult = await scheduleWhatsAppReminder({
      phoneNumber: phoneNumber,
      meetingStartISO: meetingStartISO.toISOString(),
      meetingTime: whatsappMeetingTime,
      meetingDate: whatsappDateFormatted,
      clientName: 'Test User',
      clientEmail: 'test@example.com',
      meetingLink: null,
      rescheduleLink: null,
      source: 'debug',
      metadata: {
        testCall: true,
        testPhone: phoneNumber
      }
    });
    
    return res.status(200).json({
      success: true,
      message: 'Test call scheduled successfully',
      call: {
        callId: callResult.callId,
        scheduledFor: callResult.scheduledFor,
        phoneNumber: phoneNumber,
        meetingTime: meetingTime
      },
      whatsapp: whatsappResult.success ? {
        reminderId: whatsappResult.reminderId,
        scheduledFor: whatsappResult.scheduledFor
      } : {
        success: false,
        error: whatsappResult.error
      }
    });
    
  } catch (error) {
    console.error('Error in test call status:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to schedule test call',
      error: error.message
    });
  }
}


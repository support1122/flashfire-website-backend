import fetch from 'node-fetch';
import { Logger } from './Logger.js';

const WATI_API_BASE_URL = 'https://app-server.wati.io';
const WATI_ACCESS_TOKEN = process.env.WATI_ACCESS_TOKEN;

// Log the configuration for debugging
console.log('WATI Configuration:', {
  baseUrl: WATI_API_BASE_URL,
  hasToken: !!WATI_ACCESS_TOKEN,
  tokenLength: WATI_ACCESS_TOKEN ? WATI_ACCESS_TOKEN.length : 0
});

export const sendWhatsAppMessage = async (phoneNumber, message) => {
  try {
    if (!WATI_ACCESS_TOKEN) {
      throw new Error('WATI_ACCESS_TOKEN is not configured in environment variables');
    }

    if (!message || message.trim() === '') {
      throw new Error('Message content cannot be empty');
    }

    let formattedPhoneNumber = String(phoneNumber).replace(/[^\d]/g, ''); // Remove non-digit characters

    if (formattedPhoneNumber.length === 12 && formattedPhoneNumber.startsWith('91')) {
      formattedPhoneNumber = `+${formattedPhoneNumber}`;
    } else if (formattedPhoneNumber.length === 10) {
      formattedPhoneNumber = `+91${formattedPhoneNumber}`;
    } else {
      if (!formattedPhoneNumber.startsWith('+')) {
         formattedPhoneNumber = `+${formattedPhoneNumber}`;
      }
    }

    // Note: The WATI endpoint for session messages does not include the '+' in the URL path
    const endpoint = `${WATI_API_BASE_URL}/api/v1/sendSessionMessage/${formattedPhoneNumber.substring(1)}`;
    
    Logger.info(`Sending WhatsApp message to ${formattedPhoneNumber}`, { 
      endpoint: endpoint,
      originalPhoneNumber: phoneNumber,
      formattedPhoneNumber: formattedPhoneNumber
    });

    // --- START OF FIX ---
    const cleanMessage = message.trim();
    
    // Validate message is not empty
    if (!cleanMessage || cleanMessage.length === 0) {
      throw new Error('Message content cannot be empty');
    }
    
    const payload = {
      whatsappNumber: formattedPhoneNumber,
      messageText: cleanMessage,
      messageType: "text"
    };
    
    Logger.info(`Payload being sent to WATI:`, { 
      payload,
      messageLength: cleanMessage.length,
      messagePreview: cleanMessage.substring(0, 100) + '...'
    });
    // --- END OF FIX ---

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();

    Logger.info(`WATI API Response for ${formattedPhoneNumber}`, { 
      status: response.status,
      responseData,
      success: response.ok 
    });

    if (!response.ok || responseData.result === false) {
      throw new Error(`WATI API Error: ${responseData?.info || responseData?.message || 'Failed to send message'}`);
    }

    Logger.info(`WhatsApp message sent successfully to ${formattedPhoneNumber}`, { responseData });
    
    return {
      success: true,
      data: responseData,
      phoneNumber: formattedPhoneNumber
    };

  } catch (error) {
    Logger.error('Error sending WhatsApp message via WATI', { 
      error: error.message, 
      phoneNumber,
      stack: error.stack 
    });
    
    return {
      success: false,
      error: error.message,
      phoneNumber
    };
  }
};


export const sendNoShowReminder = async (bookingData) => {
  try {
    const { clientName, clientPhone, bookingCreatedAt, calendlyMeetLink, rescheduleUrl } = bookingData;
    
    // Format the booking date
    const bookingDate = new Date(bookingCreatedAt).toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    // Use reschedule URL from webhook if available, otherwise fallback to default
    const rescheduleLink = rescheduleUrl || 'https://www.flashfirejobs.com/';

    const message = `Hi ${clientName}! 👋

You missed our scheduled meeting that was booked on ${bookingDate}. 

No worries! We understand things come up. Click here to reschedule at your convenience: ${rescheduleLink}

We're excited to connect with you and discuss how we can help with your career goals! 🚀

Best regards,
FlashFire Team`;

    Logger.info('Sending no-show reminder with reschedule URL', {
      clientName,
      clientPhone,
      hasRescheduleUrl: !!rescheduleUrl,
      rescheduleLink
    });

    return await sendWhatsAppMessage(clientPhone, message);

  } catch (error) {
    Logger.error('Error sending no-show reminder', { 
      error: error.message, 
      bookingData,
      stack: error.stack 
    });
    
    return {
      success: false,
      error: error.message,
      bookingData
    };
  }
};


export const testWatiConnection = async () => {
  try {
    if (!WATI_ACCESS_TOKEN) {
      return {
        success: false,
        error: 'WATI_ACCESS_TOKEN is not configured'
      };
    }

    // Test with a simple API call (you might need to adjust this based on WATI API documentation)
    const response = await fetch(`${WATI_API_BASE_URL}/api/v1/getInstanceInfo`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${WATI_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();

    return {
      success: response.ok,
      data: data,
      status: response.status
    };

  } catch (error) {
    Logger.error('Error testing WATI connection', { 
      error: error.message,
      stack: error.stack 
    });
    
    return {
      success: false,
      error: error.message
    };
  }
};

import { Logger } from '../Utils/Logger.js';
import { sendWhatsAppMessage } from '../Utils/WatiHelper.js';

// Message type configurations
const MESSAGE_TYPES = [
  {
    id: 'no-show',
    name: 'No Show Reminder',
    template: `Hi {clientName}! 👋

You missed our scheduled meeting that was booked on {bookingDate}.

No worries! We understand things come up. Click here to reschedule at your convenience: {bookingLink}

We're excited to connect with you and discuss how we can help with your career goals! 🚀

Best regards,
FlashFire Team`,
    fields: [
      {
        name: 'bookingLink',
        type: 'url',
        label: 'New Booking Link',
        placeholder: 'https://calendly.com/your-link',
        required: true
      }
    ]
  },
  {
    id: 'payment-reminder',
    name: 'Payment Reminder',
    template: `Hello {clientName},

I hope this message finds you well. I wanted to reach out regarding the payment information we discussed during our consultation.

As mentioned, here are the payment details for our services:

Payment Link: {paymentLink}

Please feel free to review the payment options at your convenience. If you have any questions about the pricing, payment methods, or need to discuss a payment plan, I'm here to help.

You can also visit our website at https://www.flashfirejobs.com/ for more information about our services.

Thank you for considering FlashFire for your career development needs. I look forward to hearing from you soon.

Best regards,
FlashFire Team`,
    fields: [
      {
        name: 'paymentLink',
        type: 'url',
        label: 'Payment Link',
        placeholder: 'https://example.com/payment',
        required: true
      },
      {
        name: 'reminderDays',
        type: 'number',
        label: 'Send After (Days)',
        placeholder: '7',
        required: true
      }
    ]
  },
  {
    id: 'follow-up',
    name: 'General Follow-up',
    template: `Hi {clientName},

I hope you're doing well! I wanted to follow up on our recent conversation about your career goals.

{followUpMessage}

Please don't hesitate to reach out if you have any questions or would like to discuss further.

Best regards,
FlashFire Team`,
    fields: [
      {
        name: 'followUpMessage',
        type: 'text',
        label: 'Follow-up Message',
        placeholder: 'Enter your follow-up message here...',
        required: true
      }
    ]
  },
  {
    id: 'appointment-confirmation',
    name: 'Appointment Confirmation',
    template: `Hello {clientName},

This is a confirmation for your upcoming appointment scheduled for {appointmentDate}.

Meeting Details:
- Date: {appointmentDate}
- Duration: {duration}
- Meeting Link: {meetingLink}

Please ensure you have a stable internet connection and are in a quiet environment for our meeting.

If you need to reschedule or have any questions, please let me know as soon as possible.

Looking forward to speaking with you!

Best regards,
FlashFire Team`,
    fields: [
      {
        name: 'appointmentDate',
        type: 'text',
        label: 'Appointment Date & Time',
        placeholder: 'Monday, January 15, 2024 at 2:00 PM',
        required: true
      },
      {
        name: 'duration',
        type: 'text',
        label: 'Duration',
        placeholder: '30 minutes',
        required: true
      },
      {
        name: 'meetingLink',
        type: 'url',
        label: 'Meeting Link',
        placeholder: 'https://meet.google.com/...',
        required: true
      }
    ]
  }
];

// Get available message types
export const getMessageTypes = async (req, res) => {
  try {
    Logger.info('Fetching WhatsApp message types');
    
    res.status(200).json({
      success: true,
      message: 'Message types fetched successfully',
      data: MESSAGE_TYPES
    });
  } catch (error) {
    Logger.error('Error fetching message types', { 
      error: error.message, 
      stack: error.stack 
    });
    res.status(500).json({
      success: false,
      message: 'Internal server error fetching message types'
    });
  }
};

// Send WhatsApp message
export const sendMessage = async (req, res) => {
  try {
    const { clientName, clientPhone, messageType, message, fieldValues } = req.body;

    // Validate required fields
    if (!clientName || !clientPhone || !messageType || !message) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: clientName, clientPhone, messageType, and message are required'
      });
    }

    // Validate phone number format
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    if (!phoneRegex.test(clientPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format. Please use international format (e.g., +1234567890)'
      });
    }

    // Find the message type configuration
    const messageTypeConfig = MESSAGE_TYPES.find(type => type.id === messageType);
    if (!messageTypeConfig) {
      return res.status(400).json({
        success: false,
        message: 'Invalid message type'
      });
    }

    // Validate required fields for the message type
    for (const field of messageTypeConfig.fields) {
      if (field.required && (!fieldValues[field.name] || fieldValues[field.name].trim() === '')) {
        return res.status(400).json({
          success: false,
          message: `Missing required field: ${field.label}`
        });
      }
    }

    Logger.info('Sending WhatsApp message', {
      clientName,
      clientPhone: clientPhone.substring(0, 5) + '****', // Log partial phone for privacy
      messageType
    });

    // Send the WhatsApp message
    const result = await sendWhatsAppMessage(clientPhone, message);

    if (result.success) {
      Logger.info('WhatsApp message sent successfully', {
        clientName,
        messageType,
        watiResponse: result.data
      });

      res.status(200).json({
        success: true,
        message: 'WhatsApp message sent successfully',
        data: {
          clientName,
          clientPhone: clientPhone.substring(0, 5) + '****', // Return partial phone for privacy
          messageType,
          sentAt: new Date().toISOString(),
          watiResponse: result.data
        }
      });
    } else {
      Logger.error('Failed to send WhatsApp message', {
        clientName,
        messageType,
        error: result.error
      });

      res.status(500).json({
        success: false,
        message: 'Failed to send WhatsApp message',
        error: result.error
      });
    }

  } catch (error) {
    Logger.error('Error sending WhatsApp message', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    res.status(500).json({
      success: false,
      message: 'Internal server error sending WhatsApp message'
    });
  }
};

// Test WhatsApp connection
export const testConnection = async (req, res) => {
  try {
    const { sendTestMessage, testPhone } = req.query;
    
    Logger.info('Testing WhatsApp connection', { 
      sendTestMessage: sendTestMessage === 'true',
      testPhone: testPhone || 'not provided'
    });

    if (sendTestMessage === 'true') {
      // --- START OF FIX ---
      
      let testPhoneNumber = '+917338183939'; // Default test number

      if (testPhone) {
        // If a phone number is provided, ensure it's in E.164 format
        if (testPhone.startsWith('+')) {
          testPhoneNumber = testPhone;
        } else {
          testPhoneNumber = `+${testPhone}`; // Add the missing '+'
        }
      }
      
      // --- END OF FIX ---

      const testMessage = `Hello! This is a test message from FlashFire WhatsApp system.

Message sent at: ${new Date().toLocaleString()}

If you received this message, the WhatsApp integration is working correctly!

Best regards,
FlashFire Team`;

      Logger.info('Sending test message', { 
        testPhoneNumber, 
        messageLength: testMessage.length,
        messagePreview: testMessage.substring(0, 100) + '...'
      });
      const result = await sendWhatsAppMessage(testPhoneNumber, testMessage);

      res.status(200).json({
        success: true,
        message: 'WhatsApp connection test completed',
        data: {
          connectionStatus: result.success ? 'Connected' : 'Failed',
          testMessageSent: sendTestMessage === 'true',
          testPhoneNumber: testPhoneNumber,
          messageLength: testMessage.length,
          watiResponse: result,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      // Just test the connection without sending a message
      res.status(200).json({
        success: true,
        message: 'WhatsApp connection test endpoint reached',
        data: {
          connectionStatus: 'API endpoint accessible',
          testMessageSent: false,
          timestamp: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    Logger.error('Error testing WhatsApp connection', {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({
      success: false,
      message: 'Internal server error testing WhatsApp connection'
    });
  }
};

// Send simple WhatsApp message (mobile number + message only)
export const sendSimpleMessage = async (req, res) => {
  try {
    const { mobile, message } = req.body;

    // Validate required fields
    if (!mobile || !message) {
      return res.status(400).json({
        success: false,
        message: 'Mobile number and message are required'
      });
    }

    if (!message.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Message cannot be empty'
      });
    }

    Logger.info('Sending simple WhatsApp message', {
      mobile: mobile.substring(0, 5) + '****', // Log partial mobile for privacy
      messageLength: message.trim().length
    });

    // Send the WhatsApp message
    const result = await sendWhatsAppMessage(mobile, message.trim());

    if (result.success) {
      Logger.info('Simple WhatsApp message sent successfully', {
        mobile: mobile.substring(0, 5) + '****',
        messageLength: message.trim().length
      });

      res.status(200).json({
        success: true,
        message: 'WhatsApp message sent successfully',
        data: {
          mobile: mobile.substring(0, 5) + '****', // Return partial mobile for privacy
          messageLength: message.trim().length,
          sentAt: new Date().toISOString()
        }
      });
    } else {
      Logger.error('Failed to send simple WhatsApp message', {
        mobile: mobile.substring(0, 5) + '****',
        error: result.error
      });

      res.status(500).json({
        success: false,
        message: 'Failed to send WhatsApp message',
        error: result.error
      });
    }

  } catch (error) {
    Logger.error('Error sending simple WhatsApp message', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });
    res.status(500).json({
      success: false,
      message: 'Internal server error sending WhatsApp message'
    });
  }
};
import watiService from '../Utils/WatiService.js';
import { Logger } from '../Utils/Logger.js';

export const testWhatsAppTemplate = async (req, res) => {
  try {
    const {
      templateName,
      templateId,
      mobileNumber = '919866855857',
      parameters = []
    } = req.body;

    if (!templateName && !templateId) {
      return res.status(400).json({
        success: false,
        message: 'Either templateName or templateId is required'
      });
    }

    let formattedMobile = String(mobileNumber).replace(/\D/g, '');
    if (formattedMobile.length === 10) {
      formattedMobile = `91${formattedMobile}`;
    } else if (formattedMobile.length === 12 && formattedMobile.startsWith('91')) {
      formattedMobile = formattedMobile;
    } else if (!formattedMobile.startsWith('91')) {
      formattedMobile = `91${formattedMobile}`;
    }

    Logger.info('Testing WhatsApp template', {
      templateName: templateName || 'N/A',
      templateId: templateId || 'N/A',
      mobileNumber: formattedMobile,
      parametersCount: parameters.length,
      parameters
    });

    const result = await watiService.sendTemplateMessage({
      mobileNumber: formattedMobile,
      templateName: templateName,
      templateId: templateId,
      parameters: parameters,
      campaignId: `test_${Date.now()}`
    });

    if (result.success) {
      Logger.info('WhatsApp template test successful', {
        templateName: templateName || 'N/A',
        templateId: templateId || 'N/A',
        mobileNumber: formattedMobile,
        response: result.data
      });

      return res.status(200).json({
        success: true,
        message: 'WhatsApp template sent successfully',
        data: {
          templateName: templateName || 'N/A',
          templateId: templateId || 'N/A',
          mobileNumber: formattedMobile,
          parameters,
          watiResponse: result.data,
          sentAt: new Date().toISOString()
        }
      });
    } else {
      Logger.error('WhatsApp template test failed', {
        templateName: templateName || 'N/A',
        templateId: templateId || 'N/A',
        mobileNumber: formattedMobile,
        error: result.error
      });

      return res.status(400).json({
        success: false,
        message: 'Failed to send WhatsApp template',
        error: result.error,
        data: {
          templateName: templateName || 'N/A',
          templateId: templateId || 'N/A',
          mobileNumber: formattedMobile,
          parameters
        }
      });
    }
  } catch (error) {
    Logger.error('Error testing WhatsApp template', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error testing WhatsApp template',
      error: error.message
    });
  }
};

export const testNoShowTemplate = async (req, res) => {
  try {
    const { mobileNumber = '919866855857' } = req.body;

    let formattedMobile = String(mobileNumber).replace(/\D/g, '');
    if (formattedMobile.length === 10) {
      formattedMobile = `91${formattedMobile}`;
    } else if (formattedMobile.length === 12 && formattedMobile.startsWith('91')) {
      formattedMobile = formattedMobile;
    } else if (!formattedMobile.startsWith('91')) {
      formattedMobile = `91${formattedMobile}`;
    }

    const templateName = 'cancelled1';
    
    const now = new Date();
    const meetingDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const meetingTime = '4pm – 4:15pm ET';
    const rescheduleLink = 'https://calendly.com/feedback-flashfire/30min';
    
    const defaultParameters = [
      'Test Client Name',
      meetingDate,
      meetingTime,
      rescheduleLink
    ];

    Logger.info('Testing no-show WhatsApp template', {
      templateName,
      mobileNumber: formattedMobile,
      parameters: defaultParameters
    });

    const result = await watiService.sendTemplateMessage({
      mobileNumber: formattedMobile,
      templateName: templateName,
      parameters: defaultParameters,
      campaignId: `test_noshow_${Date.now()}`
    });

    if (result.success) {
      Logger.info('No-show WhatsApp template test successful', {
        templateName,
        mobileNumber: formattedMobile,
        response: result.data
      });

      return res.status(200).json({
        success: true,
        message: 'No-show WhatsApp template sent successfully',
        data: {
          templateName,
          mobileNumber: formattedMobile,
          parameters: defaultParameters,
          watiResponse: result.data,
          sentAt: new Date().toISOString()
        }
      });
    } else {
      Logger.error('No-show WhatsApp template test failed', {
        templateName,
        mobileNumber: formattedMobile,
        error: result.error
      });

      return res.status(400).json({
        success: false,
        message: 'Failed to send no-show WhatsApp template',
        error: result.error,
        errorDetails: result.error,
        data: {
          templateName,
          mobileNumber: formattedMobile,
          parameters: defaultParameters
        }
      });
    }
  } catch (error) {
    Logger.error('Error testing no-show WhatsApp template', {
      error: error.message,
      stack: error.stack,
      body: req.body
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error testing no-show WhatsApp template',
      error: error.message,
      stack: error.stack
    });
  }
};

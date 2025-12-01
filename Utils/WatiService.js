import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Service class to handle WATI WhatsApp operations
 */
class WatiService {
  constructor() {
    this.apiBaseUrl = process.env.WATI_API_BASE_URL?.replace(/\/$/, '') || '';
    this.apiToken = process.env.WATI_API_TOKEN || '';
    this.channelNumber = process.env.WATI_CHANNEL_NUMBER || '';

    if (!this.apiBaseUrl || !this.apiToken) {
      console.warn('⚠️ WATI_API_BASE_URL and WATI_API_TOKEN must be configured');
    }

    // Remove 'Bearer ' prefix if present (we add it ourselves)
    const token = this.apiToken.replace('Bearer ', '').trim();

    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    console.log('✅ WATI Service initialized:', {
      baseUrl: this.apiBaseUrl,
      hasToken: !!token,
      tokenLength: token.length,
      channelNumber: this.channelNumber
    });
  }

  /**
   * Fetch all approved WhatsApp templates from WATI
   * @returns {Promise<{success: boolean, templates?: Array, error?: string}>}
   */
  async getTemplates() {
    try {
      const url = `${this.apiBaseUrl}/api/v1/getMessageTemplates`;
      const response = await axios.get(url, { 
        headers: this.headers,
        timeout: 10000
      });

      if (response.status === 200) {
        const data = response.data;
        const templates = data.messageTemplates || [];

        // Filter only approved templates and extract name/id
        const approvedTemplates = templates
          .filter(template => template.status === 'APPROVED')
          .map(template => ({
            name: template.elementName, // WATI uses 'elementName' for template name
            id: template.id,
            status: template.status,
            category: template.category,
            language: template.language
          }));

        return {
          success: true,
          templates: approvedTemplates
        };
      } else {
        return {
          success: false,
          error: `WATI API error: ${response.status} - ${response.statusText}`
        };
      }
    } catch (error) {
      console.error('❌ Error fetching WATI templates:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get template ID by name
   * @param {string} templateName 
   * @returns {Promise<string|null>}
   */
  async getTemplateIdByName(templateName) {
    const res = await this.getTemplates();
    if (!res.success) {
      return null;
    }
    const template = res.templates.find(t => t.name === templateName);
    return template ? template.id : null;
  }

  /**
   * Fetch all contacts from WATI
   * @returns {Promise<{success: boolean, contacts?: Array, error?: string}>}
   */
  async getContacts() {
    try {
      const url = `${this.apiBaseUrl}/api/v1/getContacts`;
      const response = await axios.get(url, { 
        headers: this.headers,
        timeout: 10000
      });

      if (response.status === 200) {
        const data = response.data;
        const contacts = data.contact_list || [];

        // Extract contact information
        const formattedContacts = contacts.map(contact => {
          const whatsappId = contact.wAId || contact.phone || '';
          const fullName = contact.fullName || '';
          const firstName = contact.firstName || '';
          const name = fullName || firstName || whatsappId;

          // Ensure phone number has + prefix for WhatsApp
          const phone = whatsappId.startsWith('+') ? whatsappId : `+${whatsappId}`;

          return {
            name,
            phone,
            whatsapp_id: whatsappId
          };
        });

        return {
          success: true,
          contacts: formattedContacts
        };
      } else {
        return {
          success: false,
          error: `WATI API error: ${response.status} - ${response.statusText}`
        };
      }
    } catch (error) {
      console.error('❌ Error fetching WATI contacts:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Send WhatsApp template message using WATI API
   * @param {Object} params
   * @param {string} params.mobileNumber - Recipient's mobile number
   * @param {string} params.templateName - Template name
   * @param {Array} params.parameters - Template parameters
   * @param {string} params.campaignId - Campaign ID for tracking
   * @returns {Promise<{success: boolean, data?: any, error?: string}>}
   */
  async sendTemplateMessage({ mobileNumber, templateName, parameters = [], campaignId }) {
    try {
      // Normalize mobile number - remove + and any non-digits
      const mobile = mobileNumber.replace(/\D/g, '');

      const url = `${this.apiBaseUrl}/api/v2/sendTemplateMessage?whatsappNumber=${mobile}`;

      // Normalize channel number: digits only, ensure starts with '91'
      let digitsOnly = this.channelNumber.replace(/\D/g, '');
      if (!digitsOnly.startsWith('91')) {
        digitsOnly = `91${digitsOnly}`;
      }

      const messageData = {
        template_name: templateName,
        broadcast_name: `Campaign_${campaignId}_${templateName}`,
        channel_number: parseInt(digitsOnly),
        parameters: parameters || []
      };

      console.log('📤 Sending WATI message:', {
        url,
        mobile,
        templateName,
        parametersCount: parameters.length
      });

      const response = await axios.post(url, messageData, {
        headers: this.headers,
        timeout: 15000
      });

      if (response.status >= 200 && response.status < 300) {
        const data = response.data;
        if (data.result === true || data.result === 'success') {
          return {
            success: true,
            data: data
          };
        } else {
          return {
            success: false,
            error: data.message || 'Unknown error from WATI'
          };
        }
      } else {
        return {
          success: false,
          error: `WATI API HTTP error: ${response.status} - ${response.statusText}`
        };
      }
    } catch (error) {
      console.error('❌ Error sending WATI message:', error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }
}

// Export singleton instance
export default new WatiService();


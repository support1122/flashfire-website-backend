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
    this.tenantId = process.env.WATI_TENANT_ID || '';
    // Try to infer tenantId if not provided but present in base URL (e.g., .../1033833)
    if (!this.tenantId) {
      const match = this.apiBaseUrl.match(/\/(\d{5,})$/);
      if (match) {
        this.tenantId = match[1];
      }
    }
    // Last-resort fallback if user has explicitly stated tenant id
    if (!this.tenantId && process.env.WATI_TENANT_FALLBACK) {
      this.tenantId = process.env.WATI_TENANT_FALLBACK;
    }

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
      const basePath = this.tenantId
        ? `${this.apiBaseUrl}/${this.tenantId}/api/v1/getMessageTemplates`
        : `${this.apiBaseUrl}/api/v1/getMessageTemplates`;
      const url = basePath;
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
   * @param {string} params.templateName - Template name (approved template name)
   * @param {string} params.templateId - Template ID (WATI template ID, alternative to templateName)
   * @param {Array} params.parameters - Template parameters
   * @param {string} params.campaignId - Campaign ID for tracking
   * @returns {Promise<{success: boolean, data?: any, error?: string}>}
   */
  async sendTemplateMessage({ mobileNumber, templateName, templateId, parameters = [], campaignId }) {
    try {
      // Normalize mobile number - remove + and any non-digits
      const mobile = mobileNumber.replace(/\D/g, '');

      const basePath = this.tenantId
        ? `${this.apiBaseUrl}/${this.tenantId}/api/v2/sendTemplateMessage`
        : `${this.apiBaseUrl}/api/v2/sendTemplateMessage`;
      const url = `${basePath}?whatsappNumber=${mobile}`;

      // Normalize channel number: digits only, ensure starts with '91'
      let digitsOnly = this.channelNumber ? this.channelNumber.replace(/\D/g, '') : '';
      if (digitsOnly && !digitsOnly.startsWith('91')) {
        digitsOnly = `91${digitsOnly}`;
      }

      const formattedParameters = (parameters || []).map((value, idx) => ({
        name: `${idx + 1}`,
        value
      }));

      const templateIdentifier = templateId || templateName;
      
      if (!templateId && !templateName) {
        throw new Error('Either templateId or templateName must be provided');
      }
      
      const messageData = {
        template_name: templateName || templateId,
        broadcast_name: `Campaign_${campaignId}_${templateIdentifier}`,
        ...(digitsOnly ? { channel_number: parseInt(digitsOnly) } : {}),
        parameters: formattedParameters
      };

      console.log('📤 Sending WATI message:', {
        url,
        mobile,
        templateName: templateName || 'N/A',
        templateId: templateId || 'N/A',
        parametersCount: formattedParameters.length,
        hasTenant: !!this.tenantId,
        payload: messageData
      });

      const response = await axios.post(url, messageData, {
        headers: this.headers,
        timeout: 15000
      });

      console.log('📥 WATI response:', {
        status: response.status,
        result: response.data?.result,
        message: response.data?.message,
        data: response.data
      });

      if (response.status >= 200 && response.status < 300) {
        const data = response.data;
        if (data.result === true || data.result === 'success') {
          return {
            success: true,
            data: data
          };
        } else {
          let errorMessage = 'Unknown error from WATI';
          
          if (data.error) {
            errorMessage = data.error;
          } else if (data.items && Array.isArray(data.items) && data.items.length > 0) {
            const errorItems = data.items.map(item => {
              if (item.description) {
                return `${item.code || 'Error'}: ${item.description}`;
              }
              return item.code || JSON.stringify(item);
            });
            errorMessage = errorItems.join('; ');
          } else if (data.message) {
            errorMessage = data.message;
          }
          
          console.error('❌ WATI API returned error:', {
            status: response.status,
            error: errorMessage,
            fullResponse: data
          });
          
          return {
            success: false,
            error: errorMessage,
            watiResponse: data
          };
        }
      } else {
        const errorMsg = `WATI API HTTP error: ${response.status} - ${response.statusText}`;
        console.error('❌ WATI API HTTP error:', errorMsg);
        return {
          success: false,
          error: errorMsg
        };
      }
    } catch (error) {
      let errorMessage = error.message;
      let watiErrorDetails = null;
      
      if (error.response?.data) {
        const data = error.response.data;
        
        if (data.error) {
          errorMessage = data.error;
          watiErrorDetails = data;
        } else if (data.items && Array.isArray(data.items) && data.items.length > 0) {
          const errorItems = data.items.map(item => {
            if (item.description) {
              return `${item.code || 'Error'}: ${item.description}`;
            }
            return item.code || JSON.stringify(item);
          });
          errorMessage = errorItems.join('; ');
          watiErrorDetails = data;
        } else if (data.message) {
          errorMessage = data.message;
          watiErrorDetails = data;
        } else {
          errorMessage = JSON.stringify(data);
          watiErrorDetails = data;
        }
      }
      
      console.error('❌ Error sending WATI message:', {
        error: errorMessage,
        responseStatus: error.response?.status,
        responseData: watiErrorDetails || error.response?.data,
        url: error.config?.url,
        requestPayload: error.config?.data ? JSON.parse(error.config.data) : null
      });
      
      return {
        success: false,
        error: errorMessage,
        watiResponse: watiErrorDetails || error.response?.data
      };
    }
  }
}

// Export singleton instance
export default new WatiService();


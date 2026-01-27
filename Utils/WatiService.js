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

    // In-memory cache for template mappings (id <-> name)
    this.templateIdToName = new Map();
    this.templateNameToId = new Map();
    this.templatesCacheLoaded = false;
    this.templatesCacheLastLoadedAt = null;

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
   * Refresh in-memory template cache (id <-> name)
   */
  async refreshTemplatesCache() {
    const res = await this.getTemplates();
    if (!res.success || !Array.isArray(res.templates)) {
      console.error('❌ Failed to refresh WATI templates cache:', res.error);
      return;
    }

    this.templateIdToName.clear();
    this.templateNameToId.clear();

    for (const t of res.templates) {
      if (!t || !t.id || !t.name) continue;
      const name = String(t.name).trim();
      const id = String(t.id).trim();
      if (!name || !id) continue;

      this.templateIdToName.set(id, name);
      this.templateNameToId.set(name, id);
    }

    this.templatesCacheLoaded = true;
    this.templatesCacheLastLoadedAt = new Date();

    console.log('✅ WATI templates cache loaded:', {
      count: this.templateIdToName.size,
      loadedAt: this.templatesCacheLastLoadedAt.toISOString()
    });
  }

  /**
   * Ensure template cache is loaded (lazy-load on first use)
   */
  async ensureTemplatesCache() {
    if (this.templatesCacheLoaded && this.templateIdToName.size > 0) {
      return;
    }
    await this.refreshTemplatesCache();
  }

  /**
   * Resolve a usable template name, preferring templateName but falling back
   * to mapping templateId -> name via cached templates.
   *
   * @param {string|null} templateName
   * @param {string|null} templateId
   * @returns {Promise<string|null>}
   */
  async resolveTemplateName(templateName, templateId) {
    // If caller already passed a name, prefer that
    if (templateName && String(templateName).trim() !== '') {
      return String(templateName).trim();
    }

    // If only ID is available, try to map it to a name
    if (templateId && String(templateId).trim() !== '') {
      const id = String(templateId).trim();

      // Try cache first
      if (!this.templatesCacheLoaded || !this.templateIdToName.size) {
        await this.ensureTemplatesCache();
      }

      let nameFromCache = this.templateIdToName.get(id);
      if (!nameFromCache) {
        // Cache miss – force a refresh once
        await this.refreshTemplatesCache();
        nameFromCache = this.templateIdToName.get(id);
      }

      if (nameFromCache) {
        return nameFromCache;
      }

      // As a last resort, fall back to treating ID as name (old behaviour),
      // but log clearly so we can see this in logs.
      console.warn('⚠️ WATI template ID not found in cache, falling back to ID as name', {
        templateId: id
      });
      return id;
    }

    return null;
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

      // Always send by template NAME to WATI.
      // If we only have an ID from older workflows, map it to a name via cached templates.
      const finalTemplateName = await this.resolveTemplateName(templateName, templateId);

      if (!finalTemplateName) {
        throw new Error('Either templateName or templateId (mappable to a name) must be provided');
      }

      const templateIdentifier = finalTemplateName;

      // Use template_name (and TemplateName for backward compatibility with WATI variants)
      const messageData = {
        template_name: finalTemplateName,
        TemplateName: finalTemplateName,
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


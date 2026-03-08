import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { Logger } from '../Utils/Logger.js';

const FB_VERIFY_TOKEN = process.env.FB_WEBHOOK_VERIFY_TOKEN || 'flashfire_meta_leads_verify';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;

/**
 * Meta Lead Ads Webhook Verification (GET)
 * Facebook sends a GET request to verify the webhook URL during setup.
 */
export const verifyMetaWebhook = (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    console.log('Meta Webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('Meta Webhook verification failed. Token mismatch.');
  return res.status(403).json({ error: 'Verification failed' });
};

/**
 * Fetch lead data from Meta Graph API using the leadgen_id
 */
async function fetchLeadDataFromMeta(leadgenId) {
  if (!FB_PAGE_ACCESS_TOKEN) {
    console.warn('FB_PAGE_ACCESS_TOKEN not configured, cannot fetch lead data from Meta');
    return null;
  }

  try {
    const url = `https://graph.facebook.com/v21.0/${leadgenId}?access_token=${FB_PAGE_ACCESS_TOKEN}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error('Meta Graph API error fetching lead:', data.error);
      return null;
    }

    return data;
  } catch (error) {
    console.error('Failed to fetch lead data from Meta:', error.message);
    return null;
  }
}

/**
 * Parse Meta Lead form field_data into a structured object
 * Meta sends fields as: [{ name: "email", values: ["user@example.com"] }, ...]
 */
function parseLeadFields(fieldData) {
  const parsed = {};
  if (!Array.isArray(fieldData)) return parsed;

  for (const field of fieldData) {
    const name = (field.name || '').toLowerCase().replace(/\s+/g, '_');
    const value = field.values?.[0] || '';

    if (name.includes('email') || name === 'email') {
      parsed.email = value;
    } else if (name.includes('full_name') || name === 'full_name') {
      parsed.fullName = value;
    } else if (name.includes('first_name') || name === 'first_name') {
      parsed.firstName = value;
    } else if (name.includes('last_name') || name === 'last_name') {
      parsed.lastName = value;
    } else if (name.includes('phone') || name === 'phone_number') {
      parsed.phone = value;
    } else if (name.includes('job') || name.includes('role') || name.includes('position')) {
      parsed.jobTitle = value;
    } else if (name.includes('utm_source') || name === 'utm_source' || name === 'utmsource') {
      // Extract UTM source from form field
      parsed.utmSource = value;
    } else if (name.includes('utm_medium') || name === 'utm_medium' || name === 'utmmedium') {
      // Extract UTM medium from form field
      parsed.utmMedium = value;
    } else if (name.includes('utm_campaign') || name === 'utm_campaign' || name === 'utmcampaign') {
      // Extract UTM campaign from form field
      parsed.utmCampaign = value;
    } else {
      // Store any other custom fields
      if (!parsed.customFields) parsed.customFields = {};
      parsed.customFields[name] = value;
    }
  }

  // Build full name from parts if not already set
  if (!parsed.fullName && (parsed.firstName || parsed.lastName)) {
    parsed.fullName = [parsed.firstName, parsed.lastName].filter(Boolean).join(' ');
  }

  return parsed;
}

/**
 * Meta Lead Ads Webhook Handler (POST)
 * Receives lead data when someone submits a Meta Lead Ad form.
 *
 * Meta webhook payload structure:
 * {
 *   "object": "page",
 *   "entry": [{
 *     "id": "page_id",
 *     "time": 1234567890,
 *     "changes": [{
 *       "field": "leadgen",
 *       "value": {
 *         "leadgen_id": "123456789",
 *         "page_id": "987654321",
 *         "form_id": "111222333",
 *         "ad_id": "444555666",
 *         "adgroup_id": "777888999",
 *         "created_time": 1234567890
 *       }
 *     }]
 *   }]
 * }
 */
export const handleMetaLeadWebhook = async (req, res) => {
  // Respond immediately to Meta (they require 200 within 20 seconds)
  res.status(200).json({ status: 'received' });

  try {
    const body = req.body;

    if (body.object !== 'page') {
      console.warn('Meta webhook: Unexpected object type:', body.object);
      return;
    }

    const entries = body.entry || [];

    for (const entry of entries) {
      const pageId = entry.id;
      const changes = entry.changes || [];

      for (const change of changes) {
        if (change.field !== 'leadgen') continue;

        const leadValue = change.value || {};
        const {
          leadgen_id,
          form_id,
          ad_id,
          adgroup_id,
          created_time
        } = leadValue;

        if (!leadgen_id) {
          console.warn('Meta webhook: Missing leadgen_id, skipping');
          continue;
        }

        // Check for duplicate lead
        const existing = await CampaignBookingModel.findOne({ metaLeadId: leadgen_id });
        if (existing) {
          console.log(`Meta lead ${leadgen_id} already exists as booking ${existing.bookingId}, skipping`);
          continue;
        }

        // Fetch the actual lead data from Meta Graph API
        const leadData = await fetchLeadDataFromMeta(leadgen_id);

        let clientName = 'Meta Lead';
        let clientEmail = '';
        let clientPhone = '';
        let formName = '';
        let additionalNotes = '';
        let parsedFields = {};

        if (leadData) {
          parsedFields = parseLeadFields(leadData.field_data);

          clientName = parsedFields.fullName || 'Meta Lead';
          clientEmail = parsedFields.email || '';
          clientPhone = parsedFields.phone || '';
          formName = leadData.form_name || '';

          // Build additional notes from custom fields (excluding UTM fields)
          const noteParts = [];
          if (parsedFields.jobTitle) noteParts.push(`Job/Role: ${parsedFields.jobTitle}`);
          if (parsedFields.customFields) {
            for (const [key, val] of Object.entries(parsedFields.customFields)) {
              // Skip UTM fields from notes (they're stored separately)
              if (!key.includes('utm')) {
                noteParts.push(`${key}: ${val}`);
              }
            }
          }
          if (noteParts.length > 0) {
            additionalNotes = noteParts.join('\n');
          }
        }

        // If we couldn't fetch data from Meta API, use minimal info
        if (!clientEmail) {
          clientEmail = `meta_lead_${leadgen_id}@meta.placeholder`;
          console.warn(`Could not fetch email for lead ${leadgen_id}, using placeholder`);
        }

        // Extract UTM parameters from form fields (if provided in Meta Lead Form)
        // This allows dynamic UTM tracking without code changes
        // Users can add hidden fields "utm_source" and "utm_medium" in Meta Lead Form
        const dynamicUtmSource = parsedFields.utmSource || 'meta_lead_ad'; // Default fallback
        const dynamicUtmMedium = parsedFields.utmMedium || 'paid'; // Default fallback
        const dynamicUtmCampaign = parsedFields.utmCampaign || (ad_id ? `meta_ad_${ad_id}` : 'meta_lead_form');

        // Create the CampaignBooking record
        const newBooking = new CampaignBookingModel({
          clientName: clientName.trim(),
          clientEmail: clientEmail.trim().toLowerCase(),
          clientPhone: clientPhone || null,
          utmSource: dynamicUtmSource, // Dynamic from form field or default
          utmMedium: dynamicUtmMedium, // Dynamic from form field or default
          utmCampaign: dynamicUtmCampaign, // Dynamic from form field or ad_id
          bookingStatus: 'scheduled',
          leadSource: 'meta_lead_ad', // ALWAYS 'meta_lead_ad' so Meta Leads tab works
          metaLeadId: leadgen_id,
          metaFormId: form_id || null,
          metaAdId: ad_id || null,
          metaAdsetId: adgroup_id || null,
          metaPageId: pageId || null,
          metaFormName: formName || null,
          metaCampaignId: leadValue.campaign_id || null,
          metaRawData: leadData || leadValue,
          anythingToKnow: additionalNotes || null,
          bookingCreatedAt: created_time ? new Date(created_time * 1000) : new Date()
        });

        await newBooking.save();

        console.log(`Meta lead saved: ${newBooking.bookingId} | ${clientName} | ${clientEmail} | Form: ${formName}`);

        // Send Discord notification for new Meta lead
        try {
          await sendMetaLeadDiscordNotification({
            bookingId: newBooking.bookingId,
            clientName,
            clientEmail,
            clientPhone,
            formName,
            leadgenId: leadgen_id,
            adId: ad_id
          });
        } catch (discordErr) {
          console.error('Failed to send Discord notification for Meta lead:', discordErr.message);
        }
      }
    }
  } catch (error) {
    console.error('Error processing Meta lead webhook:', error);
  }
};

/**
 * Send Discord notification for new Meta Lead
 */
async function sendMetaLeadDiscordNotification(leadInfo) {
  const webhookUrl = process.env.DISCORD_WEB_HOOK_URL;
  if (!webhookUrl) return;

  const embed = {
    title: 'New Meta Lead Ad Submission',
    color: 0x1877F2, // Facebook blue
    fields: [
      { name: 'Name', value: leadInfo.clientName || 'N/A', inline: true },
      { name: 'Email', value: leadInfo.clientEmail || 'N/A', inline: true },
      { name: 'Phone', value: leadInfo.clientPhone || 'N/A', inline: true },
      { name: 'Form', value: leadInfo.formName || 'N/A', inline: true },
      { name: 'Booking ID', value: leadInfo.bookingId, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Meta Lead Ads -> Flashfire CRM' }
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] })
  });
}

/**
 * Manual endpoint to test Meta lead creation (for debugging)
 */
export const createMetaLeadManually = async (req, res) => {
  try {
    const { clientName, clientEmail, clientPhone, formName, adId } = req.body;

    if (!clientName || !clientEmail) {
      return res.status(400).json({
        success: false,
        message: 'clientName and clientEmail are required'
      });
    }

    const newBooking = new CampaignBookingModel({
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
      clientPhone: clientPhone || null,
      utmSource: 'meta_lead_ad',
      utmMedium: 'paid',
      utmCampaign: adId ? `meta_ad_${adId}` : 'meta_lead_form',
      bookingStatus: 'scheduled',
      leadSource: 'meta_lead_ad',
      metaFormName: formName || null,
      metaAdId: adId || null,
      bookingCreatedAt: new Date()
    });

    await newBooking.save();

    return res.status(201).json({
      success: true,
      message: 'Meta lead created successfully',
      booking: {
        bookingId: newBooking.bookingId,
        clientName: newBooking.clientName,
        clientEmail: newBooking.clientEmail,
        leadSource: newBooking.leadSource
      }
    });
  } catch (error) {
    console.error('Error creating Meta lead manually:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create Meta lead',
      error: error.message
    });
  }
};

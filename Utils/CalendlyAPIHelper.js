import dotenv from 'dotenv';
import { Logger } from './Logger.js';

dotenv.config();

const CALENDLY_API_TOKEN = process.env.CALENDLY_API_TOKEN;
const CALENDLY_API_BASE_URL = 'https://api.calendly.com';

/**
 * Fetch reschedule link from Calendly API using invitee URI
 * @param {string} inviteeUri - Calendly invitee URI (e.g., "https://api.calendly.com/invitees/ABC123")
 * @returns {Promise<string|null>} - Reschedule URL or null if not found/error
 */
export async function fetchRescheduleLinkFromCalendly(inviteeUri) {
  if (!inviteeUri) {
    console.warn('⚠️ [CalendlyAPIHelper] No invitee URI provided');
    return null;
  }

  if (!CALENDLY_API_TOKEN) {
    console.warn('⚠️ [CalendlyAPIHelper] CALENDLY_API_TOKEN not configured, cannot fetch reschedule link');
    Logger.warn('[CalendlyAPIHelper] CALENDLY_API_TOKEN not configured');
    return null;
  }

  try {
    // Extract invitee UUID from URI if full URI is provided
    let inviteeId = inviteeUri;
    if (inviteeUri.includes('/invitees/')) {
      inviteeId = inviteeUri.split('/invitees/')[1].split('?')[0];
    }

    // Calendly API endpoint to get invitee details
    const apiUrl = `${CALENDLY_API_BASE_URL}/invitees/${inviteeId}`;
    
    console.log(`🔍 [CalendlyAPIHelper] Fetching reschedule link for invitee: ${inviteeId}`);

    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        console.warn(`⚠️ [CalendlyAPIHelper] Invitee not found: ${inviteeId}`);
        return null;
      }
      
      const errorText = await response.text();
      console.error(`❌ [CalendlyAPIHelper] API error (${response.status}):`, errorText);
      Logger.error('[CalendlyAPIHelper] Failed to fetch reschedule link', {
        inviteeId,
        status: response.status,
        error: errorText
      });
      return null;
    }

    const data = await response.json();
    
    // Extract reschedule URL from response
    // According to Calendly API docs, reschedule_url is in resource.reschedule_url
    const rescheduleUrl = data?.resource?.reschedule_url || null;
    
    if (rescheduleUrl) {
      console.log(`✅ [CalendlyAPIHelper] Successfully fetched reschedule link: ${rescheduleUrl}`);
      return rescheduleUrl;
    } else {
      console.warn(`⚠️ [CalendlyAPIHelper] No reschedule URL found in API response for invitee: ${inviteeId}`);
      return null;
    }

  } catch (error) {
    console.error('❌ [CalendlyAPIHelper] Error fetching reschedule link:', error.message);
    Logger.error('[CalendlyAPIHelper] Error fetching reschedule link', {
      inviteeUri,
      error: error.message
    });
    return null;
  }
}

/**
 * Fetch reschedule link from booking record or Calendly API
 * @param {Object} booking - Booking record with calendlyInviteeUri
 * @returns {Promise<string|null>} - Reschedule URL or null
 */
export async function getRescheduleLinkForBooking(booking) {
  // First check if reschedule link already exists in booking
  if (booking?.calendlyRescheduleLink) {
    console.log('✅ [CalendlyAPIHelper] Using existing reschedule link from booking');
    return booking.calendlyRescheduleLink;
  }

  // If invitee URI exists, try to fetch from Calendly API
  if (booking?.calendlyInviteeUri) {
    console.log('🔍 [CalendlyAPIHelper] Fetching reschedule link from Calendly API...');
    const rescheduleLink = await fetchRescheduleLinkFromCalendly(booking.calendlyInviteeUri);
    
    // If we got a reschedule link, save it to the booking
    if (rescheduleLink && booking?.bookingId) {
      try {
        const { CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js');
        await CampaignBookingModel.findOneAndUpdate(
          { bookingId: booking.bookingId },
          { calendlyRescheduleLink: rescheduleLink }
        );
        console.log('✅ [CalendlyAPIHelper] Saved reschedule link to booking record');
      } catch (updateError) {
        console.warn('⚠️ [CalendlyAPIHelper] Failed to save reschedule link to booking:', updateError.message);
      }
    }
    
    return rescheduleLink;
  }

  console.warn('⚠️ [CalendlyAPIHelper] No invitee URI found in booking, cannot fetch reschedule link');
  return null;
}

/**
 * Resolve the assigned host (BDA) for a Calendly scheduled event from an
 * invitee.created / invitee.canceled webhook payload.
 *
 * For a round-robin event type the `scheduled_event.event_memberships` array
 * contains the single host who received the booking. Each membership carries the
 * host's `user` URI and (in the current API) `user_email` / `user_name`. When the
 * email is missing we resolve it from the user URI via the Calendly API.
 *
 * @param {Object} payload - Calendly webhook payload (must contain scheduled_event)
 * @returns {Promise<{ email: string, name: string|null, calendlyUserUri: string|null }|null>}
 */
export async function resolveCalendlyHost(payload) {
  const memberships = payload?.scheduled_event?.event_memberships;
  if (!Array.isArray(memberships) || memberships.length === 0) {
    return null;
  }

  // Round-robin assigns exactly one host. Prefer the first membership that already
  // carries an email; otherwise fall back to the first and resolve via the API.
  const membership = memberships.find((m) => m?.user_email) || memberships[0];
  let email = membership?.user_email || null;
  let name = membership?.user_name || null;
  const calendlyUserUri = membership?.user || null;

  if ((!email || !name) && calendlyUserUri && CALENDLY_API_TOKEN) {
    try {
      const res = await fetch(calendlyUserUri, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${CALENDLY_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
      if (res.ok) {
        const data = await res.json();
        email = email || data?.resource?.email || null;
        name = name || data?.resource?.name || null;
      } else {
        Logger.warn('[CalendlyAPIHelper] Failed to resolve host user', {
          calendlyUserUri,
          status: res.status
        });
      }
    } catch (error) {
      Logger.warn('[CalendlyAPIHelper] Error resolving host user', {
        calendlyUserUri,
        error: error.message
      });
    }
  }

  if (!email) return null;

  return {
    email: String(email).toLowerCase().trim(),
    name: name || null,
    calendlyUserUri: calendlyUserUri || null
  };
}

export default {
  fetchRescheduleLinkFromCalendly,
  getRescheduleLinkForBooking,
  resolveCalendlyHost
};


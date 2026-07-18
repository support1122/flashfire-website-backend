/**
 * WhatsApp existence check via Whapi.cloud (same service and env pattern as
 * DASH/flashfire-dashboard-backend-main/Controllers/whatsapp/WhatsAppController.js).
 *
 * POST {WHAPI_API_URL}/contacts with { contacts: ["+1..."] } and a Bearer token
 * returns per-contact status: 'valid' = the number exists on WhatsApp,
 * 'invalid' = it does not. Docs: https://whapi.readme.io/reference/checkphones
 *
 * Unset WHAPI_API_TOKEN disables the check entirely (callers get null and
 * fall back to their next signal). Results are cached in-memory: WhatsApp
 * existence rarely changes and Whapi advises against aggressive re-checking.
 */

const WHAPI_API_URL = (process.env.WHAPI_API_URL || 'https://gate.whapi.cloud').replace(/\/+$/, '');
const WHAPI_TIMEOUT_MS = 8000;

const existenceCache = new Map(); // e164 -> boolean
const CACHE_MAX = 5000;

export function whapiConfigured() {
  return !!process.env.WHAPI_API_TOKEN;
}

/**
 * @param {string} e164 - full number with country code, e.g. "+19546662642"
 * @returns {Promise<boolean|null>} true = on WhatsApp, false = not on WhatsApp,
 *          null = could not determine (not configured, HTTP error, timeout).
 */
export async function hasWhatsApp(e164) {
  const token = process.env.WHAPI_API_TOKEN;
  if (!token || !e164) return null;

  if (existenceCache.has(e164)) return existenceCache.get(e164);

  try {
    const res = await fetch(`${WHAPI_API_URL}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ contacts: [e164] }),
      signal: AbortSignal.timeout(WHAPI_TIMEOUT_MS)
    });

    if (!res.ok) {
      console.warn(`WhapiExistenceCheck: HTTP ${res.status} for ${e164}`);
      return null;
    }

    const data = await res.json().catch(() => null);
    // Response shape: { contacts: [{ input, status: 'valid'|'invalid', wa_id? }] }
    // (some deployments return the array at the root - handle both).
    const entry = (Array.isArray(data?.contacts) ? data.contacts : Array.isArray(data) ? data : [])[0];
    if (!entry || typeof entry.status !== 'string') {
      console.warn(`WhapiExistenceCheck: unexpected response shape for ${e164}`);
      return null;
    }

    const exists = entry.status === 'valid';
    if (existenceCache.size >= CACHE_MAX) existenceCache.clear();
    existenceCache.set(e164, exists);
    return exists;
  } catch (e) {
    console.warn(`WhapiExistenceCheck: lookup failed for ${e164}:`, e.message);
    return null;
  }
}

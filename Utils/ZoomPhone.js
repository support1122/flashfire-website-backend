import crypto from 'crypto';

/**
 * Phone normalizer used to match a Zoom Phone number against
 * CampaignBooking.clientPhone (which is stored as raw E.164 in this CRM).
 * Strip every non-digit, drop a leading US country code "1" if the result
 * is 11 digits — gives a stable 10-digit US number, or all digits for the rest.
 */
export function normalizePhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

/**
 * Verify the Zoom webhook signature.
 * Zoom sends:
 *   x-zm-request-timestamp: <unix>
 *   x-zm-signature: v0=<hmacSha256(secret, 'v0:'+timestamp+':'+rawBody)>
 * We need the RAW body (Buffer / string), NOT the parsed JSON.
 */
export function verifyZoomSignature(rawBody, headers, secretToken) {
  if (!secretToken) return false;
  const ts = headers['x-zm-request-timestamp'];
  const sig = headers['x-zm-signature'];
  if (!ts || !sig) return false;
  const message = `v0:${ts}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', secretToken).update(message).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Handle Zoom's one-time endpoint validation challenge.
 * When Zoom first registers the webhook URL it sends:
 *   event: 'endpoint.url_validation', payload: { plainToken: '...' }
 * We must respond with { plainToken, encryptedToken: HMAC-SHA256(secret, plainToken) }.
 */
export function buildUrlValidationResponse(plainToken, secretToken) {
  const encryptedToken = crypto.createHmac('sha256', secretToken).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}

/**
 * Exchange Server-to-Server OAuth credentials for a Zoom access token.
 * Caches the token in memory until it expires.
 */
let cachedToken = null;
let cachedExpiry = 0;

export async function getZoomAccessToken() {
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_S2S_CLIENT_ID;
  const clientSecret = process.env.ZOOM_S2S_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSecret) return null;

  if (cachedToken && Date.now() < cachedExpiry - 60_000) return cachedToken;

  const url = `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
  });
  if (!res.ok) {
    console.error('[ZoomPhone] Token exchange failed:', res.status, await res.text());
    return null;
  }
  const body = await res.json();
  cachedToken = body.access_token;
  cachedExpiry = Date.now() + (body.expires_in || 3600) * 1000;
  return cachedToken;
}

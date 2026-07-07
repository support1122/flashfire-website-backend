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

const ZOOM_API = 'https://api.zoom.us/v2';

/** Small authenticated GET against the Zoom API. Returns parsed JSON or throws. */
async function zoomGet(path, token) {
  const res = await fetch(`${ZOOM_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Zoom ${res.status} ${path}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * Parse the static caller-ID fallback config.
 * ZOOM_CALLER_IDS = JSON array like:
 *   [{"number":"+15551230000","label":"Sales"},{"number":"+15559990000","label":"Support"}]
 * Returns [] when unset / unparseable (never throws).
 */
export function getConfiguredCallerIds() {
  const raw = process.env.ZOOM_CALLER_IDS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((n) => ({
        number: String(n.number || n.phone_number || '').trim(),
        label: n.label || n.name || null,
      }))
      .filter((n) => n.number);
  } catch {
    console.error('[ZoomPhone] ZOOM_CALLER_IDS is not valid JSON — ignoring');
    return [];
  }
}

// Per-agent caller-number cache (email -> { at, data }). Zoom number assignments
// change rarely, so a short TTL keeps the picker snappy without hammering the API.
const callerCache = new Map();
const CALLER_TTL_MS = 60_000;

/**
 * Resolve the phone numbers a given agent (by email) is allowed to place calls
 * from, annotated with whether each line is currently live/assigned.
 *
 * Strategy (matches the agreed design — live Zoom API with config fallback):
 *   1. GET /phone/users/{email}          -> the numbers assigned to this agent
 *   2. GET /phone/numbers?type=assigned  -> account numbers + status/label for annotation
 *   3. Merge labels from ZOOM_CALLER_IDS config
 *   4. If Zoom is not configured or every call fails, return the config list
 *
 * Never throws — always returns { numbers, source } so the picker still renders.
 *
 * @param {string} email
 * @returns {Promise<{ numbers: Array<{number:string,label:string|null,status:string,live:boolean}>, source: 'zoom'|'config'|'mixed'|'none' }>}
 */
export async function getAllowedCallerNumbersForAgent(email) {
  const key = String(email || '').toLowerCase();
  const cached = callerCache.get(key);
  if (cached && Date.now() - cached.at < CALLER_TTL_MS) return cached.data;

  const config = getConfiguredCallerIds();
  const configByDigits = new Map(config.map((c) => [normalizePhone(c.number), c]));

  const finish = (data) => {
    callerCache.set(key, { at: Date.now(), data });
    return data;
  };

  const liveStatus = (s) => {
    const v = String(s || '').toLowerCase();
    return v === '' || v === 'assigned' || v === 'available' || v === 'active' || v === 'ok';
  };

  let token = null;
  try {
    token = await getZoomAccessToken();
  } catch (e) {
    console.error('[ZoomPhone] token error while listing caller numbers:', e.message);
  }

  if (!token) {
    // No Zoom API access — fall back entirely to config.
    return finish({
      numbers: config.map((c) => ({ number: c.number, label: c.label, status: 'config', live: true })),
      source: config.length ? 'config' : 'none',
    });
  }

  // 2. Account numbers keyed by normalized digits, for status + label annotation.
  const accountByDigits = new Map();
  try {
    const acc = await zoomGet('/phone/numbers?type=assigned&page_size=100', token);
    for (const n of acc.phone_numbers || []) {
      const digits = normalizePhone(n.number);
      if (!digits) continue;
      accountByDigits.set(digits, {
        number: n.number,
        status: n.status || 'assigned',
        label:
          n.display_name ||
          n.assignee?.name ||
          n.site?.name ||
          null,
      });
    }
  } catch (e) {
    console.error('[ZoomPhone] list account numbers failed:', e.message);
  }

  // 1. Numbers assigned to this specific agent.
  let agentNumbers = [];
  if (key) {
    try {
      const user = await zoomGet(`/phone/users/${encodeURIComponent(key)}`, token);
      agentNumbers = (user.phone_numbers || [])
        .map((p) => p.number)
        .filter(Boolean);
    } catch (e) {
      // 404 = agent has no Zoom Phone user / not found. Not fatal.
      console.warn('[ZoomPhone] phone user lookup failed for', key, '-', e.message);
    }
  }

  // Choose the base set: prefer the agent's own assigned numbers; if none resolved,
  // offer every assigned account number so the picker is never empty.
  const baseDigits =
    agentNumbers.length > 0
      ? agentNumbers.map((num) => normalizePhone(num)).filter(Boolean)
      : [...accountByDigits.keys()];

  const seen = new Set();
  const numbers = [];
  for (const digits of baseDigits) {
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    const acc = accountByDigits.get(digits);
    const cfg = configByDigits.get(digits);
    const number =
      acc?.number ||
      cfg?.number ||
      (agentNumbers.find((n) => normalizePhone(n) === digits)) ||
      `+${digits}`;
    numbers.push({
      number,
      label: cfg?.label || acc?.label || null,
      status: acc?.status || 'assigned',
      live: liveStatus(acc?.status),
    });
  }

  // If Zoom gave us nothing usable, fall back to config.
  if (numbers.length === 0 && config.length) {
    return finish({
      numbers: config.map((c) => ({ number: c.number, label: c.label, status: 'config', live: true })),
      source: 'config',
    });
  }

  return finish({
    numbers,
    source: numbers.length && config.length ? 'mixed' : numbers.length ? 'zoom' : 'none',
  });
}

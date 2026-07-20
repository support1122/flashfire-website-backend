import { ensureCountryCode } from './ensureCountryCode.js';

/**
 * Country-code resolution for Google-Sheet Meta leads (upsertMetaLeadFromSheet ONLY).
 *
 * Problem: Meta instant forms let people type bare national numbers. The sheet then
 * delivers e.g. "9757489458" (an Indian mobile) with no "+91", and a blanket "+1"
 * default corrupts it. These campaigns attract both US and Indian leads, and a bare
 * 10-digit number starting 6-9 is valid in BOTH numbering plans by shape.
 *
 * Resolution order:
 *   1. Deterministic rules (no network):
 *      "+..."                          -> kept as-is (explicit country code)
 *      "00..."                         -> "+..." (international dialling prefix)
 *      leading "0" + 10 digits after   -> +91 (Indian trunk prefix, e.g. 09876543210)
 *      12 digits starting "91", then 6-9 -> +91 (Indian number written without "+")
 *      11 digits starting "1"          -> +1 (NANP with its country code)
 *      10 digits starting 2-5          -> +1 (Indian mobiles start 6-9, so US-only shape)
 *   2. Ambiguous 10 digits starting 6-9 -> Twilio Lookup v2 basic validation (free):
 *      the number is validated against BOTH the US and IN numbering plans.
 *      valid only as IN -> +91; valid only as US -> +1.
 *   3. Otherwise (both plans accept the shape, or Twilio unavailable) the
 *      number is stored as +1 with method 'wati-pending': the FIRST workflow
 *      WhatsApp send verifies it via WATI's isValidWhatsAppNumber response
 *      flag - if the +1 reading has no WhatsApp the sender flips to +91,
 *      retries once, and persists the working number on the lead
 *      (see the WhatsApp branch of WorkflowController.executeWorkflowStep).
 *   4. Anything else falls back to ensureCountryCode's +1 default.
 */

const TWILIO_LOOKUP_TIMEOUT_MS = 8000;

// digits -> { phone, method } so sheet re-syncs/merges don't re-hit Twilio.
const resolveCache = new Map();
const RESOLVE_CACHE_MAX = 5000;

let twilioClient = null;
let twilioInitFailed = false;

async function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (twilioInitFailed) return null;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    twilioInitFailed = true;
    console.warn('MetaSheetPhoneResolver: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set — using heuristic fallback only');
    return null;
  }
  try {
    const { default: twilio } = await import('twilio');
    twilioClient = twilio(sid, token);
    return twilioClient;
  } catch (e) {
    twilioInitFailed = true;
    console.error('MetaSheetPhoneResolver: failed to init Twilio client:', e.message);
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('twilio lookup timeout')), ms))
  ]);
}

/**
 * Twilio Lookup v2 basic validation (free tier): national number + CountryCode.
 * Returns true / false, or null when the lookup itself failed (network/auth/timeout).
 */
async function isValidInCountry(client, nationalDigits, countryCode) {
  try {
    const result = await withTimeout(
      client.lookups.v2.phoneNumbers(nationalDigits).fetch({ countryCode }),
      TWILIO_LOOKUP_TIMEOUT_MS
    );
    return result?.valid === true;
  } catch (e) {
    // 404 from Lookup means "not a parseable number for this country" -> invalid.
    if (e?.status === 404) return false;
    console.warn(`MetaSheetPhoneResolver: Twilio lookup failed for ${countryCode}:`, e.message);
    return null;
  }
}

function cacheAndReturn(key, value) {
  if (resolveCache.size >= RESOLVE_CACHE_MAX) resolveCache.clear();
  resolveCache.set(key, value);
  return value;
}

/**
 * Resolve a sheet-lead phone to E.164. Returns { phone, method } where method is one of:
 * 'empty' | 'explicit' | 'intl-prefix' | 'trunk-zero-in' | 'bare-91-in' | 'nanp-11' |
 * 'nanp-shape-us' | 'twilio-in' | 'twilio-us' | 'ambiguous-default-in' | 'default'.
 */
export async function resolveSheetLeadPhone(rawPhone) {
  if (rawPhone == null) return { phone: null, method: 'empty' };
  const raw = String(rawPhone).trim();
  if (!raw) return { phone: null, method: 'empty' };

  // Explicit country code: keep it, just normalise formatting.
  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    return { phone: digits ? `+${digits}` : raw, method: 'explicit' };
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) return { phone: raw, method: 'empty' };

  const cached = resolveCache.get(digits);
  if (cached) return cached;

  // "00" international dialling prefix -> explicit country code.
  if (digits.startsWith('00') && digits.length > 4) {
    return cacheAndReturn(digits, { phone: `+${digits.slice(2)}`, method: 'intl-prefix' });
  }

  // Indian trunk prefix: 0 + 10-digit national number (e.g. 09876543210).
  if (digits.startsWith('0')) {
    const stripped = digits.replace(/^0+/, '');
    if (stripped.length === 10) {
      return cacheAndReturn(digits, { phone: `+91${stripped}`, method: 'trunk-zero-in' });
    }
  }

  // Indian number written with its country code but no "+" (919876543210).
  if (digits.length === 12 && digits.startsWith('91') && /[6-9]/.test(digits[2])) {
    return cacheAndReturn(digits, { phone: `+${digits}`, method: 'bare-91-in' });
  }

  // NANP number carrying its own "1".
  if (digits.length === 11 && digits.startsWith('1')) {
    return cacheAndReturn(digits, { phone: `+${digits}`, method: 'nanp-11' });
  }

  if (digits.length === 10) {
    const first = digits[0];

    // Indian mobiles start 6-9; a 10-digit number starting 2-5 can only be NANP.
    if (first >= '2' && first <= '5') {
      return cacheAndReturn(digits, { phone: `+1${digits}`, method: 'nanp-shape-us' });
    }

    if (first >= '6' && first <= '9') {
      const client = await getTwilioClient();
      if (client) {
        // Free basic validation against both plans: a number valid in only
        // one plan is decided here without wasting a WhatsApp send.
        const [validIn, validUs] = await Promise.all([
          isValidInCountry(client, digits, 'IN'),
          isValidInCountry(client, digits, 'US')
        ]);
        if (validIn === true && validUs !== true) {
          return cacheAndReturn(digits, { phone: `+91${digits}`, method: 'twilio-in' });
        }
        if (validUs === true && validIn !== true) {
          return cacheAndReturn(digits, { phone: `+1${digits}`, method: 'twilio-us' });
        }
      }
      // Both plans accept the shape (or Twilio was unavailable). Product
      // rule: store +1 first; the FIRST workflow WhatsApp send verifies it
      // through WATI's isValidWhatsAppNumber flag and flips to +91 with a
      // retry when the +1 reading has no WhatsApp. The working number is
      // then persisted on the lead for all future sends.
      return cacheAndReturn(digits, { phone: `+1${digits}`, method: 'wati-pending' });
    }
  }

  // Everything else: ensureCountryCode's existing behavior (+1 default / bare "+").
  return cacheAndReturn(digits, { phone: ensureCountryCode(raw), method: 'default' });
}

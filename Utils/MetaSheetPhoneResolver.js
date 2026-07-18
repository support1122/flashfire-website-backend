import { ensureCountryCode } from './ensureCountryCode.js';
import { whapiConfigured, hasWhatsApp } from './WhapiExistenceCheck.js';

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
 *   3. Both valid -> Whapi.cloud WhatsApp existence check (product rule,
 *      needs WHAPI_API_TOKEN; same service the dashboard backend uses):
 *      check +1 first - if the US number is on WhatsApp, send there;
 *      otherwise if the IN number is on WhatsApp, use +91.
 *   4. Whapi unavailable/inconclusive -> Twilio Line Type Intelligence
 *      (paid, ~$0.008/lookup, disable with TWILIO_LOOKUP_LINE_TYPE=false):
 *      a REAL mobile beats a VoIP/landline/toll-free shell.
 *   5. Still tied or all lookups unavailable -> +91 (funnel rule: 6-9 leads
 *      are overwhelmingly Indian in this funnel).
 *   6. Anything else falls back to ensureCountryCode's +1 default.
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

function lineTypeLookupEnabled() {
  const v = String(process.env.TWILIO_LOOKUP_LINE_TYPE ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'off';
}

/**
 * Twilio Line Type Intelligence (paid, ~$0.008/lookup). Returns
 * { type, carrier } (type e.g. 'mobile' | 'nonFixedVoip' | 'landline' |
 * 'tollFree' | ...) or null when the lookup failed or returned no data.
 */
async function getLineType(client, nationalDigits, countryCode) {
  try {
    const result = await withTimeout(
      client.lookups.v2.phoneNumbers(nationalDigits).fetch({
        countryCode,
        fields: 'line_type_intelligence'
      }),
      TWILIO_LOOKUP_TIMEOUT_MS
    );
    const lti = result?.lineTypeIntelligence;
    if (!lti || !lti.type) return null;
    return { type: lti.type, carrier: lti.carrier_name || null };
  } catch (e) {
    console.warn(`MetaSheetPhoneResolver: line-type lookup failed for ${countryCode}:`, e.message);
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
        // Round 1 - free basic validation against both plans.
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

        // Round 2 - both plans accept the shape. Product rule via Whapi
        // WhatsApp existence: +1 first - if the US number has WhatsApp the
        // sends go there; else the IN number if it has WhatsApp. A stranger
        // can own the other country's number, so this order is a deliberate
        // product decision; falls through to line-type evidence when Whapi
        // is unconfigured or cannot answer.
        if (validIn === true && validUs === true && whapiConfigured()) {
          const usExists = await hasWhatsApp(`+1${digits}`);
          if (usExists === true) {
            console.log(`MetaSheetPhoneResolver: ${digits} -> +1 has WhatsApp (Whapi)`);
            return cacheAndReturn(digits, { phone: `+1${digits}`, method: 'whapi-us' });
          }
          if (usExists === false) {
            const inExists = await hasWhatsApp(`+91${digits}`);
            if (inExists === true) {
              console.log(`MetaSheetPhoneResolver: ${digits} -> +1 has no WhatsApp, +91 does (Whapi)`);
              return cacheAndReturn(digits, { phone: `+91${digits}`, method: 'whapi-in' });
            }
            if (inExists === false) {
              console.log(`MetaSheetPhoneResolver: ${digits} -> no WhatsApp on either reading (Whapi); falling back to line-type evidence`);
            }
          }
          // usExists/inExists null (Whapi error) or neither on WhatsApp ->
          // fall through to Line Type Intelligence below.
        }

        // Round 3 - paid Line Type Intelligence:
        // a real mobile beats a VoIP/landline/toll-free shell.
        if (validIn === true && validUs === true && lineTypeLookupEnabled()) {
          const [ltiIn, ltiUs] = await Promise.all([
            getLineType(client, digits, 'IN'),
            getLineType(client, digits, 'US')
          ]);
          const inMobile = ltiIn?.type === 'mobile';
          const usMobile = ltiUs?.type === 'mobile';
          if (inMobile && !usMobile) {
            console.log(`MetaSheetPhoneResolver: ${digits} -> IN mobile (${ltiIn.carrier || 'unknown carrier'}), US is ${ltiUs?.type || 'unknown'}`);
            return cacheAndReturn(digits, { phone: `+91${digits}`, method: 'lti-mobile-in' });
          }
          if (usMobile && !inMobile) {
            console.log(`MetaSheetPhoneResolver: ${digits} -> US mobile (${ltiUs.carrier || 'unknown carrier'}), IN is ${ltiIn?.type || 'unknown'}`);
            return cacheAndReturn(digits, { phone: `+1${digits}`, method: 'lti-mobile-us' });
          }
          if (inMobile && usMobile) {
            // Genuine collision: two real subscribers share these 10 digits
            // (e.g. T-Mobile US and Airtel IN). Only lead context could tell
            // them apart; the funnel rule says India.
            console.log(`MetaSheetPhoneResolver: ${digits} -> mobile in BOTH (IN: ${ltiIn.carrier}, US: ${ltiUs.carrier}); defaulting to IN`);
            return cacheAndReturn(digits, { phone: `+91${digits}`, method: 'lti-collision-default-in' });
          }
          // Neither side is a mobile, or LTI failed - fall through to the default.
        }
      }
      // Twilio unavailable, inconclusive, or line-type lookup disabled ->
      // product rule: 6-9 leads in this funnel default to India.
      return cacheAndReturn(digits, { phone: `+91${digits}`, method: 'ambiguous-default-in' });
    }
  }

  // Everything else: ensureCountryCode's existing behavior (+1 default / bare "+").
  return cacheAndReturn(digits, { phone: ensureCountryCode(raw), method: 'default' });
}

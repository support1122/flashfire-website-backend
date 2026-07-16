/**
 * Ensure a phone number carries an explicit country code, defaulting to +1 (US/Canada)
 * when none is present. A number that already specifies a country code is left as-is —
 * only the formatting is cleaned to E.164 ("+<digits>").
 *
 * Why this exists: Meta / Google-Sheet leads routinely arrive as bare national numbers
 * (e.g. "3346694343"). WhatsApp / Wati then GUESS the country from the leading digits
 * ("33" -> France: +33 46694343), corrupting the number and the contact. Pinning a
 * default of +1 for country-code-less numbers stops that guess.
 *
 * Rules (bare = digits only, no "+"):
 *   "+..."                         -> kept              (explicit country code)
 *   "00..."                        -> "+..."            (international prefix -> +)
 *   bare, 10 digits                -> "+1" + digits     (NANP national -> default +1)
 *   bare, 11 digits starting "1"   -> "+" + digits      (NANP with country code)
 *   bare, 11+ digits otherwise     -> "+" + digits      (already carries a country code)
 *   bare, < 10 digits              -> "+1" + digits     (best-effort default)
 *
 * A 10-digit bare number is treated as NANP because that is the length of a US/Canada
 * national number and these leads are North-America-targeted; longer bare numbers are
 * assumed to already include their own country code, so they are only prefixed with "+"
 * rather than an extra "+1".
 *
 * Returns a clean "+<digits>" string, or the original trimmed value when the input has
 * no usable digits.
 */
export function ensureCountryCode(phone, defaultCountryCode = '1') {
  if (phone == null) return phone;
  const raw = String(phone).trim();
  if (!raw) return raw;

  // Already explicitly international: keep the country code, normalise formatting.
  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : raw;
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;

  // "00" international dialling prefix (e.g. "0033...") -> "+".
  if (digits.startsWith('00') && digits.length > 4) {
    return `+${digits.slice(2)}`;
  }

  // NANP national number (US/Canada) with no country code -> default +1.
  if (digits.length === 10) {
    return `+${defaultCountryCode}${digits}`;
  }
  // NANP number that already carries its "1" country code.
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  // Longer bare numbers already include some country code; just make it explicit.
  if (digits.length >= 11) {
    return `+${digits}`;
  }
  // Shorter than a full national number: best-effort default.
  return `+${defaultCountryCode}${digits}`;
}

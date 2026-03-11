/**
 * Normalize phone number for matching (strip country code / use last 10 digits).
 * Used to sync leads by Email + Phone without country code (e.g. Meta leads with existing leads).
 */
export function normalizePhoneForMatching(phone) {
  if (!phone) return null;

  const cleaned = String(phone).replace(/[\s\-\(\)]/g, '');

  if (cleaned.startsWith('+1') && cleaned.length >= 12) {
    return cleaned.slice(-10);
  }
  if (cleaned.startsWith('1') && cleaned.length >= 11 && /^\d+$/.test(cleaned)) {
    return cleaned.slice(-10);
  }
  if (cleaned.length >= 10 && /^\d+$/.test(cleaned)) {
    return cleaned.slice(-10);
  }

  const digitsOnly = cleaned.replace(/\D/g, '');
  return digitsOnly.length >= 10 ? digitsOnly.slice(-10) : null;
}

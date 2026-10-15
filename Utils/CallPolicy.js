// Which destinations we do not place automated reminder calls to (WhatsApp/Discord reminders still run).
// Comma-separated E.164 prefixes in TWILIO_SKIP_CALL_PREFIXES. Default blocks Germany (+49): calls to
// German mobiles cost about $0.37 each, roughly 10x a UK call. Set the env var to "none" to call everywhere.
const raw = process.env.TWILIO_SKIP_CALL_PREFIXES;

export function getSkippedCallPrefixes() {
  if (raw && raw.trim().toLowerCase() === 'none') return [];
  return (raw === undefined ? '+49' : raw)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Returns the matching blocked prefix for this number, or null when the call is allowed. */
export function skippedCallPrefixFor(phoneNumber) {
  const phone = String(phoneNumber || '').replace(/[\s\-().]/g, '');
  const normalized = phone.startsWith('00') ? `+${phone.slice(2)}` : phone;
  return getSkippedCallPrefixes().find((prefix) => normalized.startsWith(prefix)) || null;
}

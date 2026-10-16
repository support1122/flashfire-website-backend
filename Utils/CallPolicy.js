// Which destinations we do not place automated reminder calls to (WhatsApp/Discord reminders still run).
//
// Rules come from TWILIO_SKIP_CALL_PREFIXES, comma-separated E.164 prefixes. A rule may carry a UTC date
// window so the block lifts itself: "+33@2026-10-16..2026-10-31" skips French numbers only when the
// CALL is due between those two dates, both inclusive. Either end may be left empty ("+33@..2026-10-31",
// "+33@2026-10-16.."). A rule with no "@" is always on. Set the variable to "none" to call everywhere.
//
// Defaults (when the variable is unset):
//   +49                              Germany, always: German mobiles cost about $0.37 per call, roughly 10x UK.
//   +33@2026-10-16..2026-10-31       France, paused for the second half of October 2026.
const DEFAULT_RULES = '+49,+33@2026-10-16..2026-10-31';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse the env value into [{ prefix, from, to }]. Bad windows are ignored with a warning, never thrown. */
export function getSkippedCallRules() {
  const raw = process.env.TWILIO_SKIP_CALL_PREFIXES;
  if (raw && raw.trim().toLowerCase() === 'none') return [];
  const rules = [];
  for (const part of (raw === undefined ? DEFAULT_RULES : raw).split(',')) {
    const item = part.trim();
    if (!item) continue;
    const [prefix, window] = item.split('@');
    if (window === undefined) {
      rules.push({ prefix, from: null, to: null });
      continue;
    }
    const [from = '', to = ''] = window.split('..');
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
      console.warn(`[CallPolicy] ignoring rule with bad date window: "${item}" (expected +33@YYYY-MM-DD..YYYY-MM-DD)`);
      continue;
    }
    rules.push({ prefix, from: from || null, to: to || null });
  }
  return rules;
}

/** Back-compat: just the prefixes, ignoring windows. */
export function getSkippedCallPrefixes() {
  return getSkippedCallRules().map((r) => r.prefix);
}

/**
 * Returns the matching rule label for this number, or null when the call is allowed.
 * `when` is when the call is due (Date or ISO string); it defaults to now. The window is compared as a UTC date.
 */
export function skippedCallPrefixFor(phoneNumber, when = new Date()) {
  const phone = String(phoneNumber || '').replace(/[\s\-().]/g, '');
  const normalized = phone.startsWith('00') ? `+${phone.slice(2)}` : phone;
  const at = new Date(when);
  const day = Number.isNaN(at.getTime()) ? new Date().toISOString().slice(0, 10) : at.toISOString().slice(0, 10);
  const rule = getSkippedCallRules().find(
    (r) => normalized.startsWith(r.prefix) && (!r.from || day >= r.from) && (!r.to || day <= r.to),
  );
  return rule ? rule.prefix : null;
}

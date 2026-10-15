import { DateTime, IANAZone } from 'luxon';

// Pure helpers for Sales Lead Allocation: no database, no network, so they are unit tested directly.

export const CRM_BASE_URL = 'https://flashfire-crm.vercel.app';
export const IST_ZONE = 'Asia/Kolkata';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IST_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NAME = 200;
const MAX_NOTE = 2000;

export const crmLinkFor = (allocationId) =>
  `${CRM_BASE_URL}/?tab=sales_allocation&id=${encodeURIComponent(allocationId)}`;

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  return IANAZone.isValidZone(tz.trim());
}

/** Digits with an optional leading +. Returns null unless there are 5 to 15 digits. */
export function normalizePhone(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 5 || digits.length > 15) return null;
  return (s.startsWith('+') ? '+' : '') + digits;
}

export function normalizeEmail(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  return s || null;
}

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The IST calendar date ('YYYY-MM-DD') of an instant. Leave days are stored in this form. */
export function istDayOf(instant) {
  const dt = instant instanceof Date ? DateTime.fromJSDate(instant) : DateTime.fromISO(String(instant));
  if (!dt.isValid) return null;
  return dt.setZone(IST_ZONE).toFormat('yyyy-MM-dd');
}

/** [start, end) of an IST calendar day as Dates. */
export function istDayBounds(day) {
  if (!IST_DAY_RE.test(String(day))) return null;
  const start = DateTime.fromISO(day, { zone: IST_ZONE }).startOf('day');
  if (!start.isValid) return null;
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** True when the BDA's profile lists the IST day of `callAt` as an approved leave day. */
export function isOnLeaveAt(leaveDays, callAt) {
  const day = istDayOf(callAt);
  return Boolean(day && Array.isArray(leaveDays) && leaveDays.includes(day));
}

/** Parse an ISO string that carries an explicit offset or Z. Returns a Date or null. */
export function parseInstant(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  // A bare local time would be read in the server zone and silently shift the call, so require an offset.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) return null;
  const dt = DateTime.fromISO(s, { setZone: true });
  return dt.isValid ? dt.toUTC().toJSDate() : null;
}

/** e.g. "Thu, Oct 15, 2026, 9:30 PM EDT". IST gets the abbreviation "IST" because ICU prints GMT+5:30. */
export function formatInZone(instant, zone) {
  const dt = (instant instanceof Date ? DateTime.fromJSDate(instant) : DateTime.fromISO(String(instant)));
  if (!dt.isValid) return 'Unknown';
  const z = isValidTimeZone(zone) ? zone.trim() : IST_ZONE;
  const local = dt.setZone(z);
  const abbr = z === IST_ZONE ? 'IST' : local.offsetNameShort || z;
  return `${local.toFormat('ccc, LLL d, yyyy, h:mm a')} ${abbr}`;
}

/**
 * Validate the POST body. Returns { error: { code, message } } or { value } with normalised fields.
 * `now` is injectable for tests.
 */
export function validateAllocationInput(body, now = new Date()) {
  const b = body && typeof body === 'object' ? body : {};
  const bad = (code, message) => ({ error: { code, message } });

  const clientName = String(b.clientName ?? '').trim();
  if (!clientName) return bad('invalid_client_name', 'clientName is required');
  if (clientName.length > MAX_NAME) return bad('invalid_client_name', `clientName must be at most ${MAX_NAME} characters`);

  const phoneRaw = b.phone == null ? '' : String(b.phone).trim();
  const emailRaw = b.email == null ? '' : String(b.email).trim();
  if (!phoneRaw && !emailRaw) return bad('contact_required', 'Provide at least one of phone or email');

  const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
  if (phoneRaw && !phone) return bad('invalid_phone', 'phone must have 5 to 15 digits');
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  if (emailRaw && !EMAIL_RE.test(email)) return bad('invalid_email', 'email is not valid');

  if (!isValidTimeZone(b.timezone)) return bad('invalid_timezone', 'timezone must be a valid IANA zone, e.g. America/New_York');
  const timezone = String(b.timezone).trim();

  const callAt = parseInstant(b.callAt);
  if (!callAt) return bad('invalid_call_time', 'callAt must be an ISO timestamp with a UTC offset or Z');
  if (callAt.getTime() < now.getTime() - 60 * 1000) return bad('call_in_past', 'callAt must be in the future');

  const bdaEmail = normalizeEmail(b.bdaEmail);
  if (!bdaEmail) return bad('invalid_bda', 'bdaEmail is required');

  const notes = b.notes == null ? null : String(b.notes).trim().slice(0, MAX_NOTE) || null;

  return { value: { clientName, phone, email, timezone, callAt, bdaEmail, notes } };
}

export function buildReminderMessage(a) {
  const bdaName = a.bdaName || String(a.bdaEmail || '').split('@')[0] || 'BDA';
  const url = a.crmUrl || crmLinkFor(a.allocationId);
  return [
    '📞 **Call to make in ~5 minutes**',
    '',
    `**Client:** ${a.clientName}`,
    `**Phone:** ${a.phone || 'n/a'}`,
    `**Email:** ${a.email || 'n/a'}`,
    `**Time (Client):** ${formatInZone(a.callAt, a.timezone)} (${a.timezone})`,
    `**Time (India):** ${formatInZone(a.callAt, IST_ZONE)}`,
    `**Assigned BDA:** ${bdaName}`,
    `**Open in CRM:** ${url}`,
    '',
    `${bdaName}, this call is yours. Open the link above and make the call.`,
  ].join('\n');
}

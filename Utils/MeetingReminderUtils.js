/**
 * Shared parsing, phone normalization, and reminder id helpers for
 * CallScheduler, WhatsAppReminderScheduler, DiscordMeetReminderScheduler, and Calendly webhooks.
 */
import { DateTime, IANAZone } from 'luxon';

/**
 * Parse Calendly / API instants reliably (correct UTC instant).
 * ISO without offset is interpreted in UTC (avoids host TZ shifting the meeting).
 */
export function parseMeetingStartToDate(meetingStartISO) {
  if (meetingStartISO == null) return null;
  if (meetingStartISO instanceof Date) {
    return Number.isNaN(meetingStartISO.getTime()) ? null : meetingStartISO;
  }
  const s = String(meetingStartISO).trim();
  if (!s) return null;

  const withZone = DateTime.fromISO(s, { setZone: true });
  if (withZone.isValid) {
    return withZone.toUTC().toJSDate();
  }

  const asUtcWall = DateTime.fromISO(s, { zone: 'utc' });
  if (asUtcWall.isValid) {
    return asUtcWall.toJSDate();
  }

  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Normalize phone for consistent reminder keys (matches Calendly create path).
 */
export function normalizePhoneForReminders(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(/\s+/g, '').replace(/(?!^\+)\D/g, '');
  if (!s) return null;
  return s;
}

function phoneFromQuestionsAndAnswers(qaList) {
  if (!Array.isArray(qaList)) return null;
  const row = qaList.find(
    (q) => q?.question && String(q.question).trim().toLowerCase() === 'phone number'
  );
  return row?.answer ?? null;
}

/**
 * Extract phone from full Calendly webhook payload (invitee.created shape).
 */
export function extractCalendlyPhoneFromPayload(payload) {
  if (!payload) return null;
  const topQa = phoneFromQuestionsAndAnswers(payload.questions_and_answers);
  const inv = payload.invitee || {};
  const invQa = phoneFromQuestionsAndAnswers(inv.questions_and_answers);
  const raw = topQa || invQa || inv.phone_number || payload.phone_number;
  return normalizePhoneForReminders(raw);
}

/**
 * Extract phone from Calendly invitee object (reschedule payload uses new_invitee).
 */
export function extractCalendlyPhoneFromInvitee(invitee) {
  if (!invitee) return null;
  const invQa = phoneFromQuestionsAndAnswers(invitee.questions_and_answers);
  const raw = invQa || invitee.phone_number;
  return normalizePhoneForReminders(raw);
}

/**
 * Collapse a US daylight/standard timezone abbreviation to its generic form.
 *
 * "EDT" is factually right between March and November, but clients read it as a typo
 * — almost nobody says "Eastern Daylight Time", they say EST year-round. Printing the
 * literal "EST" instead would be wrong for eight months of the year, so we print the
 * generic label, which is correct in every season and is what Calendly itself shows
 * ("Eastern Time - US & Canada").
 *
 *   EST / EDT   -> ET
 *   CST / CDT   -> CT
 *   MST / MDT   -> MT
 *   PST / PDT   -> PT
 *
 * Anything else (IST, HST, AKST, GMT+1, ...) is returned untouched: those are either
 * unambiguous already or outside the US convention this addresses.
 */
const US_TZ_GENERIC = {
  EST: 'ET', EDT: 'ET',
  CST: 'CT', CDT: 'CT',
  MST: 'MT', MDT: 'MT',
  PST: 'PT', PDT: 'PT',
};

// Map GMT offset labels → readable abbreviations for non-US timezones
const OFFSET_TO_ABBR = {
  'GMT+0': 'GMT', 'GMT-0': 'GMT',
  'GMT+1': 'BST',   // UK summer (British Summer Time)
  'GMT+2': 'CEST',  // Central Europe summer
  'GMT+3': 'MSK',   // Moscow
  'GMT+4': 'GST',   // Gulf
  'GMT+5': 'PKT',   // Pakistan
  'GMT+5:30': 'IST', // India
  'GMT+6': 'BST',   // Bangladesh
  'GMT+7': 'ICT',   // Indochina
  'GMT+8': 'SGT',   // Singapore/HK
  'GMT+9': 'JST',   // Japan
  'GMT+10': 'AEST', // Australia East
  'GMT+11': 'AEDT', // Australia East DST
  'GMT-3': 'ART',   // Argentina
  'GMT-4': 'AST',   // Atlantic
  'GMT-5': 'ET',    // Eastern (standard)
  'GMT-6': 'CT',    // Central (standard)
  'GMT-7': 'MT',    // Mountain (standard)
  'GMT-8': 'PT',    // Pacific (standard)
};

/**
 * Display policy: show every client the meeting in ONE timezone, labelled "EST".
 *
 * Requested deliberately. The trade-off, stated plainly: a client outside Eastern
 * reads a time that does not match their own clock — a 2pm Los Angeles meeting is
 * announced as 5pm — so they must convert. "EST" is also the standard-time label,
 * which is inaccurate between March and November when Eastern is on EDT.
 *
 * Set REMINDER_FORCE_EASTERN=false to go back to per-client local time with the
 * generic labels (ET / CT / MT / PT) that normalizeTimezoneLabel produces.
 */
export const FORCE_EASTERN_DISPLAY =
  String(process.env.REMINDER_FORCE_EASTERN ?? 'true').toLowerCase() !== 'false';
export const EASTERN_DISPLAY_ZONE = 'America/New_York';
export const EASTERN_DISPLAY_LABEL = 'EST';

// IANA timezone → Calendly-style friendly label (matched exactly from Calendly UI)
const IANA_TO_FRIENDLY = {
  // US / Canada
  'America/New_York':                   'Eastern Time - US & Canada',
  'America/Detroit':                    'Eastern Time - US & Canada',
  'America/Indiana/Indianapolis':       'Eastern Time - US & Canada',
  'America/Toronto':                    'Eastern Time - US & Canada',
  'America/Chicago':                    'Central Time - US & Canada',
  'America/Winnipeg':                   'Central Time - US & Canada',
  'America/Regina':                     'Saskatchewan, Guatemala, Costa Rica Time',
  'America/Guatemala':                  'Saskatchewan, Guatemala, Costa Rica Time',
  'America/Costa_Rica':                 'Saskatchewan, Guatemala, Costa Rica Time',
  'America/Denver':                     'Mountain Time - US & Canada',
  'America/Edmonton':                   'Mountain Time - US & Canada',
  'America/Phoenix':                    'Arizona, Yukon Time',
  'America/Whitehorse':                 'Arizona, Yukon Time',
  'America/Los_Angeles':                'Pacific Time - US & Canada',
  'America/Vancouver':                  'Vancouver Time',
  'America/Anchorage':                  'Alaska Time',
  'America/Juneau':                     'Alaska Time',
  'Pacific/Honolulu':                   'Hawaii Time',
  'America/Adak':                       'America/Adak',
  'America/Halifax':                    'Atlantic Time',
  'America/St_Johns':                   'Newfoundland Time',
  'America/Godthab':                    'America/Godthab',
  'America/Miquelon':                   'America/Miquelon',
  'America/Noronha':                    'America/Noronha',
  'America/Santa_Isabel':               'America/Santa Isabel',
  'America/Mazatlan':                   'America/Mazatlan',
  'America/Havana':                     'America/Havana',
  // America
  'America/Mexico_City':                'Mexico City Time',
  'America/Monterrey':                  'Mexico City Time',
  'America/Bogota':                     'Bogota, Jamaica, Lima Time',
  'America/Jamaica':                    'Bogota, Jamaica, Lima Time',
  'America/Lima':                       'Bogota, Jamaica, Lima Time',
  'America/Caracas':                    'Caracas Time',
  'America/Asuncion':                   'Asuncion Time',
  'America/Campo_Grande':               'America/Campo Grande',
  'America/Santiago':                   'Santiago Time',
  'America/Sao_Paulo':                  'Brasilia Time',
  'America/Argentina/Buenos_Aires':     'Buenos Aires Time',
  'America/Montevideo':                 'Montevideo Time',
  // Africa
  'Africa/Lagos':                       'West Africa Time',
  'Africa/Bangui':                      'West Africa Time',
  'Africa/Cairo':                       'Africa/Cairo',
  'Africa/Casablanca':                  'Africa/Cairo',
  'Africa/Nairobi':                     'Baghdad, East Africa Time',
  'Africa/Addis_Ababa':                 'Baghdad, East Africa Time',
  'Africa/Johannesburg':                'Central Africa Time',
  'Africa/Harare':                      'Central Africa Time',
  'Africa/Abidjan':                     'UTC Time',
  'Africa/Accra':                       'UTC Time',
  // Europe
  'Europe/London':                      'UK, Ireland, Lisbon Time',
  'Europe/Dublin':                      'UK, Ireland, Lisbon Time',
  'Atlantic/Reykjavik':                 'UK, Ireland, Lisbon Time',
  'Europe/Lisbon':                      'UK, Ireland, Lisbon Time',
  'Europe/Paris':                       'Central European Time',
  'Europe/Berlin':                      'Central European Time',
  'Europe/Rome':                        'Central European Time',
  'Europe/Madrid':                      'Central European Time',
  'Europe/Amsterdam':                   'Central European Time',
  'Europe/Brussels':                    'Central European Time',
  'Europe/Warsaw':                      'Central European Time',
  'Europe/Stockholm':                   'Central European Time',
  'Europe/Prague':                      'Central European Time',
  'Europe/Vienna':                      'Central European Time',
  'Europe/Athens':                      'Eastern European Time',
  'Europe/Helsinki':                    'Eastern European Time',
  'Europe/Bucharest':                   'Eastern European Time',
  'Europe/Kiev':                        'Eastern European Time',
  'Europe/Riga':                        'Eastern European Time',
  'Europe/Sofia':                       'Eastern European Time',
  'Europe/Tallinn':                     'Eastern European Time',
  'Europe/Vilnius':                     'Eastern European Time',
  'Europe/Minsk':                       'Minsk Time',
  'Europe/Moscow':                      'Moscow Time',
  'Europe/Kaliningrad':                 'Moscow Time',
  'Europe/Volgograd':                   'Moscow Time',
  // Asia
  'Asia/Baghdad':                       'Baghdad, East Africa Time',
  'Asia/Kuwait':                        'Baghdad, East Africa Time',
  'Asia/Riyadh':                        'Baghdad, East Africa Time',
  'Asia/Jordan':                        'Jordan Time',
  'Asia/Beirut':                        'Lebanon Time',
  'Asia/Damascus':                      'Syria Time',
  'Asia/Gaza':                          'Asia/Gaza',
  'Asia/Dubai':                         'Dubai Time',
  'Asia/Muscat':                        'Dubai Time',
  'Asia/Baku':                          'Asia/Baku',
  'Asia/Tehran':                        'Tehran Time',
  'Asia/Kabul':                         'Kabul Time',
  'Asia/Karachi':                       'India, Sri Lanka Time',
  'Asia/Kolkata':                       'India, Sri Lanka Time',
  'Asia/Calcutta':                      'India, Sri Lanka Time',
  'Asia/Colombo':                       'India, Sri Lanka Time',
  'Asia/Kathmandu':                     'Kathmandu Time',
  'Asia/Katmandu':                      'Kathmandu Time',
  'Asia/Dhaka':                         'Asia/Dhaka',
  'Asia/Yekaterinburg':                 'Yekaterinburg Time',
  'Asia/Tashkent':                      'India, Sri Lanka Time',
  'Asia/Almaty':                        'India, Sri Lanka Time',
  'Asia/Rangoon':                       'Asia/Rangoon',
  'Asia/Bangkok':                       'Indochina Time',
  'Asia/Jakarta':                       'Indochina Time',
  'Asia/Krasnoyarsk':                   'Krasnoyarsk Time',
  'Asia/Omsk':                          'Asia/Omsk',
  'Asia/Shanghai':                      'China, Singapore, Perth',
  'Asia/Singapore':                     'China, Singapore, Perth',
  'Asia/Hong_Kong':                     'China, Singapore, Perth',
  'Asia/Kuala_Lumpur':                  'China, Singapore, Perth',
  'Asia/Manila':                        'China, Singapore, Perth',
  'Asia/Taipei':                        'China, Singapore, Perth',
  'Asia/Irkutsk':                       'Asia/Irkutsk',
  'Asia/Tokyo':                         'Japan, Korea Time',
  'Asia/Seoul':                         'Japan, Korea Time',
  'Asia/Vladivostok':                   'Asia/Vladivostok',
  'Asia/Yakutsk':                       'Asia/Yakutsk',
  // Australia
  'Australia/Perth':                    'Australia/Perth',
  'Australia/Darwin':                   'Australia/Darwin',
  'Australia/Eucla':                    'Australia/Eucla',
  'Australia/Adelaide':                 'Adelaide Time',
  'Australia/Brisbane':                 'Brisbane Time',
  'Australia/Sydney':                   'Sydney, Melbourne Time',
  'Australia/Melbourne':                'Sydney, Melbourne Time',
  'Australia/Lord_Howe':                'Australia/Lord Howe',
  // Pacific
  'Pacific/Auckland':                   'Auckland Time',
  'Pacific/Fiji':                       'Pacific/Fiji',
  'Pacific/Apia':                       'Pacific/Apia',
  'Pacific/Chatham':                    'Pacific/Chatham',
  'Pacific/Easter':                     'Pacific/Easter',
  'Pacific/Gambier':                    'Pacific/Gambier',
  'Pacific/Kiritimati':                 'Pacific/Kiritimati',
  'Pacific/Majuro':                     'Pacific/Majuro',
  'Pacific/Marquesas':                  'Pacific/Marquesas',
  'Pacific/Norfolk':                    'Pacific/Norfolk',
  'Pacific/Noumea':                     'Pacific/Noumea',
  'Pacific/Pago_Pago':                  'Pacific/Pago Pago',
  'Pacific/Pitcairn':                   'Pacific/Pitcairn',
  'Pacific/Tarawa':                     'Pacific/Tarawa',
  'Pacific/Tongatapu':                  'Pacific/Tongatapu',
  'Pacific/Guam':                       'Pacific/Guam',
  // UTC
  'UTC':                                'UTC Time',
  'Etc/UTC':                            'UTC Time',
  'Etc/GMT':                            'UTC Time',
  // Atlantic
  'Atlantic/Azores':                    'Azores Time',
  'Atlantic/Cape_Verde':                'Cape Verde Time',
};

/** Returns the Calendly-style friendly timezone label for any IANA zone, or null. */
export function getFriendlyTimezoneLabel(inviteeTimezone) {
  const tz = typeof inviteeTimezone === 'string' ? inviteeTimezone.trim() : '';
  return IANA_TO_FRIENDLY[tz] ?? null;
}

/** Zone the client-facing meeting time should be rendered in. */
export function displayZoneFor(inviteeTimezone) {
  const tz = typeof inviteeTimezone === 'string' ? inviteeTimezone.trim() : '';
  // If we have a friendly label for this timezone, show in their own zone
  if (IANA_TO_FRIENDLY[tz] && IANAZone.isValidZone(tz)) return tz;
  if (FORCE_EASTERN_DISPLAY) return EASTERN_DISPLAY_ZONE;
  return tz && IANAZone.isValidZone(tz) ? tz : EASTERN_DISPLAY_ZONE;
}

/**
 * Render "2:30pm – 2:45pm" plus "Tuesday Aug 25, 2026" for a meeting, in the zone
 * the display policy dictates. End defaults to start + 15 minutes.
 */
export function buildMeetingDisplay(meetingStartISO, meetingEndISO, inviteeTimezone) {
  const start = parseMeetingStartToDate(meetingStartISO);
  if (!start) return null;

  const zone = displayZoneFor(inviteeTimezone);
  const s = DateTime.fromJSDate(start, { zone: 'utc' }).setZone(zone);
  if (!s.isValid) return null;

  const rawEnd = parseMeetingStartToDate(meetingEndISO);
  const e = rawEnd
    ? DateTime.fromJSDate(rawEnd, { zone: 'utc' }).setZone(zone)
    : s.plus({ minutes: 15 });

  const fmt = (dt) => (dt.minute === 0 ? dt.toFormat('ha').toLowerCase() : dt.toFormat('h:mma').toLowerCase());

  return {
    meetingTime: `${fmt(s)} – ${fmt(e.isValid ? e : s.plus({ minutes: 15 }))}`,
    meetingDate: s.toFormat('EEEE MMM d, yyyy'),
    tzLabel: getFriendlyTimezoneLabel(inviteeTimezone) ?? (FORCE_EASTERN_DISPLAY ? EASTERN_DISPLAY_LABEL : normalizeTimezoneLabel(s.toFormat('z'))),
  };
}

export function normalizeTimezoneLabel(label) {
  if (label == null) return label;
  const raw = String(label).trim();
  if (!raw) return raw;
  return US_TZ_GENERIC[raw.toUpperCase()] ?? OFFSET_TO_ABBR[raw] ?? raw;
}

export function buildCallId(phoneNumber, meetingStartMs) {
  return `call_${phoneNumber}_${meetingStartMs}`;
}

export function buildWhatsAppReminderId(reminderType, phoneNumber, meetingStartMs) {
  return `whatsapp_reminder_${reminderType}_${phoneNumber}_${meetingStartMs}`;
}

const REMINDER_DRIFT_WARN_MS = Number(process.env.REMINDER_DRIFT_WARN_MS) || 120000;

/**
 * Log when execution happens meaningfully after scheduledFor (ops / drift detection).
 */
export function logReminderDrift(channel, id, scheduledFor, label = '') {
  if (!scheduledFor) return;
  const driftMs = Date.now() - new Date(scheduledFor).getTime();
  if (driftMs <= REMINDER_DRIFT_WARN_MS) return;
  console.warn(`[ReminderDrift] channel=${channel} id=${id} driftMs=${Math.round(driftMs)} ${label}`);
}

/**
 * Shared parsing, phone normalization, and reminder id helpers for
 * CallScheduler, WhatsAppReminderScheduler, DiscordMeetReminderScheduler, and Calendly webhooks.
 */
import { DateTime } from 'luxon';

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

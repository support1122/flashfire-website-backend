import { DateTime } from 'luxon';
import { getRescheduleLinkForBooking } from './CalendlyAPIHelper.js';

const DEFAULT_SCHEDULING_LINK = 'https://calendly.com/feedback-flashfire/15min';

// Fixed base of the "Reschedule" dynamic URL button on the
// flashfire_appointment_reminder_b template. The button URL is
// `https://calendly.com/{{6}}`, so we only send the path that comes AFTER this base.
const DEFAULT_BUTTON_TAIL = 'feedback-flashfire/15min';

/**
 * Extracts the path after https://calendly.com/ for a dynamic URL button whose
 * fixed base is https://calendly.com/. Unwraps Google-redirect links of the form
 * https://www.google.com/url?q=<encoded calendly url>&... first. Falls back to the
 * default scheduling path when no calendly.com URL is found (e.g. a raw Google
 * Meet link), so the button always resolves to a valid page even though the body
 * link may differ.
 */
export function calendlyButtonTail(link) {
  if (typeof link !== 'string') return DEFAULT_BUTTON_TAIL;

  let s = link.trim();

  // Unwrap Google redirect wrappers: .../url?q=<url-encoded calendly link>&sa=...
  const q = s.match(/[?&]q=([^&]+)/i);
  if (q) {
    try { s = decodeURIComponent(q[1]); } catch { /* keep original */ }
  }

  const match = s.match(/https?:\/\/calendly\.com\/(.+)$/i);
  if (match) return match[1];

  return DEFAULT_BUTTON_TAIL;
}

/**
 * Resolves timezone abbreviation from IANA timezone name.
 */
function getTimezoneAbbreviation(timezone, meetingStart) {
  if (!timezone || !meetingStart) return 'ET';

  try {
    const meetingStartUTC = DateTime.fromJSDate(new Date(meetingStart), { zone: 'utc' });
    const meetingInTimezone = meetingStartUTC.setZone(timezone);
    const offset = meetingInTimezone.offset / 60;

    if (timezone.includes('Los_Angeles') || timezone.includes('Pacific')) {
      return offset === -8 ? 'PST' : 'PDT';
    }
    if (timezone.includes('New_York') || timezone.includes('Eastern')) {
      return offset === -5 ? 'ET' : 'EDT';
    }
    if (timezone.includes('Chicago') || timezone.includes('Central')) {
      return offset === -6 ? 'CT' : 'CDT';
    }
    if (timezone.includes('Denver') || timezone.includes('Mountain')) {
      return offset === -7 ? 'MT' : 'MDT';
    }

    if (offset === -8 || offset === -7) return 'PST';
    if (offset === -5 || offset === -4) return 'ET';
    if (offset === -6) return 'CT';

    return 'ET';
  } catch {
    return 'ET';
  }
}

/**
 * Builds meeting time parameters (date, time with timezone) from booking data.
 * Used by cancelled1 and flashfire_appointment_reminder templates.
 */
function buildMeetingTimeParams(booking) {
  const rawStart = booking.scheduledEventStartTime;
  if (rawStart == null || rawStart === '') {
    throw new Error('scheduledEventStartTime is missing for template');
  }
  const meetingStart = rawStart instanceof Date ? rawStart : new Date(rawStart);
  if (Number.isNaN(meetingStart.getTime())) {
    throw new Error('scheduledEventStartTime is not a valid date');
  }
  const meetingStartUTC = DateTime.fromJSDate(meetingStart, { zone: 'utc' });
  if (!meetingStartUTC.isValid) {
    throw new Error('Could not parse scheduledEventStartTime for template');
  }
  let meetingEndUTC;
  if (booking.scheduledEventEndTime) {
    const rawEnd = booking.scheduledEventEndTime instanceof Date
      ? booking.scheduledEventEndTime
      : new Date(booking.scheduledEventEndTime);
    meetingEndUTC = Number.isNaN(rawEnd.getTime())
      ? meetingStartUTC.plus({ minutes: 15 })
      : DateTime.fromJSDate(rawEnd, { zone: 'utc' });
    if (!meetingEndUTC.isValid) {
      meetingEndUTC = meetingStartUTC.plus({ minutes: 15 });
    }
  } else {
    meetingEndUTC = meetingStartUTC.plus({ minutes: 15 });
  }

  const meetingDateFormatted = meetingStartUTC.setZone('America/New_York').toFormat('MMM d');

  const startTimeET = meetingStartUTC.setZone('America/New_York');
  const startTimeFormatted = startTimeET.minute === 0
    ? startTimeET.toFormat('ha').toLowerCase()
    : startTimeET.toFormat('h:mma').toLowerCase();

  const endTimeET = meetingEndUTC.setZone('America/New_York');
  const endTimeFormatted = endTimeET.minute === 0
    ? endTimeET.toFormat('ha').toLowerCase()
    : endTimeET.toFormat('h:mma').toLowerCase();

  const meetingTimeFormatted = `${startTimeFormatted} – ${endTimeFormatted}`;

  const timezone = booking.inviteeTimezone
    ? getTimezoneAbbreviation(booking.inviteeTimezone, booking.scheduledEventStartTime)
    : 'ET';

  return {
    meetingDateFormatted,
    meetingTimeWithTimezone: `${meetingTimeFormatted} ${timezone}`
  };
}

/**
 * Resolves a reschedule link from booking data or Calendly API.
 */
async function resolveRescheduleLink(booking) {
  if (booking.calendlyRescheduleLink) {
    return booking.calendlyRescheduleLink;
  }

  try {
    const fetched = await getRescheduleLinkForBooking(booking);
    if (fetched) return fetched;
  } catch (error) {
    console.warn('[TemplateParameterBuilder] Could not fetch reschedule link:', error.message);
  }

  return DEFAULT_SCHEDULING_LINK;
}

/**
 * Template parameter builder registry.
 * Each builder takes { booking, step, executedAt } and returns an array of parameter values.
 */
const builders = {
  finalkk: ({ booking, step, executedAt }) => {
    const planName = booking.paymentPlan?.name || step?.templateConfig?.planName || 'PRIME';
    const days = booking.planDetails?.days || step?.templateConfig?.days || 7;

    const reminderDate = new Date(executedAt || Date.now());
    reminderDate.setDate(reminderDate.getDate() + days);
    const formattedDate = reminderDate.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric'
    });

    return [
      booking.clientName || 'Valued Client',
      planName,
      formattedDate
    ];
  },

  // plan_followup_123: single variable {{1}} = client name.
  plan_followup_123: ({ booking }) => {
    return [
      booking.clientName || 'Valued Client'
    ];
  },

  plan_followup_utility_01dd: ({ booking, step }) => {
    const DEFAULT_PLAN_PRICE = 349;
    const rawPlanPrice = booking.paymentPlan?.price ?? step?.templateConfig?.planAmount;
    const planPrice = typeof rawPlanPrice === 'number' && rawPlanPrice > 0 ? rawPlanPrice : DEFAULT_PLAN_PRICE;

    let planAmount = booking.paymentPlan?.displayPrice;
    const normalized = typeof planAmount === 'string' ? planAmount.trim() : '';
    const lower = normalized.toLowerCase();
    const isValid = !!normalized && lower !== 'null' && lower !== 'undefined' && lower !== '$null' && lower !== '$undefined';

    return [
      booking.clientName || 'Valued Client',
      isValid ? normalized : `$${planPrice}`
    ];
  },

  meta_1: async ({ booking, step }) => {
    const schedulingLink = step?.templateConfig?.schedulingLink
      || booking.calendlyRescheduleLink
      || DEFAULT_SCHEDULING_LINK;

    return [
      booking.clientName || 'Valued Client',
      schedulingLink
    ];
  },

  meta_2: async ({ booking, step }) => {
    const schedulingLink = step?.templateConfig?.schedulingLink
      || booking.calendlyRescheduleLink
      || DEFAULT_SCHEDULING_LINK;

    return [
      booking.clientName || 'Valued Client',
      schedulingLink
    ];
  },

  meta_31: async ({ booking, step }) => {
    const schedulingLink = step?.templateConfig?.schedulingLink
      || booking.calendlyRescheduleLink
      || DEFAULT_SCHEDULING_LINK;

    return [
      booking.clientName || 'Valued Client',
      schedulingLink
    ];
  },

  meta_41: async ({ booking, step }) => {
    const schedulingLink = step?.templateConfig?.schedulingLink
      || booking.calendlyRescheduleLink
      || DEFAULT_SCHEDULING_LINK;

    return [
      booking.clientName || 'Valued Client',
      schedulingLink
    ];
  },

  cancelled1: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for cancelled1 template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const rescheduleLink = await resolveRescheduleLink(booking);

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      rescheduleLink
    ];
  },

  flashfire_appointment_reminder: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for flashfire_appointment_reminder template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const meetingLink = booking.calendlyMeetLink || booking.googleMeetUrl || booking.meetingVideoUrl || 'Not Provided';
    const rescheduleLink = await resolveRescheduleLink(booking);

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      meetingLink,
      rescheduleLink
    ];
  },

  // Same body as flashfire_appointment_reminder plus one dynamic URL button var:
  // {{6}} = "Reschedule" button URL tail. Button base is https://calendly.com/, so we
  // send only the path after it. {{6}} uses the booking's real reschedule link so
  // reschedule/cancel tracking is preserved. ("I'll join" is a static quick-reply — no var.)
  flashfire_appointment_reminder_b: async ({ booking }) => {
    if (!booking.scheduledEventStartTime) {
      throw new Error('Meeting date/time not available for flashfire_appointment_reminder_b template');
    }

    const { meetingDateFormatted, meetingTimeWithTimezone } = buildMeetingTimeParams(booking);
    const meetingLink = booking.calendlyMeetLink || booking.googleMeetUrl || booking.meetingVideoUrl || 'Not Provided';
    const rescheduleLink = await resolveRescheduleLink(booking);

    return [
      booking.clientName || 'Valued Client',
      meetingDateFormatted,
      meetingTimeWithTimezone,
      meetingLink,
      rescheduleLink,
      calendlyButtonTail(rescheduleLink) // {{6}} → "Reschedule" button URL tail
    ];
  }
};

/**
 * Build template parameters for a given template name and booking context.
 * This is the single source of truth for template parameter logic, shared by
 * WorkflowController (immediate sends) and cronScheduler (scheduled sends).
 *
 * @param {string} templateName - WATI template name
 * @param {Object} context - { booking, step, executedAt }
 * @returns {Promise<string[]>} Array of parameter values
 */
export async function buildTemplateParameters(templateName, { booking, step, executedAt }) {
  const builder = builders[templateName];

  if (builder) {
    const params = await builder({ booking, step, executedAt });
    console.log(`[TemplateParameterBuilder] ${templateName} parameters:`, params);
    return params;
  }

  // Generic fallback: at minimum provide client name
  console.warn(`[TemplateParameterBuilder] No specific handler for "${templateName}", using generic fallback`);
  const params = [booking.clientName || 'Valued Client'];

  if (step?.templateConfig?.schedulingLink) {
    params.push(step.templateConfig.schedulingLink);
  }

  return params;
}

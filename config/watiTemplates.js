/**
 * WATI template names, in one place, each overridable by env.
 *
 * Template names were previously string literals scattered through the send paths.
 * A Meta template cannot be edited once approved without dropping it into review, so
 * every change means creating a NEW template and repointing the code at it. Keeping
 * the names here means that repoint is an env change and a restart, not a deploy.
 *
 * Names are not secrets. They live in .env purely so they can be swapped per
 * environment and rolled back without shipping code.
 */

export const WatiTemplates = {
  /**
   * Booking confirmation, sent ~1 minute after the booking.
   * 8 params: {{6}} = product demo link, {{7}} = Reschedule tail, {{8}} = Cancel tail.
   * Buttons: Reschedule, Cancel, and an "I'll Join" quick reply.
   *
   * Same parameter layout as the reminder templates, so they share one builder.
   * Override with WATI_TPL_BOOKED to swap it without a deploy.
   */
  bookingConfirmation:
    process.env.WATI_TPL_BOOKED || 'new_meeting_booked_reminder',

  /**
   * Original buttonless confirmation, 5 params. Used when no genuine cancel target
   * can be derived, since the booked template's Cancel button needs {{8}}.
   */
  bookingConfirmationPlain:
    process.env.WATI_TPL_REMINDER_IMMEDIATE || 'flashfire_appointment_reminder',

  /**
   * 3h / 1h / 5min reminder, current default.
   * 8 params: {{6}} = product demo link, {{7}} = Reschedule tail, {{8}} = Cancel tail.
   */
  reminderWithDemo:
    process.env.WATI_TPL_REMINDER_DEMO || 'flashfire_appointment_reminder_demo',

  /**
   * Same reminder without the demo line. 7 params: {{6}} = Reschedule, {{7}} = Cancel.
   * Used when WA_TEMPLATE_WITH_DEMO=false.
   */
  reminderWithCancel:
    process.env.WATI_TPL_REMINDER_CANCEL || 'flashfire_appointment_reminder_rc',

  /**
   * Fallback when no genuine cancel target can be derived for a booking.
   * 6 params, Reschedule button only — never shows a Cancel button that goes nowhere.
   */
  reminderRescheduleOnly:
    process.env.WATI_TPL_REMINDER_BASIC || 'flashfire_appointment_reminder_b',
};

/**
 * Not-scheduled workflow templates. Which one a step fires is configured in the CRM
 * and stored on the workflow document, so these are the values
 * scripts/switch-workflow-templates.mjs repoints steps to — they are not read by the
 * send path.
 *
 * These mirror what the active workflow currently has configured, so running
 * scripts/switch-workflow-templates.mjs is a no-op rather than silently reverting a
 * choice made in the CRM. Update them whenever the workflow's templates change.
 *
 * Historical note: meta_2_demo was classified MARKETING by Meta (the original meta_2
 * is UTILITY) and marketing templates are dropped for anyone opted out of marketing,
 * so it was never used. meta_2_demo_u was the UTILITY replacement, now superseded by
 * meta_2_revised_123.
 */
export const WatiWorkflowTemplates = {
  notScheduledImmediate: process.env.WATI_TPL_META_1 || 'meta__revised_134',
  notScheduled8h: process.env.WATI_TPL_META_2 || 'meta_2_revised_123',
  notScheduled2d: process.env.WATI_TPL_META_31 || 'meta_31',
  notScheduled7d: process.env.WATI_TPL_META_41 || 'meta_41',
};

/** Product demo video, sent as a body variable so the URL can change without a new template. */
export const PRODUCT_DEMO_LINK =
  process.env.PRODUCT_DEMO_LINK || 'https://www.flashfirejobs.com/product-demo';

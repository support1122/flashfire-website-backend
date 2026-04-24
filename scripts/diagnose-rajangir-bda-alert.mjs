/**
 * Diagnose why BDA (Discord meet) alert did NOT fire for
 *   - Invitee: rajangir@ucsd.edu  (Rahul Jangir)
 *   - Meet:    https://meet.google.com/ctn-yxvz-ccr
 *   - Start:   Fri Apr 24 1:30am (per calendar invite)
 *
 * Usage:
 *   node scripts/diagnose-rajangir-bda-alert.mjs
 *
 * Checks (in order):
 *   1. CampaignBooking row (by email / meet code / meet url)
 *   2. CalendlyWebhookLog / CalendlyWebhookDedupe rows for the invitee
 *   3. ScheduledDiscordMeetReminder rows for that booking / email
 *   4. ScheduledCall + ScheduledWhatsAppReminder rows (cross-check)
 *   5. Env sanity: DISCORD_MEET_2MIN_WEBHOOK_URL and fallbacks,
 *      DISCORD_MEET_REMINDER_OFFSET_MINUTES
 *   6. Derives likely root cause.
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

const EMAIL   = (process.env.DIAG_EMAIL   || 'rajangir@ucsd.edu').toLowerCase();
const MEETCODE = (process.env.DIAG_MEETCODE || 'ctn-yxvz-ccr').toLowerCase();
const MEETURL  = `https://meet.google.com/${MEETCODE}`;

function fmt(d, zone = 'Asia/Kolkata') {
  if (!d) return 'null';
  const dt = d instanceof Date ? DateTime.fromJSDate(d) : DateTime.fromISO(String(d));
  if (!dt.isValid) return String(d);
  return dt.setZone(zone).toFormat('yyyy-LL-dd HH:mm:ss ZZZZ');
}

function heading(t) { console.log(`\n===== ${t} =====`); }

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

heading('ENV sanity');
console.log({
  DISCORD_MEET_2MIN_WEBHOOK_URL: !!process.env.DISCORD_MEET_2MIN_WEBHOOK_URL,
  DISCORD_MEET_WEB_HOOK_URL:     !!process.env.DISCORD_MEET_WEB_HOOK_URL,
  DISCORD_REMINDER_CALL_WEBHOOK_URL: !!process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL,
  DISCORD_MEET_REMINDER_OFFSET_MINUTES: process.env.DISCORD_MEET_REMINDER_OFFSET_MINUTES || '(default 5)',
  DISCORD_MEET_REMINDER_POLL_MS:        process.env.DISCORD_MEET_REMINDER_POLL_MS        || '(default 10000)',
});

heading('CampaignBooking matches');
const bookingQ = {
  $or: [
    { clientEmail: EMAIL },
    { clientEmail: new RegExp(`^${EMAIL}$`, 'i') },
    { googleMeetCode: MEETCODE },
    { googleMeetCode: new RegExp(MEETCODE, 'i') },
    { calendlyMeetLink: new RegExp(MEETCODE, 'i') },
    { googleMeetUrl:    new RegExp(MEETCODE, 'i') },
  ],
};
const bookings = await db.collection('campaignbookings')
  .find(bookingQ)
  .sort({ bookingCreatedAt: -1 })
  .limit(10)
  .toArray();

console.log(`found ${bookings.length} booking(s)`);
for (const b of bookings) {
  console.log('---');
  console.log({
    bookingId: b.bookingId,
    clientName: b.clientName,
    clientEmail: b.clientEmail,
    clientPhone: b.clientPhone,
    bookingStatus: b.bookingStatus,
    statusChangeSource: b.statusChangeSource,
    statusChangedAt: fmt(b.statusChangedAt),
    statusChangedBy: b.statusChangedBy,
    bookingUpdatedAt: fmt(b.updatedAt),
    leadSource: b.leadSource,
    utmSource: b.utmSource,
    inviteeTimezone: b.inviteeTimezone,
    scheduledEventStartTime: fmt(b.scheduledEventStartTime),
    scheduledEventStartTime_UTC: b.scheduledEventStartTime?.toISOString?.() || b.scheduledEventStartTime,
    bookingCreatedAt: fmt(b.bookingCreatedAt),
    googleMeetCode: b.googleMeetCode,
    googleMeetUrl: b.googleMeetUrl,
    calendlyMeetLink: b.calendlyMeetLink,
    calendlyEventUri: b.calendlyEventUri,
    calendlyInviteeUri: b.calendlyInviteeUri,
    reminderCallJobId: b.reminderCallJobId,
    rescheduledCount: b.rescheduledCount,
    rescheduledAt: fmt(b.rescheduledAt),
  });
}

// Pick best match to key downstream lookups off of
const primary = bookings[0] || null;
const bookingIds = bookings.map(b => b.bookingId).filter(Boolean);

heading('CalendlyWebhookLog rows (last 30 days, filtered to this invitee)');
const sinceMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
const whLogs = await db.collection('calendlywebhooklogs')
  .find({
    createdAt: { $gte: new Date(sinceMs) },
    $or: [
      { 'payload.email': EMAIL },
      { 'payload.email': new RegExp(`^${EMAIL}$`, 'i') },
      { 'payload.invitee.email': EMAIL },
      { 'payload.invitee.email': new RegExp(`^${EMAIL}$`, 'i') },
      { 'payload.scheduled_event.location.join_url': new RegExp(MEETCODE, 'i') },
      { bookingId: { $in: bookingIds.length ? bookingIds : ['__none__'] } },
    ],
  })
  .sort({ createdAt: -1 })
  .limit(20)
  .toArray();

// broader dump — anything mentioning the meet code or invitee URI in nested payload
const whLogsBroad = await db.collection('calendlywebhooklogs')
  .find({
    createdAt: { $gte: new Date(sinceMs) },
    $or: [
      { eventType: { $regex: 'cancel|reschedul', $options: 'i' } },
      ...(primary?.calendlyEventUri ? [{ 'payload.payload.scheduled_event.uri': primary.calendlyEventUri }] : []),
    ],
  })
  .sort({ createdAt: -1 })
  .limit(50)
  .toArray();

heading('Broad cancel/reschedule webhook logs (30d)');
console.log(`found ${whLogsBroad.length}`);
for (const w of whLogsBroad.slice(0, 15)) {
  console.log({
    webhookId: w.webhookId,
    eventType: w.eventType,
    bookingId: w.bookingId,
    createdAt: fmt(w.createdAt),
    eventUri: w.payload?.payload?.scheduled_event?.uri || null,
    inviteeEmail: w.payload?.payload?.email || w.payload?.payload?.invitee?.email || null,
  });
}

heading('CalendlyWebhookDedupe keys around cancel time');
// Cancel happened 2026-04-23 01:08:50 IST == 2026-04-22 19:38:50 UTC
const cancelUtc = new Date('2026-04-22T19:38:50.000Z');
const dedupe = await db.collection('calendlywebhookdedupes')
  .find({
    createdAt: { $gte: new Date(cancelUtc.getTime() - 10 * 60 * 1000), $lte: new Date(cancelUtc.getTime() + 30 * 60 * 1000) },
  })
  .sort({ createdAt: -1 }).limit(30).toArray();
console.log(`found ${dedupe.length}`);
dedupe.forEach(d => console.log({ key: d.key, createdAt: fmt(d.createdAt) }));

heading('ANY CalendlyWebhookLog ±10min around cancel');
const whNear = await db.collection('calendlywebhooklogs')
  .find({
    createdAt: { $gte: new Date(cancelUtc.getTime() - 10 * 60 * 1000), $lte: new Date(cancelUtc.getTime() + 10 * 60 * 1000) },
  })
  .sort({ createdAt: -1 }).limit(40).toArray();
console.log(`found ${whNear.length}`);
whNear.forEach(w => console.log({
  webhookId: w.webhookId,
  eventType: w.eventType,
  bookingId: w.bookingId,
  createdAt: fmt(w.createdAt),
  error: w.error,
  email: w.payload?.email || w.payload?.invitee?.email || w.payload?.payload?.email || null,
  inviteeUri: w.payload?.invitee?.uri || w.payload?.uri || null,
  eventUri: w.payload?.scheduled_event?.uri || w.payload?.payload?.scheduled_event?.uri || null,
  startTime: w.payload?.scheduled_event?.start_time || w.payload?.payload?.scheduled_event?.start_time || null,
}));

heading('Booking full document (one-shot)');
if (primary) {
  const raw = await db.collection('campaignbookings').findOne({ bookingId: primary.bookingId });
  console.log({
    bookingId: raw.bookingId,
    bookingStatus: raw.bookingStatus,
    statusChangeSource: raw.statusChangeSource,
    statusChangedAt: fmt(raw.statusChangedAt),
    statusChangedBy: raw.statusChangedBy,
    rescheduledFrom: fmt(raw.rescheduledFrom),
    rescheduledTo: fmt(raw.rescheduledTo),
    rescheduledAt: fmt(raw.rescheduledAt),
    rescheduledCount: raw.rescheduledCount,
    updatedAt: fmt(raw.updatedAt),
    paymentPlan: raw.paymentPlan,
    paymentBreakdown: raw.paymentBreakdown,
    noShowProcessed: raw.noShowProcessed,
    whatsappReminderSent: raw.whatsappReminderSent,
  });
}

console.log(`found ${whLogs.length} webhook log(s)`);
for (const w of whLogs) {
  console.log({
    webhookId: w.webhookId,
    eventType: w.eventType,
    bookingId: w.bookingId,
    error: w.error,
    createdAt: fmt(w.createdAt),
    payloadEmail: w.payload?.email || w.payload?.invitee?.email || null,
    eventStart: w.payload?.scheduled_event?.start_time || null,
    eventUri:   w.payload?.scheduled_event?.uri || null,
    inviteeUri: w.payload?.invitee?.uri || w.payload?.uri || null,
  });
}

heading('ScheduledDiscordMeetReminder rows');
const remQ = {
  $or: [
    ...(bookingIds.length ? [{ bookingId: { $in: bookingIds } }] : []),
    { clientEmail: EMAIL },
    { clientEmail: new RegExp(`^${EMAIL}$`, 'i') },
    { meetingLink: new RegExp(MEETCODE, 'i') },
  ],
};
const reminders = await db.collection('scheduleddiscordmeetreminders')
  .find(remQ).sort({ createdAt: -1 }).limit(20).toArray();

console.log(`found ${reminders.length} reminder row(s)`);
for (const r of reminders) {
  console.log('---');
  console.log({
    reminderId: r.reminderId,
    bookingId: r.bookingId,
    clientName: r.clientName,
    clientEmail: r.clientEmail,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    errorMessage: r.errorMessage,
    source: r.source,
    inviteeTimezone: r.inviteeTimezone,
    meetingStartISO: fmt(r.meetingStartISO),
    scheduledFor:    fmt(r.scheduledFor),
    scheduledFor_UTC: r.scheduledFor?.toISOString?.() || r.scheduledFor,
    processedAt:  fmt(r.processedAt),
    completedAt:  fmt(r.completedAt),
    deliveryDriftMs: r.deliveryDriftMs,
    createdAt: fmt(r.createdAt),
    updatedAt: fmt(r.updatedAt),
  });
}

heading('ScheduledCall rows (phone-based reminder call)');
const calls = await db.collection('scheduledcalls')
  .find({
    $or: [
      ...(bookingIds.length ? [{ 'metadata.bookingId': { $in: bookingIds } }] : []),
      { inviteeEmail: EMAIL },
      { inviteeEmail: new RegExp(`^${EMAIL}$`, 'i') },
    ],
  })
  .sort({ createdAt: -1 }).limit(10).toArray();
console.log(`found ${calls.length} scheduled call row(s)`);
calls.forEach(c => console.log({
  callId: c.callId, status: c.status, scheduledFor: fmt(c.scheduledFor),
  attempts: c.attempts, errorMessage: c.errorMessage,
}));

heading('ScheduledWhatsAppReminder rows');
const was = await db.collection('scheduledwhatsappreminders')
  .find({
    $or: [
      ...(bookingIds.length ? [{ bookingId: { $in: bookingIds } }] : []),
      { clientEmail: EMAIL },
      { clientEmail: new RegExp(`^${EMAIL}$`, 'i') },
    ],
  })
  .sort({ createdAt: -1 }).limit(10).toArray();
console.log(`found ${was.length} wa reminder row(s)`);
was.forEach(w => console.log({
  reminderId: w.reminderId, reminderType: w.reminderType, status: w.status,
  scheduledFor: fmt(w.scheduledFor), error: w.errorMessage,
}));

heading('DIAGNOSIS');
const diagnose = () => {
  const offsetMin = Number(process.env.DISCORD_MEET_REMINDER_OFFSET_MINUTES) || 5;
  const haveWebhookEnv =
    !!process.env.DISCORD_MEET_2MIN_WEBHOOK_URL ||
    !!process.env.DISCORD_MEET_WEB_HOOK_URL ||
    !!process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  if (!haveWebhookEnv) {
    return 'No Discord webhook env var set (DISCORD_MEET_2MIN_WEBHOOK_URL / fallback). scheduleDiscordMeetReminder returns early with {success:false}, so no row is created and no alert fires.';
  }
  if (!primary) {
    return 'No CampaignBooking row found for this invitee / meet code. Either the Calendly webhook for invitee.created never hit this backend, or the booking landed under a different email/meet code. Check CalendlyWebhookLog rows above.';
  }
  if (reminders.length === 0) {
    // Check if meeting start - offset was already in the past when booking was created
    const start = primary.scheduledEventStartTime ? new Date(primary.scheduledEventStartTime) : null;
    const created = primary.bookingCreatedAt ? new Date(primary.bookingCreatedAt) : null;
    if (start && created) {
      const leadMs = start.getTime() - created.getTime();
      const leadMin = leadMs / 60000;
      if (leadMin <= offsetMin) {
        return `Booking was created ${leadMin.toFixed(1)} min before meeting start, which is <= reminder offset (${offsetMin} min). scheduleDiscordMeetReminder branch "Reminder time is in the past" triggers → no row is persisted, no alert fires. This is the expected code path (DiscordMeetReminderScheduler.js:131).`;
      }
    }
    return 'No ScheduledDiscordMeetReminder row created for this booking. Possible causes: webhook path that created the booking never called scheduleRemindersForBooking/scheduleDiscordMeetReminder (e.g. frontend-only capture without webhook enrichment), or meetingStartISO was missing at creation time. Cross-check CalendlyWebhookLog above.';
  }
  const r = reminders[0];
  if (r.status === 'cancelled') {
    const cancelAt = r.updatedAt ? new Date(r.updatedAt) : null;
    const meetStart = r.meetingStartISO ? new Date(r.meetingStartISO) : null;
    const hoursBefore = cancelAt && meetStart
      ? ((meetStart.getTime() - cancelAt.getTime()) / 3600000).toFixed(1)
      : '?';
    const hasCalendlyCancel = whLogs.some(w =>
      w.eventType === 'invitee.canceled' || w.eventType === 'invitee_canceled');
    const rescheduled = (primary.rescheduledCount || 0) > 0;
    let cause;
    if (hasCalendlyCancel) {
      cause = 'invitee.canceled Calendly webhook fired — client cancelled the meeting.';
    } else if (rescheduled) {
      cause = `Booking was rescheduled (rescheduledCount=${primary.rescheduledCount}). Reschedule path in CampaignBookingController.rescheduleBooking cancels old reminders and should create new ones — verify a later reminder row exists for the new meetingStartISO.`;
    } else {
      // Check for a second invitee.created for same email (== cancel + rebook)
      const rebookLog = whLogs.find(w =>
        w.eventType === 'invitee.created' &&
        w.bookingId == null &&
        (w.payload?.invitee?.email?.toLowerCase?.() === EMAIL ||
         w.payload?.email?.toLowerCase?.() === EMAIL));
      const newEventUri = rebookLog?.payload?.scheduled_event?.uri;
      const storedEventUri = primary.calendlyEventUri;
      const mismatchedUri = newEventUri && storedEventUri && newEventUri !== storedEventUri;
      if (mismatchedUri) {
        cause = `CANCEL+REBOOK race. Second invitee.created webhook arrived at ${fmt(rebookLog.createdAt)} with a different Calendly event uri (${newEventUri}) than the one stored on the booking (${storedEventUri}). The preceding invitee.canceled webhook (not persisted in CalendlyWebhookLog — only invitee.created is logged, see CalendlyWebhookController.js:213-217) fired cancelCall + cancelWhatsAppReminder + cancelDiscordMeetRemindersForMeeting with the OLD event's startTime, wiping all reminders with msg "${r.errorMessage}". The new invitee.created then hit the duplicate-short-circuit at CalendlyWebhookController.js:299-312 because \`duplicateQuery\` matches on clientEmail + scheduledEventStartTime, which are identical on the re-book. It returned {duplicate:true} WITHOUT rescheduling reminders or updating calendlyEventUri. Net effect: reminders are cancelled for a booking that is still active, and BDA alert never fires. Reminder was cancelled ~${hoursBefore}h before meeting.`;
      } else {
        cause = `No Calendly cancel/reschedule webhook in last 30d that we logged. Only invitee.created is persisted to CalendlyWebhookLog (see CalendlyWebhookController.js:213-217) — invitee.canceled and invitee.rescheduled are NOT logged. So the absence of a cancel log does not rule out a cancel webhook. Likeliest explanation: invitee.canceled fired for this meeting, cancelling reminders, and booking was later set to "${primary.bookingStatus}" by admin (statusChangedAt=${fmt(primary.statusChangedAt)}). Reminder was cancelled ~${hoursBefore}h before meeting.`;
      }
    }
    return `Reminder cancelled with msg: "${r.errorMessage}". ${cause}`;
  }
  if (r.status === 'failed') {
    return `Reminder row is failed after ${r.attempts}/${r.maxAttempts} attempts. Error: ${r.errorMessage}`;
  }
  if (r.status === 'processing') {
    return `Reminder row stuck in processing since ${fmt(r.processedAt)}. Will be reset by resetStuckProcessingReminders after 8 min — check poller uptime.`;
  }
  if (r.status === 'pending') {
    const sf = new Date(r.scheduledFor);
    if (sf.getTime() > Date.now()) {
      return `Reminder is pending and scheduledFor is in the future (${fmt(r.scheduledFor)}). It has not fired yet — that is expected. Alert will post ${offsetMin} min before meeting start.`;
    }
    return `Reminder is pending but scheduledFor is in the past (${fmt(r.scheduledFor)}). Poller likely not running, or MongoDB index/claim query never matched. Check backend process uptime and DISCORD_MEET_2MIN_WEBHOOK_URL.`;
  }
  if (r.status === 'completed') {
    return `Reminder was sent at ${fmt(r.completedAt)} (drift ${r.deliveryDriftMs} ms). If BDA did not see it in Discord, check the webhook channel — delivery from backend succeeded.`;
  }
  return 'Unhandled reminder state — dump above for manual inspection.';
};
console.log(diagnose());

await mongoose.disconnect();

/**
 * Backfill the 24h / 3h / 1h / 5min WhatsApp reminders onto bookings that already exist.
 *
 * Every future scheduled meeting is covered by default. For each one, a reminder is
 * created only if its send time is still ahead (a meeting 2h away gets 1h and 5min, not
 * 3h or 24h), and only if it is not already queued. Same scheduleWhatsAppReminder() the
 * app uses, so they go out on the same template (flashfire_appointment_reminder_demo).
 *
 *   node scripts/backfill-reminders.mjs                 # DRY RUN, every future meeting
 *   node scripts/backfill-reminders.mjs --today         # DRY RUN, rest of today only
 *   node scripts/backfill-reminders.mjs --types 24h,1h  # limit which reminders
 *   node scripts/backfill-reminders.mjs --apply         # creates pending reminders
 *
 * The running backend's poller sends them when due; no restart needed. --quiet is on
 * for --apply so Discord gets one summary, not one post per reminder.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

dotenv.config({ quiet: true });

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const APPLY = argv.includes('--apply');
const TODAY = argv.includes('--today');
const ALL = !TODAY;
const TYPES = (flag('types', '24h,3h,1h,5min')).split(',').map(t => t.trim()).filter(Boolean);
const OFFSETS = { '24h': 1440, '3h': 180, '1h': 60, '5min': 5 };
if (TYPES.some(t => !OFFSETS[t])) { console.error(`Unknown --types value. Use: ${Object.keys(OFFSETS).join(',')}`); process.exit(1); }
const ZONE = flag('zone', 'America/New_York');
const URI = flag('uri', process.env.MONGODB_URI);
const QUIET = true;

if (!URI) {
  console.error('No connection string. Pass --uri "mongodb+srv://..." or set MONGODB_URI in .env');
  process.exit(1);
}

// Captured before the scheduler module is imported. Setting the key to '' (rather
// than deleting it) keeps dotenv.config() inside that module from restoring it,
// since dotenv only fills keys that are absent from process.env.
const DISCORD_WEBHOOK = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
if (QUIET) process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL = '';

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });

// Imported AFTER connect so the models bind to this connection. Importing the
// scheduler does not start its poller — startWhatsAppReminderScheduler() is separate.
const { scheduleWhatsAppReminder } = await import('../Utils/WhatsAppReminderScheduler.js');
const { CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js');
const { ScheduledWhatsAppReminderModel } = await import('../Schema_Models/ScheduledWhatsAppReminder.js');
const { normalizePhoneForReminders, buildWhatsAppReminderId, buildMeetingDisplay } = await import('../Utils/MeetingReminderUtils.js');
const { DiscordConnect } = await import('../Utils/DiscordConnect.js');

const now = new Date();
const nowLocal = DateTime.fromJSDate(now).setZone(ZONE);
const windowEnd = ALL ? nowLocal.plus({ years: 5 }) : nowLocal.endOf('day');

const scopeLabel = ALL ? 'every future scheduled meeting' : 'rest of today';

console.log(`Mode:   ${APPLY ? 'APPLY — reminders will be created' : 'DRY RUN — nothing will be written'}`);
console.log(`Scope:  ${scopeLabel}`);
console.log(`Zone:   ${ZONE}`);
console.log(`Window: ${nowLocal.toFormat('ff')} → ${ALL ? 'no limit' : windowEnd.toFormat('ff')}`);
console.log(`Discord per-reminder posts: ${QUIET ? 'suppressed (summary only)' : 'on'}\n`);

const inScope = await CampaignBookingModel.find({
  bookingStatus: 'scheduled',
  scheduledEventStartTime: { $gte: now, $lte: windowEnd.toJSDate() },
})
  .select(
    'bookingId clientName clientEmail clientPhone bookingStatus scheduledEventStartTime ' +
    'scheduledEventEndTime inviteeTimezone calendlyMeetLink googleMeetUrl calendlyRescheduleLink calendlyCancelLink'
  )
  .sort({ scheduledEventStartTime: 1 })
  .lean();

console.log(`=== upcoming meetings with bookingStatus "scheduled": ${inScope.length} ===`);
const byDay = inScope.reduce((acc, b) => {
  const k = DateTime.fromJSDate(new Date(b.scheduledEventStartTime)).setZone(ZONE).toFormat('EEE MMM d');
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});
for (const [day, n] of Object.entries(byDay)) console.log(`  ${day.padEnd(12)} ${n}`);
console.log('');

const buildDisplay = (booking) => {
  const d = buildMeetingDisplay(
    booking.scheduledEventStartTime,
    booking.scheduledEventEndTime,
    booking.inviteeTimezone
  );
  return d
    ? { meetingTime: d.meetingTime, meetingDate: d.meetingDate, tzAbbr: d.tzLabel }
    : { meetingTime: '', meetingDate: '', tzAbbr: 'EST' };
};

const results = { created: 0, noPhone: 0, failed: 0 };
const rows = [];
const failures = [];
const badPhones = [];

const tally = Object.fromEntries(TYPES.map(t => [t, { created: 0, existing: 0, passed: 0 }]));

for (const b of inScope) {
  const start = new Date(b.scheduledEventStartTime);
  const when = DateTime.fromJSDate(start).setZone(ZONE).toFormat('MMM d HH:mm');
  const who = `${(b.clientName || 'Unknown').slice(0, 22).padEnd(22)}`;

  const phone = b.clientPhone ? normalizePhoneForReminders(b.clientPhone) : null;
  const phoneOk = phone && /^\+?[1-9]\d{9,14}$/.test(phone);

  if (!phoneOk) {
    results.noPhone++;
    badPhones.push(`${b.clientName || 'Unknown'} <${b.clientEmail || 'no email'}> phone=${b.clientPhone || 'none'} meeting=${when}`);
    rows.push(`${when}  ${who} SKIP  no usable phone (${b.clientPhone || 'none'})`);
    continue;
  }

  const actions = [];
  for (const type of TYPES) {
    const offset = OFFSETS[type];
    // Send time already behind us: the reminder can no longer be sent on time.
    if (start.getTime() - offset * 60000 <= now.getTime()) { tally[type].passed++; continue; }

    const reminderId = buildWhatsAppReminderId(type, phone, start.getTime());
    const existing = await ScheduledWhatsAppReminderModel.findOne({ reminderId }).lean();
    if (existing && existing.status !== 'cancelled') { tally[type].existing++; continue; }

    if (!APPLY) { tally[type].created++; results.created++; actions.push(`+${type}`); continue; }

    const disp = buildDisplay(b);
    const res = await scheduleWhatsAppReminder({
      phoneNumber: phone,
      meetingStartISO: b.scheduledEventStartTime,
      meetingTime: disp.meetingTime,
      meetingDate: disp.meetingDate,
      clientName: b.clientName,
      clientEmail: b.clientEmail,
      meetingLink: b.calendlyMeetLink || b.googleMeetUrl || null,
      rescheduleLink: b.calendlyRescheduleLink || null,
      cancelLink: b.calendlyCancelLink || null,
      source: 'manual',
      timezone: disp.tzAbbr,
      metadata: { bookingId: b.bookingId, inviteeTimezone: b.inviteeTimezone },
      reminderOffsetMinutes: offset,
      reminderType: type,
    });
    if (res.success) { tally[type].created++; results.created++; actions.push(`${res.reactivated ? 'revived ' : '+'}${type}`); }
    else { results.failed++; failures.push(`${b.clientName || 'Unknown'} ${when} ${type}: ${res.error}`); actions.push(`FAIL ${type}`); }
  }
  if (actions.length) rows.push(`${when}  ${who} ${actions.join(' ')}  ${phone}`);
}

console.log(rows.join('\n') || '(nothing upcoming)');

console.log('\n=== summary ===');
console.log(`${APPLY ? 'created' : 'would create'}: ${results.created}   failed: ${results.failed}   no phone: ${results.noPhone}`);
for (const t of TYPES) console.log(`  ${t.padEnd(5)} ${APPLY ? 'created' : 'would create'} ${tally[t].created}, already queued ${tally[t].existing}, send time passed ${tally[t].passed}`);

if (badPhones.length) {
  console.log('\n=== bookings that can receive nothing (no usable phone) ===');
  for (const p of badPhones) console.log(`  ${p}`);
}
if (failures.length) {
  console.log('\n=== failures ===');
  for (const f of failures) console.log(`  ${f}`);
}

if (APPLY) {
  if (DISCORD_WEBHOOK) {
    await DiscordConnect(
      DISCORD_WEBHOOK,
      `🧰 WA reminder backfill (${TYPES.join(', ')}), ${scopeLabel}\n` +
        `📅 ${inScope.length} upcoming scheduled meetings in scope\n` +
        `✅ Created: ${results.created}\n` +
        TYPES.map(t => `   • ${t}: +${tally[t].created}, had ${tally[t].existing}, passed ${tally[t].passed}`).join('\n') + '\n' +
        `📵 No usable phone: ${results.noPhone}\n` +
        `❌ Failed: ${results.failed}`
    );
    console.log('\nDiscord summary posted.');
  } else {
    console.log('\nDISCORD_REMINDER_CALL_WEBHOOK_URL not set — no Discord summary posted.');
  }
} else {
  console.log('\nDry run only. Re-run with --apply to create these reminders.');
}

await mongoose.disconnect();

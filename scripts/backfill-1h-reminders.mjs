/**
 * Backfill the 1-hour WhatsApp reminder onto bookings that already exist.
 *
 * The hourly self-heal in UnifiedScheduler creates this reminder on its own, but
 * only for meetings inside its 48-hour lookahead. This script fills in everything
 * else, and covers the gap before a deploy reaches production.
 *
 * Dry run (default — reads only, writes nothing):
 *   node scripts/backfill-1h-reminders.mjs                    # rest of today
 *   node scripts/backfill-1h-reminders.mjs --all              # every future scheduled meeting
 *   node scripts/backfill-1h-reminders.mjs --hours 72         # next 72 hours
 *   node scripts/backfill-1h-reminders.mjs --zone America/New_York
 *
 * Apply (creates pending reminders — real WhatsApp messages will be sent when due):
 *   node scripts/backfill-1h-reminders.mjs --all --apply
 *
 * Reminders are created through the same scheduleWhatsAppReminder() the app uses,
 * so reminderId, metadata and behaviour are identical to a normal booking. The
 * running backend's poller picks them up; no restart required.
 *
 * Discord: each created reminder normally posts its own line. For bulk runs that is
 * hundreds of messages, so --quiet suppresses the per-reminder posts and leaves only
 * the summary. --all turns --quiet on automatically.
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
const ALL = argv.includes('--all');
const ZONE = flag('zone', 'America/New_York');
const HOURS = flag('hours') ? Number(flag('hours')) : null;
const URI = flag('uri', process.env.MONGODB_URI);
const QUIET = argv.includes('--quiet') || ALL;

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
const { normalizePhoneForReminders, buildWhatsAppReminderId } = await import('../Utils/MeetingReminderUtils.js');
const { DiscordConnect } = await import('../Utils/DiscordConnect.js');

const now = new Date();
const nowLocal = DateTime.fromJSDate(now).setZone(ZONE);
const windowEnd = ALL
  ? nowLocal.plus({ years: 5 })
  : HOURS
    ? nowLocal.plus({ hours: HOURS })
    : nowLocal.endOf('day');

const scopeLabel = ALL ? 'every future scheduled meeting' : HOURS ? `next ${HOURS}h` : 'rest of today';

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
    'scheduledEventEndTime inviteeTimezone calendlyMeetLink googleMeetUrl calendlyRescheduleLink'
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
  const tz = booking.inviteeTimezone || 'America/New_York';
  const s = DateTime.fromJSDate(new Date(booking.scheduledEventStartTime)).setZone(tz);
  const e = booking.scheduledEventEndTime
    ? DateTime.fromJSDate(new Date(booking.scheduledEventEndTime)).setZone(tz)
    : s.plus({ minutes: 15 });
  const fmt = dt => (dt.minute === 0 ? dt.toFormat('ha').toLowerCase() : dt.toFormat('h:mma').toLowerCase());
  return {
    meetingTime: `${fmt(s)} – ${fmt(e)}`,
    meetingDate: s.toFormat('EEEE MMM d, yyyy'),
    tzAbbr: s.toFormat('ZZZZ') || 'ET',
  };
};

const results = { created: 0, existing: 0, tooClose: 0, noPhone: 0, failed: 0 };
const rows = [];
const failures = [];
const badPhones = [];

for (const b of inScope) {
  const start = new Date(b.scheduledEventStartTime);
  const minsUntil = (start.getTime() - now.getTime()) / 60000;
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

  // A 1h reminder needs the meeting to be more than an hour out, otherwise its send
  // time is already in the past and scheduleWhatsAppReminder rejects it.
  if (minsUntil <= 60) {
    results.tooClose++;
    rows.push(`${when}  ${who} SKIP  starts in ${Math.round(minsUntil)}m — 1h mark has passed`);
    continue;
  }

  const reminderId = buildWhatsAppReminderId('1h', phone, start.getTime());
  const existing = await ScheduledWhatsAppReminderModel.findOne({ reminderId }).lean();
  if (existing && existing.status !== 'cancelled') {
    results.existing++;
    rows.push(`${when}  ${who} HAVE  1h reminder already ${existing.status}`);
    continue;
  }

  if (!APPLY) {
    results.created++;
    const at = DateTime.fromJSDate(new Date(start.getTime() - 3600000)).setZone(ZONE).toFormat('MMM d HH:mm');
    rows.push(`${when}  ${who} WOULD CREATE  → sends ${at}  ${phone}`);
    continue;
  }

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
    source: 'manual',
    timezone: disp.tzAbbr,
    metadata: { bookingId: b.bookingId, inviteeTimezone: b.inviteeTimezone },
    reminderOffsetMinutes: 60,
    reminderType: '1h',
  });

  if (res.success) {
    results.created++;
    const at = res.scheduledFor ? DateTime.fromJSDate(new Date(res.scheduledFor)).setZone(ZONE).toFormat('MMM d HH:mm') : '?';
    rows.push(`${when}  ${who} ${res.existing ? 'HAVE ' : res.reactivated ? 'REVIVED' : 'CREATED'}  → sends ${at}  ${phone}`);
  } else {
    results.failed++;
    failures.push(`${b.clientName || 'Unknown'} <${b.clientEmail || 'no email'}> ${when}: ${res.error}`);
    rows.push(`${when}  ${who} FAIL  ${res.error}`);
  }
}

console.log(rows.join('\n') || '(nothing upcoming)');

console.log('\n=== summary ===');
console.log(`${APPLY ? 'created' : 'would create'}:  ${results.created}`);
console.log(`already had:  ${results.existing}`);
console.log(`too close:    ${results.tooClose}   (meeting is under an hour away)`);
console.log(`no phone:     ${results.noPhone}`);
console.log(`failed:       ${results.failed}`);

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
      `🧰 1h WA reminder backfill — ${scopeLabel}\n` +
        `📅 ${inScope.length} upcoming scheduled meetings in scope\n` +
        `✅ Created: ${results.created}\n` +
        `ℹ️ Already had: ${results.existing}\n` +
        `⏭️ Too close (<1h): ${results.tooClose}\n` +
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

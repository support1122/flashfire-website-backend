import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { DateTime, IANAZone } from 'luxon';

const args = new Set(process.argv.slice(2));
const SHOULD_FIX = args.has('--fix-pending');
const INCLUDE_COMPLETED = args.has('--include-completed');
const FIX_ALL_STATUSES = args.has('--fix-all-statuses');
const DAYS = Number(process.env.WA_AUDIT_DAYS || 30);

function isUnknownLike(v) {
  if (v == null) return true;
  const s = String(v).trim().toLowerCase();
  return !s || s === 'unknown' || s.startsWith('unknown') || s === 'undefined' || s === 'null' || s === 'invalid datetime';
}

function resolveInviteeTimezone(doc) {
  const raw = doc?.metadata?.inviteeTimezone || doc?.inviteeTimezone || null;
  if (typeof raw === 'string' && raw.trim() && IANAZone.isValidZone(raw.trim())) return raw.trim();
  return 'America/New_York';
}

function resolveMeetingStartDate(doc) {
  if (doc?.meetingStartISO) {
    const d = new Date(doc.meetingStartISO);
    if (!Number.isNaN(d.getTime())) return d;
  }

  if (doc?.scheduledFor) {
    const offsetMap = { immediate: 1, '5min': 5, '3h': 180, '2hour': 120, '24hour': 1440 };
    const reminderType = doc?.metadata?.reminderType ?? doc?.reminderType;
    const offsetMin = Number.isFinite(doc?.metadata?.reminderOffsetMinutes)
      ? doc.metadata.reminderOffsetMinutes
      : (offsetMap[reminderType] ?? 5);
    const d = new Date(new Date(doc.scheduledFor).getTime() + offsetMin * 60 * 1000);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

function resolveTimezoneLabel(doc, startDT, inviteeTz) {
  const raw = doc?.timezone;
  if (!isUnknownLike(raw)) {
    const s = String(raw).trim();
    if (!s.includes('/') && s !== 'GMT' && s !== 'UTC') return s;
  }

  const abbr = startDT.toFormat('ZZZZ');
  if (abbr && !abbr.startsWith('GMT') && !abbr.startsWith('UTC') && !isUnknownLike(abbr)) return abbr;
  if (inviteeTz.includes('Kolkata') || inviteeTz.includes('Calcutta')) return 'IST';
  if (inviteeTz.includes('Los_Angeles') || inviteeTz.includes('Pacific')) return 'PT';
  if (inviteeTz.includes('New_York') || inviteeTz.includes('Eastern')) return 'ET';
  if (inviteeTz.includes('Chicago') || inviteeTz.includes('Central')) return 'CT';
  if (inviteeTz.includes('Denver') || inviteeTz.includes('Mountain')) return 'MT';
  return 'ET';
}

function resolveMeetingTimeWindow(startDT) {
  const endDT = startDT.plus({ minutes: 15 });
  const fmt = (dt) => dt.minute === 0 ? dt.toFormat('ha').toLowerCase() : dt.toFormat('h:mma').toLowerCase();
  return `${fmt(startDT)} – ${fmt(endDT)}`;
}

const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const activeStatuses = INCLUDE_COMPLETED
  ? ['pending', 'scheduled', 'processing', 'completed', 'failed', 'cancelled']
  : ['pending', 'scheduled', 'processing'];

await mongoose.connect(process.env.MONGODB_URI);
const col = mongoose.connection.db.collection('scheduledwhatsappreminders');

const target = await col.find({
  createdAt: { $gte: since },
  status: { $in: activeStatuses },
  $or: [
    { meetingTime: { $regex: /^unknown/i } },
    { meetingTime: 'undefined' },
    { meetingTime: null },
    { timezone: { $regex: /^unknown$/i } },
    { timezone: 'undefined' },
    { timezone: 'null' },
    { timezone: null }
  ]
}).sort({ createdAt: -1 }).toArray();

console.log(`WA unknown-time/timezone audit window: last ${DAYS} day(s)`);
console.log(`Statuses: ${activeStatuses.join(', ')}`);
console.log(`Found candidate rows: ${target.length}`);
console.log(`Mode: ${SHOULD_FIX ? (FIX_ALL_STATUSES ? 'FIX all statuses' : 'FIX pending rows') : 'DRY RUN'}\n`);

let fixable = 0;
let fixed = 0;

for (const doc of target) {
  const inviteeTz = resolveInviteeTimezone(doc);
  const meetingStart = resolveMeetingStartDate(doc);
  if (!meetingStart) {
    console.log(`SKIP ${doc._id}: no valid meeting start (bookingId=${doc?.metadata?.bookingId || 'n/a'})`);
    continue;
  }

  const startDT = DateTime.fromJSDate(meetingStart, { zone: 'utc' }).setZone(inviteeTz);
  if (!startDT.isValid) {
    console.log(`SKIP ${doc._id}: invalid Luxon datetime`);
    continue;
  }

  const newMeetingTime = resolveMeetingTimeWindow(startDT);
  const newTimezone = resolveTimezoneLabel(doc, startDT, inviteeTz);
  const newMeetingDate = startDT.toFormat('EEEE MMM d, yyyy');

  fixable++;
  console.log(
    `[${doc.status}] ${doc.clientName || 'Unknown'} | ${doc.reminderId}\n` +
    `  old: time="${doc.meetingTime}" tz="${doc.timezone}" date="${doc.meetingDate}"\n` +
    `  new: time="${newMeetingTime}" tz="${newTimezone}" date="${newMeetingDate}" tzIana="${inviteeTz}"`
  );

  if (SHOULD_FIX && (FIX_ALL_STATUSES || doc.status === 'pending' || doc.status === 'scheduled' || doc.status === 'processing')) {
    const res = await col.updateOne(
      { _id: doc._id },
      {
        $set: {
          meetingTime: newMeetingTime,
          meetingDate: newMeetingDate,
          timezone: newTimezone,
          inviteeTimezone: inviteeTz,
          updatedAt: new Date(),
        }
      }
    );
    if (res.modifiedCount > 0) fixed++;
  }
}

console.log(`\nSummary: fixable=${fixable}, fixed=${fixed}`);
await mongoose.disconnect();

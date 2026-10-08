/**
 * Re-link Zoom call logs to bookings with the corrected phone matching (plan 6.2 step 3).
 *
 *   node scripts/backfill-call-links.js            DRY RUN (default): reads, prints counts, writes nothing
 *   node scripts/backfill-call-links.js --apply    writes the changes
 *   add --fix-booking-keys                         (with --apply) also fills a missing normalizedClientPhone
 *
 * What it changes on calllogs, and nothing else:
 *   - leadNumberNormalized, recomputed from leadNumber with the shared helper (older rows used a different key
 *     for non-US numbers, so they could never match a booking);
 *   - bookingId / leadEmail / leadName on rows with no link, using the booking closest in time when the client
 *     has more than one booking;
 *   - bookingId on rows linked to the wrong one of two bookings with the same phone.
 * A row linked to a booking with a different phone is never touched: that link was made on purpose.
 *
 * Prints counts only. --apply writes to whatever MONGODB_URI points at, which locally is PRODUCTION, so it needs
 * bsc's go-ahead first.
 */
import { pathToFileURL } from 'node:url';
import {
  bookingPhoneKey,
  leadSideOfHistoryRow,
  normalizeLeadPhone,
  pickBookingForCall,
} from '../Utils/CallLinking.js';

const BATCH = 500;

/** The client's number for a stored call: the saved leadNumber, else the one inside a synced row's raw payload. */
export function deriveLeadNumber(row) {
  if (row.leadNumber) return row.leadNumber;
  if (row.source === 'sync' && row.raw) return leadSideOfHistoryRow({ ...row.raw, direction: row.direction }).number;
  return null;
}

/**
 * Pure: decide what to change on one call row.
 * @param {object} row  CallLog row
 * @param {Map<string, object[]>} bookingsByKey phone key -> bookings
 * @returns {{ set: object, kind: 'linked'|'moved'|null, normalizationFixed: boolean }}
 */
export function planRelink(row, bookingsByKey) {
  const set = {};
  const newKey = normalizeLeadPhone(deriveLeadNumber(row));
  let normalizationFixed = false;
  if (newKey && row.leadNumberNormalized !== newKey) {
    set.leadNumberNormalized = newKey;
    normalizationFixed = true;
  }
  const cands = newKey ? (bookingsByKey.get(newKey) || []) : [];
  let kind = null;
  if (cands.length > 0) {
    if (!row.bookingId) {
      const pick = pickBookingForCall(cands, row.startedAt ?? row.createdAt);
      if (pick) {
        set.bookingId = pick.bookingId;
        set.leadEmail = pick.clientEmail || null;
        set.leadName = pick.clientName || row.leadName || null;
        kind = 'linked';
      }
    } else if (cands.length > 1 && cands.some((b) => b.bookingId === row.bookingId)) {
      const pick = pickBookingForCall(cands, row.startedAt ?? row.createdAt);
      if (pick && pick.bookingId !== row.bookingId) {
        set.bookingId = pick.bookingId;
        set.leadEmail = pick.clientEmail || null;
        set.leadName = pick.clientName || row.leadName || null;
        kind = 'moved';
      }
    }
  }
  return { set, kind, normalizationFixed };
}

/**
 * Runs on the already-open mongoose connection. Writes ONLY when apply === true.
 * callFilter narrows which call rows are scanned (used by tests; the CLI scans everything).
 */
export async function runBackfill({ apply = false, fixBookingKeys = false, callFilter = {} } = {}) {
  const { CallLogModel } = await import('../Schema_Models/CallLog.js');
  const { CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js');

  const rows = await CallLogModel.find(callFilter)
    .select('callId direction source bookingId leadNumber leadNumberNormalized leadName startedAt createdAt raw.callee_did_number raw.callee_number raw.caller_did_number raw.caller_number')
    .lean();

  // Bookings by key. Includes bookings that never got normalizedClientPhone, keyed in memory.
  const bookings = await CampaignBookingModel.find({ clientPhone: { $nin: [null, ''] } })
    .select('bookingId clientPhone normalizedClientPhone clientEmail clientName scheduledEventStartTime bookingCreatedAt')
    .lean();
  const bookingsByKey = new Map();
  const missingKey = [];
  for (const b of bookings) {
    const key = bookingPhoneKey(b);
    if (!key) continue;
    if (!b.normalizedClientPhone) missingKey.push({ _id: b._id, key });
    if (!bookingsByKey.has(key)) bookingsByKey.set(key, []);
    bookingsByKey.get(key).push(b);
  }

  const stats = {
    mode: apply ? 'APPLY' : 'DRY RUN',
    callRowsScanned: rows.length,
    normalizationFixed: 0,
    unlinkedNowLinked: 0,
    movedBetweenSiblingBookings: 0,
    stillUnlinked: 0,
    bookingsMissingNormalizedPhone: missingKey.length,
    bookingKeysFixed: 0,
  };

  const ops = [];
  for (const row of rows) {
    const { set, kind, normalizationFixed } = planRelink(row, bookingsByKey);
    if (normalizationFixed) stats.normalizationFixed += 1;
    if (kind === 'linked') stats.unlinkedNowLinked += 1;
    else if (kind === 'moved') stats.movedBetweenSiblingBookings += 1;
    else if (!row.bookingId) stats.stillUnlinked += 1;
    if (Object.keys(set).length > 0) ops.push({ updateOne: { filter: { _id: row._id }, update: { $set: set } } });
  }

  if (apply === true) {
    for (let i = 0; i < ops.length; i += BATCH) {
      await CallLogModel.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    }
    if (fixBookingKeys && missingKey.length > 0) {
      const bops = missingKey.map(({ _id, key }) => ({
        updateOne: { filter: { _id, normalizedClientPhone: { $in: [null, ''] } }, update: { $set: { normalizedClientPhone: key } } },
      }));
      for (let i = 0; i < bops.length; i += BATCH) {
        const r = await CampaignBookingModel.bulkWrite(bops.slice(i, i + BATCH), { ordered: false });
        stats.bookingKeysFixed += r.modifiedCount || 0;
      }
    }
  }
  stats.callRowsToChange = ops.length;
  return stats;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dotenv = (await import('dotenv')).default;
  const mongoose = (await import('mongoose')).default;
  dotenv.config({ quiet: true });
  const apply = process.argv.includes('--apply');
  const fixBookingKeys = process.argv.includes('--fix-booking-keys');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to database "${mongoose.connection.name}". Mode: ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
  try {
    const stats = await runBackfill({ apply, fixBookingKeys });
    for (const [k, v] of Object.entries(stats)) console.log(`${k.padEnd(32)} ${v}`);
    if (!apply) console.log('\nDry run only. Re-run with --apply to write these changes.');
  } finally {
    await mongoose.disconnect();
  }
}

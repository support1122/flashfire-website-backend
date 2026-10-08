/**
 * READ-ONLY audit: how many no-shows were called by someone but the call is not linked to the booking?
 * (plan 6.2 step 1, problem P11)
 *
 *   node scripts/audit-call-linking.js            last 30 days (reads MONGODB_URI from .env)
 *   node scripts/audit-call-linking.js 60         window in days
 *
 * It performs find() calls only: no writes, no schedulers, no network. It prints counts and booking ids, never
 * client names, phones or emails.
 *
 * The logic is the exported pure function analyzeNoShowLinking, so it is unit-tested without a database.
 * Running this against the real database needs bsc's go-ahead.
 */
import { pathToFileURL } from 'node:url';
import { bookingPhoneKey, extractCallerZoomUserId, getIdentityDeps, normalizeLeadPhone } from '../Utils/CallLinking.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a call that happened is not linked, strongest evidence first. */
export const CAUSES = [
  'booking_phone_not_normalized', // booking has clientPhone but no normalizedClientPhone, so lookups by key miss it
  'stale_call_normalization',     // call stored an older phone key (country code / format) than the booking's
  'linked_to_sibling_booking',    // same client, another booking got the link
  'unlinked_same_phone',          // same phone key on both sides, link never made
  'name_only_match',              // phone differs, client name equal: wrong number dialled or a typo in one record
];

const foldName = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const ms = (d) => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};
const callMs = (c) => ms(c.startedAt) ?? ms(c.createdAt);

/**
 * @param {object} input
 * @param {object[]} input.noShows  CampaignBooking rows (bookingId, clientName, clientPhone, normalizedClientPhone, scheduledEventStartTime)
 * @param {object[]} input.calls    CallLog rows
 * @param {(b:object)=>string|null} input.assignedEmailOf  assigned BDA email of a booking
 * @param {(c:object)=>string|null} input.callerEmailOf    tracked BDA email of whoever made the call, or null
 * @param {number} [input.windowMs] search window around the scheduled start (default one day each side)
 */
export function analyzeNoShowLinking({ noShows, calls, assignedEmailOf, callerEmailOf, windowMs = DAY_MS }) {
  const outbound = (calls || []).filter((c) => c.direction === 'outbound');
  const byCause = Object.fromEntries([...CAUSES, 'called_by_other_agent', 'no_phone_on_booking', 'not_called'].map((k) => [k, []]));
  const linked = [];

  for (const b of noShows || []) {
    const assigned = assignedEmailOf(b);
    const hasHostLink = outbound.some((c) => c.bookingId === b.bookingId && assigned && callerEmailOf(c) === assigned);
    if (hasHostLink) {
      linked.push(b.bookingId);
      continue;
    }

    const startMs = ms(b.scheduledEventStartTime);
    const key = bookingPhoneKey(b);
    const near = startMs == null ? [] : outbound.filter((c) => {
      const t = callMs(c);
      return t != null && Math.abs(t - startMs) <= windowMs;
    });

    const phoneHits = key ? near.filter((c) => (
      c.leadNumberNormalized === key || normalizeLeadPhone(c.leadNumber) === key
    )) : [];
    const nameWanted = foldName(b.clientName);
    const nameHits = nameWanted ? near.filter((c) => foldName(c.leadName) === nameWanted && !phoneHits.includes(c)) : [];

    let cause;
    if (phoneHits.length > 0) {
      if (!b.normalizedClientPhone) cause = 'booking_phone_not_normalized';
      else if (phoneHits.some((c) => c.leadNumberNormalized !== key)) cause = 'stale_call_normalization';
      else if (phoneHits.some((c) => c.bookingId && c.bookingId !== b.bookingId)) cause = 'linked_to_sibling_booking';
      else if (phoneHits.some((c) => !c.bookingId)) cause = 'unlinked_same_phone';
      else cause = 'called_by_other_agent'; // linked to this booking, but not by the assigned BDA
    } else if (nameHits.length > 0) {
      cause = 'name_only_match';
    } else {
      cause = key ? 'not_called' : 'no_phone_on_booking';
    }
    byCause[cause].push(b.bookingId);
  }

  const counts = Object.fromEntries(Object.entries(byCause).map(([k, ids]) => [k, ids.length]));
  const calledButNotLinked = CAUSES.reduce((n, k) => n + counts[k], 0);
  const total = (noShows || []).length;
  return {
    noShows: total,
    linkedHostCall: linked.length,
    withoutLinkedHostCall: total - linked.length,
    calledButNotLinked,
    calledButNotLinkedPct: total ? Math.round((calledButNotLinked / total) * 1000) / 10 : 0,
    counts,
    bookingIds: byCause,
  };
}

/**
 * Load the data with two read queries and run the analysis. Uses whatever mongoose connection is already open.
 */
export async function runAudit({ days = 30, now = new Date(), deps } = {}) {
  const { CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js');
  const { CallLogModel } = await import('../Schema_Models/CallLog.js');
  const d = await getIdentityDeps(deps);
  const registry = await d.getTrackedBdas();

  const since = new Date(now.getTime() - days * DAY_MS);
  const noShows = await CampaignBookingModel.find({
    bookingStatus: 'no-show',
    scheduledEventStartTime: { $gte: since, $lte: now },
  })
    .select('bookingId clientName clientPhone normalizedClientPhone scheduledEventStartTime calendlyHost claimedBy attendanceAssignee')
    .lean();

  const calls = await CallLogModel.find({
    direction: 'outbound',
    startedAt: { $gte: new Date(since.getTime() - DAY_MS), $lte: new Date(now.getTime() + DAY_MS) },
  })
    .select('callId direction bookingId leadNumber leadNumberNormalized leadName startedAt createdAt salesEmail raw.caller_user_id raw.payload.object.caller raw.payload.object.user')
    .lean();

  const memo = new Map();
  const callerEmailOf = (c) => {
    const zoomUserId = extractCallerZoomUserId(c);
    const k = `${c.salesEmail || ''}|${zoomUserId || ''}`;
    if (!memo.has(k)) {
      const hit = (c.salesEmail || zoomUserId)
        ? d.resolveBda({ email: c.salesEmail || null, zoomUserId: zoomUserId ? String(zoomUserId) : null }, registry)
        : null;
      memo.set(k, hit?.bda?.email ? String(hit.bda.email).toLowerCase() : null);
    }
    return memo.get(k);
  };
  const assignedEmailOf = (b) => {
    const e = d.getAssignedBdaEmail(b);
    return e ? String(e).toLowerCase() : null;
  };

  return { days, ...analyzeNoShowLinking({ noShows, calls, assignedEmailOf, callerEmailOf }) };
}

function printSummary(s) {
  console.log(`Call-linking audit, last ${s.days} days (read-only)`);
  console.log(`no-shows checked:            ${s.noShows}`);
  console.log(`  with a linked host call:   ${s.linkedHostCall}`);
  console.log(`  without one:               ${s.withoutLinkedHostCall}`);
  console.log(`called but not linked:       ${s.calledButNotLinked} (${s.calledButNotLinkedPct}% of no-shows; target under 2%)`);
  console.log('by cause:');
  for (const [cause, n] of Object.entries(s.counts)) console.log(`  ${cause.padEnd(30)} ${n}`);
  console.log('booking ids per cause (first 50):');
  for (const [cause, ids] of Object.entries(s.bookingIds)) {
    if (ids.length) console.log(`  ${cause}: ${ids.slice(0, 50).join(', ')}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dotenv = (await import('dotenv')).default;
  const mongoose = (await import('mongoose')).default;
  dotenv.config({ quiet: true });
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }
  const days = Number(process.argv[2]) || 30;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log(`Connected to database "${mongoose.connection.name}" (read-only audit).`);
  try {
    printSummary(await runAudit({ days }));
  } finally {
    await mongoose.disconnect();
  }
}

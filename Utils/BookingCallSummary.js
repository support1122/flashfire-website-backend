// Per-meeting "did the assigned BDA call the client" summary (plan 2.4 and 6.3).
//
// A call COUNTS for a booking only when all of these hold:
//   - it is an outbound Zoom Phone CallLog row,
//   - the caller resolves (by email or Zoom user id, never by name) to the booking's assigned BDA,
//   - it is linked to the booking by bookingId, or, when the call has no bookingId at all, by the phone key.
import { CallLogModel } from '../Schema_Models/CallLog.js';
import {
  bookingPhoneKey,
  extractCallerZoomUserId,
  getIdentityDeps,
  normalizeLeadPhone,
  pickBookingForCall,
} from './CallLinking.js';

/** "Called in time" means a counted call from the scheduled start up to start + 30 min (plan D1). */
export const CALLED_WITHIN_MS = 30 * 60 * 1000;

export const emptyCallSummary = () => ({
  calls: 0,
  connected: false,
  firstCallAt: null,
  firstCallOffsetMin: null,
  talkSec: 0,
  calledWithin30Min: false,
  lastCallAt: null,
});

const ms = (d) => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

const callTimeMs = (c) => ms(c.startedAt) ?? ms(c.answeredAt) ?? ms(c.createdAt);

/**
 * Pure core: no database, no identity lookups. Everything it needs is passed in.
 *
 * @param {object[]} bookings  lean CampaignBooking rows
 * @param {object[]} calls     lean CallLog rows (any direction, any caller; this function filters)
 * @param {{ assignedEmailOf: (b:object)=>string|null, callerEmailOf: (c:object)=>string|null }} resolvers
 * @returns {Map<string, object>} bookingId -> callSummary. Bookings with no scheduled start or no assigned
 *   BDA get no entry: the answer is unknown, not "zero calls", and callers must render null.
 */
export function buildCallSummaries(bookings, calls, { assignedEmailOf, callerEmailOf }) {
  const eligible = new Map(); // bookingId -> { booking, startMs, assigned }
  const byPhone = new Map(); // phone key -> booking[]
  for (const b of bookings || []) {
    if (!b?.bookingId || eligible.has(b.bookingId)) continue;
    const startMs = ms(b.scheduledEventStartTime);
    const assigned = assignedEmailOf(b);
    if (startMs == null || !assigned) continue;
    eligible.set(b.bookingId, { booking: b, startMs, assigned: String(assigned).toLowerCase() });
    const key = bookingPhoneKey(b);
    if (key) {
      if (!byPhone.has(key)) byPhone.set(key, []);
      byPhone.get(key).push(b);
    }
  }

  const acc = new Map(); // bookingId -> counted calls
  for (const c of calls || []) {
    if (c.direction !== 'outbound') continue; // inbound and internal calls never count
    const when = callTimeMs(c);
    if (when == null) continue;

    let target = null;
    if (c.bookingId) {
      target = eligible.get(c.bookingId) || null; // explicitly linked elsewhere: it belongs to that booking
    } else {
      const key = c.leadNumberNormalized || normalizeLeadPhone(c.leadNumber);
      const picked = key ? pickBookingForCall(byPhone.get(key), when) : null;
      target = picked ? eligible.get(picked.bookingId) : null;
    }
    if (!target) continue;

    const caller = callerEmailOf(c);
    if (!caller || caller !== target.assigned) continue; // a colleague or an unknown caller never counts

    if (!acc.has(target.booking.bookingId)) acc.set(target.booking.bookingId, []);
    acc.get(target.booking.bookingId).push({ when, call: c });
  }

  const out = new Map();
  for (const [bookingId, { startMs }] of eligible) {
    const counted = (acc.get(bookingId) || []).sort((a, b) => a.when - b.when);
    if (counted.length === 0) {
      out.set(bookingId, emptyCallSummary());
      continue;
    }
    const first = counted[0].when;
    const last = counted[counted.length - 1].when;
    const offset = Math.round((first - startMs) / 60000);
    out.set(bookingId, {
      calls: counted.length,
      connected: counted.some(({ call }) => call.callResult === 'connected'),
      firstCallAt: new Date(first),
      firstCallOffsetMin: offset === 0 ? 0 : offset, // avoid -0
      talkSec: counted.reduce((sum, { call }) => sum + (Number(call.durationSec) || 0), 0),
      calledWithin30Min: counted.some(({ when }) => when >= startMs && when <= startMs + CALLED_WITHIN_MS),
      lastCallAt: new Date(last),
    });
  }
  return out;
}

const CALL_FIELDS = [
  'callId', 'direction', 'bookingId', 'leadNumber', 'leadNumberNormalized', 'startedAt', 'answeredAt',
  'durationSec', 'callResult', 'salesEmail', 'createdAt',
  // Only the caller id out of the big raw payload, for both synced rows and webhook rows.
  'raw.caller_user_id', 'raw.payload.object.caller', 'raw.payload.object.user',
].join(' ');

/**
 * Call summaries for one page of bookings, with ONE CallLog query regardless of page size.
 *
 * @param {object[]} bookings lean CampaignBooking rows (needs bookingId, scheduledEventStartTime, phone and
 *   assignment fields)
 * @param {object} [deps] test overrides: { resolveBda, getTrackedBdas, getAssignedBdaEmail }
 * @returns {Promise<Map<string, object>>} bookingId -> callSummary (see buildCallSummaries)
 */
export async function getCallSummaries(bookings, deps) {
  const list = Array.isArray(bookings) ? bookings.filter((b) => b?.bookingId) : [];
  if (list.length === 0) return new Map();

  const d = await getIdentityDeps(deps);
  const ids = [];
  const phones = new Set();
  for (const b of list) {
    ids.push(b.bookingId);
    const key = bookingPhoneKey(b);
    if (key) phones.add(key);
  }

  const or = [{ bookingId: { $in: ids } }];
  if (phones.size > 0) or.push({ leadNumberNormalized: { $in: [...phones] } });

  const [registry, calls] = await Promise.all([
    d.getTrackedBdas(),
    CallLogModel.find({ direction: 'outbound', $or: or }).select(CALL_FIELDS).lean(),
  ]);

  const memo = new Map(); // one identity lookup per distinct caller on the page
  const callerEmailOf = (c) => {
    const zoomUserId = extractCallerZoomUserId(c);
    const memoKey = `${c.salesEmail || ''}|${zoomUserId || ''}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    const hit = (c.salesEmail || zoomUserId)
      ? d.resolveBda({ email: c.salesEmail || null, zoomUserId: zoomUserId ? String(zoomUserId) : null }, registry)
      : null;
    const email = hit?.bda?.email ? String(hit.bda.email).toLowerCase() : null;
    memo.set(memoKey, email);
    return email;
  };

  return buildCallSummaries(list, calls, {
    assignedEmailOf: d.getAssignedBdaEmail,
    callerEmailOf,
  });
}

/**
 * Same as getCallSummaries, but a failure returns an empty map (rows render callSummary: null) instead of
 * failing the whole page. Use this from list endpoints.
 */
export async function getCallSummariesSafe(bookings, deps) {
  try {
    return await getCallSummaries(bookings, deps);
  } catch (e) {
    console.error('[BookingCallSummary] call summaries unavailable:', e.message);
    return new Map();
  }
}

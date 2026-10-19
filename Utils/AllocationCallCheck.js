// "Did the BDA call the client?" for Lead Allocation calls. Same evidence as the Calendly no-show rule: outbound Zoom
// Phone calls in CallLog, attributed to a BDA by email or Zoom user id (never by name), matched to the client by phone.
//
// This only SHOWS what the call log says. It never fines anyone: an admin looks at "Not called" and decides.
//
// A call counts for an allocation when it is outbound, made by the allocated BDA, to the client's number, and placed
// between the moment the allocation was created and 30 minutes after the call time. The team's rule is "call before
// Time (India)", so a call at or before the call time is "called in time" and one in the next 30 minutes is "called late".
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { extractCallerZoomUserId, getIdentityDeps, normalizeLeadPhone } from './CallLinking.js';

export const LATE_WINDOW_MS = 30 * 60 * 1000;
// Used when an allocation has no createdAt: never look further back than this before the call time.
const FALLBACK_LOOKBACK_MS = 3 * 60 * 60 * 1000;

export const CALL_VERDICTS = Object.freeze(['called_in_time', 'called_late', 'not_called', 'waiting', 'no_phone']);

const ms = (d) => {
  const t = d == null ? NaN : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};
const callTimeMs = (c) => ms(c.startedAt) ?? ms(c.answeredAt) ?? ms(c.createdAt);

const empty = (verdict) => ({ verdict, calls: 0, connected: false, firstCallAt: null, firstCallOffsetMin: null, talkSec: 0 });

/**
 * Pure core. `calls` are lean CallLog rows (any direction, any caller; this function filters).
 * @returns {Map<string, object>} allocationId -> { verdict, calls, connected, firstCallAt, firstCallOffsetMin, talkSec }.
 *   An allocation with no call time gets no entry: the answer is unknown.
 */
export function buildAllocationCallChecks(allocations, calls, { callerEmailOf }, nowMs = Date.now()) {
  const byPhone = new Map(); // phone key -> outbound calls [{ when, call, caller }]
  for (const c of calls || []) {
    if (c.direction !== 'outbound') continue;
    const when = callTimeMs(c);
    const key = normalizeLeadPhone(c.leadNumberNormalized) || normalizeLeadPhone(c.leadNumber);
    if (when == null || !key) continue;
    const caller = callerEmailOf(c);
    if (!caller) continue;
    if (!byPhone.has(key)) byPhone.set(key, []);
    byPhone.get(key).push({ when, call: c, caller });
  }

  const out = new Map();
  for (const a of allocations || []) {
    const callAt = ms(a?.callAt);
    if (!a?.allocationId || callAt == null) continue;
    const key = normalizeLeadPhone(a.phone);
    if (!key) {
      out.set(a.allocationId, empty('no_phone'));
      continue;
    }
    const bda = String(a.bdaEmail || '').trim().toLowerCase();
    const from = ms(a.createdAt) ?? callAt - FALLBACK_LOOKBACK_MS;
    const counted = (byPhone.get(key) || [])
      .filter((x) => x.caller === bda && x.when >= from && x.when <= callAt + LATE_WINDOW_MS)
      .sort((p, q) => p.when - q.when);

    if (counted.length === 0) {
      out.set(a.allocationId, empty(nowMs > callAt + LATE_WINDOW_MS ? 'not_called' : 'waiting'));
      continue;
    }
    const first = counted[0].when;
    out.set(a.allocationId, {
      verdict: first <= callAt ? 'called_in_time' : 'called_late',
      calls: counted.length,
      connected: counted.some(({ call }) => call.callResult === 'connected'),
      firstCallAt: new Date(first).toISOString(),
      firstCallOffsetMin: Math.round((first - callAt) / 60000) || 0, // negative = before the call time; || 0 avoids -0
      talkSec: counted.reduce((sum, { call }) => sum + (Number(call.durationSec) || 0), 0),
    });
  }
  return out;
}

const CALL_FIELDS = [
  'callId', 'direction', 'leadNumber', 'leadNumberNormalized', 'startedAt', 'answeredAt', 'durationSec', 'callResult',
  'salesEmail', 'createdAt', 'raw.caller_user_id', 'raw.payload.object.caller', 'raw.payload.object.user',
].join(' ');

/** One CallLog query for a whole page of allocations. `deps` overrides { resolveBda, getTrackedBdas } for tests. */
export async function getAllocationCallChecks(allocations, deps, nowMs = Date.now()) {
  const list = Array.isArray(allocations) ? allocations.filter((a) => a?.allocationId && ms(a.callAt) != null) : [];
  if (list.length === 0) return new Map();
  const phones = new Set(list.map((a) => normalizeLeadPhone(a.phone)).filter(Boolean));
  if (phones.size === 0) return buildAllocationCallChecks(list, [], { callerEmailOf: () => null }, nowMs);

  const earliest = Math.min(...list.map((a) => ms(a.createdAt) ?? ms(a.callAt) - FALLBACK_LOOKBACK_MS));
  const d = await getIdentityDeps(deps);
  const [registry, calls] = await Promise.all([
    d.getTrackedBdas(),
    CallLogModel.find({ direction: 'outbound', leadNumberNormalized: { $in: [...phones] }, startedAt: { $gte: new Date(earliest) } })
      .select(CALL_FIELDS)
      .lean(),
  ]);

  const memo = new Map();
  const callerEmailOf = (c) => {
    const zoomUserId = extractCallerZoomUserId(c);
    const memoKey = `${c.salesEmail || ''}|${zoomUserId || ''}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    const hit = c.salesEmail || zoomUserId
      ? d.resolveBda({ email: c.salesEmail || null, zoomUserId: zoomUserId ? String(zoomUserId) : null }, registry)
      : null;
    const email = hit?.bda?.email ? String(hit.bda.email).toLowerCase() : null;
    memo.set(memoKey, email);
    return email;
  };
  return buildAllocationCallChecks(list, calls, { callerEmailOf }, nowMs);
}

/** A failure returns an empty map (rows render callCheck: null) instead of failing the whole list. */
export async function getAllocationCallChecksSafe(allocations, deps, nowMs) {
  try {
    return await getAllocationCallChecks(allocations, deps, nowMs);
  } catch (err) {
    console.error('[AllocationCallCheck] call check unavailable:', err?.message);
    return new Map();
  }
}

// Shared call-to-booking linking helpers (plan 2.4, 2.8, 6.2).
//
// Why this file exists: the webhook (ZoomPhoneController) and the poller (ZoomPhoneSync) each had their own
// phone matching, and both disagreed with how CampaignBooking.normalizedClientPhone is built. Everything that
// turns a phone into a key, picks a booking for a call, or decides who made a call now lives here.
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { normalizePhoneForMatching } from './normalizePhoneForMatching.js';

/**
 * The one phone key for calls and bookings: the last 10 digits. It is the same function
 * CampaignBooking.normalizedClientPhone is built with, so the two sides can never drift.
 * (The old ZoomPhone.normalizePhone kept all digits for non-US numbers, so "+91 98765 43210" became
 * "919876543210" on the call and "9876543210" on the booking and never matched.)
 */
export const normalizeLeadPhone = (raw) => normalizePhoneForMatching(raw);

/** Phone key of a booking. Falls back to clientPhone because bookings written without save() have no stored key. */
export function bookingPhoneKey(booking) {
  if (!booking) return null;
  return booking.normalizedClientPhone || normalizeLeadPhone(booking.clientPhone) || null;
}

const toMs = (d) => {
  if (!d) return null;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
};

const bookingTimeMs = (b) => toMs(b.scheduledEventStartTime) ?? toMs(b.bookingCreatedAt) ?? 0;

/**
 * A client with two bookings has one phone and two meetings. Link the call to the booking whose meeting is
 * closest in time to the call, ignoring bookings created after the call (a call cannot be about a booking
 * that did not exist yet) unless nothing else is left. Ties go to the later meeting.
 */
export function pickBookingForCall(candidates, callStartedAt) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const callMs = toMs(callStartedAt);
  let pool = candidates;
  if (callMs != null) {
    const existed = candidates.filter((b) => {
      const created = toMs(b.bookingCreatedAt);
      return created == null || created <= callMs;
    });
    if (existed.length > 0) pool = existed;
  }
  let best = null;
  let bestDist = Infinity;
  for (const b of pool) {
    const t = bookingTimeMs(b);
    const dist = callMs == null ? -t : Math.abs(t - callMs); // no call time: the most recent meeting wins
    if (dist < bestDist || (dist === bestDist && best && t > bookingTimeMs(best))) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * One indexed query for any number of phone keys. Returns Map<key, booking[]>.
 * Uses normalizedClientPhone (indexed); bookings that never got the field are caught by the backfill script.
 */
export async function findBookingsByPhoneKeys(keys) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  const byKey = new Map();
  if (unique.length === 0) return byKey;
  const rows = await CampaignBookingModel
    .find({ normalizedClientPhone: { $in: unique } })
    .select('bookingId clientPhone normalizedClientPhone clientEmail clientName scheduledEventStartTime bookingCreatedAt')
    .lean();
  for (const b of rows) {
    const k = b.normalizedClientPhone;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(b);
  }
  return byKey;
}

/**
 * The lead (client) side of a Zoom call_history row. Outbound: the callee. Inbound: the caller.
 * Zoom leaves *_did_number empty for some external parties, so fall back to *_number.
 */
export function leadSideOfHistoryRow(c) {
  const outbound = c.direction === 'outbound';
  return outbound
    ? { number: c.callee_did_number || c.callee_number || null, name: c.callee_name || null }
    : { number: c.caller_did_number || c.caller_number || null, name: c.caller_name || null };
}

/** The BDA (agent) side of a Zoom call_history row. Outbound: the caller. Inbound: the callee. */
export function salesSideOfHistoryRow(c) {
  const outbound = c.direction === 'outbound';
  const email = outbound ? c.caller_email : c.callee_email;
  return {
    email: email ? String(email).toLowerCase() : null,
    name: (outbound ? c.caller_name : c.callee_name) || null,
    number: (outbound
      ? (c.caller_did_number || c.caller_ext_number)
      : (c.callee_did_number || c.callee_ext_number)) || null,
    zoomUserId: (outbound ? c.caller_user_id : c.callee_user_id) || null,
  };
}

/** Zoom user id of whoever made a stored call, from either a synced row or a webhook row. */
export function extractCallerZoomUserId(callLog) {
  const raw = callLog?.raw;
  if (!raw) return null;
  const obj = raw.payload?.object;
  return raw.caller_user_id
    || obj?.caller?.user_id
    || obj?.caller?.id
    || obj?.user?.id
    || null;
}

// ---- BDA identity (written by another module; loaded lazily so this file stays testable on its own) ----

let cachedDeps = null;

async function defaultIdentityDeps() {
  if (cachedDeps) return cachedDeps;
  const [identity, registry, assignment] = await Promise.all([
    import('./BdaIdentity.js'),
    import('./BdaRegistry.js'),
    import('./BdaAssignment.js'),
  ]);
  cachedDeps = {
    resolveBda: identity.resolveBda,
    getTrackedBdas: registry.getTrackedBdas,
    learnZoomUserId: registry.learnZoomUserId || identity.learnZoomUserId || null,
    getAssignedBdaEmail: assignment.getAssignedBdaEmail,
  };
  return cachedDeps;
}

/** Test hook: swap the identity functions for the whole process (pass null to go back to the real modules). */
export function __setIdentityDepsForTests(deps) {
  cachedDeps = deps;
}

/** Resolve the identity functions: caller-supplied overrides win, the real modules fill the rest. */
export async function getIdentityDeps(overrides = {}) {
  const needsDefaults = !(overrides.resolveBda && overrides.getTrackedBdas && overrides.getAssignedBdaEmail);
  const base = needsDefaults ? await defaultIdentityDeps() : {};
  return { ...base, ...overrides };
}

/**
 * Decide which tracked BDA made a call, from stable ids only (email, Zoom user id). Names are never used:
 * salesName can hold a client's name (plan 2.8). Returns the BDA email or null when the caller is unknown.
 * Side effect: the first time an email matches a profile, the profile's zoomUserId is learned.
 *
 * @param {{email?: string|null, zoomUserId?: string|null}} hint
 * @param {object} deps  from getIdentityDeps()
 * @param {object} [ctx] { registry } to reuse one registry read across many calls; { learned: Set } to learn once per run
 */
export async function attributeCaller(hint, deps, ctx = {}) {
  const registry = ctx.registry ?? await deps.getTrackedBdas();
  const email = hint.email ? String(hint.email).toLowerCase() : null;
  const zoomUserId = hint.zoomUserId ? String(hint.zoomUserId) : null;
  if (!email && !zoomUserId) return null;
  const hit = deps.resolveBda({ email, zoomUserId }, registry);
  if (!hit?.bda?.email) return null;
  if (hit.via === 'email' && zoomUserId && deps.learnZoomUserId && hit.bda.zoomUserId !== zoomUserId) {
    const key = `${hit.bda.email}|${zoomUserId}`;
    if (!ctx.learned || !ctx.learned.has(key)) {
      ctx.learned?.add(key);
      try {
        await deps.learnZoomUserId(hit.bda.email, zoomUserId);
      } catch (e) {
        console.error('[CallLinking] learnZoomUserId failed:', e.message);
      }
    }
  }
  return String(hit.bda.email).toLowerCase();
}

let healthModule = null;

/** Test hook: swap the SyncHealth module (pass null to go back to the real one). */
export function __setSyncHealthForTests(mod) {
  healthModule = mod;
}

/** SyncHealth writes must never break a sync or a webhook, so failures are logged and swallowed. */
export async function reportSync(ok, err, override) {
  try {
    const mod = override || healthModule || (healthModule = await import('./SyncHealth.js'));
    if (ok) await mod.recordSyncOk('zoom_phone');
    else await mod.recordSyncError('zoom_phone', err);
  } catch (e) {
    console.error('[CallLinking] SyncHealth write failed:', e.message);
  }
}

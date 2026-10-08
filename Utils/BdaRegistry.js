import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { BdaUnknownNameModel } from '../Schema_Models/BdaUnknownName.js';
import { foldName, isNonHuman, isShared } from './BdaIdentity.js';

// The BDA registry (plan 2.8): who is tracked, who is on leave. Profiles are few and rarely change,
// so the whole set is cached for 60 s and every lookup is answered from memory.

const CACHE_TTL_MS = 60 * 1000;

let cache = null; // { at, profiles }
let inflight = null;

const normEmail = (e) => String(e ?? '').trim().toLowerCase();

export function invalidateRegistryCache() {
  cache = null;
  inflight = null;
}

async function loadProfiles() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.profiles;
  if (inflight) return inflight;
  const started = BdaProfileModel.find({})
    .lean()
    .then((profiles) => {
      // A write that invalidated the cache while this read was in flight must not be overwritten by it.
      if (inflight === started) cache = { at: Date.now(), profiles };
      return profiles;
    })
    .finally(() => {
      if (inflight === started) inflight = null;
    });
  inflight = started;
  return started;
}

/** Every profile, including untracked and inactive ones (for the matcher's stable-ID lookups). */
export async function getAllBdaProfiles() {
  return loadProfiles();
}

/** Profiles with active and tracked both true: the people attendance, calls and deductions apply to. */
export async function getTrackedBdas() {
  const profiles = await loadProfiles();
  return profiles.filter((p) => p.active !== false && p.tracked === true);
}

/** One profile by email (any state), or null. */
export async function getBdaProfile(email) {
  const wanted = normEmail(email);
  if (!wanted) return null;
  const profiles = await loadProfiles();
  return profiles.find((p) => p.email === wanted) || null;
}

/** True only for an active, tracked registry BDA. A CRM user with role 'bda' is not automatically one. */
export async function isTrackedBda(email) {
  const profile = await getBdaProfile(email);
  return Boolean(profile && profile.active !== false && profile.tracked === true);
}

/** True when `dateIST` ('YYYY-MM-DD', the IST calendar date) is one of the BDA's approved leave days. */
export async function isOnLeave(email, dateIST) {
  const profile = await getBdaProfile(email);
  return Boolean(profile && Array.isArray(profile.leaveDays) && profile.leaveDays.includes(dateIST));
}

async function learnField(field, email, value) {
  const wanted = normEmail(email);
  const id = String(value ?? '').trim();
  if (!wanted || !id) return false;
  // Only fill an empty field on an existing profile. A stored ID is never overwritten by a guess.
  const res = await BdaProfileModel.updateOne(
    { email: wanted, $or: [{ [field]: null }, { [field]: '' }, { [field]: { $exists: false } }] },
    { $set: { [field]: id } }
  );
  if (res.modifiedCount > 0) {
    invalidateRegistryCache();
    return true;
  }
  return false;
}

/** Remember a Meet participant's `users/{id}` the first time Directory matched it to this BDA. */
export const learnGoogleUserId = (email, googleUserId) => learnField('googleUserId', email, googleUserId);

/** Remember the Zoom `caller_user_id` the first time a call's caller_email matched this BDA. */
export const learnZoomUserId = (email, zoomUserId) => learnField('zoomUserId', email, zoomUserId);

/**
 * Record a name the matcher could not resolve. Bots, the shared account and blanks are known, not unknown,
 * so they are skipped. `ref` (a booking or call id) keeps one meeting polled every minute from counting 60 times.
 * Never throws: logging must not break attendance.
 */
export async function logUnknownName({ name, source = null, ref = null }) {
  const key = foldName(name);
  if (!key || isNonHuman(key) || isShared(key)) return false;
  const now = new Date();
  const refStr = ref == null ? null : String(ref);
  try {
    await BdaUnknownNameModel.updateOne(
      { key },
      [
        {
          $set: {
            name: String(name).trim().slice(0, 200),
            source,
            lastSeenAt: now,
            count: {
              $cond: [
                { $and: [{ $ne: [refStr, null] }, { $eq: ['$lastRef', refStr] }] },
                { $ifNull: ['$count', 0] },
                { $add: [{ $ifNull: ['$count', 0] }, 1] },
              ],
            },
            lastRef: refStr,
          },
        },
      ],
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error('[BdaRegistry] could not log unknown name:', err?.message);
    return false;
  }
}

/** Newest distinct unresolved names, for the admin screen. */
export async function getRecentUnknownNames(limit = 20) {
  const rows = await BdaUnknownNameModel.find({}).sort({ lastSeenAt: -1 }).limit(limit).lean();
  return rows.map((r) => ({ name: r.name, count: r.count, lastSeenAt: r.lastSeenAt, source: r.source }));
}

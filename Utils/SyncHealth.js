import { SyncHealthModel } from '../Schema_Models/SyncHealth.js';

// Sync health (plan 2.7). Every background source reports here; the deduction engine asks whether a source was
// healthy for the exact window a fine rests on. Writers never throw: health reporting must not break the sync.

export const SYNC_SOURCES = ['google_meet', 'zoom_phone', 'verdict_job'];

// How stale a source may be before it counts as unhealthy (plan 2.7). The verdict job runs every 15 s.
export const SYNC_LIMITS_MS = {
  google_meet: 10 * 60 * 1000,
  zoom_phone: 30 * 60 * 1000,
  verdict_job: 5 * 60 * 1000,
};

const OK_SAMPLE_GAP_MS = 30 * 1000;
const OK_KEEP = 2880;

function knownSource(source, fn) {
  if (SYNC_SOURCES.includes(source)) return true;
  console.error(`[SyncHealth] ${fn}: unknown source "${source}"`);
  return false;
}

/** Mark a successful run. Clears the last error, and keeps a sampled history for window checks. */
export async function recordSyncOk(source, now = new Date()) {
  if (!knownSource(source, 'recordSyncOk')) return false;
  const okTimes = { $ifNull: ['$okTimes', []] };
  try {
    await SyncHealthModel.updateOne(
      { source },
      [
        {
          $set: {
            lastOkAt: now,
            lastError: null,
            updatedAt: now,
            okTimes: {
              $cond: [
                {
                  $gte: [
                    { $subtract: [now, { $ifNull: [{ $arrayElemAt: ['$okTimes', -1] }, new Date(0)] }] },
                    OK_SAMPLE_GAP_MS,
                  ],
                },
                { $slice: [{ $concatArrays: [okTimes, [now]] }, -OK_KEEP] },
                okTimes,
              ],
            },
          },
        },
      ],
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error(`[SyncHealth] could not record ok for ${source}:`, err?.message);
    return false;
  }
}

/** Mark a failed run. lastOkAt is kept, so the age of the last good sync stays visible. */
export async function recordSyncError(source, err, now = new Date()) {
  if (!knownSource(source, 'recordSyncError')) return false;
  const message = String(err?.message ?? err ?? 'unknown error').slice(0, 500);
  try {
    await SyncHealthModel.updateOne(
      { source },
      { $set: { lastError: message, lastErrorAt: now, updatedAt: now } },
      { upsert: true }
    );
    return true;
  } catch (e) {
    console.error(`[SyncHealth] could not record error for ${source}:`, e?.message);
    return false;
  }
}

/** One entry per known source, never-run sources included with nulls. */
export async function getAllSyncHealth() {
  const rows = await SyncHealthModel.find({}).select('-okTimes -_id -__v').lean();
  const bySource = new Map(rows.map((r) => [r.source, r]));
  return SYNC_SOURCES.map(
    (source) =>
      bySource.get(source) || { source, lastOkAt: null, lastError: null, lastErrorAt: null, updatedAt: null }
  );
}

async function okTimesMs(source) {
  const row = await SyncHealthModel.findOne({ source }).select('okTimes lastOkAt').lean();
  if (!row) return [];
  const times = (row.okTimes || []).map((d) => new Date(d).getTime());
  const last = row.lastOkAt ? new Date(row.lastOkAt).getTime() : null;
  if (last != null && (times.length === 0 || last > times[times.length - 1])) times.push(last);
  return times.sort((a, b) => a - b);
}

/** True when at least one successful run landed inside [fromMs, toMs]. */
export async function syncOkBetween(source, fromMs, toMs) {
  const times = await okTimesMs(source);
  return times.some((t) => t >= fromMs && t <= toMs);
}

/**
 * True when, at every moment of [fromMs, toMs], the newest successful run was at most maxAgeMs old.
 * Unknown history counts as unhealthy: a fine is never built on data we cannot vouch for.
 * Call it after toMs; a window that has not finished yet cannot be vouched for either.
 */
export async function wasSourceHealthy(source, { fromMs, toMs, maxAgeMs }) {
  if (!knownSource(source, 'wasSourceHealthy')) return false;
  if (![fromMs, toMs, maxAgeMs].every(Number.isFinite) || toMs < fromMs) return false;
  const times = await okTimesMs(source);
  let cursor = fromMs;
  while (cursor <= toMs) {
    let newest = null;
    for (const t of times) {
      if (t > cursor) break;
      newest = t;
    }
    if (newest == null) return false;
    const reach = newest + maxAgeMs;
    if (reach < cursor) return false;
    if (reach >= toMs) return true;
    cursor = reach + 1;
  }
  return true;
}

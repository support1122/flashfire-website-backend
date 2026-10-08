import { CallLogModel } from '../Schema_Models/CallLog.js';
import { getZoomAccessToken } from './ZoomPhone.js';
import {
  attributeCaller,
  findBookingsByPhoneKeys,
  getIdentityDeps,
  leadSideOfHistoryRow,
  normalizeLeadPhone,
  pickBookingForCall,
  reportSync,
  salesSideOfHistoryRow,
} from './CallLinking.js';

const ZOOM_API = 'https://api.zoom.us/v2';
const fmtDate = (d) => d.toISOString().slice(0, 10);

const statusFromResult = (r) => (r === 'connected' ? 'completed'
  : r === 'voicemail' ? 'voicemail'
  : r === 'missed' || r === 'no_answer' ? 'missed'
  : r === 'cancelled' ? 'cancelled'
  : 'unknown');

/**
 * Build the upsert for one Zoom call_history row. Pure, so it is unit-tested without a database.
 *
 * Link fields (bookingId, leadEmail) are only written when a booking matched. The old code wrote null when the
 * poller could not match, which erased a link the webhook had already made.
 *
 * @returns {{ set: object, setOnInsert: object }}
 */
export function buildHistoryCallDoc(c, booking) {
  const lead = leadSideOfHistoryRow(c);
  const sales = salesSideOfHistoryRow(c);
  const leadNumberNormalized = normalizeLeadPhone(lead.number);

  const set = {
    direction: c.direction || 'outbound',
    status: statusFromResult(c.call_result),

    // Inbound calls: the BDA is the callee, so read the sales side from the right party.
    salesEmail: sales.email,
    salesName: sales.name,
    salesNumber: sales.number,

    leadNumber: lead.number,
    leadNumberNormalized,

    startedAt: c.start_time ? new Date(c.start_time) : null,
    answeredAt: c.answer_time ? new Date(c.answer_time) : null,
    endedAt: c.end_time ? new Date(c.end_time) : null,
    durationSec: Number(c.duration) || 0,

    callPathId: c.call_path_id || null,
    callType: c.call_type || null,
    connectType: c.connect_type || null,
    callResult: c.call_result || null,
    recordingStatus: c.recording_status || null,
    international: typeof c.international === 'boolean' ? c.international : null,
    hideCallerId: typeof c.hide_caller_id === 'boolean' ? c.hide_caller_id : null,
    endToEnd: typeof c.end_to_end === 'boolean' ? c.end_to_end : null,

    callerExtNumber: c.caller_ext_number || null,
    callerExtType: c.caller_ext_type || null,
    callerNumberType: c.caller_number_type || null,
    callerDeviceType: c.caller_device_type || null,
    callerCountryCode: c.caller_country_code || null,
    callerCountryIso: c.caller_country_iso_code || null,

    calleeName: c.callee_name || null,
    calleeEmail: c.callee_email ? String(c.callee_email).toLowerCase() : null,
    calleeExtNumber: c.callee_ext_number || null,
    calleeNumberType: c.callee_number_type || null,
    calleeCountryCode: c.callee_country_code || null,
    calleeCountryIso: c.callee_country_iso_code || null,

    source: 'sync',
    raw: c,
  };
  const setOnInsert = {};

  if (booking) {
    set.bookingId = booking.bookingId;
    set.leadEmail = booking.clientEmail || null;
    set.leadName = booking.clientName || lead.name || null;
  } else {
    setOnInsert.leadName = lead.name; // never overwrite a name an earlier link already stored
  }

  // Only set durationSec if the synced value is non-zero, to preserve a larger value from a webhook event.
  if (!set.durationSec) delete set.durationSec;
  return { set, setOnInsert };
}

/**
 * Upsert call_history rows into CallLog: one booking query for the whole batch, one bulkWrite.
 * Idempotent: re-running the same rows overwrites by callId and creates no duplicates.
 *
 * @param {object[]} calls Zoom call_history rows
 * @param {object} [deps] test overrides for the identity functions
 * @returns {Promise<{ upserted: number, matched: number, unknownCallers: number }>}
 */
export async function upsertCallHistoryRows(calls, deps) {
  const keys = new Set();
  for (const c of calls) {
    const k = normalizeLeadPhone(leadSideOfHistoryRow(c).number);
    if (k) keys.add(k);
  }
  const bookingsByKey = await findBookingsByPhoneKeys([...keys]);

  // Who made each call (plan 2.8). Unknown callers are stored but never counted; this only learns Zoom user
  // ids and reports how many calls had no known BDA. A failure here must never stop the upsert.
  let unknownCallers = 0;
  try {
    const d = await getIdentityDeps(deps);
    const ctx = { registry: await d.getTrackedBdas(), learned: new Set() };
    const memo = new Map();
    for (const c of calls) {
      if (c.direction !== 'outbound') continue;
      const s = salesSideOfHistoryRow(c);
      const memoKey = `${s.email || ''}|${s.zoomUserId || ''}`;
      if (!memo.has(memoKey)) memo.set(memoKey, await attributeCaller(s, d, ctx));
      if (!memo.get(memoKey)) unknownCallers += 1;
    }
  } catch (e) {
    console.error('[ZoomPhoneSync] caller attribution failed:', e.message);
  }

  const ops = [];
  let matched = 0;
  for (const c of calls) {
    const callId = c.call_id || c.id;
    if (!callId) continue;
    const startedAt = c.start_time ? new Date(c.start_time) : null;
    const key = normalizeLeadPhone(leadSideOfHistoryRow(c).number);
    const booking = key ? pickBookingForCall(bookingsByKey.get(key), startedAt) : null;
    if (booking) matched += 1;
    const { set, setOnInsert } = buildHistoryCallDoc(c, booking);
    ops.push({
      updateOne: {
        filter: { callId },
        update: { $set: set, $setOnInsert: { callId, ...setOnInsert } },
        upsert: true,
      },
    });
  }
  if (ops.length > 0) await CallLogModel.bulkWrite(ops, { ordered: false });
  return { upserted: ops.length, matched, unknownCallers };
}

/**
 * Pull Zoom Phone /phone/call_history for a date range and upsert each call into the CallLog collection.
 * Records SyncHealth 'zoom_phone' on every outcome so the deduction engine knows whether call data is fresh.
 *
 * @param {object} opts
 * @param {number} [opts.lookbackDays=30] how many days back from "now" to pull
 * @param {number} [opts.pageSize=100] Zoom max is 300; 100 is safe
 * @param {object} [deps] test overrides: { getToken, fetchFn, health, ...identity }
 * @returns {{ ok: boolean, fetched: number, upserted: number, matched: number, error?: string }}
 */
export async function syncZoomCallHistory({ lookbackDays = 30, pageSize = 100 } = {}, deps = {}) {
  const getToken = deps.getToken || getZoomAccessToken;
  const fetchFn = deps.fetchFn || fetch;
  const fail = async (result) => {
    await reportSync(false, new Error(result.error), deps.health);
    return result;
  };
  try {
    const token = await getToken();
    if (!token) return await fail({ ok: false, fetched: 0, upserted: 0, matched: 0, error: 'Zoom OAuth not configured' });

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - lookbackDays);
    const fromStr = fmtDate(from);
    const toStr = fmtDate(to);

    // Page through call_history.
    const all = [];
    let nextPageToken = '';
    let safety = 0;
    do {
      const url = new URL(`${ZOOM_API}/phone/call_history`);
      url.searchParams.set('from', fromStr);
      url.searchParams.set('to', toStr);
      url.searchParams.set('page_size', String(pageSize));
      if (nextPageToken) url.searchParams.set('next_page_token', nextPageToken);

      const r = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const body = await r.text();
        return await fail({
          ok: false, fetched: all.length, upserted: 0, matched: 0,
          error: `Zoom ${r.status}: ${body.slice(0, 200)}`,
        });
      }
      const j = await r.json();
      all.push(...(j.call_logs || []));
      nextPageToken = j.next_page_token || '';
      safety += 1;
      if (safety > 50) break; // 50 pages x 100 = 5000 calls; plenty.
    } while (nextPageToken);

    const { upserted, matched, unknownCallers } = await upsertCallHistoryRows(all, deps);
    if (unknownCallers > 0) console.warn(`[ZoomPhoneSync] ${unknownCallers} outbound call(s) from callers not in the BDA registry (stored, not counted)`);
    await reportSync(true, null, deps.health);
    return { ok: true, fetched: all.length, upserted, matched };
  } catch (error) {
    console.error('[ZoomPhoneSync] error:', error);
    await reportSync(false, error, deps.health);
    return { ok: false, fetched: 0, upserted: 0, matched: 0, error: error.message };
  }
}

let intervalHandle = null;

/** Start the 5-min poll loop. Idempotent. */
export function startZoomPhoneSyncer(intervalMs = 5 * 60 * 1000) {
  if (intervalHandle) return;
  console.log(`[ZoomPhoneSync] starting poll loop every ${intervalMs / 1000}s`);
  // Fire once on boot — lookback 30d to backfill.
  syncZoomCallHistory({ lookbackDays: 30 }).then((r) =>
    console.log(`[ZoomPhoneSync] initial sync: ${JSON.stringify(r)}`)
  );
  intervalHandle = setInterval(() => {
    syncZoomCallHistory({ lookbackDays: 2 }).then((r) => {
      if (r.upserted > 0 || !r.ok) {
        console.log(`[ZoomPhoneSync] tick: ${JSON.stringify(r)}`);
      }
    });
  }, intervalMs);
}

export function stopZoomPhoneSyncer() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

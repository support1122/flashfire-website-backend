import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getZoomAccessToken, normalizePhone } from './ZoomPhone.js';

const ZOOM_API = 'https://api.zoom.us/v2';
const fmtDate = (d) => d.toISOString().slice(0, 10);

/**
 * Pull Zoom Phone /phone/call_history for a date range and upsert each call into
 * the CallLog collection. Idempotent — re-running the same range overwrites
 * existing rows by callId without creating duplicates.
 *
 * @param {object} opts
 * @param {number} [opts.lookbackDays=30] — how many days back from "now" to pull
 * @param {number} [opts.pageSize=100]   — Zoom max is 300; 100 is safe
 * @returns {{ ok: boolean, fetched: number, upserted: number, matched: number, error?: string }}
 */
export async function syncZoomCallHistory({ lookbackDays = 30, pageSize = 100 } = {}) {
  try {
    const token = await getZoomAccessToken();
    if (!token) return { ok: false, fetched: 0, upserted: 0, matched: 0, error: 'Zoom OAuth not configured' };

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

      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) {
        const body = await r.text();
        return {
          ok: false, fetched: all.length, upserted: 0, matched: 0,
          error: `Zoom ${r.status}: ${body.slice(0, 200)}`,
        };
      }
      const j = await r.json();
      const calls = j.call_logs || [];
      all.push(...calls);
      nextPageToken = j.next_page_token || '';
      safety += 1;
      if (safety > 50) break; // 50 pages × 100 = 5000 calls; plenty.
    } while (nextPageToken);

    // Pre-collect distinct lead phones to match in one Mongo round trip.
    const phoneSet = new Set();
    for (const c of all) {
      const isOutbound = c.direction === 'outbound';
      const leadRaw = isOutbound ? c.callee_did_number : c.caller_did_number;
      const n = normalizePhone(leadRaw);
      if (n) phoneSet.add(n);
    }
    let phoneToBooking = new Map();
    if (phoneSet.size > 0) {
      const phones = [...phoneSet];
      const regex = new RegExp(`(${phones.join('|')})$`);
      const bookings = await CampaignBookingModel
        .find({ clientPhone: { $regex: regex } })
        .select('bookingId clientPhone clientEmail clientName')
        .lean();
      for (const b of bookings) {
        const n = normalizePhone(b.clientPhone);
        if (n && !phoneToBooking.has(n)) phoneToBooking.set(n, b);
      }
    }

    let upserted = 0;
    let matched = 0;
    for (const c of all) {
      const callId = c.call_id || c.id;
      if (!callId) continue;

      const isOutbound = c.direction === 'outbound';
      const leadRaw = isOutbound ? c.callee_did_number : c.caller_did_number;
      const leadNumberNormalized = normalizePhone(leadRaw);
      const booking = leadNumberNormalized ? phoneToBooking.get(leadNumberNormalized) : null;
      if (booking) matched += 1;

      const status = c.call_result === 'connected' ? 'completed'
        : c.call_result === 'voicemail' ? 'voicemail'
        : c.call_result === 'missed' || c.call_result === 'no_answer' ? 'missed'
        : c.call_result === 'cancelled' ? 'cancelled'
        : 'unknown';

      const doc = {
        direction: c.direction || 'outbound',
        status,

        salesEmail: c.caller_email ? String(c.caller_email).toLowerCase() : null,
        salesName: c.caller_name || null,
        salesNumber: c.caller_did_number || c.caller_ext_number || null,

        leadNumber: leadRaw || null,
        leadNumberNormalized,
        bookingId: booking?.bookingId || null,
        leadEmail: booking?.clientEmail || null,
        leadName: booking?.clientName || c.callee_name || null,

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

      // Only set durationSec if the synced value is non-zero — preserve a
      // larger value already stored from a webhook event.
      if (!doc.durationSec) delete doc.durationSec;

      await CallLogModel.updateOne(
        { callId },
        { $set: doc, $setOnInsert: { callId } },
        { upsert: true }
      );
      upserted += 1;
    }

    return { ok: true, fetched: all.length, upserted, matched };
  } catch (error) {
    console.error('[ZoomPhoneSync] error:', error);
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

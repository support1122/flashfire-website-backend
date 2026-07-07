import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ZoomWebhookEventModel } from '../Schema_Models/ZoomWebhookEvent.js';
import { ZoomUserPresenceModel } from '../Schema_Models/ZoomUserPresence.js';
import {
  normalizePhone,
  verifyZoomSignature,
  buildUrlValidationResponse,
  getZoomAccessToken,
  getAllowedCallerNumbersForAgent,
} from '../Utils/ZoomPhone.js';
import { syncZoomCallHistory } from '../Utils/ZoomPhoneSync.js';

/**
 * Zoom Phone webhook receiver.
 * Express route MUST be mounted with a raw-body parser so we can verify the
 * HMAC signature against the exact bytes Zoom signed.
 */
export const zoomPhoneWebhook = async (req, res) => {
  // Persist every incoming hit so we have a permanent record of what Zoom sent.
  // Done before any other processing so even crashes leave a row behind.
  const debug = {
    event: req.body?.event || null,
    signatureValid: null,
    handled: false,
    handlerNote: null,
    callId: null,
    headers: {
      'x-zm-request-timestamp': req.headers['x-zm-request-timestamp'],
      'x-zm-signature': req.headers['x-zm-signature'] ? '[present]' : null,
      'user-agent': req.headers['user-agent'],
      'x-forwarded-for': req.headers['x-forwarded-for'],
    },
    body: req.body,
  };
  const persistDebug = async () => {
    try {
      await ZoomWebhookEventModel.create(debug);
    } catch (e) {
      console.error('[ZoomPhone] Failed to persist debug event:', e.message);
    }
  };

  try {
    const rawBody = req.rawBody != null ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
    const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

    // Visibility: log every webhook hit so we can see which events Zoom is firing.
    console.log(`[ZoomPhone] hit ${req.body?.event || 'unknown'} from ${req.ip}`);

    // 1. URL validation handshake — only happens when adding the webhook in Zoom Marketplace.
    if (req.body?.event === 'endpoint.url_validation') {
      const plainToken = req.body?.payload?.plainToken;
      if (!secret || !plainToken) {
        debug.handlerNote = 'url_validation missing secret or plainToken';
        await persistDebug();
        return res.status(400).json({ error: 'Missing secret or plainToken' });
      }
      debug.handled = true;
      debug.handlerNote = 'url_validation responded';
      await persistDebug();
      return res.status(200).json(buildUrlValidationResponse(plainToken, secret));
    }

    // 2. Signature check (skipped only when no secret set — dev / stub mode).
    if (secret) {
      const ok = verifyZoomSignature(rawBody, req.headers, secret);
      debug.signatureValid = ok;
      if (!ok) {
        debug.handlerNote = 'invalid signature';
        await persistDebug();
        return res.status(401).json({ error: 'Invalid Zoom signature' });
      }
    } else {
      debug.signatureValid = null;
    }

    const event = req.body?.event;
    const payload = req.body?.payload || {};

    // 2b. Presence updates carry no call_id — handle and return early.
    if (event === 'user.presence_status_updated') {
      const pobj = payload.object || {};
      const pEmail = pobj.email || pobj.user_email || null;
      const pStatus = pobj.presence_status || pobj.status || null;
      if (pEmail) {
        await ZoomUserPresenceModel.updateOne(
          { email: String(pEmail).toLowerCase() },
          { $set: { presenceStatus: pStatus, lastPresenceEventAt: new Date() } },
          { upsert: true }
        );
      }
      debug.handled = true;
      debug.handlerNote = `presence updated (${pEmail}=${pStatus})`;
      await persistDebug();
      return res.status(200).json({ ok: true });
    }

    // 3. Persist the call event. Different Zoom events use slightly different
    // payload shapes — we pick the relevant fields and upsert by callId.
    const obj = payload.object || {};
    const callId = obj.call_id || obj.id || obj.call_log_id;
    debug.callId = callId || null;
    if (!callId) {
      console.log('[ZoomPhone] no call_id in payload:', JSON.stringify(req.body).slice(0, 800));
      debug.handlerNote = 'no call_id — event dropped';
      await persistDebug();
      return res.status(202).json({ ok: true, ignored: 'no call_id' });
    }
    console.log(`[ZoomPhone] persisting callId=${callId} event=${event}`);

    const direction = obj.direction === 'inbound' ? 'inbound'
      : obj.direction === 'outbound' ? 'outbound'
      : 'unknown';

    // "caller" makes the call, "callee" receives. For outbound, sales = caller.
    const isOutbound = direction === 'outbound';
    const sales = isOutbound ? (obj.caller || obj.user) : (obj.callee || obj.user);
    const lead = isOutbound ? obj.callee : obj.caller;

    const salesEmail = sales?.email || obj.user?.email || null;
    const salesName = sales?.name || sales?.user_name || null;
    const salesNumber = sales?.phone_number || sales?.extension_number || null;
    const leadNumber = lead?.phone_number || obj.callee_number || obj.caller_number || null;
    const leadNumberNormalized = normalizePhone(leadNumber);

    // Map Zoom event types to our internal status.
    let status = 'unknown';
    if (event?.includes('ringing')) status = 'ringing';
    else if (event?.includes('answered') || event?.includes('connected')) status = 'answered';
    else if (event?.includes('missed')) status = 'missed';
    else if (event?.includes('voicemail')) status = 'voicemail';
    else if (event?.includes('call_log_completed')) status = obj.result === 'No Answer' ? 'missed' : 'completed';
    else if (event?.includes('_ended')) status = 'completed';

    const durationSec = Number(obj.duration ?? obj.call_duration ?? 0) || 0;
    const startedAt = obj.start_time ? new Date(obj.start_time) : (obj.date_time ? new Date(obj.date_time) : null);
    const endedAt = obj.end_time ? new Date(obj.end_time) : null;
    const answeredAt = obj.answer_start_time ? new Date(obj.answer_start_time) : null;
    const recordingUrl = obj.download_url || obj.recording?.download_url || null;
    const transcriptUrl = obj.transcript_download_url || null;
    const aiSummary = obj.ai_summary || obj.summary || null;

    // Try to attach the call to an existing lead by phone.
    let bookingId = null;
    let leadEmail = null;
    let leadName = null;
    if (leadNumberNormalized) {
      const booking = await CampaignBookingModel
        .findOne({
          $expr: {
            $regexMatch: {
              input: { $ifNull: ['$clientPhone', ''] },
              regex: new RegExp(`${leadNumberNormalized}$`),
            },
          },
        })
        .select('bookingId clientEmail clientName')
        .lean();
      if (booking) {
        bookingId = booking.bookingId;
        leadEmail = booking.clientEmail || null;
        leadName = booking.clientName || null;
      }
    }

    const update = {
      direction: direction === 'unknown' ? (isOutbound ? 'outbound' : 'inbound') : direction,
      status,
      salesEmail: salesEmail ? String(salesEmail).toLowerCase() : null,
      salesName,
      salesNumber,
      leadNumber,
      leadNumberNormalized,
      bookingId,
      leadEmail,
      leadName,
      startedAt,
      answeredAt,
      endedAt,
      // Only overwrite durationSec when the new value is larger than what we
      // already stored (the ringing event has 0, the completed event has the real one).
      ...(durationSec > 0 ? { durationSec } : {}),
      ...(recordingUrl ? { recordingUrl } : {}),
      ...(transcriptUrl ? { transcriptUrl } : {}),
      ...(aiSummary ? { aiSummary } : {}),
      raw: req.body,
    };

    await CallLogModel.findOneAndUpdate(
      { callId },
      { $set: update, $setOnInsert: { callId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Keep the agent's on-call state in sync from the connected/ended events.
    // "connected" (or ringing) => on a call; ended/completed/missed => free.
    if (salesEmail) {
      const emailLc = String(salesEmail).toLowerCase();
      if (event?.includes('connected') || status === 'answered' || status === 'ringing') {
        await ZoomUserPresenceModel.updateOne(
          { email: emailLc },
          { $set: { onCall: true, activeCallId: callId, lastCallEventAt: new Date() } },
          { upsert: true }
        );
      } else if (event?.includes('_ended') || ['completed', 'missed', 'voicemail', 'cancelled', 'busy'].includes(status)) {
        // Only clear if this is the call we think is active (avoid a late ended
        // event for an old call wiping a freshly-started one).
        await ZoomUserPresenceModel.updateOne(
          { email: emailLc, $or: [{ activeCallId: callId }, { activeCallId: null }] },
          { $set: { onCall: false, activeCallId: null, lastCallEventAt: new Date() } },
          { upsert: true }
        );
      }
    }

    debug.handled = true;
    debug.handlerNote = `CallLog upserted (status=${status}, bookingMatched=${!!bookingId})`;
    await persistDebug();
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[ZoomPhone] Webhook error:', error);
    debug.handlerNote = `error: ${error.message}`;
    await persistDebug();
    // Always 200 so Zoom doesn't retry forever; we log the error.
    return res.status(200).json({ ok: false, error: error.message });
  }
};

/**
 * Aggregate total call minutes per (normalized) phone number for a list
 * of phones. Used by the Leads / All-Data tables to show "minutes called"
 * next to each lead.
 *
 * GET /api/crm/call-logs/minutes-by-phone?phones=+1234,+1555,...
 */
export const getCallMinutesByPhone = async (req, res) => {
  try {
    const rawPhones = String(req.query.phones || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (rawPhones.length === 0) {
      return res.status(200).json({ success: true, data: {} });
    }
    const normalizedSet = new Set(rawPhones.map(normalizePhone).filter(Boolean));
    const normalizedList = [...normalizedSet];

    const rows = await CallLogModel.aggregate([
      { $match: { leadNumberNormalized: { $in: normalizedList } } },
      {
        $group: {
          _id: '$leadNumberNormalized',
          totalSec: { $sum: '$durationSec' },
          calls: { $sum: 1 },
          lastCalledAt: { $max: '$startedAt' },
        },
      },
    ]);

    const data = {};
    // Map results back so callers can look up by either the raw phone they sent
    // or the normalized digits.
    for (const r of rows) {
      data[r._id] = {
        minutes: Math.round((r.totalSec || 0) / 60),
        seconds: r.totalSec || 0,
        calls: r.calls,
        lastCalledAt: r.lastCalledAt,
      };
    }
    // Echo a mapping keyed by the original phones too.
    const byRaw = {};
    for (const raw of rawPhones) {
      const n = normalizePhone(raw);
      if (n && data[n]) byRaw[raw] = data[n];
    }
    return res.status(200).json({ success: true, data, byRaw });
  } catch (error) {
    console.error('[ZoomPhone] getCallMinutesByPhone error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * List the calls for one lead (by phone or bookingId).
 * GET /api/crm/call-logs?phone=...    or  ?bookingId=...
 */
export const getCallsForLead = async (req, res) => {
  try {
    const { phone, bookingId } = req.query;
    const query = {};
    if (bookingId) query.bookingId = String(bookingId);
    else if (phone) {
      const n = normalizePhone(phone);
      if (!n) return res.status(400).json({ success: false, error: 'Bad phone' });
      query.leadNumberNormalized = n;
    } else {
      return res.status(400).json({ success: false, error: 'phone or bookingId required' });
    }
    const calls = await CallLogModel.find(query)
      .sort({ startedAt: -1 })
      .limit(50)
      .select('callId direction status salesEmail salesName startedAt durationSec recordingUrl transcriptUrl aiSummary')
      .lean();
    return res.status(200).json({ success: true, data: calls });
  } catch (error) {
    console.error('[ZoomPhone] getCallsForLead error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Proxy the Zoom-protected recording URL.
 * GET /api/crm/call-logs/:callId/recording
 * Streams the audio bytes with the Zoom S2S OAuth token attached.
 */
/**
 * Recent calls feed for the Phone tab. Paginated, newest first.
 * GET /api/crm/call-logs/recent?limit=50&skip=0&direction=outbound&search=...
 */
export const getRecentCalls = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const skip = parseInt(req.query.skip || '0', 10);
    const { direction, search } = req.query;
    const q = {};
    if (direction === 'inbound' || direction === 'outbound') q.direction = direction;
    if (search) {
      const re = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [
        { leadName: re }, { leadEmail: re }, { salesEmail: re }, { salesName: re },
        { leadNumber: re }, { leadNumberNormalized: re },
      ];
    }
    const [rows, total] = await Promise.all([
      CallLogModel.find(q)
        .sort({ startedAt: -1, createdAt: -1 })
        .skip(skip).limit(limit)
        .select('callId direction status callResult recordingStatus salesEmail salesName salesNumber callerExtNumber callerDeviceType callerCountryIso leadName leadEmail leadNumber calleeExtNumber calleeCountryIso bookingId startedAt answeredAt endedAt durationSec callType connectType international hideCallerId endToEnd source recordingUrl transcriptUrl aiSummary')
        .lean(),
      CallLogModel.countDocuments(q),
    ]);
    return res.status(200).json({ success: true, data: rows, total });
  } catch (error) {
    console.error('[ZoomPhone] getRecentCalls error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const proxyCallRecording = async (req, res) => {
  try {
    const { callId } = req.params;
    const log = await CallLogModel.findOne({ callId }).lean();
    if (!log?.recordingUrl) return res.status(404).json({ success: false, error: 'No recording' });
    const token = await getZoomAccessToken();
    if (!token) return res.status(503).json({ success: false, error: 'Zoom not configured' });
    const upstream = await fetch(log.recordingUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, error: 'Upstream fetch failed' });
    }
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    upstream.body.pipe(res);
  } catch (error) {
    console.error('[ZoomPhone] proxyCallRecording error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * No-show leads that never received a phone call.
 * Deduped by client. Returns each lead + their bookingStatus, last meeting time,
 * normalized phone. Useful for "who did we forget to call?".
 *
 * GET /api/crm/phone-gaps/no-show?limit=200&days=60
 */
export const getNoShowLeadsWithoutCalls = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
    const days = Math.min(parseInt(req.query.days || '60', 10), 365);
    const since = new Date();
    since.setDate(since.getDate() - days);

    // 1. Pull deduped no-show leads (one row per client, latest booking).
    const leads = await CampaignBookingModel.aggregate([
      {
        $match: {
          bookingStatus: 'no-show',
          $or: [
            { scheduledEventStartTime: { $gte: since } },
            { bookingCreatedAt: { $gte: since } },
          ],
        },
      },
      { $addFields: { groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] } } },
      { $sort: { scheduledEventStartTime: -1, bookingCreatedAt: -1 } },
      {
        $group: {
          _id: '$groupKey',
          bookingId: { $first: '$bookingId' },
          clientName: { $first: '$clientName' },
          clientEmail: { $first: '$clientEmail' },
          clientPhone: { $first: '$clientPhone' },
          scheduledEventStartTime: { $first: '$scheduledEventStartTime' },
          bookingCreatedAt: { $first: '$bookingCreatedAt' },
        },
      },
      { $match: { clientPhone: { $ne: null, $ne: '' } } },
      { $limit: limit * 2 }, // grab a buffer so we have enough after exclusion
    ]);

    // 2. Compute normalized phones for those leads.
    const phoneToLead = new Map();
    for (const l of leads) {
      const n = normalizePhone(l.clientPhone);
      if (!n) continue;
      if (!phoneToLead.has(n)) phoneToLead.set(n, l);
    }
    const normalizedList = [...phoneToLead.keys()];

    // 3. Find which of those phones already have a CallLog row.
    const calledRows = await CallLogModel.find({
      leadNumberNormalized: { $in: normalizedList },
    })
      .select('leadNumberNormalized')
      .lean();
    const calledSet = new Set(calledRows.map((r) => r.leadNumberNormalized));

    // 4. Keep only the ones with zero calls.
    const notCalled = [];
    for (const [phoneN, l] of phoneToLead.entries()) {
      if (calledSet.has(phoneN)) continue;
      notCalled.push({
        bookingId: l.bookingId,
        clientName: l.clientName,
        clientEmail: l.clientEmail,
        clientPhone: l.clientPhone,
        clientPhoneNormalized: phoneN,
        scheduledEventStartTime: l.scheduledEventStartTime,
        bookingCreatedAt: l.bookingCreatedAt,
      });
      if (notCalled.length >= limit) break;
    }

    return res.status(200).json({
      success: true,
      total: notCalled.length,
      scannedNoShowLeads: phoneToLead.size,
      data: notCalled,
    });
  } catch (error) {
    console.error('[ZoomPhone] getNoShowLeadsWithoutCalls error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/** Manual trigger for the Zoom call-history sync (refresh button in the UI). */
export const triggerZoomSync = async (req, res) => {
  try {
    const lookbackDays = Math.min(parseInt(req.query.lookbackDays || '30', 10), 180);
    const result = await syncZoomCallHistory({ lookbackDays });
    return res.status(result.ok ? 200 : 500).json({ success: result.ok, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/** Debug: list the most recent raw Zoom webhook events stored in the DB. */
export const getZoomWebhookEvents = async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const events = await ZoomWebhookEventModel.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
    return res.status(200).json({ success: true, count: events.length, data: events });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

/** Fetch the VTT transcript and return as plain text. */
export const proxyCallTranscript = async (req, res) => {
  try {
    const { callId } = req.params;
    const log = await CallLogModel.findOne({ callId }).lean();
    if (!log?.transcriptUrl) return res.status(404).json({ success: false, error: 'No transcript' });
    const token = await getZoomAccessToken();
    if (!token) return res.status(503).json({ success: false, error: 'Zoom not configured' });
    const upstream = await fetch(log.transcriptUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ success: false, error: 'Upstream fetch failed' });
    }
    const raw = await upstream.text();
    // Strip VTT timing lines for a readable transcript. Keep cues.
    const lines = raw.split(/\r?\n/);
    const out = [];
    let speaker = '';
    for (const line of lines) {
      if (!line || /^WEBVTT/i.test(line) || /^NOTE\b/i.test(line)) continue;
      if (/^\d+$/.test(line)) continue; // cue index
      if (/-->/.test(line)) continue; // time range
      // Zoom format: "Speaker Name: text"
      const m = line.match(/^([^:]{1,60}):\s*(.+)$/);
      if (m && m[1] !== speaker) {
        speaker = m[1];
        out.push(`\n${m[1]}: ${m[2]}`);
      } else {
        out.push(line.trim());
      }
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(200).send(out.join('\n').trim());
  } catch (error) {
    console.error('[ZoomPhone] proxyCallTranscript error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * List the phone numbers the current agent may place calls from (their outbound
 * caller-ID options), each annotated with whether the line is live/assigned.
 * Resolves via the live Zoom API with a static config fallback.
 *
 * GET /api/crm/zoom-phone/numbers
 */
export const getCallerNumbers = async (req, res) => {
  try {
    // Prefer the authenticated agent's email; allow an explicit override for admins/testing.
    const email = req.crmUser?.email || req.query.agentEmail || null;
    const result = await getAllowedCallerNumbersForAgent(email);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[ZoomPhone] getCallerNumbers error:', error);
    // Never hard-fail the picker — return empty so the UI can still dial without a caller ID.
    return res.status(200).json({ success: true, numbers: [], source: 'none', error: error.message });
  }
};

/**
 * The most recent in-flight call for a lead phone (optionally scoped to the
 * calling agent), used by the CRM to show live call status right after dialing.
 * "In flight" = started within the last few minutes and not yet ended.
 *
 * GET /api/crm/call-logs/live?phone=+1...&agentEmail=...&windowSec=180
 */
export const getLiveCallForLead = async (req, res) => {
  try {
    const { phone, agentEmail } = req.query;
    const n = normalizePhone(phone);
    if (!n) return res.status(400).json({ success: false, error: 'phone required' });

    const windowSec = Math.min(parseInt(req.query.windowSec || '180', 10), 900);
    const since = new Date(Date.now() - windowSec * 1000);

    const q = {
      leadNumberNormalized: n,
      // Match rows created or started within the window (webhook rows may set
      // startedAt slightly after createdAt).
      $or: [{ startedAt: { $gte: since } }, { createdAt: { $gte: since } }],
    };
    if (agentEmail) q.salesEmail = String(agentEmail).toLowerCase();

    const call = await CallLogModel.findOne(q)
      .sort({ startedAt: -1, createdAt: -1 })
      .select('callId direction status startedAt answeredAt endedAt durationSec salesEmail leadNumber')
      .lean();

    if (!call) return res.status(200).json({ success: true, active: false, call: null });

    const ended = ['completed', 'missed', 'voicemail', 'cancelled', 'busy'].includes(call.status);
    return res.status(200).json({ success: true, active: !ended, call });
  } catch (error) {
    console.error('[ZoomPhone] getLiveCallForLead error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

/**
 * Cached Zoom presence / on-call state for an agent.
 * GET /api/crm/agents/:email/presence
 * Returns { status: 'available'|'busy'|'on_call'|'away'|'offline'|'unknown', onCall, presenceStatus }.
 */
export const getAgentPresence = async (req, res) => {
  try {
    const email = String(req.params.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ success: false, error: 'email required' });

    const row = await ZoomUserPresenceModel.findOne({ email }).lean();
    if (!row) {
      return res.status(200).json({ success: true, email, status: 'unknown', onCall: false, presenceStatus: null });
    }

    // Derive a simple status. On-call (from phone webhooks) always wins.
    let status = 'unknown';
    if (row.onCall) status = 'on_call';
    else {
      const p = String(row.presenceStatus || '').toLowerCase();
      if (p.includes('do_not_disturb') || p.includes('busy') || p.includes('presenting') || p.includes('in_meeting') || p.includes('phone')) status = 'busy';
      else if (p.includes('available')) status = 'available';
      else if (p.includes('away')) status = 'away';
      else if (p.includes('offline')) status = 'offline';
      else if (p) status = 'available';
    }

    return res.status(200).json({
      success: true,
      email,
      status,
      onCall: !!row.onCall,
      presenceStatus: row.presenceStatus || null,
      activeCallId: row.activeCallId || null,
      updatedAt: row.updatedAt,
    });
  } catch (error) {
    console.error('[ZoomPhone] getAgentPresence error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

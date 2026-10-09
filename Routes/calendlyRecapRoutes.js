import { isCrmAdmin } from '../Utils/isCrmAdmin.js';
import crypto from 'crypto';
import { DateTime } from 'luxon';
import { requireCrmAnyPermission, requireCrmUser } from '../Middlewares/CrmAuth.js';
import { createUserRateLimiter } from '../Middlewares/perUserRateLimit.js';
import { CalendlyRecapModel } from '../Schema_Models/CalendlyRecap.js';
import { IntegrationKeyModel } from '../Schema_Models/IntegrationKey.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from '../Utils/DiscordConnect.js';
import { getAssignedBdaEmail } from '../Utils/BdaAssignment.js';
import { parseRecapEmail } from '../Utils/CalendlyRecapParser.js';
import { matchRecapToBooking } from '../Utils/CalendlyRecapMatcher.js';
import { requireAdminLive, requireCrmUserOrAdmin } from './deductionRoutes.js';

// Calendly Notetaker recaps (the "Summary" emails) saved to the database.
//
//   POST /api/integrations/calendly-recap            the Gmail Apps Script sends each recap email here
//   GET  /api/crm/bookings/:bookingId/recap          the CRM reads a meeting's recap(s)
//   GET  /api/crm/admin/calendly-recaps?status=      admin: unmatched / ambiguous recaps to link by hand
//   POST /api/crm/admin/calendly-recaps/:messageId/link   admin: link a recap to a booking
//
// The ingest endpoint is called by a script, not a person, so it authenticates with a key in the X-Recap-Secret
// header. No env var is needed (bsc's call): the first key of 32+ characters the script presents is enrolled and
// only its SHA-256 hash is stored (collection integrationkeys); after that only that key is accepted. The key is
// never in this public repo. If env CALENDLY_RECAP_INGEST_SECRET is set, it wins over the enrolled key.
// Errors use the shared shape { success: false, error: { code, message } }.

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

const MAX_BODY_CHARS = 90_000;
const MAX_LINKS = 200;
const DISCORD_CHUNK = 1900;

const KEY_NAME = 'calendly_recap_ingest';
const MIN_KEY_CHARS = 32;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();

/** true when the key is accepted. Env wins; otherwise the enrolled key; with none enrolled, this key is enrolled. */
async function keyOk(given) {
  if (typeof given !== 'string' || given.length < MIN_KEY_CHARS) return false;
  const fromEnv = process.env.CALENDLY_RECAP_INGEST_SECRET || '';
  if (fromEnv) return crypto.timingSafeEqual(sha256(given), sha256(fromEnv));

  let doc = await IntegrationKeyModel.findOne({ name: KEY_NAME }).lean();
  if (!doc) {
    try {
      await IntegrationKeyModel.create({ name: KEY_NAME, keyHash: sha256(given).toString('hex') });
      console.log('[calendlyRecap] enrolled the Apps Script key (first use)');
      return true;
    } catch (err) {
      if (err?.code !== 11000) throw err;
      doc = await IntegrationKeyModel.findOne({ name: KEY_NAME }).lean(); // a parallel first call enrolled it
    }
  }
  return crypto.timingSafeEqual(sha256(given), Buffer.from(doc.keyHash, 'hex'));
}

// One script, a few calls a minute at most; a leaked secret in a loop is the case this exists for.
const ingestLimiter = createUserRateLimiter({ max: 120, windowMs: 60 * 1000, keyOf: () => 'calendly-recap-ingest' });

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Send a JSON object';
  const { messageId, sentAt, subject, plainBody, links } = body;
  if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200) return 'messageId is required';
  if (!Number.isFinite(new Date(sentAt).getTime())) return 'sentAt must be a date';
  if (subject != null && (typeof subject !== 'string' || subject.length > 1000)) return 'subject must be a string up to 1000 characters';
  if (typeof plainBody !== 'string' || !plainBody.trim()) return 'plainBody is required';
  if (plainBody.length > MAX_BODY_CHARS) return `plainBody is over ${MAX_BODY_CHARS} characters`;
  if (links != null && (!Array.isArray(links) || links.length > MAX_LINKS || links.some((l) => typeof l !== 'string' || l.length > 2000))) {
    return `links must be up to ${MAX_LINKS} strings`;
  }
  return null;
}

function chunks(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/**
 * Optional server-side Discord post with the client, time and BDA added. Off unless
 * DISCORD_CALENDLY_RECAP_WEBHOOK_URL is set. The Apps Script already posts each recap to Discord itself, so leave
 * this unset unless that post is removed from the script, or every recap appears twice. Never throws.
 */
async function postRecapToDiscord(recap, booking) {
  const url = process.env.DISCORD_CALENDLY_RECAP_WEBHOOK_URL || null;
  if (!url) return false;
  const when = booking?.scheduledEventStartTime
    ? DateTime.fromJSDate(new Date(booking.scheduledEventStartTime), { zone: 'Asia/Kolkata' }).toFormat('dd MMM, hh:mm a')
    : null;
  const bda = booking ? booking.calendlyHost?.name || getAssignedBdaEmail(booking) : null;
  const header =
    `📅 **${recap.subject || 'Calendly meeting summary'}**\n` +
    (booking ? `**Client:** ${booking.clientName || '-'}${when ? ` · ${when} IST` : ''}${bda ? ` · **BDA:** ${bda}` : ''}\n` : `_Not linked to a booking yet (${recap.matchStatus})._\n`) +
    (recap.recapUrl ? `**Recap:** ${recap.recapUrl}\n` : '') +
    '\n';
  try {
    let ok = true;
    for (const part of chunks(`${header}${recap.summary}`, DISCORD_CHUNK)) {
      const r = await DiscordConnect(url, part, false);
      ok = ok && r?.ok !== false;
    }
    return ok;
  } catch (err) {
    console.error('[calendlyRecap] Discord post failed:', err?.message);
    return false;
  }
}

async function ingest(req, res) {
  try {
    if (!(await keyOk(req.get('x-recap-secret')))) return fail(res, 401, 'bad_secret', 'Missing or wrong X-Recap-Secret');
    const problem = validate(req.body);
    if (problem) return fail(res, 422, 'invalid_recap', problem);

    const b = req.body;
    const messageId = b.messageId.trim();
    const existing = await CalendlyRecapModel.findOne({ messageId }).select('matchStatus bookingId').lean();
    if (existing) {
      return res.status(200).json({ success: true, duplicate: true, matchStatus: existing.matchStatus, bookingId: existing.bookingId });
    }

    const sentAtMs = new Date(b.sentAt).getTime();
    const links = (b.links || []).slice(0, MAX_LINKS);
    const parsed = parseRecapEmail({ subject: b.subject, plainBody: b.plainBody, links });
    const account = typeof b.account === 'string' ? b.account.trim().toLowerCase().slice(0, 200) : null;
    const decision = await matchRecapToBooking({ ...parsed, plainBody: b.plainBody, account, sentAtMs });
    const bookingId = decision.status === 'matched' ? decision.best.booking.bookingId : null;

    let doc;
    try {
      doc = await CalendlyRecapModel.create({
        messageId,
        threadId: typeof b.threadId === 'string' ? b.threadId.slice(0, 200) : null,
        account,
        from: typeof b.from === 'string' ? b.from.slice(0, 300) : null,
        subject: b.subject || '',
        sentAt: new Date(sentAtMs),
        plainBody: b.plainBody,
        links,
        summary: parsed.summary,
        sections: parsed.sections,
        recapUrl: parsed.recapUrl,
        attendees: parsed.attendees,
        inviteeNames: parsed.inviteeNames,
        bookingId,
        matchStatus: decision.status,
        matchScore: decision.score,
        matchWhy: decision.why,
      });
    } catch (err) {
      if (err?.code === 11000) return res.status(200).json({ success: true, duplicate: true }); // a parallel retry won
      throw err;
    }

    const booking = bookingId ? decision.best.booking : null;
    if (await postRecapToDiscord(doc, booking)) {
      await CalendlyRecapModel.updateOne({ _id: doc._id }, { $set: { discordPostedAt: new Date() } });
    }
    return res.status(201).json({ success: true, matchStatus: decision.status, bookingId, score: decision.score });
  } catch (err) {
    console.error('[calendlyRecap] ingest failed:', err?.message);
    return fail(res, 500, 'internal_error', 'Could not save the recap');
  }
}

const shapeRecap = (r) => ({
  messageId: r.messageId,
  subject: r.subject,
  sentAt: r.sentAt ? new Date(r.sentAt).toISOString() : null,
  summary: r.summary,
  sections: r.sections || {},
  recapUrl: r.recapUrl,
  attendees: r.attendees || [],
  matchStatus: r.matchStatus,
});

export function registerCalendlyRecapRoutes(app) {
  app.post('/api/integrations/calendly-recap', ingestLimiter, ingest);

  app.get(
    '/api/crm/bookings/:bookingId/recap',
    requireCrmUser,
    requireCrmAnyPermission(['meeting_links', 'leads', 'all_data', 'claim_leads']),
    async (req, res) => {
      try {
        const bookingId = String(req.params.bookingId || '').slice(0, 200);
        // Same visibility as the leads screens: admins and Meeting Info / All Data users see every meeting; any other
        // CRM user sees only meetings assigned to them. A summary holds a client's personal details.
        const me = String(req.crmUser?.email || '').toLowerCase();
        const perms = Array.isArray(req.crmUser?.permissions) ? req.crmUser.permissions : [];
        const seesAll = perms.some((p) => ['meeting_links', 'meeting_links_edit', 'all_data', 'all_data_edit'].includes(p)) || (await isCrmAdmin(req.crmUser));
        if (!seesAll) {
          const booking = await CampaignBookingModel.findOne({ bookingId }).select('calendlyHost claimedBy attendanceAssignee').lean();
          if (!booking) return fail(res, 404, 'booking_not_found', 'No booking with that id');
          if (getAssignedBdaEmail(booking) !== me) return fail(res, 403, 'forbidden', 'This meeting belongs to another BDA');
        }
        const recaps = await CalendlyRecapModel.find({ bookingId }).sort({ sentAt: -1 }).limit(5).lean();
        return res.status(200).json({ success: true, recaps: recaps.map(shapeRecap) });
      } catch (err) {
        console.error('[calendlyRecap] read failed:', err?.message);
        return fail(res, 500, 'internal_error', 'Could not load the recap');
      }
    }
  );

  app.get('/api/crm/admin/calendly-recaps', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const status = ['unmatched', 'ambiguous', 'matched', 'manual'].includes(req.query.status) ? req.query.status : null;
      const query = status ? { matchStatus: status } : { matchStatus: { $in: ['unmatched', 'ambiguous'] } };
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const rows = await CalendlyRecapModel.find(query).sort({ sentAt: -1 }).limit(limit).lean();
      return res.status(200).json({
        success: true,
        recaps: rows.map((r) => ({ ...shapeRecap(r), bookingId: r.bookingId, matchScore: r.matchScore, matchWhy: r.matchWhy, account: r.account })),
      });
    } catch (err) {
      console.error('[calendlyRecap] admin list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load recaps');
    }
  });

  app.post('/api/crm/admin/calendly-recaps/:messageId/link', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const bookingId = typeof req.body?.bookingId === 'string' ? req.body.bookingId.trim() : '';
      if (!bookingId) return fail(res, 422, 'booking_required', 'Send { bookingId }');
      const booking = await CampaignBookingModel.findOne({ bookingId }).select('bookingId').lean();
      if (!booking) return fail(res, 404, 'booking_not_found', 'No booking with that id');
      const who = req.crmUser?.email || req.crmAdmin?.email || 'admin';
      const updated = await CalendlyRecapModel.findOneAndUpdate(
        { messageId: String(req.params.messageId) },
        { $set: { bookingId, matchStatus: 'manual', linkedBy: who, linkedAt: new Date() } },
        { new: true }
      ).lean();
      if (!updated) return fail(res, 404, 'recap_not_found', 'No recap with that message id');
      return res.status(200).json({ success: true, recap: { ...shapeRecap(updated), bookingId: updated.bookingId } });
    } catch (err) {
      console.error('[calendlyRecap] link failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not link the recap');
    }
  });
}

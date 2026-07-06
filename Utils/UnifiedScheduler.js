/**
 * UnifiedScheduler — Precision timing scheduler for all reminders.
 *
 * Replaces 5 independent polling loops with:
 * 1. In-memory setTimeout timers for exact-millisecond firing
 * 2. Single 30s safety-net poll as fallback
 * 3. Batch booking pre-fetch (eliminates N+1 queries)
 * 4. Parallel processing within each reminder type
 * 5. Circuit breakers on all external APIs
 * 6. Graceful shutdown with drain
 */

import dotenv from 'dotenv';
import { ScheduledCallModel } from '../Schema_Models/ScheduledCall.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { ScheduledDiscordMeetReminderModel } from '../Schema_Models/ScheduledDiscordMeetReminder.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { DiscordConnect } from './DiscordConnect.js';
import { logReminderDrift } from './MeetingReminderUtils.js';
import { makeCall, scheduleCall } from './CallScheduler.js';
import { sendWhatsAppMessage, scheduleAllWhatsAppReminders } from './WhatsAppReminderScheduler.js';
import { formatMeetingWallTime, headlineForSendTime, scheduleDiscordMeetReminder } from './DiscordMeetReminderScheduler.js';
import { resolveCalendlyHostByEventUri } from './CalendlyAPIHelper.js';
import { normalizePhoneForReminders } from './MeetingReminderUtils.js';
import { DateTime } from 'luxon';

dotenv.config();

// ── Singleton ──
let instance = null;
export function getScheduler() { return instance; }

// ── Config ──
const SAFETY_POLL_MS = Number(process.env.UNIFIED_SCHEDULER_POLL_MS) || 30000;
const STUCK_MS = Math.max(60000, Number(process.env.SCHEDULER_STUCK_PROCESSING_MS) || 2 * 60 * 1000);
const BATCH_LIMIT = 20;

const DISCORD_CALL_WEBHOOK = process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
const DISCORD_MEET_WEBHOOK =
  process.env.DISCORD_MEET_2MIN_WEBHOOK_URL ||
  process.env.DISCORD_MEET_WEB_HOOK_URL ||
  process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL ||
  null;

// Meetings assigned to a BDA whose name starts with "Kalpataru" route to a
// dedicated Discord channel. Env can override; the hardcoded URL is the default
// so the channel keeps working even when the env var is missing on a deploy.
const DISCORD_MEET_KALPATARU_WEBHOOK =
  process.env.DISCORD_MEET_KALPATARU_WEBHOOK_URL ||
  'https://discord.com/api/webhooks/1523575499454939307/i_ESYLBr2ADfKJlB_Owb0aFub1LRivpN1us8Xrbf0vIFKB-TsK8RQefcG3PTDRjojgat';

export class UnifiedScheduler {
  constructor() {
    this.timers = new Map();
    this.pollHandle = null;
    this.bdaPollHandle = null;
    this.jobPollHandle = null;
    this.healHandle = null;
    this.running = false;
    this.processing = false;
    this.inFlight = 0;
    this.lastPollAt = null;
    this.lastPollMs = 0;
    this.driftSamples = { call: [], whatsapp: [], discord: [] };
    instance = this;
  }

  // ────────────────────────── Timer management ──────────────────────────

  scheduleTimer(type, id, scheduledFor) {
    const key = `${type}:${id}`;
    if (this.timers.has(key)) clearTimeout(this.timers.get(key));

    const delayMs = Math.max(0, new Date(scheduledFor).getTime() - Date.now());
    if (delayMs === 0) return; // Already overdue — safety poll will catch it

    // Node setTimeout uses int32 ms; delays > ~24.85 days fire immediately.
    // Re-arm in chunks so far-future reminders wait until their real scheduledFor.
    const MAX_TIMEOUT_MS = 2_147_483_647;
    const armDelay = Math.min(delayMs, MAX_TIMEOUT_MS);

    const timer = setTimeout(() => {
      this.timers.delete(key);
      if (armDelay < delayMs) {
        this.scheduleTimer(type, id, scheduledFor);
      } else {
        this._trigger();
      }
    }, armDelay);
    if (timer.unref) timer.unref();
    this.timers.set(key, timer);
  }

  cancelTimer(id) {
    for (const [key, timer] of this.timers) {
      if (key.endsWith(`:${id}`)) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
    }
  }

  // ────────────────────────── Lifecycle ──────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;

    // 1. Reset stuck items (fast: 2-min threshold instead of 8-min)
    await this.resetAllStuck();

    // 2. Load all future pending items → set precision timers
    const [calls, wa, discord] = await Promise.all([
      ScheduledCallModel.find({ status: 'pending', scheduledFor: { $gt: new Date() } })
        .select('callId scheduledFor').lean(),
      ScheduledWhatsAppReminderModel.find({ status: 'pending', scheduledFor: { $gt: new Date() } })
        .select('reminderId scheduledFor').lean(),
      ScheduledDiscordMeetReminderModel.find({ status: 'pending', scheduledFor: { $gt: new Date() } })
        .select('reminderId scheduledFor').lean(),
    ]);

    for (const c of calls) this.scheduleTimer('call', c.callId, c.scheduledFor);
    for (const w of wa) this.scheduleTimer('whatsapp', w.reminderId, w.scheduledFor);
    for (const d of discord) this.scheduleTimer('discord', d.reminderId, d.scheduledFor);

    console.log(`[UnifiedScheduler] Loaded ${calls.length} call, ${wa.length} WA, ${discord.length} Discord precision timers`);

    // 3. Process anything already overdue right now
    await this.processAllDue();

    // 4. Safety-net poll (30s)
    this.pollHandle = setInterval(() => this._trigger(), SAFETY_POLL_MS);

    // 5. BDA absent detection (60s) — not time-critical
    try {
      const { pollForAbsentBDAs } = await import('./BdaAbsentScheduler.js');
      pollForAbsentBDAs().catch(() => {});
      this.bdaPollHandle = setInterval(() => {
        pollForAbsentBDAs().catch(e => console.error('[UnifiedScheduler] BDA poll error:', e.message));
      }, 60000);
    } catch (e) {
      console.warn('[UnifiedScheduler] BDA absent scheduler not available:', e.message);
    }

    // 6. Campaign job processing (30s) — lower priority than reminders
    try {
      const { processDueJobs } = await import('./JobScheduler.js');
      this.jobPollHandle = setInterval(() => {
        processDueJobs().catch(e => console.error('[UnifiedScheduler] Job poll error:', e.message));
      }, 30000);
    } catch (e) {
      console.warn('[UnifiedScheduler] Job scheduler not available:', e.message);
    }

    // 7. Hourly self-heal: creates missing reminder records for upcoming bookings
    const runHeal = () => this._healMissingReminders().catch(e => console.error('[UnifiedScheduler] Heal error:', e.message));
    setTimeout(runHeal, 60000); // first run 1 min after start
    this.healHandle = setInterval(runHeal, 60 * 60 * 1000); // then every hour

    console.log('[UnifiedScheduler] Started — precision timers active, safety poll every 30s');
  }

  async stop() {
    if (!this.running) return;

    if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
    if (this.bdaPollHandle) { clearInterval(this.bdaPollHandle); this.bdaPollHandle = null; }
    if (this.jobPollHandle) { clearInterval(this.jobPollHandle); this.jobPollHandle = null; }
    if (this.healHandle) { clearInterval(this.healHandle); this.healHandle = null; }

    for (const [, timer] of this.timers) clearTimeout(timer);
    this.timers.clear();

    // Drain in-flight items (max 10s)
    const deadline = Date.now() + 10000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (this.inFlight > 0) {
      console.warn(`[UnifiedScheduler] Force shutdown with ${this.inFlight} in-flight items`);
    }

    this.running = false;
    instance = null;
    console.log('[UnifiedScheduler] Stopped');
  }

  // ────────────────────────── Trigger (debounced) ──────────────────────────

  async _trigger() {
    if (this.processing || !this.running) return;
    try {
      await this.processAllDue();
    } catch (err) {
      console.error('[UnifiedScheduler] Processing error:', err.message);
    }
  }

  // ────────────────────────── Main processing loop ──────────────────────────

  async processAllDue() {
    if (this.processing) return;
    this.processing = true;
    const start = Date.now();

    try {
      const now = new Date();

      // 1. Batch query ALL due items in parallel (1 query per type, not per item)
      const [dueCalls, dueWA, dueDiscord] = await Promise.all([
        ScheduledCallModel.find({
          status: 'pending', scheduledFor: { $lte: now }, attempts: { $lt: 3 },
        }).sort({ scheduledFor: 1 }).limit(BATCH_LIMIT).lean(),
        ScheduledWhatsAppReminderModel.find({
          status: 'pending', scheduledFor: { $lte: now }, attempts: { $lt: 3 },
        }).sort({ scheduledFor: 1 }).limit(BATCH_LIMIT).lean(),
        ScheduledDiscordMeetReminderModel.find({
          status: 'pending', scheduledFor: { $lte: now }, attempts: { $lt: 3 },
        }).sort({ scheduledFor: 1 }).limit(BATCH_LIMIT).lean(),
      ]);

      const total = dueCalls.length + dueWA.length + dueDiscord.length;
      if (total === 0) return;

      console.log(`[UnifiedScheduler] Processing: ${dueCalls.length} calls, ${dueWA.length} WA, ${dueDiscord.length} Discord`);

      // 2. Batch pre-fetch ALL bookings needed for guards (eliminates N+1)
      const bookingMap = await this._fetchBookings([...dueCalls, ...dueWA, ...dueDiscord]);

      // 3. Process all types in PARALLEL — calls, WA, Discord fire concurrently
      await Promise.allSettled([
        this._processBatch(dueCalls, (item) => this._processOneCall(item, bookingMap), 3),
        this._processBatch(dueWA, (item) => this._processOneWA(item, bookingMap), 5),
        this._processBatch(dueDiscord, (item) => this._processOneDiscord(item, bookingMap), 10),
      ]);

      // 4. Periodic stuck reset
      await this.resetAllStuck();

    } finally {
      this.lastPollAt = new Date();
      this.lastPollMs = Date.now() - start;
      this.processing = false;
    }
  }

  // ────────────────────────── Batch processor with concurrency ──────────────────────────

  async _processBatch(items, processFn, concurrency) {
    if (items.length === 0) return;

    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map(item => {
          this.inFlight++;
          return processFn(item).catch(err => {
            console.error('[UnifiedScheduler] Item error:', err.message);
          }).finally(() => { this.inFlight--; });
        })
      );
    }
  }

  // ────────────────────────── Booking pre-fetch (N+1 eliminator) ──────────────────────────

  async _fetchBookings(items) {
    const bookingIds = new Set();
    const emails = new Set();

    for (const item of items) {
      if (item.metadata?.bookingId) bookingIds.add(item.metadata.bookingId);
      if (item.bookingId) bookingIds.add(item.bookingId);
      const email = (item.inviteeEmail || item.clientEmail || '').toLowerCase().trim();
      if (email) emails.add(email);
    }

    if (bookingIds.size === 0 && emails.size === 0) {
      return { byId: new Map(), byEmail: new Map() };
    }

    const orClauses = [];
    if (bookingIds.size > 0) orClauses.push({ bookingId: { $in: [...bookingIds] } });
    if (emails.size > 0) orClauses.push({ clientEmail: { $in: [...emails] } });

    const bookings = await CampaignBookingModel.find({ $or: orClauses })
      .sort({ bookingCreatedAt: -1 })
      // calendlyHost + claimedBy are needed to route Kalpataru-assigned meetings
      // to their dedicated Discord channel in _processOneDiscord.
      .select('bookingId clientEmail bookingStatus scheduledEventStartTime calendlyHost claimedBy')
      .lean();

    const byId = new Map();
    const byEmail = new Map();
    for (const b of bookings) {
      if (b.bookingId && !byId.has(b.bookingId)) byId.set(b.bookingId, b);
      const em = (b.clientEmail || '').toLowerCase().trim();
      if (em && !byEmail.has(em)) byEmail.set(em, b);
    }

    return { byId, byEmail };
  }

  // ────────────────────────── Booking guard (in-memory, zero DB calls) ──────────────────────────

  _checkGuard(item, bookingMap) {
    const bId = item.metadata?.bookingId || item.bookingId;
    const email = (item.inviteeEmail || item.clientEmail || '').toLowerCase().trim();

    const booking = (bId && bookingMap.byId.get(bId)) || (email && bookingMap.byEmail.get(email));
    if (!booking) return { ok: true };

    if (booking.bookingStatus === 'canceled' || booking.bookingStatus === 'no-show') {
      return { ok: false, reason: `booking ${booking.bookingStatus}` };
    }

    const bookingTime = booking.scheduledEventStartTime
      ? new Date(booking.scheduledEventStartTime).getTime() : null;
    const itemTime = item.meetingStartISO
      ? new Date(item.meetingStartISO).getTime() : null;
    if (bookingTime && itemTime && Math.abs(bookingTime - itemTime) > 60000) {
      return { ok: false, reason: 'meeting rescheduled' };
    }

    return { ok: true, booking };
  }

  // ────────────────────────── Per-item: CALL ──────────────────────────

  async _processOneCall(candidate, bookingMap) {
    const now = new Date();
    const call = await ScheduledCallModel.findOneAndUpdate(
      { _id: candidate._id, status: 'pending', scheduledFor: { $lte: now }, attempts: { $lt: 3 } },
      { $set: { status: 'processing', processedAt: now }, $inc: { attempts: 1 } },
      { new: true }
    ).lean();

    if (!call) return; // Already claimed

    try {
      const guard = this._checkGuard(call, bookingMap);
      if (!guard.ok) {
        await ScheduledCallModel.updateOne(
          { _id: call._id },
          { status: 'cancelled', errorMessage: `Cancelled: ${guard.reason}` }
        );
        console.log(`[UnifiedScheduler] Call blocked (${guard.reason}): ${call.callId}`);
        return;
      }

      // Single-winner claim across backends.
      const bId = call.metadata?.bookingId || call.bookingId;
      if (bId) {
        const claim = await CampaignBookingModel.findOneAndUpdate(
          { bookingId: bId, bdaCallPlacedAt: null },
          { $set: { bdaCallPlacedAt: new Date(), bdaCallPlacedBy: 'main' } },
          { new: false }
        );
        if (!claim) {
          await ScheduledCallModel.updateOne(
            { _id: call._id },
            { status: 'cancelled', errorMessage: 'bdaCallPlacedAt already set (other backend dispatched)' }
          );
          console.log(`[UnifiedScheduler] Call skipped — already placed: ${call.callId}`);
          return;
        }
      }

      logReminderDrift('call', call.callId, call.scheduledFor);

      const result = await makeCall(call);

      if (result.success) {
        const driftMs = Date.now() - new Date(call.scheduledFor).getTime();
        await ScheduledCallModel.updateOne(
          { _id: call._id, status: 'processing' },
          { twilioCallSid: result.twilioCallSid, deliveryDriftMs: driftMs }
        );
        this._trackDrift('call', driftMs);
        console.log(`[UnifiedScheduler] Call initiated: ${call.callId} (drift: ${driftMs}ms)`);
      } else {
        await this._handleCallFailure(call, result.error);
      }
    } catch (error) {
      console.error(`[UnifiedScheduler] Call error ${call.callId}:`, error.message);
      await ScheduledCallModel.updateOne(
        { _id: call._id, status: 'processing' },
        { status: 'pending', errorMessage: error.message }
      ).catch(() => {});
    }
  }

  async _handleCallFailure(call, errorMsg) {
    const updated = await ScheduledCallModel.findById(call._id);
    const maxA = updated?.maxAttempts ?? 3;

    if (updated.attempts >= maxA) {
      await ScheduledCallModel.updateOne(
        { _id: call._id },
        { status: 'failed', errorMessage: errorMsg }
      );
      if (DISCORD_CALL_WEBHOOK) {
        await DiscordConnect(DISCORD_CALL_WEBHOOK,
          `❌ **Call Failed**\n` +
          `📞 Phone: ${call.phoneNumber}\n` +
          `👤 Name: ${call.inviteeName || 'Unknown'}\n` +
          `📧 Email: ${call.inviteeEmail || 'Unknown'}\n` +
          `📆 Meeting: ${call.meetingTime}\n` +
          `❗ Error: ${errorMsg}\n` +
          `🔄 Attempts: ${updated.attempts}/${maxA}`
        ).catch(() => {});
      }
    } else {
      // Exponential backoff retry: 30s, 60s, 120s (max 5min)
      const retryDelay = Math.min(30000 * Math.pow(2, updated.attempts - 1), 5 * 60 * 1000);
      const retryAt = new Date(Date.now() + retryDelay);
      await ScheduledCallModel.updateOne(
        { _id: call._id, status: 'processing' },
        { status: 'pending', scheduledFor: retryAt, errorMessage: errorMsg }
      );
      this.scheduleTimer('call', call.callId, retryAt);
      console.log(`[UnifiedScheduler] Call retry in ${retryDelay / 1000}s: ${call.callId}`);
    }
  }

  // ────────────────────────── Per-item: WHATSAPP ──────────────────────────

  async _processOneWA(candidate, bookingMap) {
    const now = new Date();
    const reminder = await ScheduledWhatsAppReminderModel.findOneAndUpdate(
      { _id: candidate._id, status: 'pending', scheduledFor: { $lte: now }, attempts: { $lt: 3 } },
      { $set: { status: 'processing', processedAt: now }, $inc: { attempts: 1 } },
      { new: true }
    ).lean();

    if (!reminder) return;

    try {
      const guard = this._checkGuard(reminder, bookingMap);
      if (!guard.ok) {
        await ScheduledWhatsAppReminderModel.updateOne(
          { _id: reminder._id },
          { status: 'cancelled', errorMessage: `Cancelled: ${guard.reason}` }
        );
        console.log(`[UnifiedScheduler] WA blocked (${guard.reason}): ${reminder.reminderId}`);
        return;
      }

      logReminderDrift('whatsapp', reminder.reminderId, reminder.scheduledFor);

      const result = await sendWhatsAppMessage(reminder);

      if (result.success) {
        const driftMs = Date.now() - new Date(reminder.scheduledFor).getTime();
        await ScheduledWhatsAppReminderModel.updateOne(
          { _id: reminder._id, status: 'processing' },
          {
            status: 'completed',
            completedAt: new Date(),
            watiResponse: result.watiResponse,
            deliveryDriftMs: driftMs,
          }
        );
        this._trackDrift('whatsapp', driftMs);

        if (DISCORD_CALL_WEBHOOK) {
          const rType = reminder.metadata?.reminderType || '5min';
          await DiscordConnect(DISCORD_CALL_WEBHOOK,
            `✅ WA reminder sent: ${rType}\n` +
            `📞 ${reminder.phoneNumber} • ${reminder.clientName || 'Unknown'}\n` +
            `📧 ${reminder.clientEmail || 'Unknown'}\n` +
            `🗓️ ${reminder.meetingDate} @ ${reminder.meetingTime}\n` +
            `🔗 join: ${reminder.meetingLink || 'n/a'} | resched: ${reminder.rescheduleLink || 'n/a'}\n` +
            `⏰ ${new Date().toISOString()} driftMs=${driftMs}`
          ).catch(() => {});
        }
      } else {
        await this._handleWAFailure(reminder, result.error);
      }
    } catch (error) {
      console.error(`[UnifiedScheduler] WA error ${reminder.reminderId}:`, error.message);
      await ScheduledWhatsAppReminderModel.updateOne(
        { _id: reminder._id, status: 'processing' },
        { status: 'pending', errorMessage: error.message }
      ).catch(() => {});
    }
  }

  async _handleWAFailure(reminder, errorMsg) {
    const updated = await ScheduledWhatsAppReminderModel.findById(reminder._id);
    const maxA = updated?.maxAttempts ?? 3;

    if (updated.attempts >= maxA) {
      await ScheduledWhatsAppReminderModel.updateOne(
        { _id: reminder._id },
        { status: 'failed', errorMessage: errorMsg }
      );
      if (DISCORD_CALL_WEBHOOK) {
        const rType = reminder.metadata?.reminderType || '5min';
        await DiscordConnect(DISCORD_CALL_WEBHOOK,
          `❌ WA reminder failed: ${rType}\n` +
          `📞 ${reminder.phoneNumber} • ${reminder.clientName || 'Unknown'}\n` +
          `📧 ${reminder.clientEmail || 'Unknown'}\n` +
          `🗓️ ${reminder.meetingDate} @ ${reminder.meetingTime}\n` +
          `⚠️ ${errorMsg}\n` +
          `🔄 ${updated.attempts}/${maxA}`
        ).catch(() => {});
      }
    } else {
      const retryDelay = Math.min(30000 * Math.pow(2, updated.attempts - 1), 5 * 60 * 1000);
      const retryAt = new Date(Date.now() + retryDelay);
      await ScheduledWhatsAppReminderModel.updateOne(
        { _id: reminder._id, status: 'processing' },
        { status: 'pending', scheduledFor: retryAt, errorMessage: errorMsg }
      );
      this.scheduleTimer('whatsapp', reminder.reminderId, retryAt);
      console.log(`[UnifiedScheduler] WA retry in ${retryDelay / 1000}s: ${reminder.reminderId}`);
    }
  }

  // ────────────────────────── Per-item: DISCORD ──────────────────────────

  async _processOneDiscord(candidate, bookingMap) {
    if (!DISCORD_MEET_WEBHOOK) return;

    const now = new Date();
    const reminder = await ScheduledDiscordMeetReminderModel.findOneAndUpdate(
      { _id: candidate._id, status: 'pending', scheduledFor: { $lte: now }, attempts: { $lt: 3 } },
      { $set: { status: 'processing', processedAt: now }, $inc: { attempts: 1 } },
      { new: true }
    ).lean();

    if (!reminder) return;

    try {
      const guard = this._checkGuard(reminder, bookingMap);
      if (!guard.ok) {
        await ScheduledDiscordMeetReminderModel.updateOne(
          { _id: reminder._id },
          { status: 'cancelled', errorMessage: `Cancelled: ${guard.reason}` }
        );
        console.log(`[UnifiedScheduler] Discord blocked (${guard.reason}): ${reminder.reminderId}`);
        return;
      }

      // Single-winner claim across backends.
      const bIdDisc = reminder.metadata?.bookingId || reminder.bookingId;
      if (bIdDisc) {
        const claim = await CampaignBookingModel.findOneAndUpdate(
          { bookingId: bIdDisc, bdaDiscordReminderSentAt: null },
          { $set: { bdaDiscordReminderSentAt: new Date(), bdaDiscordReminderSentBy: 'main' } },
          { new: false }
        );
        if (!claim) {
          await ScheduledDiscordMeetReminderModel.updateOne(
            { _id: reminder._id },
            { status: 'cancelled', errorMessage: 'bdaDiscordReminderSentAt already set (other backend dispatched)' }
          );
          console.log(`[UnifiedScheduler] Discord skipped — already sent: ${reminder.reminderId}`);
          return;
        }
      }

      const meetingStart = new Date(reminder.meetingStartISO);
      const meetingTimeWall = formatMeetingWallTime(meetingStart, reminder.inviteeTimezone);
      const headline = headlineForSendTime(meetingStart);

      const content = [
        headline,
        '',
        `Client: ${reminder.clientName}`,
        `Time: ${meetingTimeWall}`,
        `Link: ${reminder.meetingLink || 'Not provided'}`,
        '',
        "BDA team, confirm attendance by typing **\"I'm in.\"** Let's close this.",
      ].join('\n');

      logReminderDrift('discord_bda', reminder.reminderId, reminder.scheduledFor);

      // Route to the Kalpataru channel when the assigned BDA's name starts with
      // "Kalpataru" (Calendly round-robin host, else manual CRM claim); otherwise
      // use the shared channel. Mirrors the legacy DiscordMeetReminderScheduler
      // routing — this precision path is the one that actually wins the claim.
      const bookingForRoute =
        (bIdDisc && bookingMap.byId.get(bIdDisc)) ||
        ((reminder.clientEmail || '') && bookingMap.byEmail.get(String(reminder.clientEmail).toLowerCase().trim())) ||
        null;
      const assignedBdaName = (
        bookingForRoute?.calendlyHost?.name ||
        bookingForRoute?.claimedBy?.name ||
        ''
      ).trim();
      const isKalpataru = /^kalpataru/i.test(assignedBdaName);
      const targetWebhook =
        isKalpataru && DISCORD_MEET_KALPATARU_WEBHOOK
          ? DISCORD_MEET_KALPATARU_WEBHOOK
          : DISCORD_MEET_WEBHOOK;

      await DiscordConnect(targetWebhook, content, false);

      const driftMs = Date.now() - new Date(reminder.scheduledFor).getTime();
      await ScheduledDiscordMeetReminderModel.updateOne(
        { _id: reminder._id, status: 'processing' },
        { status: 'completed', completedAt: new Date(), errorMessage: null, deliveryDriftMs: driftMs }
      );
      this._trackDrift('discord', driftMs);
      console.log(`[UnifiedScheduler] Discord reminder sent: ${reminder.reminderId} (drift: ${driftMs}ms)`);

    } catch (error) {
      console.error(`[UnifiedScheduler] Discord error ${reminder.reminderId}:`, error.message);
      const maxA = reminder.maxAttempts ?? 3;
      await ScheduledDiscordMeetReminderModel.updateOne(
        { _id: reminder._id, status: 'processing' },
        {
          status: reminder.attempts >= maxA ? 'failed' : 'pending',
          errorMessage: error.message,
        }
      ).catch(() => {});
    }
  }

  // ────────────────────────── Stuck item reset ──────────────────────────

  async resetAllStuck() {
    const cutoff = new Date(Date.now() - STUCK_MS);
    const msg = 'reset: stuck in processing (unified scheduler recovery)';

    const [callRes, waRes, discordRes] = await Promise.all([
      ScheduledCallModel.updateMany(
        { status: 'processing', processedAt: { $lt: cutoff }, $or: [{ twilioCallSid: null }, { twilioCallSid: '' }] },
        { $set: { status: 'pending', errorMessage: msg } }
      ),
      ScheduledWhatsAppReminderModel.updateMany(
        { status: 'processing', processedAt: { $lt: cutoff } },
        { $set: { status: 'pending', errorMessage: msg } }
      ),
      ScheduledDiscordMeetReminderModel.updateMany(
        { status: 'processing', processedAt: { $lt: cutoff } },
        { $set: { status: 'pending', errorMessage: msg } }
      ),
    ]);

    const total = (callRes.modifiedCount || 0) + (waRes.modifiedCount || 0) + (discordRes.modifiedCount || 0);
    if (total > 0) {
      console.warn(`[UnifiedScheduler] Reset ${total} stuck items (call:${callRes.modifiedCount} wa:${waRes.modifiedCount} discord:${discordRes.modifiedCount})`);
    }
  }

  // ────────────────────────── Self-heal ──────────────────────────────────

  _buildDisplay(booking) {
    const tz = booking.inviteeTimezone || 'America/New_York';
    const s = DateTime.fromJSDate(new Date(booking.scheduledEventStartTime)).setZone(tz);
    const e = booking.scheduledEventEndTime
      ? DateTime.fromJSDate(new Date(booking.scheduledEventEndTime)).setZone(tz)
      : s.plus({ minutes: 15 });
    const fmt = dt => dt.minute === 0 ? dt.toFormat('ha').toLowerCase() : dt.toFormat('h:mma').toLowerCase();
    return {
      meetingTime: `${fmt(s)} – ${fmt(e)}`,
      meetingDate: s.toFormat('EEEE MMM d, yyyy'),
      tzAbbr: s.toFormat('ZZZZ') || 'ET',
    };
  }

  async _healMissingReminders() {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const bookings = await CampaignBookingModel.find({
      bookingStatus: 'scheduled',
      scheduledEventStartTime: { $gte: now, $lt: windowEnd },
    }).lean();

    if (!bookings.length) return;

    let created = 0;
    let flagsCleared = 0;

    // Heal missing calendlyHost on upcoming bookings (sync-created rows often lack
    // it). Required for BDA channel routing (Kalpataru) at reminder send time.
    // resolveCalendlyHostByEventUri no-ops when CALENDLY_API_TOKEN is absent.
    // Capped per run to stay gentle on the Calendly API.
    let hostsHealed = 0;
    const HOST_HEAL_CAP = 20;
    for (const booking of bookings) {
      if (hostsHealed >= HOST_HEAL_CAP) break;
      if (booking.calendlyHost?.email || !booking.calendlyEventUri) continue;
      try {
        const host = await resolveCalendlyHostByEventUri(booking.calendlyEventUri);
        if (!host?.email) continue;
        await CampaignBookingModel.updateOne(
          { bookingId: booking.bookingId },
          {
            $set: {
              calendlyHost: {
                email: host.email,
                name: host.name || null,
                calendlyUserUri: host.calendlyUserUri || null,
                matchedCrmUser: false,
              },
            },
          }
        );
        booking.calendlyHost = { email: host.email, name: host.name || null };
        hostsHealed++;
        console.log(`[UnifiedScheduler] Heal: calendlyHost set for ${booking.clientName} → ${host.name || host.email}`);
      } catch (err) {
        console.error(`[UnifiedScheduler] Heal host error (${booking.bookingId}): ${err.message}`);
      }
    }

    for (const booking of bookings) {
      const meetingStart = new Date(booking.scheduledEventStartTime);
      const minUntil = (meetingStart.getTime() - now.getTime()) / 60000;
      if (minUntil < 5) continue;

      const phone = booking.clientPhone ? normalizePhoneForReminders(booking.clientPhone) : null;
      const phoneOk = phone && /^\+?[1-9]\d{9,14}$/.test(phone);

      const [waRecords, activeCall, activeDisc] = await Promise.all([
        ScheduledWhatsAppReminderModel.find({ bookingId: booking.bookingId }).lean(),
        ScheduledCallModel.findOne({ bookingId: booking.bookingId, status: { $in: ['pending', 'processing', 'completed'] } }).lean(),
        ScheduledDiscordMeetReminderModel.findOne({ bookingId: booking.bookingId, status: { $in: ['pending', 'processing', 'completed'] } }).lean(),
      ]);

      // Clear stale whatsappReminderSentAt if no completed WA reminder exists
      const waCompleted = waRecords.some(r => r.status === 'completed');
      if (booking.whatsappReminderSentAt && !waCompleted) {
        await CampaignBookingModel.updateOne(
          { _id: booking._id },
          { $set: { whatsappReminderSentAt: null, whatsappReminderSentBy: null } }
        );
        flagsCleared++;
      }

      // Check per-type — only create what's actually missing
      const active = s => ['pending', 'processing', 'completed'].includes(s);
      const waByType = {};
      for (const r of waRecords) {
        const t = r.metadata?.reminderType;
        if (t && (!waByType[t] || active(r.status))) waByType[t] = r;
      }
      const missingImmediate = !waByType.immediate || !active(waByType.immediate.status);
      const missing3h = (!waByType['3h'] || !active(waByType['3h'].status)) && minUntil > 180;
      const missing5min = (!waByType['5min'] || !active(waByType['5min'].status)) && minUntil > 5;
      const needsWa = missingImmediate || missing3h || missing5min;

      if (needsWa && phoneOk) {
        const disp = this._buildDisplay(booking);
        try {
          await scheduleAllWhatsAppReminders({
            phoneNumber: phone,
            meetingStartISO: booking.scheduledEventStartTime,
            meetingTime: disp.meetingTime,
            meetingDate: disp.meetingDate,
            clientName: booking.clientName,
            clientEmail: booking.clientEmail,
            meetingLink: booking.calendlyMeetLink || booking.googleMeetUrl || null,
            rescheduleLink: booking.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
            source: 'auto-heal',
            timezone: disp.tzAbbr,
            metadata: { bookingId: booking.bookingId, inviteeTimezone: booking.inviteeTimezone },
          });
          const newWa = await ScheduledWhatsAppReminderModel.find({
            bookingId: booking.bookingId, status: 'pending', scheduledFor: { $gt: now },
          }).select('reminderId scheduledFor').lean();
          for (const w of newWa) this.scheduleTimer('whatsapp', w.reminderId, w.scheduledFor);
          created++;
          console.log(`[UnifiedScheduler] Heal: WA reminders created for ${booking.clientName}`);
        } catch (err) {
          console.error(`[UnifiedScheduler] Heal WA error (${booking.clientEmail}): ${err.message}`);
        }
      }

      if (!activeCall && phoneOk && minUntil > 12) {
        try {
          await scheduleCall({
            phoneNumber: phone,
            meetingStartISO: booking.scheduledEventStartTime,
            meetingTime: DateTime.fromJSDate(meetingStart).setZone(booking.inviteeTimezone || 'America/New_York').toFormat('ff'),
            inviteeName: booking.clientName,
            inviteeEmail: booking.clientEmail,
            source: 'auto-heal',
            meetingLink: booking.calendlyMeetLink || null,
            rescheduleLink: booking.calendlyRescheduleLink || 'https://calendly.com/flashfirejobs',
            skipWhatsAppReminders: true,
            metadata: { bookingId: booking.bookingId, inviteeTimezone: booking.inviteeTimezone },
          });
          const newCall = await ScheduledCallModel.findOne({ bookingId: booking.bookingId, status: 'pending', scheduledFor: { $gt: now } })
            .select('callId scheduledFor').lean();
          if (newCall) this.scheduleTimer('call', newCall.callId, newCall.scheduledFor);
          created++;
          console.log(`[UnifiedScheduler] Heal: call reminder created for ${booking.clientName}`);
        } catch (err) {
          console.error(`[UnifiedScheduler] Heal call error (${booking.clientEmail}): ${err.message}`);
        }
      }

      if (!activeDisc && minUntil > 6) {
        try {
          await scheduleDiscordMeetReminder({
            bookingId: booking.bookingId,
            clientName: booking.clientName,
            clientEmail: booking.clientEmail,
            meetingStartISO: booking.scheduledEventStartTime,
            meetingLink: booking.calendlyMeetLink || null,
            inviteeTimezone: booking.inviteeTimezone,
            source: 'auto-heal',
            metadata: { bookingId: booking.bookingId },
          });
          const newDisc = await ScheduledDiscordMeetReminderModel.findOne({ bookingId: booking.bookingId, status: 'pending', scheduledFor: { $gt: now } })
            .select('reminderId scheduledFor').lean();
          if (newDisc) this.scheduleTimer('discord', newDisc.reminderId, newDisc.scheduledFor);
          created++;
          console.log(`[UnifiedScheduler] Heal: Discord reminder created for ${booking.clientName}`);
        } catch (err) {
          console.error(`[UnifiedScheduler] Heal Discord error (${booking.clientEmail}): ${err.message}`);
        }
      }
    }

    if (created > 0 || flagsCleared > 0) {
      console.log(`[UnifiedScheduler] Heal complete: ${created} reminder(s) created, ${flagsCleared} stale flag(s) cleared`);
    }
  }

  // ────────────────────────── Drift tracking ──────────────────────────

  _trackDrift(type, driftMs) {
    const samples = this.driftSamples[type];
    if (!samples) return;
    samples.push(driftMs);
    if (samples.length > 100) samples.shift();
  }

  _avgDrift(type) {
    const s = this.driftSamples[type];
    if (!s || s.length === 0) return 0;
    return Math.round(s.reduce((a, b) => a + b, 0) / s.length);
  }

  // ────────────────────────── Stats & Health ──────────────────────────

  async getStats() {
    const [callCounts, waCounts, discordCounts] = await Promise.all([
      this._countByStatus(ScheduledCallModel),
      this._countByStatus(ScheduledWhatsAppReminderModel),
      this._countByStatus(ScheduledDiscordMeetReminderModel),
    ]);

    return {
      isRunning: this.running,
      safetyPollMs: SAFETY_POLL_MS,
      stuckThresholdMs: STUCK_MS,
      activeTimers: this.timers.size,
      inFlight: this.inFlight,
      lastPollAt: this.lastPollAt,
      lastPollDurationMs: this.lastPollMs,
      calls: callCounts,
      whatsapp: waCounts,
      discord: discordCounts,
      averageDriftMs: {
        call: this._avgDrift('call'),
        whatsapp: this._avgDrift('whatsapp'),
        discord: this._avgDrift('discord'),
      },
    };
  }

  async _countByStatus(Model) {
    const [pending, processing, completed, failed, cancelled] = await Promise.all([
      Model.countDocuments({ status: { $in: ['pending', 'scheduled'] } }),
      Model.countDocuments({ status: 'processing' }),
      Model.countDocuments({ status: 'completed' }),
      Model.countDocuments({ status: 'failed' }),
      Model.countDocuments({ status: 'cancelled' }),
    ]);
    return { pending, processing, completed, failed, cancelled };
  }

  getHealth() {
    return {
      isRunning: this.running,
      isHealthy: this.running && this.lastPollAt && (Date.now() - this.lastPollAt.getTime()) < SAFETY_POLL_MS * 3,
      lastPollAt: this.lastPollAt,
      lastPollDurationMs: this.lastPollMs,
      activeTimers: this.timers.size,
      inFlight: this.inFlight,
      averageDriftMs: {
        call: this._avgDrift('call'),
        whatsapp: this._avgDrift('whatsapp'),
        discord: this._avgDrift('discord'),
      },
    };
  }
}

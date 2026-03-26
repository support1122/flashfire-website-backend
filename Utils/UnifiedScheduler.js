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
import { makeCall } from './CallScheduler.js';
import { sendWhatsAppMessage } from './WhatsAppReminderScheduler.js';
import { formatMeetingWallTime, headlineForSendTime } from './DiscordMeetReminderScheduler.js';

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

export class UnifiedScheduler {
  constructor() {
    this.timers = new Map();
    this.pollHandle = null;
    this.bdaPollHandle = null;
    this.jobPollHandle = null;
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

    const timer = setTimeout(() => {
      this.timers.delete(key);
      this._trigger();
    }, delayMs);
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

    console.log('[UnifiedScheduler] Started — precision timers active, safety poll every 30s');
  }

  async stop() {
    if (!this.running) return;

    if (this.pollHandle) { clearInterval(this.pollHandle); this.pollHandle = null; }
    if (this.bdaPollHandle) { clearInterval(this.bdaPollHandle); this.bdaPollHandle = null; }
    if (this.jobPollHandle) { clearInterval(this.jobPollHandle); this.jobPollHandle = null; }

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
      .select('bookingId clientEmail bookingStatus scheduledEventStartTime')
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

      await DiscordConnect(DISCORD_MEET_WEBHOOK, content, false);

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

import dotenv from 'dotenv';
import { DiscordConnect } from './DiscordConnect.js';
import { SalesLeadAllocationModel } from '../Schema_Models/SalesLeadAllocation.js';
import { buildEarlyReminderMessage, buildReminderMessage, crmLinkFor } from './SalesAllocations.js';

dotenv.config();

// Posts a Discord reminder ~5 minutes before each scheduled sales call. Same webhook as the Calendly
// meeting reminders. A row is claimed pending -> sending with one atomic update, so the poller and any
// second instance can never post the same reminder twice.

const POLL_INTERVAL_MS = 30 * 1000;
const LEAD_MS = 5 * 60 * 1000; // remind this long before the call
const EARLY_LEAD_MS = 30 * 60 * 1000; // the heads-up goes out this long before the call
const GRACE_MS = 10 * 60 * 1000; // still remind up to this long after the call time (late start)
const STUCK_SENDING_MS = 3 * 60 * 1000;
const BATCH = 20;

export const resolveWebhookUrl = () =>
  process.env.DISCORD_MEET_2MIN_WEBHOOK_URL ||
  process.env.DISCORD_MEET_WEB_HOOK_URL ||
  process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL ||
  null;

/** Calls whose reminder is due at `now`: callAt within [now - 10 min, now + 5 min]. */
export function reminderWindow(now) {
  const t = now.getTime();
  return { from: new Date(t - GRACE_MS), to: new Date(t + LEAD_MS) };
}

export function isInReminderWindow(callAt, now) {
  const t = new Date(callAt).getTime();
  const { from, to } = reminderWindow(now);
  return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
}

/**
 * Calls whose 30-minute heads-up is due: between 5 and 30 minutes away. A call booked with less than 5 minutes of
 * notice skips the heads-up, because the final reminder is already due and two pings back to back would be noise.
 */
export function earlyWindow(now) {
  const t = now.getTime();
  return { from: new Date(t + LEAD_MS), to: new Date(t + EARLY_LEAD_MS) };
}

export function isInEarlyWindow(callAt, now) {
  const t = new Date(callAt).getTime();
  const { from, to } = earlyWindow(now);
  return Number.isFinite(t) && t >= from.getTime() && t <= to.getTime();
}

/** Real dependencies backed by Mongo. tick() takes these so tests can inject fakes. */
export function mongoDeps(webhookUrl = resolveWebhookUrl()) {
  const M = SalesLeadAllocationModel;
  return {
    webhookUrl,
    async resetStuck(now) {
      const res = await M.updateMany(
        { reminderState: 'sending', reminderClaimedAt: { $lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
        { $set: { reminderState: 'pending' } }
      );
      return res.modifiedCount || 0;
    },
    async findDue(now) {
      const { from, to } = reminderWindow(now);
      return M.find({ status: 'scheduled', reminderState: 'pending', callAt: { $gte: from, $lte: to } })
        .sort({ callAt: 1 })
        .limit(BATCH)
        .lean();
    },
    async claim(row, now) {
      const { from, to } = reminderWindow(now);
      return M.findOneAndUpdate(
        { allocationId: row.allocationId, status: 'scheduled', reminderState: 'pending', callAt: { $gte: from, $lte: to } },
        { $set: { reminderState: 'sending', reminderClaimedAt: now } },
        { new: true }
      ).lean();
    },
    async markSent(row, now) {
      await M.updateOne(
        { allocationId: row.allocationId, reminderState: 'sending' },
        { $set: { reminderState: 'sent', reminderSentAt: now } }
      );
    },
    async markFailed(row) {
      await M.updateOne({ allocationId: row.allocationId, reminderState: 'sending' }, { $set: { reminderState: 'failed' } });
    },
    send: (content) => DiscordConnect(webhookUrl, content, false),
  };
}

/** Shared poll loop. Returns counts so tests (and logs) can see what happened. Never throws. */
async function runTick(label, now, deps, build) {
  const out = { reset: 0, sent: 0, failed: 0, skipped: 0 };
  try {
    out.reset = (await deps.resetStuck(now)) || 0;
    const due = await deps.findDue(now);
    for (const candidate of due) {
      const row = await deps.claim(candidate, now);
      if (!row) {
        out.skipped += 1; // another instance won, or the row changed since the read
        continue;
      }
      try {
        const content = build({ ...row, crmUrl: crmLinkFor(row.allocationId) });
        const res = await deps.send(content);
        if (!res?.ok) throw new Error(res?.error || 'unknown');
        await deps.markSent(row, new Date());
        out.sent += 1;
      } catch (err) {
        console.error(`[SalesAllocationReminder] ${label} send failed for`, row.allocationId, err?.message);
        await deps.markFailed(row);
        out.failed += 1;
      }
    }
  } catch (err) {
    console.error(`[SalesAllocationReminder] ${label} tick failed:`, err?.message);
  }
  return out;
}

/** One pass of the 5-minute reminder. */
export const tick = (now = new Date(), deps = mongoDeps()) => runTick('final', now, deps, buildReminderMessage);

/** Real dependencies for the 30-minute heads-up. Same shape as mongoDeps, different state fields and window. */
export function mongoEarlyDeps(webhookUrl = resolveWebhookUrl()) {
  const M = SalesLeadAllocationModel;
  // A row written before these fields existed has no earlyReminderState; null matches a missing field.
  const pending = { $in: ['pending', null] };
  return {
    webhookUrl,
    async resetStuck(now) {
      const res = await M.updateMany(
        { earlyReminderState: 'sending', earlyReminderClaimedAt: { $lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
        { $set: { earlyReminderState: 'pending' } }
      );
      return res.modifiedCount || 0;
    },
    async findDue(now) {
      const { from, to } = earlyWindow(now);
      return M.find({ status: 'scheduled', earlyReminderState: pending, callAt: { $gte: from, $lte: to } })
        .sort({ callAt: 1 })
        .limit(BATCH)
        .lean();
    },
    async claim(row, now) {
      const { from, to } = earlyWindow(now);
      return M.findOneAndUpdate(
        { allocationId: row.allocationId, status: 'scheduled', earlyReminderState: pending, callAt: { $gte: from, $lte: to } },
        { $set: { earlyReminderState: 'sending', earlyReminderClaimedAt: now } },
        { new: true }
      ).lean();
    },
    async markSent(row, now) {
      await M.updateOne(
        { allocationId: row.allocationId, earlyReminderState: 'sending' },
        { $set: { earlyReminderState: 'sent', earlyReminderSentAt: now } }
      );
    },
    async markFailed(row) {
      await M.updateOne({ allocationId: row.allocationId, earlyReminderState: 'sending' }, { $set: { earlyReminderState: 'failed' } });
    },
    send: (content) => DiscordConnect(webhookUrl, content, false),
  };
}

/** One pass of the 30-minute heads-up. */
export const tickEarly = (now = new Date(), deps = mongoEarlyDeps()) => runTick('early', now, deps, buildEarlyReminderMessage);

let timer = null;
let running = false;

export function startSalesAllocationReminders() {
  if (timer) return;
  if (!resolveWebhookUrl()) {
    console.warn('[SalesAllocationReminder] No Discord webhook configured. Reminders will not start.');
    return;
  }
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      await tickEarly(now);
      await tick(now);
    } finally {
      running = false;
    }
  };
  console.log(`🚀 [SalesAllocationReminder] Polling every ${POLL_INTERVAL_MS / 1000}s, heads-up ${EARLY_LEAD_MS / 60000} min and reminder ${LEAD_MS / 60000} min before each call`);
  run();
  timer = setInterval(run, POLL_INTERVAL_MS);
}

export function stopSalesAllocationReminders() {
  if (timer) clearInterval(timer);
  timer = null;
}

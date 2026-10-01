import cron from 'node-cron';
import { DateTime } from 'luxon';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { WatiTemplates } from '../config/watiTemplates.js';
import watiService from './WatiService.js';
import { DiscordConnect } from './DiscordConnect.js';

/**
 * Every 12 hours, report WhatsApp (WATI) send failures to Discord.
 *
 * Sources of failed sends:
 *   - WorkflowLog              step.channel 'whatsapp', status 'failed'   (workflow steps)
 *   - ScheduledWhatsAppReminder status 'failed'                          (meeting reminders)
 *   - WhatsAppCampaign          messageStatuses[].status 'failed'         (bulk campaigns)
 *
 * A logged failure is not always a lost message: on a timeout WATI often accepts the
 * request and sends it after our client gave up. Every failure is therefore checked
 * against the contact's WATI conversation, and the report splits "sent anyway" (with
 * WATI's send time) from messages that really did not go out.
 *
 * Webhook: DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL. When unset the job logs and skips.
 */

const IST_TIMEZONE = 'Asia/Kolkata';
export const WINDOW_HOURS = 12;
// 09:00 and 21:00 IST, 12 hours apart so consecutive windows neither overlap nor leave gaps.
const CRON_EXPRESSION = '0 9,21 * * *';
const MAX_NOT_SENT_LINES = 8;
const MAX_SENT_LINES = 6;
const MAX_TOP_ERRORS = 5;
const MAX_ERROR_CHARS = 120;
const DISCORD_MAX_CHARS = 1900; // Discord caps content at 2000; keep headroom

// How far around the failed attempt a WATI message still counts as that send.
const MATCH_BEFORE_MS = 2 * 60 * 1000;
const MATCH_AFTER_MS = 30 * 60 * 1000;
// Lookups share the WATI quota with real sends, so cap and space them.
const MAX_WATI_LOOKUPS = 40;
const WATI_LOOKUP_GAP_MS = 300;

const REMINDER_TEMPLATES = Object.values(WatiTemplates);
const RATE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b/i;
const TEMPLATE_IN_EVENT = /"([^"]+)" template/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function oneLine(text, max = MAX_ERROR_CHARS) {
  const s = String(text ?? 'Unknown error').replace(/\s+/g, ' ').trim() || 'Unknown error';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Failed workflow errors carry the full WATI JSON after "\nWATI Response:"; keep only the headline.
// Also strip JSON quotes and the circuit breaker's countdown so identical errors group together.
function errorHeadline(error) {
  const headline = String(error ?? '')
    .split('\nWATI Response:')[0]
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/\s*\(resets in \d+s\)/, '');
  return oneLine(headline);
}

function formatIST(date, withSeconds = false) {
  return DateTime.fromJSDate(new Date(date)).setZone(IST_TIMEZONE).toFormat(withSeconds ? 'dd LLL HH:mm:ss' : 'dd LLL HH:mm');
}

const plus = (date, ms) => new Date(new Date(date).getTime() + ms);

/**
 * Load every WhatsApp failure recorded in [since, until).
 * Each failure carries the template name(s) it should have sent and the time range a
 * matching WATI message may fall in, for verifyFailuresWithWati().
 */
export async function collectWhatsAppFailures(since, until) {
  const window = { $gte: since, $lt: until };

  const [workflowLogs, reminders, campaigns] = await Promise.all([
    WorkflowLogModel.find({
      'step.channel': 'whatsapp',
      status: 'failed',
      $or: [{ executedAt: window }, { updatedAt: window }]
    })
      .select('workflowName workflowId clientName clientPhone step.templateName step.templateId error executedAt updatedAt')
      .lean(),
    ScheduledWhatsAppReminderModel.find({ status: 'failed', updatedAt: window })
      .select('clientName phoneNumber metadata.reminderType errorMessage scheduledFor updatedAt')
      .lean(),
    // messageStatuses have no failure timestamp, so a campaign counts when it was last
    // touched inside the window and still holds failed messages.
    WhatsAppCampaignModel.find({ updatedAt: window, 'messageStatuses.status': 'failed' })
      .select('campaignId templateName messageStatuses createdAt updatedAt')
      .lean()
  ]);

  const failures = [];

  for (const log of workflowLogs) {
    let template = log.step?.templateName || null;
    if (!template && log.step?.templateId) {
      template = await watiService.resolveTemplateName(null, log.step.templateId).catch(() => null);
    }
    const at = log.executedAt || log.updatedAt;
    failures.push({
      source: 'workflow',
      at,
      phone: log.clientPhone || null,
      name: log.clientName || null,
      label: `${log.workflowName || log.workflowId} · ${template || log.step?.templateId || 'template?'}`,
      error: errorHeadline(log.error),
      templates: template ? [template] : [],
      matchFrom: plus(at, -MATCH_BEFORE_MS),
      matchTo: plus(log.updatedAt || at, MATCH_AFTER_MS)
    });
  }

  for (const r of reminders) {
    failures.push({
      source: 'reminder',
      at: r.updatedAt,
      phone: r.phoneNumber || null,
      name: r.clientName || null,
      label: `meeting reminder (${r.metadata?.reminderType || '5min'})`,
      error: errorHeadline(r.errorMessage),
      // The exact template depends on the booking's links, so accept any booking/reminder template.
      templates: REMINDER_TEMPLATES,
      matchFrom: plus(r.scheduledFor || r.updatedAt, -MATCH_BEFORE_MS),
      matchTo: plus(r.updatedAt, MATCH_AFTER_MS)
    });
  }

  for (const c of campaigns) {
    for (const m of c.messageStatuses || []) {
      if (m.status !== 'failed') continue;
      failures.push({
        source: 'campaign',
        at: c.updatedAt,
        phone: m.mobileNumber || null,
        name: null,
        label: `campaign ${c.templateName}`,
        error: errorHeadline(m.errorMessage),
        templates: [c.templateName],
        matchFrom: plus(c.createdAt || c.updatedAt, -MATCH_BEFORE_MS),
        matchTo: plus(c.updatedAt, MATCH_AFTER_MS)
      });
    }
  }

  failures.sort((a, b) => new Date(b.at) - new Date(a.at));
  return dedupeFailures(failures);
}

// One failed immediate workflow step is currently logged twice (by executeWorkflowStep and
// again by triggerWorkflow's catch). Collapse rows for the same send within a minute.
export function dedupeFailures(failures) {
  const kept = [];
  for (const f of failures) {
    const dup = kept.find(k =>
      k.source === f.source && k.phone === f.phone && k.label === f.label &&
      Math.abs(new Date(k.at) - new Date(f.at)) < 60 * 1000
    );
    if (!dup) kept.push(f);
  }
  return kept;
}

/**
 * Find the WATI message that proves a failed send actually went out.
 * @returns {{ at: Date, status: string, template: string } | null}
 */
export function findSentMessage(failure, watiItems) {
  const from = new Date(failure.matchFrom).getTime();
  const to = new Date(failure.matchTo).getTime();
  for (const item of watiItems || []) {
    const template = item.eventDescription?.match(TEMPLATE_IN_EVENT)?.[1];
    if (!template || !failure.templates.includes(template)) continue;
    if (String(item.statusString || '').toUpperCase() === 'FAILED') continue;
    const created = new Date(item.created).getTime();
    if (created >= from && created <= to) {
      return { at: new Date(item.created), status: item.statusString || 'SENT', template };
    }
  }
  return null;
}

/**
 * Attach `wati` to each failure: { checked: true, sent: {at,status,template} | null }
 * or { checked: false, reason }. One WATI lookup per phone number.
 */
export async function verifyFailuresWithWati(failures, {
  fetchMessages = (phone) => watiService.getMessages(phone),
  gapMs = WATI_LOOKUP_GAP_MS,
  maxLookups = MAX_WATI_LOOKUPS
} = {}) {
  const byPhone = new Map();
  for (const f of failures) {
    const digits = String(f.phone || '').replace(/\D/g, '');
    if (!digits || f.templates.length === 0) {
      f.wati = { checked: false, reason: !digits ? 'no phone' : 'unknown template' };
      continue;
    }
    if (!byPhone.has(digits)) byPhone.set(digits, []);
    byPhone.get(digits).push(f);
  }

  let lookups = 0;
  for (const [digits, group] of byPhone) {
    if (lookups >= maxLookups) {
      group.forEach(f => { f.wati = { checked: false, reason: 'lookup cap reached' }; });
      continue;
    }
    if (lookups > 0 && gapMs > 0) await sleep(gapMs);
    lookups++;

    const res = await fetchMessages(digits).catch(error => ({ success: false, error: error.message }));
    for (const f of group) {
      f.wati = res.success
        ? { checked: true, sent: findSentMessage(f, res.items) }
        : { checked: false, reason: `WATI lookup failed: ${oneLine(res.error, 60)}` };
    }
  }
  return failures;
}

const whoOf = (f) => oneLine([f.name, f.phone].filter(Boolean).join(' ') || 'unknown recipient', 40);

/**
 * Build the Discord message from verified failures. Pure, so it can be unit tested.
 * Stays under Discord's 2000-char limit by capping error lengths and trimming the lists.
 */
export function formatWhatsAppFailureReport(failures, since, until) {
  const range = `${formatIST(since)} - ${formatIST(until)} IST`;

  if (failures.length === 0) {
    return `✅ **WhatsApp send check (last ${WINDOW_HOURS}h)**: no failed messages. (${range})`;
  }

  const sent = failures.filter(f => f.wati?.sent);
  const notSent = failures.filter(f => !f.wati?.sent);

  const head = [];
  if (notSent.length === 0) {
    head.push(
      `✅ **WhatsApp send check (last ${WINDOW_HOURS}h)**: ${failures.length} send error(s) logged, but WATI confirms every message went out. Nothing to do.`,
      `🕒 ${range}`
    );
  } else {
    head.push(
      `⚠️ **WhatsApp: ${notSent.length} message(s) NOT sent (last ${WINDOW_HOURS}h)**` +
        (sent.length ? ` · ${sent.length} more logged an error but WATI sent them anyway` : ''),
      `🕒 ${range}`
    );

    const bySource = { workflow: 0, reminder: 0, campaign: 0 };
    const byError = new Map();
    let rateLimited = 0;
    for (const f of notSent) {
      bySource[f.source] = (bySource[f.source] || 0) + 1;
      byError.set(f.error, (byError.get(f.error) || 0) + 1);
      if (RATE_LIMIT_PATTERN.test(f.error)) rateLimited++;
    }
    head.push(
      '',
      `• Workflow messages: ${bySource.workflow}`,
      `• Meeting reminders: ${bySource.reminder}`,
      `• Campaign messages: ${bySource.campaign}`
    );
    const unchecked = notSent.filter(f => !f.wati?.checked).length;
    if (unchecked > 0) {
      head.push(`• Could not verify in WATI: ${unchecked} (counted as not sent)`);
    }
    if (rateLimited > 0) {
      head.push('', `🚦 ${rateLimited} of ${notSent.length} were WATI rate/usage-limit rejections ("API usage limit exceeded").`);
    }
    head.push('', '**Top errors**');
    for (const [error, count] of [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_ERRORS)) {
      head.push(`• ${count}× ${oneLine(error)}`);
    }
  }

  // Trim the "sent anyway" list first, then the "not sent" list, until it fits one post.
  for (let n = Math.min(MAX_NOT_SENT_LINES, notSent.length); n >= 0; n--) {
    for (let s = Math.min(MAX_SENT_LINES, sent.length); s >= 0; s--) {
      const message = [...head, ...formatNotSent(notSent, n), ...formatSent(sent, s)].join('\n');
      if (message.length <= DISCORD_MAX_CHARS || (n === 0 && s === 0)) return message;
    }
  }
}

function formatNotSent(notSent, count) {
  if (notSent.length === 0) return [];
  const out = ['', `**❌ Not sent (${notSent.length})**`];
  for (const f of notSent.slice(0, count)) {
    const note = f.wati?.checked ? 'not in WATI' : oneLine(f.wati?.reason || 'not checked', 40);
    out.push(`• ${formatIST(f.at)} · ${whoOf(f)} · ${oneLine(f.label, 60)} · ${oneLine(f.error, 70)} · ${note}`);
  }
  if (notSent.length > count) {
    out.push(`…and ${notSent.length - count} more. See the CRM workflow logs / WhatsApp reminders.`);
  }
  return out;
}

function formatSent(sent, count) {
  if (sent.length === 0) return [];
  const out = ['', `**✅ Sent anyway, confirmed in WATI (${sent.length})**`];
  for (const f of sent.slice(0, count)) {
    out.push(
      `• ${whoOf(f)} · ${oneLine(f.label, 60)} · logged "${oneLine(f.error, 50)}" at ${formatIST(f.at)}` +
        ` → sent ${formatIST(f.wati.sent.at, true)} IST (${f.wati.sent.status})`
    );
  }
  if (sent.length > count) {
    out.push(`…and ${sent.length - count} more sent anyway.`);
  }
  return out;
}

/**
 * Run one check over the WINDOW_HOURS ending at `now` and post the result.
 * @param {{ now?: Date, dryRun?: boolean }} options  dryRun returns the message without posting.
 */
export async function runWhatsAppFailureCheck({ now = new Date(), dryRun = false } = {}) {
  const until = now;
  const since = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000);

  const failures = await verifyFailuresWithWati(await collectWhatsAppFailures(since, until));
  const message = formatWhatsAppFailureReport(failures, since, until);
  const summary = {
    failures: failures.length,
    sentAnyway: failures.filter(f => f.wati?.sent).length,
    notSent: failures.filter(f => !f.wati?.sent).length,
    message
  };

  if (dryRun) {
    return { ...summary, posted: false };
  }

  const webhookUrl = process.env.DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('⚠️ [WhatsAppFailureAlert] DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL not set. Report not posted:', message.split('\n')[0]);
    return { ...summary, posted: false };
  }

  const result = await DiscordConnect(webhookUrl, message, false);
  console.log(`${result.ok ? '✅' : '❌'} [WhatsAppFailureAlert] ${summary.failures} failure(s) in last ${WINDOW_HOURS}h (${summary.sentAnyway} sent anyway, ${summary.notSent} not sent), report ${result.ok ? 'posted' : `not posted: ${result.error}`}`);
  return { ...summary, posted: result.ok };
}

export function startWhatsAppFailureAlertCron() {
  cron.schedule(CRON_EXPRESSION, async () => {
    try {
      await runWhatsAppFailureCheck();
    } catch (error) {
      console.error('❌ [WhatsAppFailureAlert] check failed:', error.message);
      const webhookUrl = process.env.DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL;
      if (webhookUrl) {
        await DiscordConnect(webhookUrl, `❌ **WhatsApp failure check crashed**: ${oneLine(error.message, 300)}`, false).catch(() => {});
      }
    }
  }, {
    scheduled: true,
    timezone: IST_TIMEZONE
  });

  console.log(`✅ WhatsApp failure alert cron started - 09:00 and 21:00 IST, last ${WINDOW_HOURS}h per run`);
}

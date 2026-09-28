import cron from 'node-cron';
import { DateTime } from 'luxon';
import { WorkflowLogModel } from '../Schema_Models/WorkflowLog.js';
import { ScheduledWhatsAppReminderModel } from '../Schema_Models/ScheduledWhatsAppReminder.js';
import { WhatsAppCampaignModel } from '../Schema_Models/WhatsAppCampaign.js';
import { DiscordConnect } from './DiscordConnect.js';

/**
 * Every 12 hours, report WhatsApp (WATI) send failures to Discord.
 *
 * Sources of failed sends:
 *   - WorkflowLog              step.channel 'whatsapp', status 'failed'   (workflow steps)
 *   - ScheduledWhatsAppReminder status 'failed'                          (meeting reminders)
 *   - WhatsAppCampaign          messageStatuses[].status 'failed'         (bulk campaigns)
 *
 * Webhook: DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL. When unset the job logs and skips.
 */

const IST_TIMEZONE = 'Asia/Kolkata';
export const WINDOW_HOURS = 12;
// 09:00 and 21:00 IST, 12 hours apart so consecutive windows neither overlap nor leave gaps.
const CRON_EXPRESSION = '0 9,21 * * *';
const MAX_RECENT_LINES = 8;
const MAX_TOP_ERRORS = 5;
const MAX_ERROR_CHARS = 120;
const DISCORD_MAX_CHARS = 1900; // Discord caps content at 2000; keep headroom

const RATE_LIMIT_PATTERN = /usage limit|rate limit|too many requests|\b429\b/i;

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

function formatIST(date) {
  return DateTime.fromJSDate(new Date(date)).setZone(IST_TIMEZONE).toFormat('dd LLL HH:mm');
}

/**
 * Load every WhatsApp failure recorded in [since, until).
 * @returns {Promise<Array<{source: string, at: Date, phone: string|null, name: string|null, label: string, error: string}>>}
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
      .select('clientName phoneNumber metadata.reminderType errorMessage updatedAt')
      .lean(),
    // messageStatuses have no failure timestamp, so a campaign counts when it was last
    // touched inside the window and still holds failed messages.
    WhatsAppCampaignModel.find({ updatedAt: window, 'messageStatuses.status': 'failed' })
      .select('campaignId templateName messageStatuses updatedAt')
      .lean()
  ]);

  const failures = [];

  for (const log of workflowLogs) {
    failures.push({
      source: 'workflow',
      at: log.executedAt || log.updatedAt,
      phone: log.clientPhone || null,
      name: log.clientName || null,
      label: `${log.workflowName || log.workflowId} · ${log.step?.templateName || log.step?.templateId || 'template?'}`,
      error: errorHeadline(log.error)
    });
  }

  for (const r of reminders) {
    failures.push({
      source: 'reminder',
      at: r.updatedAt,
      phone: r.phoneNumber || null,
      name: r.clientName || null,
      label: `meeting reminder (${r.metadata?.reminderType || '5min'})`,
      error: errorHeadline(r.errorMessage)
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
        error: errorHeadline(m.errorMessage)
      });
    }
  }

  failures.sort((a, b) => new Date(b.at) - new Date(a.at));
  return failures;
}

/**
 * Build the Discord message. Pure, so it can be unit tested without Mongo or Discord.
 * Stays under Discord's 2000-char limit by capping error lengths and trimming the recent list.
 */
export function formatWhatsAppFailureReport(failures, since, until) {
  const range = `${formatIST(since)} - ${formatIST(until)} IST`;

  if (failures.length === 0) {
    return `✅ **WhatsApp send check (last ${WINDOW_HOURS}h)**: no failed messages. (${range})`;
  }

  const bySource = { workflow: 0, reminder: 0, campaign: 0 };
  const byError = new Map();
  let rateLimited = 0;
  for (const f of failures) {
    bySource[f.source] = (bySource[f.source] || 0) + 1;
    byError.set(f.error, (byError.get(f.error) || 0) + 1);
    if (RATE_LIMIT_PATTERN.test(f.error)) rateLimited++;
  }

  const lines = [
    `⚠️ **WhatsApp send failures (last ${WINDOW_HOURS}h): ${failures.length}**`,
    `🕒 ${range}`,
    '',
    `• Workflow messages: ${bySource.workflow}`,
    `• Meeting reminders: ${bySource.reminder}`,
    `• Campaign messages: ${bySource.campaign}`
  ];

  if (rateLimited > 0) {
    lines.push('', `🚦 ${rateLimited} of ${failures.length} were WATI rate/usage-limit rejections ("API usage limit exceeded").`);
  }

  const topErrors = [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_ERRORS);
  lines.push('', '**Top errors**');
  for (const [error, count] of topErrors) {
    lines.push(`• ${count}× ${oneLine(error)}`);
  }

  // Drop recent lines until the whole message fits in one Discord post.
  for (let recentCount = Math.min(MAX_RECENT_LINES, failures.length); recentCount >= 0; recentCount--) {
    const message = [...lines, ...formatRecent(failures, recentCount)].join('\n');
    if (message.length <= DISCORD_MAX_CHARS || recentCount === 0) return message;
  }
}

function formatRecent(failures, count) {
  const out = [];
  if (count > 0) {
    out.push('', `**Most recent ${count}**`);
    for (const f of failures.slice(0, count)) {
      const who = [f.name, f.phone].filter(Boolean).join(' ') || 'unknown recipient';
      out.push(`• ${formatIST(f.at)} · ${oneLine(who, 40)} · ${oneLine(f.label, 60)} · ${oneLine(f.error, 80)}`);
    }
  }
  if (failures.length > count) {
    out.push(`…and ${failures.length - count} more. See the CRM workflow logs / WhatsApp reminders.`);
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

  const failures = await collectWhatsAppFailures(since, until);
  const message = formatWhatsAppFailureReport(failures, since, until);

  if (dryRun) {
    return { failures: failures.length, message, posted: false };
  }

  const webhookUrl = process.env.DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('⚠️ [WhatsAppFailureAlert] DISCORD_WHATSAPP_FAILURE_WEBHOOK_URL not set. Report not posted:', message.split('\n')[0]);
    return { failures: failures.length, message, posted: false };
  }

  const result = await DiscordConnect(webhookUrl, message, false);
  console.log(`${result.ok ? '✅' : '❌'} [WhatsAppFailureAlert] ${failures.length} failure(s) in last ${WINDOW_HOURS}h, report ${result.ok ? 'posted' : `not posted: ${result.error}`}`);
  return { failures: failures.length, message, posted: result.ok };
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

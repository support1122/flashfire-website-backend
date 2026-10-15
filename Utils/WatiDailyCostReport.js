import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { DiscordConnect } from './DiscordConnect.js';
import { countryOf } from './TwilioDailyCostReport.js';
import watiService from './WatiService.js';
import { AppSettingModel } from '../Schema_Models/AppSetting.js';
import { WatiSendLogModel } from '../Schema_Models/WatiSendLog.js';

dotenv.config();

// Posts yesterday's WATI template-message volume and an estimated Meta charge to Discord.
// WATI has no billing API, so counts are exact (every accepted send is logged in WatiSendLog)
// and dollars are count x rate card. Same channel as the Twilio report unless
// DISCORD_WATI_COST_WEBHOOK_URL overrides it.
const SETTING_KEY = 'watiDailyCostLastSent';

// Approximate Meta per-message rates in USD. Override with WATI_RATE_CARD_JSON, e.g.
// {"+44":{"UTILITY":0.022,"MARKETING":0.053},"default":{"UTILITY":0.03,"MARKETING":0.08}}
// Check these against the rate card in the WATI dashboard before trusting the dollar figure.
const DEFAULT_RATES = {
  '+1': { UTILITY: 0.0034, MARKETING: 0.025 },
  '+44': { UTILITY: 0.022, MARKETING: 0.053 },
  '+49': { UTILITY: 0.055, MARKETING: 0.136 },
  '+91': { UTILITY: 0.0014, MARKETING: 0.0107 },
  default: { UTILITY: 0.03, MARKETING: 0.08 },
};

function rateCard() {
  if (!process.env.WATI_RATE_CARD_JSON) return DEFAULT_RATES;
  try {
    return { ...DEFAULT_RATES, ...JSON.parse(process.env.WATI_RATE_CARD_JSON) };
  } catch (err) {
    console.warn('[WatiDailyCost] WATI_RATE_CARD_JSON is not valid JSON, using defaults:', err.message);
    return DEFAULT_RATES;
  }
}

function rateFor(card, number, category) {
  const to = `+${number}`;
  const prefix = Object.keys(card)
    .filter((k) => k !== 'default' && to.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  const row = card[prefix] || card.default;
  return row[category] ?? row.UTILITY;
}

const usd = (n) => `$${n.toFixed(2)}`;

/** Build the report for one UTC day (YYYY-MM-DD). Default is yesterday. Does not send. */
export async function buildWatiDailyCostReport(dayISO) {
  const day = dayISO
    ? DateTime.fromISO(dayISO, { zone: 'utc' }).startOf('day')
    : DateTime.utc().minus({ days: 1 }).startOf('day');
  const start = day.toJSDate();
  const end = day.plus({ days: 1 }).toJSDate();

  const rows = await WatiSendLogModel.find({ createdAt: { $gte: start, $lt: end } })
    .select('to templateName')
    .lean();

  // Template category decides the rate. If WATI is unreachable, fall back to UTILITY.
  const categoryByName = new Map();
  const tpl = await watiService.getTemplates();
  if (tpl.success) for (const t of tpl.templates) categoryByName.set(t.name, String(t.category || '').toUpperCase());
  else console.warn('[WatiDailyCost] template categories unavailable, pricing all as UTILITY:', tpl.error);

  const card = rateCard();
  const byCountry = {};
  const byTemplate = {};
  const byCategory = {};
  let total = 0;
  for (const r of rows) {
    const category = categoryByName.get(r.templateName) === 'MARKETING' ? 'MARKETING' : 'UTILITY';
    const cost = rateFor(card, r.to, category);
    total += cost;
    const country = countryOf(`+${r.to}`);
    const c = (byCountry[country] ||= { n: 0, cost: 0 });
    c.n += 1;
    c.cost += cost;
    const t = (byTemplate[r.templateName || 'unknown'] ||= { n: 0, cost: 0 });
    t.n += 1;
    t.cost += cost;
    byCategory[category] = (byCategory[category] || 0) + 1;
  }

  const countryLines = Object.entries(byCountry)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8)
    .map(([name, v]) => `• ${name}: ${v.n} msg${v.n === 1 ? '' : 's'}, ~${usd(v.cost)}`);
  const templateLines = Object.entries(byTemplate)
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 6)
    .map(([name, v]) => `• ${name}: ${v.n}`);
  const categoryLine = Object.entries(byCategory).map(([k, n]) => `${k.toLowerCase()} ${n}`).join(', ');

  const message = [
    `💬 **WATI daily cost, ${day.toFormat('ccc d LLL yyyy')} (UTC)**`,
    `💸 Estimated Meta charge: **~${usd(total)}** across ${rows.length} template message${rows.length === 1 ? '' : 's'}`,
    categoryLine ? `📊 Category: ${categoryLine}` : null,
    countryLines.length ? `🌍 By country:\n${countryLines.join('\n')}` : null,
    templateLines.length ? `🧾 Top templates:\n${templateLines.join('\n')}` : null,
    `ℹ️ Counts are exact. Dollars use an approximate rate card, so check the WATI dashboard for the billed figure.`,
  ].filter(Boolean).join('\n');

  return { message, totals: { day: day.toISODate(), messages: rows.length, estimated: total } };
}

/**
 * Build and post the report. Safe across several instances: a per-day claim in AppSetting means
 * only one of them posts. Pass { force: true } to skip the claim (manual runs).
 */
export async function sendWatiDailyCostReport({ dayISO, force = false } = {}) {
  const url = process.env.DISCORD_WATI_COST_WEBHOOK_URL
    || process.env.DISCORD_TWILIO_COST_WEBHOOK_URL
    || process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  if (!url) return { ok: false, error: 'no_webhook' };

  const { message, totals } = await buildWatiDailyCostReport(dayISO);

  if (!force) {
    try {
      await AppSettingModel.findOneAndUpdate(
        { key: SETTING_KEY, 'value.day': { $ne: totals.day } },
        { $set: { value: { day: totals.day }, updatedAt: new Date(), updatedBy: 'system' } },
        { upsert: true, new: false },
      );
    } catch (err) {
      if (err?.code === 11000) return { ok: true, skipped: 'already_sent', day: totals.day };
      throw err;
    }
  }

  const res = await DiscordConnect(url, message, false);
  if (!res.ok && !force) {
    await AppSettingModel.updateOne({ key: SETTING_KEY }, { $set: { 'value.day': null } }).catch(() => {});
  }
  return { ...res, totals };
}

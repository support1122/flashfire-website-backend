import Twilio from 'twilio';
import dotenv from 'dotenv';
import { DateTime } from 'luxon';
import { DiscordConnect } from './DiscordConnect.js';
import { AppSettingModel } from '../Schema_Models/AppSetting.js';

dotenv.config();

// Posts yesterday's Twilio voice spend to Discord: total, per-country split, balance and runway.
// Goes to the twilio-automated-call channel unless DISCORD_TWILIO_COST_WEBHOOK_URL overrides it.
const SETTING_KEY = 'twilioDailyCostLastSent';
const LOW_BALANCE_USD = Number(process.env.TWILIO_LOW_BALANCE_USD) || 10;

// Longest prefix wins. Covers the countries we dial; anything else shows as "Other (+code)".
const COUNTRY_PREFIXES = [
  ['+1', 'US/CA'], ['+31', 'Netherlands'], ['+33', 'France'], ['+34', 'Spain'], ['+39', 'Italy'],
  ['+44', 'UK'], ['+46', 'Sweden'], ['+49', 'Germany'], ['+52', 'Mexico'], ['+61', 'Australia'],
  ['+64', 'New Zealand'], ['+65', 'Singapore'], ['+91', 'India'], ['+92', 'Pakistan'],
  ['+201', 'Egypt'], ['+234', 'Nigeria'], ['+254', 'Kenya'], ['+353', 'Ireland'],
  ['+639', 'Philippines'], ['+971', 'UAE'],
];

function countryOf(number) {
  const to = String(number || '');
  let best = null;
  for (const [prefix, name] of COUNTRY_PREFIXES) {
    if (to.startsWith(prefix) && (!best || prefix.length > best[0].length)) best = [prefix, name];
  }
  return best ? best[1] : `Other (${to.slice(0, 4) || 'unknown'})`;
}

function getClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error('Twilio credentials missing');
  return Twilio(sid, token);
}

const usd = (n) => `$${n.toFixed(2)}`;

/**
 * Build the report for one UTC day (YYYY-MM-DD). Default is yesterday.
 * Returns { message, totals } without sending, so it can be tested.
 */
export async function buildTwilioDailyCostReport(dayISO) {
  const client = getClient();
  const day = dayISO
    ? DateTime.fromISO(dayISO, { zone: 'utc' }).startOf('day')
    : DateTime.utc().minus({ days: 1 }).startOf('day');
  const start = day.toJSDate();
  const end = day.plus({ days: 1 }).toJSDate();

  const calls = await client.calls.list({
    startTimeAfter: start,
    startTimeBefore: end,
    limit: 5000,
    pageSize: 1000,
  });

  const byCountry = {};
  const byStatus = {};
  let total = 0;
  for (const c of calls) {
    const cost = Math.abs(parseFloat(c.price || 0));
    total += cost;
    const country = countryOf(c.to);
    const row = (byCountry[country] ||= { calls: 0, cost: 0 });
    row.calls += 1;
    row.cost += cost;
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
  }

  // Twilio's own daily usage record is the billing figure; use it for the headline when present.
  let billed = total;
  try {
    const usage = await client.usage.records.daily.list({
      category: 'calls-outbound',
      startDate: start,
      endDate: start,
      limit: 1,
    });
    if (usage[0] && Number.isFinite(parseFloat(usage[0].price))) billed = parseFloat(usage[0].price);
  } catch (err) {
    console.warn('[TwilioDailyCost] usage record lookup failed, using call-list sum:', err.message);
  }

  let balance = null;
  try {
    balance = parseFloat((await client.balance.fetch()).balance);
  } catch (err) {
    console.warn('[TwilioDailyCost] balance lookup failed:', err.message);
  }

  // Runway from the last 7 days of billed spend (excludes today, which is partial).
  let avg7 = null;
  try {
    const recent = await client.usage.records.daily.list({
      category: 'calls-outbound',
      startDate: day.minus({ days: 6 }).toJSDate(),
      endDate: start,
      limit: 7,
    });
    const sum = recent.reduce((s, r) => s + (parseFloat(r.price) || 0), 0);
    avg7 = recent.length ? sum / 7 : null;
  } catch (err) {
    console.warn('[TwilioDailyCost] 7-day usage lookup failed:', err.message);
  }

  const lines = Object.entries(byCountry)
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8)
    .map(([name, r]) => `• ${name}: ${r.calls} call${r.calls === 1 ? '' : 's'}, ${usd(r.cost)}`);

  const statusLine = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s} ${n}`)
    .join(', ');

  const msg = [
    `📞 **Twilio daily cost, ${day.toFormat('ccc d LLL yyyy')} (UTC)**`,
    `💸 Spend: **${usd(billed)}** across ${calls.length} call${calls.length === 1 ? '' : 's'}`,
    statusLine ? `📊 Status: ${statusLine}` : null,
    lines.length ? `🌍 By country:\n${lines.join('\n')}` : null,
    balance !== null ? `🏦 Balance: **${usd(balance)}**` : null,
    balance !== null && avg7 > 0
      ? `⏳ 7-day avg ${usd(avg7)}/day, about ${(balance / avg7).toFixed(1)} days of runway`
      : null,
    balance !== null && balance < LOW_BALANCE_USD
      ? `🚨 Balance is under ${usd(LOW_BALANCE_USD)}. Top up Twilio or reminder calls will start failing.`
      : null,
  ].filter(Boolean).join('\n');

  return { message: msg, totals: { day: day.toISODate(), calls: calls.length, billed, balance, avg7 } };
}

/**
 * Build and post the report. Safe to call from several instances: a per-day claim in AppSetting
 * makes sure only one of them posts. Pass { force: true } to skip the claim (manual runs).
 */
export async function sendTwilioDailyCostReport({ dayISO, force = false } = {}) {
  const url = process.env.DISCORD_TWILIO_COST_WEBHOOK_URL || process.env.DISCORD_REMINDER_CALL_WEBHOOK_URL;
  if (!url) return { ok: false, error: 'no_webhook' };

  const { message, totals } = await buildTwilioDailyCostReport(dayISO);

  if (!force) {
    // $ne keeps this atomic: the upsert collides on the unique key for the loser, which throws E11000.
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
    // Release the claim so the next run can retry.
    await AppSettingModel.updateOne({ key: SETTING_KEY }, { $set: { 'value.day': null } }).catch(() => {});
  }
  return { ...res, totals };
}

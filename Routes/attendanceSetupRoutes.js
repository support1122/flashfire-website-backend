import mongoose from 'mongoose';
import { AttendanceSetupRunModel } from '../Schema_Models/AttendanceSetupRun.js';
import { SEED_PROFILES, applySeed, planSeed } from '../Utils/BdaSeed.js';
import { getAllBdaProfiles } from '../Utils/BdaRegistry.js';
import { SYNC_LIMITS_MS, getAllSyncHealth } from '../Utils/SyncHealth.js';
import { describeMeetCredentials } from '../Utils/MeetAttendanceScheduler.js';
import { getDeductionsMode, getLiveFrom } from '../Utils/deductionPolicy.js';
import { actorOf, requireAdminLive, requireCrmUserOrAdmin } from './deductionRoutes.js';

// One-call setup for the BDA attendance system. These replace running scripts by hand on a server.
//
//   GET  /api/crm/admin/attendance/setup/status           is everything configured? (read-only, never returns a secret)
//   POST /api/crm/admin/attendance/setup/seed-profiles    create the tracked BDAs in the registry
//   GET  /api/crm/admin/attendance/setup/call-link-audit  how many no-shows were called but not linked (read-only)
//   POST /api/crm/admin/attendance/setup/relink-calls     re-link call logs to bookings
//   POST /api/crm/admin/attendance/setup/run              all of the above in order, then the status
//
// Safety, because these can write to the live database:
//   - Admin only (a crm_admin token, or a user the database says is an admin).
//   - DRY RUN by default. Nothing is written unless the body says `"apply": true`.
//   - A write also needs `"confirmDatabase": "<name>"` equal to the database this server is connected to. A dry run
//     returns that name, so a call aimed at the wrong environment is refused instead of executed.
//   - Every write is idempotent (safe to repeat) and is recorded in AttendanceSetupRun with who ran it.

const fail = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, error: { code, message }, ...extra });

const dbName = () => mongoose.connection?.name || null;
const SEED_SHORTCUT_MIN_GAP_MS = 5000;
// TEMPORARY route (bsc, 2026-10-09: "we will remove it in the next few days"). It switches itself off on this date
// even if nobody remembers to delete it. Override with SEED_ROUTE_UNTIL=YYYY-MM-DD; delete the route when done.
const SEED_SHORTCUT_DEFAULT_UNTIL = '2026-10-23';
function seedShortcutExpired(now = Date.now()) {
  const raw = String(process.env.SEED_ROUTE_UNTIL || SEED_SHORTCUT_DEFAULT_UNTIL).trim();
  const until = Date.parse(`${raw}T23:59:59+05:30`);
  return !Number.isFinite(until) || now > until;
}
let lastSeedShortcutAt = 0;
/** Tests only: lets two calls in a row run without waiting out the rate limit. */
export function resetSeedShortcutLimiter() {
  lastSeedShortcutAt = 0;
}
const adminOnly = [requireCrmUserOrAdmin, requireAdminLive];

/** Returns an error response (already sent) when a write was asked for without the matching database name. */
function refuseUnconfirmedWrite(req, res) {
  const db = dbName();
  if (req.body?.confirmDatabase === db) return false;
  fail(
    res,
    409,
    'confirmation_required',
    `This would write to the database "${db}". Send "confirmDatabase": "${db}" together with "apply": true to confirm.`,
    { database: db }
  );
  return true;
}

async function recordRun(req, action, summary) {
  const who = actorOf(req);
  await AttendanceSetupRunModel.create({ action, database: dbName(), byEmail: who.email, byName: who.name, summary });
}

/**
 * The checklist. Only booleans, counts and names: never a webhook URL, key or token.
 * `ready` is true when nothing in `problems` is left.
 */
export async function buildSetupStatus() {
  const profiles = await getAllBdaProfiles();
  const tracked = profiles.filter((p) => p.tracked && p.active);
  const credentials = describeMeetCredentials();
  const webhooks = {
    attendance: Boolean(process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL),
    duration: Boolean(process.env.DISCORD_BDA_DURATION_WEBHOOK_URL),
    absent: Boolean(process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL),
    admin: Boolean(process.env.DISCORD_BDA_ADMIN_WEBHOOK_URL),
    deductions: Boolean(process.env.DISCORD_BDA_DEDUCTIONS_WEBHOOK_URL),
  };
  // A source is healthy when it last succeeded within its limit (plan 2.7). One that never ran is not healthy yet.
  const nowMs = Date.now();
  const sources = (await getAllSyncHealth()).map((row) => {
    const limitMs = SYNC_LIMITS_MS[row.source] ?? null;
    const ageMs = row.lastOkAt ? nowMs - new Date(row.lastOkAt).getTime() : null;
    return { ...row, limitMs, ageMs, healthy: ageMs != null && limitMs != null ? ageMs <= limitMs : false };
  });
  const googleSync = sources.find((s) => s.source === 'google_meet');
  const lastRuns = await AttendanceSetupRunModel.find({}).sort({ at: -1 }).limit(5).lean();

  const problems = [];
  if (tracked.length === 0) {
    problems.push('No tracked BDAs in the registry, so nobody is judged and no absent alert fires. Call POST /setup/seed-profiles.');
  }
  if (credentials === 'MISSING') {
    problems.push('Google credentials are missing (set GOOGLE_SERVICE_ACCOUNT_KEY_JSON). Attendance is not verified against Google Meet.');
  }
  if (String(process.env.MEET_API_ATTENDANCE_ENABLED || '').trim().toLowerCase() === 'false') {
    problems.push('MEET_API_ATTENDANCE_ENABLED is false, so Google verification is switched off.');
  }
  if (!webhooks.attendance) problems.push('DISCORD_BDA_ATTENDANCE_WEBHOOK_URL is not set: join alerts will not post.');
  if (!webhooks.absent) problems.push('DISCORD_BDA_ABSENT_WEBHOOK_URL is not set: absent alerts will not post.');
  if (!webhooks.duration && !webhooks.attendance) {
    problems.push('Neither DISCORD_BDA_DURATION_WEBHOOK_URL nor the attendance webhook is set: leave and recap alerts will not post.');
  }
  if (credentials !== 'MISSING' && googleSync && !googleSync.healthy) {
    problems.push(
      googleSync.lastOkAt
        ? `The Google Meet sync last succeeded ${Math.round(googleSync.ageMs / 60000)} min ago (limit ${Math.round(googleSync.limitMs / 60000)} min)${googleSync.lastError ? `: ${String(googleSync.lastError).slice(0, 120)}` : ''}.`
        : 'The Google Meet sync has not completed since this server started. Give it a minute, then check again.'
    );
  }

  return {
    database: dbName(),
    ready: problems.length === 0,
    problems,
    registry: {
      profiles: profiles.length,
      tracked: tracked.length,
      trackedEmails: tracked.map((p) => p.email),
    },
    googleMeet: { credentials, syncOk: googleSync ? googleSync.healthy : null },
    discordWebhooksConfigured: webhooks,
    deductions: { mode: getDeductionsMode(), liveFrom: getLiveFrom() ? new Date(getLiveFrom()).toISOString() : null },
    minExtensionVersion: String(process.env.MIN_EXTENSION_VERSION || '').trim() || null,
    syncHealth: sources,
    lastSetupRuns: lastRuns.map((r) => ({ action: r.action, database: r.database, by: r.byEmail || r.byName, at: r.at })),
  };
}

async function runSeed({ apply }) {
  if (!apply) return { mode: 'dry-run', plan: await planSeed() };
  return { mode: 'applied', results: await applySeed() };
}

async function runRelink({ apply, fixBookingKeys }) {
  const { runBackfill } = await import('../scripts/backfill-call-links.js');
  return runBackfill({ apply: apply === true, fixBookingKeys: Boolean(fixBookingKeys) });
}

async function runCallAudit(days) {
  const { runAudit } = await import('../scripts/audit-call-linking.js');
  return runAudit({ days });
}

function parseDays(raw) {
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 90 ? n : null;
}

/**
 * The one-click version: GET /script/seed/bda (and /script/seed/dba, the same thing) with no token and no body.
 * Open it in a browser or curl it and it makes the BDA registry ready so the absent alerts start working.
 *
 * Why a public write is acceptable here, and where the limits are:
 *   - It takes NO input, so there is nothing to inject or tamper with.
 *   - It only ensures two fixed, intended profiles exist (Utils/BdaSeed.js). It is idempotent: once they exist it
 *     changes nothing, and it never overwrites what an admin edited.
 *   - It does not return emails, counts of customers, config or secrets, only a name and what happened.
 *   - Calls are limited to one per 5 seconds.
 *   - Set DISABLE_SEED_ROUTE=true on the server to turn it off completely (it then answers 404).
 *   - It is temporary: it also answers 404 after SEED_ROUTE_UNTIL (default 2026-10-23).
 * The heavier jobs (call linking) stay behind the admin routes below.
 */
function registerSeedShortcut(app) {
  const handler = async (req, res) => {
    if (String(process.env.DISABLE_SEED_ROUTE || '').trim().toLowerCase() === 'true' || seedShortcutExpired()) {
      return res.status(404).json({ success: false, error: { code: 'not_found', message: 'Not found' } });
    }
    const now = Date.now();
    if (now - lastSeedShortcutAt < SEED_SHORTCUT_MIN_GAP_MS) {
      return fail(res, 429, 'rate_limited', 'Try again in a few seconds');
    }
    lastSeedShortcutAt = now;
    try {
      const results = await applySeed();
      const changed = results.filter((r) => r.action !== 'unchanged');
      if (changed.length > 0) {
        await AttendanceSetupRunModel.create({
          action: 'seed-profiles',
          database: dbName(),
          byEmail: null,
          byName: 'public seed route',
          summary: results,
        });
      }
      const tracked = (await getAllBdaProfiles()).filter((p) => p.tracked && p.active).length;
      return res.status(200).json({
        success: true,
        message: changed.length
          ? 'BDA registry is ready. Absent alerts are now active.'
          : 'Already set up. Nothing needed changing.',
        profiles: results.map((r) => ({ name: SEED_PROFILES.find((p) => p.email === r.email)?.displayName, action: r.action })),
        trackedBdas: tracked,
      });
    } catch (err) {
      console.error('[attendanceSetup] seed shortcut failed:', err?.message || err);
      return fail(res, 500, 'seed_failed', 'Seeding the BDA profiles failed');
    }
  };
  app.get('/script/seed/bda', handler);
  app.get('/script/seed/dba', handler);
}

export function registerAttendanceSetupRoutes(app) {
  registerSeedShortcut(app);
  const BASE = '/api/crm/admin/attendance/setup';

  app.get(`${BASE}/status`, ...adminOnly, async (req, res) => {
    try {
      return res.status(200).json({ success: true, ...(await buildSetupStatus()) });
    } catch (err) {
      console.error('[attendanceSetup] status failed:', err?.message || err);
      return fail(res, 500, 'status_failed', 'Could not build the setup status');
    }
  });

  app.post(`${BASE}/seed-profiles`, ...adminOnly, async (req, res) => {
    try {
      const apply = req.body?.apply === true;
      if (apply && refuseUnconfirmedWrite(req, res)) return undefined;
      const result = await runSeed({ apply });
      if (apply) await recordRun(req, 'seed-profiles', result.results);
      return res.status(200).json({ success: true, database: dbName(), ...result });
    } catch (err) {
      console.error('[attendanceSetup] seed failed:', err?.message || err);
      return fail(res, 500, 'seed_failed', 'Seeding the BDA profiles failed');
    }
  });

  app.get(`${BASE}/call-link-audit`, ...adminOnly, async (req, res) => {
    const days = parseDays(req.query?.days);
    if (days === null) return fail(res, 422, 'invalid_days', 'days must be a whole number from 1 to 90');
    try {
      return res.status(200).json({ success: true, database: dbName(), audit: await runCallAudit(days) });
    } catch (err) {
      console.error('[attendanceSetup] audit failed:', err?.message || err);
      return fail(res, 500, 'audit_failed', 'The call linking audit failed');
    }
  });

  app.post(`${BASE}/relink-calls`, ...adminOnly, async (req, res) => {
    try {
      const apply = req.body?.apply === true;
      if (apply && refuseUnconfirmedWrite(req, res)) return undefined;
      const stats = await runRelink({ apply, fixBookingKeys: req.body?.fixBookingKeys === true });
      if (apply) await recordRun(req, 'relink-calls', stats);
      return res.status(200).json({ success: true, database: dbName(), mode: apply ? 'applied' : 'dry-run', stats });
    } catch (err) {
      console.error('[attendanceSetup] relink failed:', err?.message || err);
      return fail(res, 500, 'relink_failed', 'Re-linking the call logs failed');
    }
  });

  // Everything in order. Each step reports its own result, so one failing step does not hide the others.
  app.post(`${BASE}/run`, ...adminOnly, async (req, res) => {
    const apply = req.body?.apply === true;
    if (apply && refuseUnconfirmedWrite(req, res)) return undefined;

    const steps = {};
    const attempt = async (name, fn) => {
      try {
        steps[name] = { ok: true, ...(await fn()) };
      } catch (err) {
        console.error(`[attendanceSetup] run step ${name} failed:`, err?.message || err);
        steps[name] = { ok: false, error: String(err?.message || err).slice(0, 200) };
      }
    };

    await attempt('seedProfiles', () => runSeed({ apply }));
    await attempt('callLinkAudit', async () => ({ audit: await runCallAudit(30) }));
    await attempt('relinkCalls', async () => ({
      mode: apply ? 'applied' : 'dry-run',
      stats: await runRelink({ apply, fixBookingKeys: true }),
    }));
    if (apply) await recordRun(req, 'run', { seed: steps.seedProfiles, relink: steps.relinkCalls });

    let status = null;
    try {
      status = await buildSetupStatus();
    } catch (err) {
      console.error('[attendanceSetup] run status failed:', err?.message || err);
    }
    const allOk = Object.values(steps).every((s) => s.ok);
    return res.status(allOk ? 200 : 207).json({
      success: allOk,
      database: dbName(),
      mode: apply ? 'applied' : 'dry-run',
      steps,
      status,
    });
  });
}

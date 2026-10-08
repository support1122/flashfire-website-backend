import { DiscordConnect } from './DiscordConnect.js';

// Discord posters for the attendance engine. Each returns true when the post went out and false otherwise
// (no webhook configured, or Discord refused). Callers inject their own poster in tests, so nothing here ever
// runs against the network under test.

const firstEnv = (...names) => names.map((n) => process.env[n]).find((v) => v && String(v).trim()) || null;

async function post(url, message) {
  if (!url) return false;
  try {
    const res = await DiscordConnect(url, message, false);
    return Boolean(res?.ok);
  } catch (err) {
    console.error('[attendanceDiscord] post failed:', err?.message || err);
    return false;
  }
}

/** Absent verdicts and corrections. */
export const postAbsentChannel = (message) => post(firstEnv('DISCORD_BDA_ABSENT_WEBHOOK_URL'), message);

/** "Your extension is offline" warnings, which mention the BDA. */
export const postAttendanceChannel = (message) =>
  post(firstEnv('DISCORD_BDA_ATTENDANCE_WEBHOOK_URL', 'DISCORD_BDA_ABSENT_WEBHOOK_URL'), message);

/** Admin-only alerts: sync health, meetings that need a new BDA. */
export const postAdminChannel = (message) =>
  post(firstEnv('DISCORD_BDA_ADMIN_WEBHOOK_URL', 'DISCORD_BDA_ABSENT_WEBHOOK_URL'), message);

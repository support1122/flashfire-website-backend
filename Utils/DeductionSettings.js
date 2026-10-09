import { AppSettingModel } from '../Schema_Models/AppSetting.js';
import { DEDUCTION_MODES, deductionsModeSource, getDeductionsMode, getLiveFrom, setDbDeductionSettings } from './deductionPolicy.js';

// The CRM's fines switch, stored in the database (AppSetting 'deductions') so it needs no env var.
const KEY = 'deductions';
let timer = null;

/** Load the stored setting into deductionPolicy's cache. Never throws (a read failure keeps the last value). */
export async function refreshDeductionSettings() {
  try {
    const doc = await AppSettingModel.findOne({ key: KEY }).lean();
    setDbDeductionSettings({ mode: doc?.value?.mode ?? null, liveFrom: doc?.value?.liveFrom ?? null });
  } catch (err) {
    console.warn('[DeductionSettings] refresh failed, keeping the last value:', err?.message);
  }
}

/** What is in force right now, and where it comes from. */
export function currentDeductionSettings() {
  const liveFrom = getLiveFrom();
  return { mode: getDeductionsMode(), liveFrom: liveFrom ? liveFrom.toISOString() : null, source: deductionsModeSource() };
}

/**
 * Save a new mode. Switching to shadow or live starts the clock NOW unless an explicit start in the future is given:
 * meetings before liveFrom are never fined, so a past start would fine meetings retroactively and is refused.
 * Returns { ok, settings } or { ok: false, status, code, message }.
 */
export async function saveDeductionSettings({ mode, liveFrom, by, now = new Date() }) {
  if (deductionsModeSource() === 'env') {
    return { ok: false, status: 409, code: 'env_override', message: 'DEDUCTIONS_MODE is set on the server, so the CRM switch is read-only' };
  }
  if (!DEDUCTION_MODES.includes(mode)) return { ok: false, status: 422, code: 'invalid_mode', message: 'mode must be off, shadow or live' };
  let start = null;
  if (mode !== 'off') {
    start = liveFrom ? new Date(liveFrom) : now;
    if (!Number.isFinite(start.getTime())) return { ok: false, status: 422, code: 'invalid_live_from', message: 'liveFrom must be a date' };
    if (start.getTime() < now.getTime() - 5 * 60 * 1000) {
      return { ok: false, status: 422, code: 'live_from_in_past', message: 'Fines cannot start in the past (that would fine earlier meetings)' };
    }
  }
  await AppSettingModel.updateOne(
    { key: KEY },
    { $set: { value: { mode, liveFrom: start }, updatedBy: by || null, updatedAt: now } },
    { upsert: true }
  );
  await refreshDeductionSettings();
  return { ok: true, settings: currentDeductionSettings() };
}

/** Keep every backend instance in step with the CRM switch (30 s). */
export function startDeductionSettingsRefresher() {
  if (timer) return;
  refreshDeductionSettings();
  timer = setInterval(refreshDeductionSettings, 30 * 1000);
  timer.unref?.();
}

export function stopDeductionSettingsRefresher() {
  if (timer) clearInterval(timer);
  timer = null;
}

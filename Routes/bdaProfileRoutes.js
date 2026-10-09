import { DateTime } from 'luxon';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { foldName } from '../Utils/BdaIdentity.js';
import { getRecentUnknownNames, invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { postAdminChannel } from '../Utils/attendanceDiscord.js';
// Accepts the CRM user token AND the crm_admin token that /admin/analysis (where this screen lives) sends.
import { requireAdminLive, requireCrmUserOrAdmin } from './deductionRoutes.js';

// Admin screen backend for the BDA registry (plan 2.8). Errors use the shared contract shape:
// { success: false, error: { code, message } }.

const EDITABLE_FIELDS = ['aliases', 'discordUserId', 'leaveDays', 'tracked', 'active'];
// Atomic list edits ($addToSet / $pull). Sending a whole list from a cached screen let two admins overwrite each
// other: the second save dropped the first admin's leave day, and a meeting on that day was fined.
const LIST_OPS = ['addAliases', 'removeAliases', 'addLeaveDays', 'removeLeaveDays'];
const ACCEPTED_FIELDS = [...EDITABLE_FIELDS, ...LIST_OPS];
const MAX_ALIASES = 20;
const MAX_ALIAS_LENGTH = 80;
const MAX_LEAVE_DAYS = 400;
const DISCORD_ID_RE = /^\d{15,25}$/;
const LEAVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

function isRealDate(day) {
  return LEAVE_DAY_RE.test(day) && DateTime.fromISO(day, { zone: 'Asia/Kolkata' }).isValid;
}

/** Validate the PUT body. Returns { update } or { error: { code, message } }. */
function validateUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: { code: 'invalid_body', message: 'Send a JSON object' } };
  }
  const unknown = Object.keys(body).filter((k) => !ACCEPTED_FIELDS.includes(k));
  if (unknown.length > 0) {
    return { status: 422, error: { code: 'unknown_field', message: `Cannot edit: ${unknown.join(', ')}` } };
  }
  if (Object.keys(body).length === 0) {
    return { status: 422, error: { code: 'empty_update', message: `Send at least one of: ${ACCEPTED_FIELDS.join(', ')}` } };
  }
  // MongoDB cannot set, add to and pull from the same list in one update.
  for (const [field, add, remove] of [['aliases', 'addAliases', 'removeAliases'], ['leaveDays', 'addLeaveDays', 'removeLeaveDays']]) {
    const used = [field, add, remove].filter((k) => k in body);
    if (used.length > 1) {
      return { status: 422, error: { code: 'conflicting_list_edit', message: `Send only one of ${used.join(', ')} per request` } };
    }
  }

  const update = {};
  const addToSet = {};
  const pull = {};

  const cleanAliases = (raw, code) => {
    if (!Array.isArray(raw) || raw.length > MAX_ALIASES || raw.some((a) => typeof a !== 'string')) {
      return { error: { code, message: `${code.replace('invalid_', '')} must be an array of at most ${MAX_ALIASES} strings` } };
    }
    const out = [];
    for (const a of raw.map((x) => x.trim())) {
      if (!foldName(a) || a.length > MAX_ALIAS_LENGTH) {
        return { error: { code, message: `Each alias needs letters and at most ${MAX_ALIAS_LENGTH} characters` } };
      }
      if (!out.includes(a)) out.push(a);
    }
    return { list: out };
  };
  const cleanDays = (raw, code) => {
    if (!Array.isArray(raw) || raw.length > MAX_LEAVE_DAYS || !raw.every((d) => typeof d === 'string' && isRealDate(d))) {
      return { error: { code, message: 'Send an array of real YYYY-MM-DD dates' } };
    }
    return { list: [...new Set(raw)].sort() };
  };
  for (const [key, field, clean, target] of [
    ['addAliases', 'aliases', cleanAliases, addToSet],
    ['removeAliases', 'aliases', cleanAliases, pull],
    ['addLeaveDays', 'leaveDays', cleanDays, addToSet],
    ['removeLeaveDays', 'leaveDays', cleanDays, pull],
  ]) {
    if (!(key in body)) continue;
    const r = clean(body[key], `invalid_${key}`);
    if (r.error) return { status: 422, error: r.error };
    // $pullAll takes a plain list; {$pull: {$in}} trips the leaveDays update validator ("days.every is not a function").
    if (r.list.length) target[field] = target === addToSet ? { $each: r.list } : r.list;
  }

  if ('aliases' in body) {
    const raw = body.aliases;
    if (!Array.isArray(raw) || raw.length > MAX_ALIASES || raw.some((a) => typeof a !== 'string')) {
      return { status: 422, error: { code: 'invalid_aliases', message: `aliases must be an array of at most ${MAX_ALIASES} strings` } };
    }
    const seen = new Set();
    const aliases = [];
    for (const a of raw.map((x) => x.trim())) {
      const key = foldName(a);
      if (!key || a.length > MAX_ALIAS_LENGTH) {
        return { status: 422, error: { code: 'invalid_aliases', message: `Each alias needs letters and at most ${MAX_ALIAS_LENGTH} characters` } };
      }
      if (!seen.has(key)) {
        seen.add(key);
        aliases.push(a);
      }
    }
    update.aliases = aliases;
  }

  if ('discordUserId' in body) {
    const v = body.discordUserId;
    if (v === null || v === '') update.discordUserId = null;
    else if (typeof v === 'string' && DISCORD_ID_RE.test(v.trim())) update.discordUserId = v.trim();
    else return { status: 422, error: { code: 'invalid_discord_user_id', message: 'discordUserId must be 15 to 25 digits, or null to clear it' } };
  }

  if ('leaveDays' in body) {
    const days = body.leaveDays;
    if (!Array.isArray(days) || days.length > MAX_LEAVE_DAYS || !days.every((d) => typeof d === 'string' && isRealDate(d))) {
      return { status: 422, error: { code: 'invalid_leave_days', message: 'leaveDays must be an array of real YYYY-MM-DD dates' } };
    }
    update.leaveDays = [...new Set(days)].sort();
  }

  for (const flag of ['tracked', 'active']) {
    if (flag in body) {
      if (typeof body[flag] !== 'boolean') {
        return { status: 422, error: { code: `invalid_${flag}`, message: `${flag} must be true or false` } };
      }
      update[flag] = body[flag];
    }
  }

  return { update, addToSet, pull };
}

/** An alias that equals another person's name or alias would make both unmatchable, so refuse it up front. */
async function findAliasConflict(email, aliases) {
  if (!aliases?.length) return null;
  const others = await BdaProfileModel.find({ email: { $ne: email } })
    .select('email displayName firstName lastName aliases')
    .lean();
  for (const alias of aliases) {
    const key = foldName(alias);
    for (const o of others) {
      const taken = [o.displayName, o.firstName, `${o.firstName} ${o.lastName}`, `${o.lastName} ${o.firstName}`, ...(o.aliases || [])]
        .map(foldName)
        .filter(Boolean);
      if (taken.includes(key)) return { alias, owner: o.email };
    }
  }
  return null;
}

export function registerBdaProfileRoutes(app) {
  app.get('/api/crm/admin/bda-profiles', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const [profiles, unknownNames] = await Promise.all([
        BdaProfileModel.find({}).select('-__v').sort({ displayName: 1 }).lean(),
        getRecentUnknownNames(20),
      ]);
      return res.status(200).json({ success: true, profiles, unknownNames });
    } catch (err) {
      console.error('[bdaProfileRoutes] list failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not load BDA profiles');
    }
  });

  app.put('/api/crm/admin/bda-profiles/:email', requireCrmUserOrAdmin, requireAdminLive, async (req, res) => {
    try {
      const email = String(req.params.email ?? '').trim().toLowerCase();
      const checked = validateUpdate(req.body);
      if (checked.error) return fail(res, checked.status, checked.error.code, checked.error.message);

      if (!(await BdaProfileModel.exists({ email }))) {
        return fail(res, 404, 'profile_not_found', `No BDA profile for ${email}`);
      }
      const conflict = await findAliasConflict(email, checked.update.aliases ?? checked.addToSet.aliases?.$each);
      if (conflict) {
        return fail(res, 409, 'alias_conflict', `"${conflict.alias}" already belongs to ${conflict.owner}`);
      }

      // Switching tracking on starts the go-live clock: meetings before this moment are never judged.
      const before = await BdaProfileModel.findOne({ email }).select('tracked active').lean();
      const update = { ...checked.update };
      const nextTracked = update.tracked ?? before?.tracked;
      const nextActive = update.active ?? before?.active;
      if (nextTracked === true && nextActive !== false && !(before?.tracked === true && before?.active !== false)) {
        update.trackedSince = new Date();
      }

      const ops = {};
      if (Object.keys(update).length) ops.$set = update;
      if (Object.keys(checked.addToSet).length) ops.$addToSet = checked.addToSet;
      if (Object.keys(checked.pull).length) ops.$pullAll = checked.pull;
      const profile = await BdaProfileModel.findOneAndUpdate(
        { email },
        ops,
        { new: true, runValidators: true }
      )
        .select('-__v')
        .lean();
      if (!profile) return fail(res, 404, 'profile_not_found', `No BDA profile for ${email}`);

      invalidateRegistryCache();
      // Tell the admin channel when judging starts or stops for someone: the counterpart of the startup
      // "Attendance alerts are OFF" warning, so nobody has to guess whether alerts are live.
      const nowOn = profile.tracked === true && profile.active !== false;
      const wasOn = before?.tracked === true && before?.active !== false;
      if (nowOn !== wasOn) {
        const name = profile.displayName || profile.email;
        postAdminChannel(
          nowOn
            ? `✅ **Attendance tracking ON for ${name}** from now. Meetings that start from this moment are judged (Mark Present window and absent alerts; fines follow DEDUCTIONS_MODE). Earlier meetings are not.`
            : `⏸️ **Attendance tracking OFF for ${name}.** Their meetings are no longer judged and no absent alerts fire.`
        ).catch((err) => console.warn('[bdaProfileRoutes] tracking notice failed:', err?.message));
      }
      return res.status(200).json({ success: true, profile });
    } catch (err) {
      console.error('[bdaProfileRoutes] update failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not update the BDA profile');
    }
  });
}

import { DateTime } from 'luxon';
import { requireCrmUser } from '../Middlewares/CrmAuth.js';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { foldName } from '../Utils/BdaIdentity.js';
import { getRecentUnknownNames, invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import { isCrmAdmin } from '../Utils/isCrmAdmin.js';

// Admin screen backend for the BDA registry (plan 2.8). Errors use the shared contract shape:
// { success: false, error: { code, message } }.

const EDITABLE_FIELDS = ['aliases', 'discordUserId', 'leaveDays', 'tracked', 'active'];
const MAX_ALIASES = 20;
const MAX_ALIAS_LENGTH = 80;
const MAX_LEAVE_DAYS = 400;
const DISCORD_ID_RE = /^\d{15,25}$/;
const LEAVE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const fail = (res, status, code, message) => res.status(status).json({ success: false, error: { code, message } });

async function requireAdminLive(req, res, next) {
  try {
    if (await isCrmAdmin(req.crmUser)) return next();
    return fail(res, 403, 'forbidden', 'Admin access required');
  } catch (err) {
    console.error('[bdaProfileRoutes] admin check failed:', err?.message);
    return fail(res, 503, 'admin_check_failed', 'Could not verify admin access, try again');
  }
}

function isRealDate(day) {
  return LEAVE_DAY_RE.test(day) && DateTime.fromISO(day, { zone: 'Asia/Kolkata' }).isValid;
}

/** Validate the PUT body. Returns { update } or { error: { code, message } }. */
function validateUpdate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: { code: 'invalid_body', message: 'Send a JSON object' } };
  }
  const unknown = Object.keys(body).filter((k) => !EDITABLE_FIELDS.includes(k));
  if (unknown.length > 0) {
    return { status: 422, error: { code: 'unknown_field', message: `Cannot edit: ${unknown.join(', ')}` } };
  }
  if (Object.keys(body).length === 0) {
    return { status: 422, error: { code: 'empty_update', message: `Send at least one of: ${EDITABLE_FIELDS.join(', ')}` } };
  }

  const update = {};

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

  return { update };
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
  app.get('/api/crm/admin/bda-profiles', requireCrmUser, requireAdminLive, async (req, res) => {
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

  app.put('/api/crm/admin/bda-profiles/:email', requireCrmUser, requireAdminLive, async (req, res) => {
    try {
      const email = String(req.params.email ?? '').trim().toLowerCase();
      const checked = validateUpdate(req.body);
      if (checked.error) return fail(res, checked.status, checked.error.code, checked.error.message);

      if (!(await BdaProfileModel.exists({ email }))) {
        return fail(res, 404, 'profile_not_found', `No BDA profile for ${email}`);
      }
      const conflict = await findAliasConflict(email, checked.update.aliases);
      if (conflict) {
        return fail(res, 409, 'alias_conflict', `"${conflict.alias}" already belongs to ${conflict.owner}`);
      }

      const profile = await BdaProfileModel.findOneAndUpdate(
        { email },
        { $set: checked.update },
        { new: true, runValidators: true }
      )
        .select('-__v')
        .lean();
      if (!profile) return fail(res, 404, 'profile_not_found', `No BDA profile for ${email}`);

      invalidateRegistryCache();
      return res.status(200).json({ success: true, profile });
    } catch (err) {
      console.error('[bdaProfileRoutes] update failed:', err?.message);
      return fail(res, 500, 'internal_error', 'Could not update the BDA profile');
    }
  });
}

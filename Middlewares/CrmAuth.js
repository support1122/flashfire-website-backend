import jwt from 'jsonwebtoken';
import { CrmSessionModel } from '../Schema_Models/CrmSessionModel.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';

export function getCrmJwtSecret() {
  // Prefer a dedicated secret; fall back to existing long-lived secret in this repo if present.
  return (
    process.env.CRM_JWT_SECRET ||
    process.env.SUPABASE_PUBLIC_SECRET_SERVICE_KEY_FOR_BACKEND ||
    'dev_only_insecure_crm_jwt_secret'
  );
}

function readBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization;
  if (!header) return null;
  const value = String(header);
  if (!value.toLowerCase().startsWith('bearer ')) return null;
  return value.slice(7).trim();
}

export function requireCrmAdmin(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Missing Authorization bearer token' });
    const payload = jwt.verify(token, getCrmJwtSecret());
    if (payload?.role !== 'crm_admin') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    req.crmAdmin = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

export async function requireCrmUser(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Missing Authorization bearer token' });
    const payload = jwt.verify(token, getCrmJwtSecret());
    if (payload?.role !== 'crm_user') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    // Tokens issued before session tracking was added have no sessionId — let them through
    // unchecked rather than force-logging-out everyone on deploy.
    if (payload.sessionId) {
      const session = await CrmSessionModel.findOneAndUpdate(
        { sessionId: payload.sessionId },
        { lastSeenAt: new Date() },
        { new: true }
      );
      if (session && session.revoked) {
        return res.status(401).json({ success: false, error: 'Session revoked. Please log in again.' });
      }
    }

    req.crmUser = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}

/**
 * Non-blocking auth: if a valid CRM bearer token is present, attach req.crmUser.
 * If absent or invalid, continue anyway. Used on routes that must stay open to
 * non-CRM callers (microservices/automations) but should trust the logged-in
 * CRM user's identity when one is present — e.g. status-ownership enforcement.
 */
export function attachCrmUserOptional(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (token) {
      const payload = jwt.verify(token, getCrmJwtSecret());
      if (payload?.role === 'crm_user' || payload?.role === 'crm_admin') {
        req.crmUser = payload;
      }
    }
  } catch {
    // Invalid/expired token — treat as anonymous, do not block.
  }
  return next();
}

export function requireBdaExtension(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Missing Authorization bearer token' });
    const payload = jwt.verify(token, getCrmJwtSecret());
    if (payload?.role !== 'bda_extension') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    req.bdaUser = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function requireCrmPermission(permission) {
  return (req, res, next) => {
    const perms = req.crmUser?.permissions;
    if (!Array.isArray(perms)) {
      return res.status(403).json({ success: false, error: 'Insufficient permission' });
    }
    // Holding the `_edit` variant implies view access for the same module.
    const editVariant = `${permission}_edit`;
    if (!perms.includes(permission) && !perms.includes(editVariant)) {
      return res.status(403).json({ success: false, error: 'Insufficient permission' });
    }
    return next();
  };
}

/** Require edit (mutate) permission for a module. View alone is not sufficient. */
export function requireCrmEdit(module) {
  return (req, res, next) => {
    const perms = req.crmUser?.permissions;
    if (!Array.isArray(perms) || !perms.includes(`${module}_edit`)) {
      return res.status(403).json({ success: false, error: 'Read-only access — edit permission required' });
    }
    return next();
  };
}

/**
 * Like requireCrmEdit, but if the JWT's permission list does not carry the
 * grant, fall back to the current CrmUser record in the DB. This lets a
 * freshly-granted permission take effect without the user logging out and
 * back in (the JWT is a snapshot from login time). Admins (bdaRole === 'admin')
 * pass automatically. One indexed findOne per request, only on the slow path.
 */
export function requireCrmEditLive(module) {
  const editKey = `${module}_edit`;
  return async (req, res, next) => {
    if (req.crmUser?.bdaRole === 'admin') return next();

    const jwtPerms = req.crmUser?.permissions;
    if (Array.isArray(jwtPerms) && jwtPerms.includes(editKey)) return next();

    try {
      const email = req.crmUser?.email;
      if (email) {
        const user = await CrmUserModel.findOne({ email: String(email).toLowerCase().trim() })
          .select('permissions isActive')
          .lean();
        if (user && user.isActive !== false && Array.isArray(user.permissions) && user.permissions.includes(editKey)) {
          // Refresh the request's view of permissions for any downstream check.
          req.crmUser.permissions = user.permissions;
          return next();
        }
      }
    } catch (e) {
      console.error('[requireCrmEditLive] lookup failed:', e?.message || e);
    }

    return res.status(403).json({ success: false, error: 'Read-only access — edit permission required' });
  };
}

/** True if CRM user may only access Meta-scoped lead APIs (not full Leads). */
export function crmUserMetaLeadsOnly(req) {
  const perms = req.crmUser?.permissions;
  if (!Array.isArray(perms)) return false;
  return perms.includes('meta_leads') && !perms.includes('leads');
}

/**
 * Returns the requesting BDA's own email if the Leads list should be scoped to
 * only their assigned leads, or null if the request should see everyone's leads
 * (admins, and anyone whose role isn't 'bda').
 *
 * Leads with no resolved calendlyHost (old bookings, or Meta-lead bookings that
 * never got a host resolved) are intentionally left visible to every BDA — the
 * scope only ever narrows leads that DO have a clear owner.
 */
export function crmUserBdaOwnEmailScope(req) {
  // bdaRole carries CrmUser.role (admin/bda); absent on tokens issued before this
  // field existed, or on non-crm_user tokens — treat anything but an explicit
  // 'bda' as unscoped so nobody is unexpectedly locked out by an old token.
  if (req.crmUser?.bdaRole !== 'bda') return null;
  const email = req.crmUser?.email;
  return email ? String(email).toLowerCase().trim() : null;
}

export function requireCrmAnyPermission(permissions) {
  const list = Array.isArray(permissions) ? permissions : [];
  return (req, res, next) => {
    const perms = req.crmUser?.permissions;
    if (!Array.isArray(perms) || !list.some((p) => perms.includes(p))) {
      return res.status(403).json({ success: false, error: 'Insufficient permission' });
    }
    return next();
  };
}



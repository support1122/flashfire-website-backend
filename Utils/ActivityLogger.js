import { ActivityLogModel } from '../Schema_Models/ActivityLog.js';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Paths we never want in the activity feed (webhooks, machine traffic, the feed itself).
const EXCLUDE_PATTERNS = [
  /^\/api\/webhooks\//,
  /webhook/i,
  /^\/api\/bda-attendance\/(sse|beacon|report-|manual-mark|mark-absent|warn-absent)/,
  /^\/api\/crm\/admin\/activity-logs/,
  /\/calendly-webhook/,
];

const SENSITIVE_KEYS = new Set([
  'password',
  'otp',
  'token',
  'secret',
  'authorization',
  'accesstoken',
  'refreshtoken',
  'apikey',
]);

function pickActor(req) {
  if (req.crmAdmin) {
    return {
      actorEmail: req.crmAdmin.email || 'crm-admin',
      actorName: req.crmAdmin.name || 'CRM Admin',
      actorRole: 'crm_admin',
    };
  }
  if (req.crmUser) {
    return {
      actorEmail: req.crmUser.email || 'unknown',
      actorName: req.crmUser.name || null,
      actorRole: 'crm_user',
    };
  }
  if (req.bdaUser) {
    return {
      actorEmail: req.bdaUser.email || 'unknown',
      actorName: req.bdaUser.name || null,
      actorRole: 'bda_extension',
    };
  }
  return null;
}

function routePattern(req) {
  const raw = req.route?.path;
  const base = req.baseUrl || '';
  if (raw && typeof raw === 'string') return `${base}${raw}`.replace(/\/+/g, '/');
  return (req.originalUrl || req.url || '').split('?')[0];
}

function deriveCategory(pattern) {
  // /api/crm/admin/users -> crm ; /api/leads/paginated -> leads
  const parts = pattern.split('/').filter(Boolean);
  const apiIdx = parts.indexOf('api');
  const seg = apiIdx >= 0 ? parts[apiIdx + 1] : parts[0];
  return (seg || 'general').toLowerCase();
}

function humanize(segment) {
  return String(segment)
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveLabel(method, pattern) {
  const verb =
    method === 'POST'
      ? 'Created'
      : method === 'DELETE'
      ? 'Deleted'
      : method === 'PUT' || method === 'PATCH'
      ? 'Updated'
      : 'Accessed';
  const parts = pattern.split('/').filter((p) => p && p !== 'api' && !p.startsWith(':'));
  const subject = parts.slice(-2).map(humanize).join(' / ') || 'resource';
  return `${verb} ${subject}`;
}

function sanitize(obj, depth = 0) {
  if (obj == null || typeof obj !== 'object' || depth > 3) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else if (typeof v === 'object' && v !== null) {
      out[k] = sanitize(v, depth + 1);
    } else if (typeof v === 'string' && v.length > 500) {
      out[k] = `${v.slice(0, 500)}…`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function deriveTarget(req) {
  const p = req.params || {};
  if (p.id) return { targetType: 'id', targetId: String(p.id) };
  if (p.bookingId) return { targetType: 'booking', targetId: String(p.bookingId) };
  if (p.approvalId) return { targetType: 'approval', targetId: String(p.approvalId) };
  if (p.workflowId) return { targetType: 'workflow', targetId: String(p.workflowId) };
  if (p.campaignId) return { targetType: 'campaign', targetId: String(p.campaignId) };
  if (p.email) return { targetType: 'email', targetId: String(p.email) };
  const bodyEmail = req.body?.email || req.body?.clientEmail;
  if (bodyEmail) return { targetType: 'email', targetId: String(bodyEmail) };
  return { targetType: null, targetId: null };
}

/**
 * Fire-and-forget activity write. Never throws — logging must not break a request.
 */
export async function logActivity(entry) {
  try {
    await ActivityLogModel.create({ ...entry, createdAt: entry.createdAt || new Date() });
  } catch (err) {
    console.error('[ActivityLogger] failed to write log:', err?.message || err);
  }
}

/**
 * Express middleware. Registers a `res.finish` hook that records every mutating
 * CRM/BDA request once auth middleware has populated the actor on `req`.
 */
export function activityLogMiddleware(req, res, next) {
  const start = Date.now();
  const method = req.method?.toUpperCase();

  res.on('finish', () => {
    try {
      const url = (req.originalUrl || req.url || '').split('?')[0];
      if (!url.startsWith('/api/')) return;
      if (!MUTATING_METHODS.has(method)) return;
      if (EXCLUDE_PATTERNS.some((re) => re.test(url))) return;

      const actor = pickActor(req);
      // Only log authenticated actors — skip anonymous machine/preflight noise.
      if (!actor) return;

      const pattern = routePattern(req);
      const target = deriveTarget(req);
      const metadata = {};
      if (req.params && Object.keys(req.params).length) metadata.params = sanitize(req.params);
      if (req.body && Object.keys(req.body).length) metadata.body = sanitize(req.body);
      if (res.statusCode >= 400 && res.locals?.errorMessage) {
        metadata.error = String(res.locals.errorMessage).slice(0, 500);
      }

      logActivity({
        ...actor,
        action: `${method} ${pattern}`,
        label: deriveLabel(method, pattern),
        category: deriveCategory(pattern),
        method,
        path: pattern,
        url,
        statusCode: res.statusCode,
        success: res.statusCode < 400,
        durationMs: Date.now() - start,
        targetType: target.targetType,
        targetId: target.targetId,
        metadata: Object.keys(metadata).length ? metadata : null,
        ip: req.ip || req.headers['x-forwarded-for'] || null,
        userAgent: req.headers['user-agent'] || null,
      });
    } catch (err) {
      console.error('[ActivityLogger] middleware error:', err?.message || err);
    }
  });

  next();
}

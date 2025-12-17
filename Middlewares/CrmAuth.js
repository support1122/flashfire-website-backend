import jwt from 'jsonwebtoken';

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

export function requireCrmUser(req, res, next) {
  try {
    const token = readBearerToken(req);
    if (!token) return res.status(401).json({ success: false, error: 'Missing Authorization bearer token' });
    const payload = jwt.verify(token, getCrmJwtSecret());
    if (payload?.role !== 'crm_user') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    req.crmUser = payload;
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
}



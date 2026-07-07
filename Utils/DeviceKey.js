import crypto from 'crypto';

// A stable fingerprint for "this browser on this network," built from User-Agent + IP.
// Deliberately coarse: switching networks (e.g. wifi -> mobile data) or browsers counts
// as a new device and re-triggers approval, which is the safer default for this use case.
export function computeDeviceKey(userAgent, ip) {
  const value = `${String(userAgent || '').trim()}|${String(ip || '').trim()}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}

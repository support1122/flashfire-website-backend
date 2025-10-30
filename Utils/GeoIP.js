import { Reader } from '@maxmind/geoip2-node';
import fs from 'fs';
import path from 'path';

let geoReader = null;
const ipCache = new Map(); // ip -> { countryCode, country, expiresAt }
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function resolveDatabasePath() {
  const candidates = [];

  if (process.env.GEOIP_DB_PATH) candidates.push(process.env.GEOIP_DB_PATH);

  // Common local paths (relative to backend root)
  candidates.push(path.resolve(process.cwd(), 'GeoLite2-Country.mmdb'));
  candidates.push(path.resolve(process.cwd(), 'Utils', 'GeoLite2-Country.mmdb'));

  // Sibling IPBASED copy if present in monorepo
  candidates.push(path.resolve(process.cwd(), '..', 'IPBASED', 'backend', 'GeoLite2-Country.mmdb'));

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {
      // ignore
    }
  }

  return null;
}

export async function initGeoIp() {
  try {
    const dbPath = resolveDatabasePath();
    if (!dbPath) {
      console.warn('[GeoIP] Database not found. Set GEOIP_DB_PATH or place GeoLite2-Country.mmdb in project. Falling back to default.');
      return;
    }
    const buffer = fs.readFileSync(dbPath);
    geoReader = await Reader.openBuffer(buffer);
    console.log(`✅ [GeoIP] Database loaded from: ${dbPath}`);
  } catch (error) {
    console.error('❌ [GeoIP] Failed to load database:', error.message);
  }
}

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'];
  const ipFromForward = forwarded ? String(forwarded).split(',')[0].trim() : null;
  const chosen = (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    ipFromForward ||
    req.ip ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    null
  );
  if (!chosen) return null;
  return String(chosen).replace('::ffff:', '');
}

export function detectCountryFromIp(ip) {
  if (!ip) {
    console.warn('[GeoIP] No IP found on request; returning default US');
    return { countryCode: 'US', country: 'United States' };
  }

  // Normalize IPv6-mapped IPv4
  const normalizedIp = ip.replace('::ffff:', '');

  // Cleanup expired cache entries lazily
  const now = Date.now();
  const cached = ipCache.get(normalizedIp);
  if (cached && cached.expiresAt > now) {
    console.log(`[GeoIP] Cache hit for ${normalizedIp}: ${cached.countryCode}`);
    return { countryCode: cached.countryCode, country: cached.country };
  }

  let result = { countryCode: 'US', country: 'United States' };

  if (geoReader) {
    try {
      const lookup = geoReader.country(normalizedIp);
      if (lookup?.country) {
        result = {
          countryCode: lookup.country.isoCode,
          country: lookup.country.names?.en || lookup.country.isoCode
        };
        console.log(`[GeoIP] Lookup for ${normalizedIp}: ${result.countryCode}`);
      }
    } catch (e) {
      // localhost or unroutable IPs will often throw
      if (normalizedIp === '127.0.0.1' || normalizedIp === '::1' || normalizedIp === 'localhost') {
        result = { countryCode: 'IN', country: 'India (Local)' };
      } else {
        console.warn('[GeoIP] Lookup error:', normalizedIp, e.message);
      }
    }
  } else {
    // No DB: treat localhost specially
    if (normalizedIp === '127.0.0.1' || normalizedIp === '::1' || normalizedIp === 'localhost') {
      result = { countryCode: 'IN', country: 'India (Local)' };
    }
  }

  ipCache.set(normalizedIp, { ...result, expiresAt: now + TTL_MS });
  console.log(`[GeoIP] Cache store ${normalizedIp} -> ${result.countryCode} (ttl ${TTL_MS / (60*60*1000)}h)`);
  return result;
}



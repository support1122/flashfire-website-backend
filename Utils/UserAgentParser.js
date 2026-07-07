// Minimal dependency-free User-Agent parser covering the common browsers/OSes.
// Good enough for "which device/browser is this session on" display purposes —
// not meant to be as exhaustive as ua-parser-js.

export function parseUserAgent(uaString) {
  const ua = String(uaString || '');

  let os = 'Unknown OS';
  if (/windows nt/i.test(ua)) os = 'Windows';
  else if (/iphone|ipad|ipod/i.test(ua)) os = 'iOS';
  else if (/mac os x/i.test(ua)) os = 'macOS';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/linux/i.test(ua)) os = 'Linux';

  let browser = 'Unknown Browser';
  if (/edg\//i.test(ua)) browser = 'Edge';
  else if (/opr\/|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome\//i.test(ua) && !/edg\//i.test(ua)) browser = 'Chrome';
  else if (/crios\//i.test(ua)) browser = 'Chrome';
  else if (/fxios\//i.test(ua)) browser = 'Firefox';
  else if (/firefox\//i.test(ua)) browser = 'Firefox';
  else if (/safari\//i.test(ua) && /version\//i.test(ua)) browser = 'Safari';

  let deviceType = 'Desktop';
  if (/ipad|tablet/i.test(ua)) deviceType = 'Tablet';
  else if (/mobi|iphone|android/i.test(ua)) deviceType = 'Mobile';

  const deviceLabel = `${browser} on ${os}`;

  return { browser, os, deviceType, deviceLabel };
}

// A small in-memory per-user limiter (sliding window of timestamps). One backend process keeps its own counts,
// which is enough for the Mark Present buttons: a stuck client retrying in a loop is the case it exists for.
// Expired entries are pruned on use, so there is no background timer to leak.

export function createUserRateLimiter({ max = 10, windowMs = 60 * 1000, keyOf, now = () => Date.now() } = {}) {
  const hits = new Map(); // key -> number[] of request times inside the window

  function check(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return { allowed: false, retryAfterMs: windowMs - (t - recent[0]) };
    }
    recent.push(t);
    hits.set(key, recent);
    // Keep the map small: drop idle keys now and then.
    if (hits.size > 5000) {
      for (const [k, list] of hits) if (list.every((at) => t - at >= windowMs)) hits.delete(k);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  function middleware(req, res, next) {
    const key = keyOf(req);
    if (!key) return next(); // unauthenticated requests never reach here; auth runs first
    const { allowed, retryAfterMs } = check(key);
    if (allowed) return next();
    res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    return res.status(429).json({
      success: false,
      error: { code: 'rate_limited', message: 'Too many requests, try again in a minute' },
    });
  }

  middleware.reset = () => hits.clear();
  return middleware;
}

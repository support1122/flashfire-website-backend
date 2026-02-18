/**
 * In-memory rate limiter (sliding window). No Redis. Plan 7.1.
 * Use for hot endpoints to prevent DoS / abuse.
 */

const DEFAULT_POINTS = 100;
const DEFAULT_DURATION_SEC = 60;

// key -> { count, windowStart }
const store = new Map();

function getKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {Object} options
 * @param {number} [options.points=100] - Max requests per window
 * @param {number} [options.duration=60] - Window duration in seconds
 */
export function rateLimitMiddleware(options = {}) {
  const points = options.points ?? DEFAULT_POINTS;
  const durationMs = (options.duration ?? DEFAULT_DURATION_SEC) * 1000;

  return (req, res, next) => {
    const key = getKey(req);
    const now = Date.now();

    let entry = store.get(key);
    if (!entry) {
      entry = { count: 0, windowStart: now };
      store.set(key, entry);
    }

    // Sliding window: if we're past the window, reset
    if (now - entry.windowStart >= durationMs) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count += 1;

    if (entry.count > points) {
      return res.status(429).json({
        success: false,
        message: 'Too many requests, please try again later'
      });
    }

    next();
  };
}

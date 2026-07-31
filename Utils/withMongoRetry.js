const RETRYABLE_ERROR_NAMES = new Set([
  'MongoNetworkTimeoutError',
  'MongoNetworkError',
  'MongoServerSelectionError',
  'MongoTimeoutError',
]);

function isRetryableMongoError(err) {
  if (!err) return false;
  if (RETRYABLE_ERROR_NAMES.has(err.name)) return true;
  if (err.errorLabelSet?.has?.('RetryableWriteError')) return true;
  return false;
}

/**
 * Retries a Mongo operation on transient network/timeout errors with short backoff.
 * Calendly expects a response within ~10-20s, so total retry time is kept small
 * (default 3 attempts, ~4.5s max added delay) rather than trying to ride out a
 * multi-minute Atlas outage inline.
 */
export async function withMongoRetry(fn, { attempts = 3, baseDelayMs = 750 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryableMongoError(err) || attempt === attempts) {
        throw err;
      }
      const delay = baseDelayMs * attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Circuit Breaker for external API calls (WATI, SendGrid).
 * Only trips on infrastructure failures (network errors, timeouts, 5xx).
 * Does NOT trip on client errors (4xx) — those indicate bad input, not a down service.
 *
 * States:
 *   CLOSED    - Normal operation, all calls go through
 *   OPEN      - Service is down, fast-fail all calls
 *   HALF_OPEN - Testing one call to see if service recovered
 */
export class CircuitBreaker {
  constructor(name, { failureThreshold = 5, resetTimeoutMs = 60000 } = {}) {
    this.name = name;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.lastFailureTime = null;
  }

  /**
   * Returns true if this error represents an infrastructure failure
   * (service is actually down), false for client/business errors.
   */
  isInfrastructureFailure(error) {
    // Network errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.)
    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND' ||
        error.code === 'ERR_NETWORK') {
      return true;
    }

    // Axios timeout
    if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
      return true;
    }

    // Server errors (5xx) — service is having problems
    const status = error.response?.status;
    if (status && status >= 500) {
      return true;
    }

    // 429 Too Many Requests — service is rate limiting us
    if (status === 429) {
      return true;
    }

    // 4xx errors (400, 401, 403, 404, 422) are client errors — NOT infrastructure failures
    // These mean our request was wrong, not that the service is down
    return false;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailureTime > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        console.log(`[CircuitBreaker:${this.name}] HALF_OPEN - testing one call`);
      } else {
        throw new Error(`Circuit breaker "${this.name}" is OPEN - service temporarily unavailable (resets in ${Math.ceil((this.resetTimeoutMs - (Date.now() - this.lastFailureTime)) / 1000)}s)`);
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.isInfrastructureFailure(error)) {
        this.onFailure();
      }
      // Always rethrow — caller handles the error
      throw error;
    }
  }

  onSuccess() {
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker:${this.name}] CLOSED - service recovered`);
    }
    this.state = 'CLOSED';
    this.failureCount = 0;
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      console.error(`[CircuitBreaker:${this.name}] OPEN - ${this.failureCount} infrastructure failures, pausing calls for ${this.resetTimeoutMs / 1000}s`);
    }
  }

  getState() {
    return { name: this.name, state: this.state, failureCount: this.failureCount };
  }
}

// Shared instances for external services
export const watiCircuitBreaker = new CircuitBreaker('WATI', { failureThreshold: 5, resetTimeoutMs: 60000 });
export const sendgridCircuitBreaker = new CircuitBreaker('SendGrid', { failureThreshold: 5, resetTimeoutMs: 60000 });

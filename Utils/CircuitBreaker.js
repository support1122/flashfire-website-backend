/**
 * Simple Circuit Breaker for external API calls (WATI, SendGrid).
 * Prevents cascading failures when an external service is down.
 *
 * States:
 *   CLOSED   - Normal operation, all calls go through
 *   OPEN     - Service is down, fast-fail all calls
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
      this.onFailure();
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
      console.error(`[CircuitBreaker:${this.name}] OPEN - ${this.failureCount} failures, pausing calls for ${this.resetTimeoutMs / 1000}s`);
    }
  }

  getState() {
    return { name: this.name, state: this.state, failureCount: this.failureCount };
  }
}

// Shared instances for external services
export const watiCircuitBreaker = new CircuitBreaker('WATI', { failureThreshold: 5, resetTimeoutMs: 60000 });
export const sendgridCircuitBreaker = new CircuitBreaker('SendGrid', { failureThreshold: 5, resetTimeoutMs: 60000 });

/**
 * Circuit breaker for LCM summarization API calls.
 * Tracks consecutive auth failures per model key and halts calls after threshold.
 * Auto-resets after cooldown period.
 */

const LCM_CIRCUIT_BREAKER_THRESHOLD = parseInt(process.env.LCM_CIRCUIT_BREAKER_THRESHOLD || '5', 10);
const LCM_CIRCUIT_BREAKER_COOLDOWN_MS = parseInt(process.env.LCM_CIRCUIT_BREAKER_COOLDOWN_MS || '1800000', 10);

interface CircuitState {
  failures: number;
  openSince: number | null;
}

export class CircuitBreaker {
  private states = new Map<string, CircuitState>();
  private threshold: number;
  private cooldownMs: number;

  constructor(threshold = LCM_CIRCUIT_BREAKER_THRESHOLD, cooldownMs = LCM_CIRCUIT_BREAKER_COOLDOWN_MS) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  isOpen(key: string): boolean {
    const state = this.states.get(key);
    if (!state || state.openSince === null) return false;

    const elapsed = Date.now() - state.openSince;
    if (elapsed >= this.cooldownMs) {
      // Auto-reset after cooldown
      this.reset(key);
      return false;
    }
    return true;
  }

  recordFailure(key: string): void {
    const state = this.getOrCreateState(key);
    state.failures++;

    const halfThreshold = Math.ceil(this.threshold / 2);
    if (state.failures === halfThreshold && state.failures < this.threshold) {
      console.error(
        `[lcm] WARNING: compaction degraded — ${state.failures}/${this.threshold} consecutive auth failures for ${key}`,
      );
    }

    if (state.failures >= this.threshold) {
      state.openSince = Date.now();
      const cooldownMin = Math.round(this.cooldownMs / 60000);
      console.error(
        `[lcm] CIRCUIT BREAKER OPEN: compaction disabled for ${key}. Auto-retry in ${cooldownMin}m.`,
      );
    }
  }

  recordSuccess(key: string): void {
    this.reset(key);
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  /** @internal — for tests */
  _getState(key: string): CircuitState | undefined {
    return this.states.get(key);
  }

  private getOrCreateState(key: string): CircuitState {
    let state = this.states.get(key);
    if (!state) {
      state = { failures: 0, openSince: null };
      this.states.set(key, state);
    }
    return state;
  }
}

/** Singleton instance used by lcm-summarize */
export const summarizationBreaker = new CircuitBreaker();

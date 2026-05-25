/**
 * Circuit Breaker — three-state machine.
 *
 *   closed       — calls flow through; failures counted in a window
 *   open         — calls fail-fast immediately; periodic reset attempt
 *   half_open    — one probe call allowed; success → closed, fail → open
 *
 * Per-service breaker registry shared via `getBreaker(name)`.
 * Configurable thresholds via env so prod and dev can diverge.
 */

import type { CircuitState } from './types';

interface Failure { ts: number; }

interface Config {
  failureThreshold: number;
  windowMs:         number;
  resetMs:          number;
  halfOpenAfterMs:  number;
}

const DEFAULTS: Config = {
  failureThreshold: Number(process.env.QT_BREAKER_FAILURE_THRESHOLD ?? 5),
  windowMs:         Number(process.env.QT_BREAKER_WINDOW_MS         ?? 10_000),
  resetMs:          Number(process.env.QT_BREAKER_RESET_MS          ?? 30_000),
  halfOpenAfterMs:  Number(process.env.QT_BREAKER_RESET_MS          ?? 30_000),
};

export class CircuitBreaker {
  name: string;
  cfg: Config;
  state: CircuitState = 'closed';
  failures: Failure[] = [];
  openedAt: number | null = null;
  halfOpenInFlight = false;

  /* Lightweight metrics. */
  metrics = { total: 0, allowed: 0, rejected: 0, failed: 0, succeeded: 0, opens: 0 };

  constructor(name: string, cfg: Partial<Config> = {}) {
    this.name = name;
    this.cfg = { ...DEFAULTS, ...cfg };
  }

  /** Returns the state the call sees right now and lazily transitions
   * open→half_open when the cool-off period has elapsed. */
  observe(): CircuitState {
    if (this.state === 'open' && this.openedAt && Date.now() - this.openedAt > this.cfg.halfOpenAfterMs) {
      this.state = 'half_open';
      this.halfOpenInFlight = false;
    }
    return this.state;
  }

  /** Decide whether to allow this call; throw on rejection so callers
   * can let the error propagate as a normal failure. */
  allow(): boolean {
    this.metrics.total++;
    const state = this.observe();
    if (state === 'open') { this.metrics.rejected++; return false; }
    if (state === 'half_open') {
      if (this.halfOpenInFlight) { this.metrics.rejected++; return false; }
      this.halfOpenInFlight = true;
    }
    this.metrics.allowed++;
    return true;
  }

  /** Call this after the protected call succeeds. */
  recordSuccess(): void {
    this.metrics.succeeded++;
    if (this.state === 'half_open') {
      this.state = 'closed';
      this.openedAt = null;
      this.failures = [];
      this.halfOpenInFlight = false;
    }
    /* In closed state we don't prune failures aggressively — the
     * window check in recordFailure() drops stale ones. */
  }

  /** Call this after the protected call fails. */
  recordFailure(): void {
    this.metrics.failed++;
    const now = Date.now();
    if (this.state === 'half_open') {
      this.state = 'open';
      this.openedAt = now;
      this.halfOpenInFlight = false;
      this.metrics.opens++;
      return;
    }
    this.failures = this.failures.filter((f) => now - f.ts < this.cfg.windowMs);
    this.failures.push({ ts: now });
    if (this.failures.length >= this.cfg.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
      this.metrics.opens++;
    }
  }

  snapshot() {
    return {
      name: this.name, state: this.observe(),
      failures_in_window: this.failures.length,
      opened_at: this.openedAt,
      ...this.metrics,
      config: this.cfg,
    };
  }
}

const registry = new Map<string, CircuitBreaker>();

export function getBreaker(name: string, cfg?: Partial<Config>): CircuitBreaker {
  let b = registry.get(name);
  if (!b) { b = new CircuitBreaker(name, cfg); registry.set(name, b); }
  return b;
}

export function allBreakers(): CircuitBreaker[] { return [...registry.values()]; }

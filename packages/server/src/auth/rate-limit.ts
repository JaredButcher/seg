/**
 * In-memory auth rate limiting (planning/02 §7).
 *
 * Two independent limiters, because they stop different attacks:
 *   - per username: password guessing against one account
 *   - per IP: spraying one common password across many accounts, which no per-username
 *     counter would ever notice
 *
 * In-memory is correct for a single-process server (planning/01 §1). Moving to multiple
 * processes means moving this to Redis, which is why it sits behind an interface.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

const ALLOWED: RateLimitDecision = { allowed: true, retryAfterSeconds: 0 };

export interface RateLimiterOptions {
  /** Failures before a key is locked out. */
  readonly maxFailures: number;
  /** How long a lockout lasts, in milliseconds. */
  readonly lockoutMs: number;
  /** Failures older than this are forgotten, in milliseconds. */
  readonly windowMs: number;
}

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly options: RateLimiterOptions) {}

  check(key: string, now: number): RateLimitDecision {
    const entry = this.entries.get(key);
    if (entry === undefined) return ALLOWED;

    if (entry.lockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000),
      };
    }

    // Lockout elapsed, or the window rolled over: start clean.
    if (entry.lockedUntil !== 0 || now - entry.firstFailureAt > this.options.windowMs) {
      this.entries.delete(key);
    }
    return ALLOWED;
  }

  recordFailure(key: string, now: number): void {
    const entry = this.entries.get(key);

    if (entry === undefined || now - entry.firstFailureAt > this.options.windowMs) {
      this.entries.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
      return;
    }

    entry.failures += 1;
    if (entry.failures >= this.options.maxFailures) {
      entry.lockedUntil = now + this.options.lockoutMs;
    }
  }

  /** Called on a successful login so one typo does not count against the next attempt. */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** Drops entries that can no longer affect a decision. Called periodically. */
  sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      const expired =
        entry.lockedUntil <= now && now - entry.firstFailureAt > this.options.windowMs;
      if (expired) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** 10 failures then a 15-minute lockout, per planning/02 §7. */
export const USERNAME_LIMITS: RateLimiterOptions = {
  maxFailures: 10,
  lockoutMs: 15 * 60_000,
  windowMs: 15 * 60_000,
};

/** Looser, because one IP may legitimately be a household or a NAT gateway. */
export const IP_LIMITS: RateLimiterOptions = {
  maxFailures: 30,
  lockoutMs: 15 * 60_000,
  windowMs: 15 * 60_000,
};

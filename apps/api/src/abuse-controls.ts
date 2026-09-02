export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly reset: number;
}

export interface RateLimiterOptions {
  readonly windowMs?: number;
  readonly maxRequests?: number;
  readonly clock?: () => number;
}

/**
 * Deterministic in-memory sliding/fixed window rate limiter.
 */
export class MemoryRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly clock: () => number;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60000;
    this.maxRequests = options.maxRequests ?? 100;
    this.clock = options.clock ?? (() => Date.now());
  }

  check(key: string, customMax?: number, customWindowMs?: number): RateLimitResult {
    const now = this.clock();
    const windowMs = customWindowMs ?? this.windowMs;
    const maxRequests = customMax ?? this.maxRequests;

    let record = this.hits.get(key);
    if (!record || now >= record.resetAt) {
      record = { count: 1, resetAt: now + windowMs };
      this.hits.set(key, record);
      const remaining = Math.max(0, maxRequests - 1);
      const resetSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
      return { allowed: true, limit: maxRequests, remaining, reset: resetSeconds };
    }

    record.count += 1;
    const resetSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    if (record.count > maxRequests) {
      return { allowed: false, limit: maxRequests, remaining: 0, reset: resetSeconds };
    }

    const remaining = Math.max(0, maxRequests - record.count);
    return { allowed: true, limit: maxRequests, remaining, reset: resetSeconds };
  }

  reset(): void {
    this.hits.clear();
  }
}

export interface ConcurrencyLimiterOptions {
  readonly maxConcurrent?: number;
}

/**
 * Bounded concurrency limiter tracking active operations.
 */
export class ConcurrencyLimiter {
  readonly maxConcurrent: number;
  private active = 0;

  constructor(options: ConcurrencyLimiterOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 10;
  }

  tryAcquire(): boolean {
    if (this.active >= this.maxConcurrent) {
      return false;
    }
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) {
      this.active -= 1;
    }
  }

  currentActive(): number {
    return this.active;
  }

  reset(): void {
    this.active = 0;
  }
}

export interface BudgetTrackerOptions {
  readonly maxDailyQueries?: number;
  readonly clock?: () => number;
}

/**
 * Daily provider budget limiter.
 */
export class DailyBudgetTracker {
  private readonly maxDailyQueries: number;
  private readonly clock: () => number;
  private consumed = 0;
  private currentDay = '';

  constructor(options: BudgetTrackerOptions = {}) {
    this.maxDailyQueries = options.maxDailyQueries ?? 10000;
    this.clock = options.clock ?? (() => Date.now());
  }

  private resolveDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  tryConsume(count = 1): boolean {
    const now = this.clock();
    const day = this.resolveDay(now);

    if (day !== this.currentDay) {
      this.currentDay = day;
      this.consumed = 0;
    }

    if (this.consumed + count > this.maxDailyQueries) {
      return false;
    }

    this.consumed += count;
    return true;
  }

  getRemaining(): number {
    return Math.max(0, this.maxDailyQueries - this.consumed);
  }

  reset(): void {
    this.consumed = 0;
    this.currentDay = '';
  }
}

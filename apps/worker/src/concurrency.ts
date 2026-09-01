import type { Redis } from 'ioredis';
import type { SourceKey } from '@techpulse/contracts';

export interface SourceConcurrencyLimiter {
  run<T>(sourceKey: SourceKey, operation: () => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

export type SourceConcurrency = number | Readonly<Partial<Record<SourceKey, number>>>;

function capForSource(sourceKey: SourceKey, caps: SourceConcurrency, fallback: number): number {
  const cap = typeof caps === 'number' ? caps : (caps[sourceKey] ?? fallback);
  if (!Number.isSafeInteger(cap) || cap < 1 || cap > 100) {
    throw new RangeError(`invalid concurrency cap for ${sourceKey}`);
  }
  return cap;
}

interface Waiter<T> {
  readonly operation: () => Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

interface SourceState {
  active: number;
  readonly waiters: Array<Waiter<unknown>>;
}

export class InMemorySourceConcurrencyLimiter implements SourceConcurrencyLimiter {
  private readonly states = new Map<SourceKey, SourceState>();
  private readonly fallback: number;

  constructor(
    private readonly caps: SourceConcurrency,
    fallback = 1,
  ) {
    this.fallback = fallback;
    capForSource('github_releases', caps, fallback);
  }

  run<T>(sourceKey: SourceKey, operation: () => Promise<T>): Promise<T> {
    const cap = capForSource(sourceKey, this.caps, this.fallback);
    const state = this.states.get(sourceKey) ?? { active: 0, waiters: [] };
    this.states.set(sourceKey, state);
    return new Promise<T>((resolve, reject) => {
      state.waiters.push({
        operation: async () => operation(),
        resolve: (value) => resolve(value as T),
        reject,
      });
      void this.drain(sourceKey, cap, state);
    });
  }

  private async drain(sourceKey: SourceKey, cap: number, state: SourceState): Promise<void> {
    while (state.active < cap && state.waiters.length > 0) {
      const waiter = state.waiters.shift();
      if (!waiter) return;
      state.active += 1;
      void waiter
        .operation()
        .then(waiter.resolve, waiter.reject)
        .finally(() => {
          state.active -= 1;
          void this.drain(sourceKey, cap, state);
        });
    }
  }
}

const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[3])
local fields = redis.call('HGETALL', KEYS[1])
for index = 1, #fields, 2 do
  local token = fields[index]
  local expires = tonumber(fields[index + 1])
  if expires and expires <= now then redis.call('HDEL', KEYS[1], token) end
end
if redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], now + tonumber(ARGV[4]))
return 1
`;
const RENEW_SCRIPT = `
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then
  redis.call('HSET', KEYS[1], ARGV[1], tonumber(ARGV[2]) + tonumber(ARGV[3]))
  return 1
end
return 0
`;
const RELEASE_SCRIPT = `redis.call('HDEL', KEYS[1], ARGV[1]); return 1`;

export interface RedisSourceConcurrencyLimiterOptions {
  readonly leaseMs?: number;
  readonly pollMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly keyPrefix?: string;
}

/**
 * A Redis lease makes the source cap global across worker processes. Expiry is
 * deliberately bounded: a SIGKILL leaves capacity blocked for at most leaseMs.
 */
export class RedisSourceConcurrencyLimiter implements SourceConcurrencyLimiter {
  private readonly leaseMs: number;
  private readonly pollMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly keyPrefix: string;
  private readonly fallback: number;

  constructor(
    private readonly redis: Redis,
    private readonly caps: SourceConcurrency,
    fallback = 1,
    options: RedisSourceConcurrencyLimiterOptions = {},
  ) {
    this.fallback = fallback;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollMs = options.pollMs ?? 25;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 60_000;
    this.keyPrefix = options.keyPrefix ?? 'techpulse:worker:source-cap';
    if (this.leaseMs < 1_000 || this.pollMs < 1 || this.acquireTimeoutMs < this.pollMs) {
      throw new RangeError('invalid Redis source limiter timing');
    }
    capForSource('github_releases', caps, fallback);
  }

  async run<T>(sourceKey: SourceKey, operation: () => Promise<T>): Promise<T> {
    const cap = capForSource(sourceKey, this.caps, this.fallback);
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const key = `${this.keyPrefix}:${sourceKey}`;
    const deadline = Date.now() + this.acquireTimeoutMs;
    while (true) {
      const acquired = await this.redis.eval(
        ACQUIRE_SCRIPT,
        1,
        key,
        token,
        cap,
        Date.now(),
        this.leaseMs,
      );
      if (acquired === 1) break;
      if (Date.now() >= deadline) {
        throw new Error(`source concurrency capacity unavailable: ${sourceKey}`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollMs));
    }

    let renewing = true;
    let renewTimer: NodeJS.Timeout | undefined;
    const renew = async (): Promise<void> => {
      if (!renewing) return;
      await this.redis.eval(RENEW_SCRIPT, 1, key, token, Date.now(), this.leaseMs);
      if (renewing) {
        renewTimer = setTimeout(() => void renew(), Math.max(1_000, this.leaseMs / 3));
      }
    };
    renewTimer = setTimeout(() => void renew(), Math.max(1_000, this.leaseMs / 3));
    try {
      return await operation();
    } finally {
      renewing = false;
      clearTimeout(renewTimer);
      renewTimer = undefined;
      await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

import assert from 'node:assert/strict';
import type { Redis } from 'ioredis';
import { afterEach, describe, test, vi } from 'vitest';
import {
  LeaseOwnershipLostError,
  LeaseReleaseError,
  LeaseRenewalError,
  RedisSourceConcurrencyLimiter,
  leaseRenewalIntervalMs,
} from '../src/index.js';

class FakeRedis {
  readonly scripts: string[] = [];
  renewResult: unknown = 1;
  releaseResult: unknown = 1;
  releaseError: Error | undefined;

  async eval(script: string): Promise<unknown> {
    this.scripts.push(script);
    if (script.includes('HGETALL')) return 1;
    if (script.includes('HEXISTS')) {
      if (this.renewResult instanceof Error) throw this.renewResult;
      return this.renewResult;
    }
    if (script.includes('HDEL')) {
      if (this.releaseError) throw this.releaseError;
      return this.releaseResult;
    }
    return 1;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

function fakeRedis(redis: FakeRedis): Redis {
  return redis as unknown as Redis;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Redis lease renewal', () => {
  test('renews strictly before a one-second lease expires', async () => {
    vi.useFakeTimers();
    assert.equal(leaseRenewalIntervalMs(1_000), 333);
    const redis = new FakeRedis();
    const limiter = new RedisSourceConcurrencyLimiter(fakeRedis(redis), 1, 1, {
      leaseMs: 1_000,
      keyPrefix: 'test-renewal',
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = limiter.run('github_releases', async () => held);
    await vi.advanceTimersByTimeAsync(332);
    assert.equal(redis.scripts.filter((script) => script.includes('HEXISTS')).length, 0);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(redis.scripts.filter((script) => script.includes('HEXISTS')).length, 1);
    release();
    await running;
    await limiter.close();
  });

  test('fails closed when renewal loses ownership', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    redis.renewResult = 0;
    const limiter = new RedisSourceConcurrencyLimiter(fakeRedis(redis), 1, 1, {
      leaseMs: 1_000,
      keyPrefix: 'test-ownership',
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = limiter.run('github_releases', async () => held);
    await vi.advanceTimersByTimeAsync(333);
    release();
    await assert.rejects(running, LeaseOwnershipLostError);
    await limiter.close();
  });

  test('converts renewal command failures without unhandled timer rejection', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    redis.renewResult = new Error('redis unavailable');
    const limiter = new RedisSourceConcurrencyLimiter(fakeRedis(redis), 1, 1, {
      leaseMs: 1_000,
      keyPrefix: 'test-renew-error',
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = limiter.run('github_releases', async () => held);
    await vi.advanceTimersByTimeAsync(333);
    release();
    await assert.rejects(running, LeaseRenewalError);
    await limiter.close();
  });

  test('preserves the operation error when release also fails', async () => {
    const redis = new FakeRedis();
    redis.releaseError = new Error('release unavailable');
    const limiter = new RedisSourceConcurrencyLimiter(fakeRedis(redis), 1, 1, {
      keyPrefix: 'test-release-error',
    });
    const operationError = new Error('operation failed');
    let observed: unknown;
    try {
      await limiter.run('github_releases', async () => {
        throw operationError;
      });
    } catch (error) {
      observed = error;
    }
    assert.equal(observed, operationError);
    assert.ok(operationError.cause instanceof LeaseReleaseError);
    await limiter.close();
  });
});

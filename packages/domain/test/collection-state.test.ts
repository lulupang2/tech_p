import { describe, expect, it } from 'vitest';
import {
  decodePageCursor,
  encodePageCursor,
  partitionNaturalKey,
  validatePageResult,
  type CollectionPartition,
} from '../src/collection-state.js';

const partition: CollectionPartition = {
  id: 'partition-a',
  targetRevisionId: 'revision-a',
  mode: 'backfill',
  scopeKey: 'cohort-a',
  window: { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-09-01T00:00:00Z') },
  timeBasis: 'published_at',
  workflowVersion: '1',
  state: 'running',
  pageSequence: 0,
  cursor: null,
  leaseEpoch: 1,
  leaseUntil: null,
  nextDueAt: new Date('2026-09-01T00:00:00Z'),
  reason: null,
};

describe('partition checkpoint isolation', () => {
  it('rejects a cursor belonging to another target, time window or adapter version', () => {
    const cursor = encodePageCursor(partition, 1, 'page=2');
    expect(decodePageCursor({ ...partition, cursor }, 1)).toBe('page=2');
    expect(() =>
      decodePageCursor({ ...partition, cursor, targetRevisionId: 'revision-b' }, 1),
    ).toThrow('invalid_cursor');
    expect(() =>
      decodePageCursor(
        {
          ...partition,
          cursor,
          window: { ...partition.window, to: new Date('2026-10-01T00:00:00Z') },
        },
        1,
      ),
    ).toThrow('invalid_cursor');
    expect(() => decodePageCursor({ ...partition, cursor }, 2)).toThrow('invalid_cursor');
  });
  it('does not collapse target, mode or demand scopes into a source window', () => {
    const plan = {
      targetRevisionId: partition.targetRevisionId,
      mode: partition.mode,
      scopeKey: partition.scopeKey,
      window: partition.window,
      timeBasis: partition.timeBasis,
      workflowVersion: partition.workflowVersion,
    };
    const key = partitionNaturalKey(plan);
    expect(partitionNaturalKey({ ...plan })).toBe(key);
    expect(partitionNaturalKey(partition)).toBe(key);
    const resumed: CollectionPartition = { ...partition, leaseEpoch: 99, pageSequence: 7 };
    expect(partitionNaturalKey(resumed)).toBe(key);
    expect(partitionNaturalKey({ ...plan, targetRevisionId: 'another-target' })).not.toBe(key);
    expect(partitionNaturalKey({ ...plan, mode: 'incremental' })).not.toBe(key);
    expect(partitionNaturalKey({ ...plan, scopeKey: 'other-query' })).not.toBe(key);
    expect(() =>
      partitionNaturalKey({ ...plan, window: { from: plan.window.to, to: plan.window.from } }),
    ).toThrow('invalid_window');
  });
  it('rejects non-progressing pages and waits without a resume instant', () => {
    const result = {
      items: [],
      nextCursor: 'same',
      disposition: 'continue' as const,
      reason: null,
      retryAt: null,
      requests: 1,
      bytes: 0,
    };
    expect(() => validatePageResult({ ...partition, cursor: 'same' }, result)).toThrow(
      'invalid_page',
    );
    expect(() => validatePageResult(partition, { ...result, disposition: 'deferred' })).toThrow(
      'invalid_page',
    );
    expect(() => validatePageResult(partition, { ...result, disposition: 'partial' })).toThrow(
      'invalid_page',
    );
  });
});

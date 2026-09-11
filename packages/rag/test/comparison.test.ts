import { describe, expect, it } from 'vitest';
import type { MetricObservationRecord } from '@techpulse/domain';
import { computeMetricObservations } from '../src/comparison.js';

function row(overrides: Partial<MetricObservationRecord> = {}): MetricObservationRecord {
  return {
    id: 'm1',
    sourceId: 's1',
    topicId: null,
    subjectKey: 'bun',
    metricType: 'community_mentions',
    windowStart: new Date('2026-09-01T00:00:00Z'),
    windowEnd: new Date('2026-09-08T00:00:00Z'),
    value: 20,
    unit: 'mentions',
    collectedAt: new Date('2026-09-08T00:00:00Z'),
    rawItemId: null,
    querySignature: null,
    isIncomplete: false,
    ...overrides,
  };
}

describe('RAG-006 metric comparison', () => {
  it('compares only matching metric+unit and preserves absolute values', () => {
    const result = computeMetricObservations({
      subject: 'bun',
      current: [
        row({ value: 20 }),
        row({ id: 'm2', metricType: 'release_activity', unit: 'releases', value: 3 }),
      ],
      baseline: [
        row({ id: 'b1', value: 10 }),
        row({ id: 'b2', metricType: 'release_activity', unit: 'releases', value: 2 }),
      ],
    });
    expect(result).toEqual([
      { subject: 'bun', metric: 'community_mentions', value: 20, unit: 'mentions', change: 1 },
      { subject: 'bun', metric: 'release_activity', value: 3, unit: 'releases', change: 0.5 },
    ]);
  });

  it('uses null change for missing/zero baseline and excludes incomplete rows', () => {
    const result = computeMetricObservations({
      subject: 'node',
      current: [row({ value: 5 }), row({ id: 'skip', value: 999, isIncomplete: true })],
      baseline: [row({ id: 'b', value: 0 })],
    });
    expect(result).toEqual([
      { subject: 'node', metric: 'community_mentions', value: 5, unit: 'mentions', change: null },
    ]);
  });
});

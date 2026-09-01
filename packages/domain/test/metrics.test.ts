import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  MetricAggregationError,
  aggregateMetricObservations,
  validateMetricObservation,
  type MetricAggregationObservation,
} from '../src/index.js';

const start = new Date('2026-09-02T00:00:00.000Z');
const end = new Date('2026-09-03T00:00:00.000Z');
let metricCounter = 0;

function metric(
  overrides: Partial<MetricAggregationObservation> = {},
): MetricAggregationObservation {
  return {
    subjectKey: 'typescript',
    metricType: 'community_mentions',
    windowStart: start,
    windowEnd: end,
    value: 1,
    unit: 'mentions',
    sourceKey: 'stack_exchange',
    rawItemId: `raw-generated-${metricCounter++}`,
    querySignature: null,
    isIncomplete: false,
    ...overrides,
  };
}

describe('PIPE-006 deterministic metric aggregation', () => {
  test('keeps metric types and units separate rather than summing incomparable values', () => {
    const result = aggregateMetricObservations([
      metric({ metricType: 'package_downloads', unit: 'downloads', sourceKey: 'npm_downloads' }),
      metric({ metricType: 'repo_attention', unit: 'stars', sourceKey: 'github_search' }),
      metric({
        metricType: 'repo_attention',
        unit: 'new_repositories',
        sourceKey: 'github_search',
      }),
    ]);
    assert.equal(result.length, 3);
    assert.deepEqual(
      result.map((item) => [item.metricType, item.unit]),
      [
        ['package_downloads', 'downloads'],
        ['repo_attention', 'stars'],
        ['repo_attention', 'new_repositories'],
      ],
    );
  });

  test('deduplicates community mentions by accepted cluster identity while retaining source provenance', () => {
    const result = aggregateMetricObservations([
      metric({
        rawItemId: 'raw-1',
        duplicateClusterId: 'cluster-1',
        duplicateMembershipStatus: 'accepted',
        value: 2,
      }),
      metric({
        rawItemId: 'raw-2',
        sourceKey: 'users_rust_lang',
        duplicateClusterId: 'cluster-1',
        duplicateMembershipStatus: 'accepted',
        value: 3,
      }),
      metric({
        rawItemId: 'raw-3',
        duplicateClusterId: 'cluster-1',
        duplicateMembershipStatus: 'suggested',
        value: 4,
      }),
      metric({ rawItemId: 'raw-4', value: 5 }),
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.value, 7);
    assert.equal(result[0]?.deduplicatedObservationCount, 2);
    assert.deepEqual(result[0]?.rawItemIds, ['raw-1', 'raw-2', 'raw-3', 'raw-4']);
    assert.deepEqual(result[0]?.sourceKeys, ['stack_exchange', 'users_rust_lang']);
  });

  test('keeps repo attention at or after the collection boundary and marks snapshots', () => {
    const collectionStartedAt = new Date('2026-09-01T00:00:00.000Z');
    const result = aggregateMetricObservations([
      metric({
        metricType: 'repo_attention',
        unit: 'stars',
        sourceKey: 'github_search',
        collectionStartedAt,
      }),
    ]);
    assert.equal(result[0]?.isSnapshot, true);
    assert.throws(
      () =>
        aggregateMetricObservations([
          metric({
            metricType: 'repo_attention',
            unit: 'stars',
            sourceKey: 'github_search',
            windowStart: new Date('2025-01-01T00:00:00.000Z'),
            collectionStartedAt,
          }),
        ]),
      /precede collection start/u,
    );
  });

  test('propagates query signatures and incomplete flags for search observations', () => {
    const result = aggregateMetricObservations([
      metric({
        metricType: 'repo_attention',
        unit: 'stars',
        sourceKey: 'github_search',
        querySignature: 'q=ts',
        isIncomplete: true,
      }),
      metric({
        metricType: 'repo_attention',
        unit: 'stars',
        sourceKey: 'github_search',
        querySignature: 'q=ts&page=2',
      }),
    ]);
    assert.deepEqual(result[0]?.querySignatures, ['q=ts', 'q=ts&page=2']);
    assert.equal(result[0]?.isIncomplete, true);
  });

  test('does not synthesize missing windows', () => {
    const result = aggregateMetricObservations([metric({ windowStart: start, windowEnd: end })]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.windowStart.toISOString(), start.toISOString());
  });

  test('rejects unsupported types, invalid units, non-integer values, and reversed windows', () => {
    assert.throws(
      () =>
        validateMetricObservation({
          metricType: 'interest_score',
          unit: 'points',
          value: 1,
          windowStart: start,
          windowEnd: end,
        }),
      MetricAggregationError,
    );
    assert.throws(() => aggregateMetricObservations([metric({ unit: 'stars' })]), /Invalid unit/u);
    assert.throws(() => aggregateMetricObservations([metric({ value: 1.5 })]), /safe integer/u);
    assert.throws(
      () => aggregateMetricObservations([metric({ windowStart: end, windowEnd: start })]),
      /valid UTC dates/u,
    );
  });
});

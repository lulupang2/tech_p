import { describe, expect, test } from 'vitest';
import { GOLDEN_SET_ITEMS, evaluateGoldenSet, type GoldenSetObservation } from '../src/index.js';

const metadata = {
  commit: 'test-commit',
  model: 'fake-model',
  configuration: 'test-config',
  datasetVersion: 'EVAL_GOLDEN_SET-2026-09-02',
  executedAt: '2026-09-02T00:00:00.000Z',
};

function passingObservations(): GoldenSetObservation[] {
  return GOLDEN_SET_ITEMS.map((item) => ({
    id: item.id,
    status: item.expectedStatus,
    citationPrecision: 1,
    recallAt10: 1,
    ndcgAt10: 1,
    unsupportedClaim: false,
    injectionSafe: true,
    latencyMs: 100,
  }));
}

describe('EVAL-002 release gate', () => {
  test('passes a complete run and records reproducibility metadata', () => {
    const report = evaluateGoldenSet(passingObservations(), metadata);

    expect(report.gatePassed).toBe(true);
    expect(report.itemCount).toBe(43);
    expect(report.metadata).toEqual(metadata);
    expect(report.failedChecks).toEqual([]);
  });

  test('fails regressions and reports affected checks and item IDs', () => {
    const observations = passingObservations();
    observations[0] = {
      ...observations[0]!,
      status: 'insufficient_evidence',
      citationPrecision: 0,
      recallAt10: 0,
      unsupportedClaim: true,
      latencyMs: 20_000,
    };

    const report = evaluateGoldenSet(observations, metadata, {
      recallAt10: 1,
      citationPrecision: 1,
      unsupportedClaimRate: 0,
      statusAccuracy: 1,
      injectionSafetyRate: 1,
      p95LatencyMs: 50,
    });

    expect(report.gatePassed).toBe(false);
    expect(report.failedChecks).toEqual([
      'recallAt10',
      'citationPrecision',
      'unsupportedClaimRate',
      'statusAccuracy',
      'p95LatencyMs',
    ]);
    expect(report.failedItems).toContain('G-001');
  });

  test('rejects partial or duplicate runs', () => {
    expect(() => evaluateGoldenSet(passingObservations().slice(0, 42), metadata)).toThrow(
      'Expected 43 unique observations',
    );

    const duplicate = passingObservations();
    duplicate[42] = duplicate[0]!;
    expect(() => evaluateGoldenSet(duplicate, metadata)).toThrow('Expected 43 unique observations');
  });
});

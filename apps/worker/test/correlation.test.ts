import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import { jobCorrelationContext } from '../src/index.js';

describe('worker correlation aliases', () => {
  test('uses the next valid alias when the primary alias is malformed', () => {
    assert.deepEqual(
      jobCorrelationContext({
        runId: 'run id with spaces',
        queryRunId: 'query-run-valid',
        collectionRunId: 'collection-run-valid',
      }),
      { runId: 'query-run-valid' },
    );
  });

  test('keeps the deterministic primary alias when all candidates are valid', () => {
    assert.deepEqual(
      jobCorrelationContext({
        runId: 'run-primary',
        queryRunId: 'query-run-secondary',
        collectionRunId: 'collection-run-tertiary',
      }),
      { runId: 'run-primary' },
    );
  });

  test('preserves ID boundary filtering while selecting aliases', () => {
    assert.deepEqual(
      jobCorrelationContext({
        runId: 'r'.repeat(129),
        queryRunId: 'query-run-valid',
        jobId: 'job id with spaces',
      }),
      { runId: 'query-run-valid' },
    );
  });
});

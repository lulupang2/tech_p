import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  REDACTED_VALUE,
  STRUCTURED_EVENT_SCHEMA_VERSION,
  correlationContextFromHeaders,
  createStructuredEvent,
  createStructuredLogger,
  isValidCorrelationId,
  mergeCorrelationContext,
  normalizeCorrelationContext,
  redact,
  serializeStructuredEvent,
} from '../src/index.js';

describe('correlation context', () => {
  test('merges valid values in deterministic precedence order', () => {
    assert.deepEqual(
      mergeCorrelationContext(
        { requestId: 'req-parent', runId: 'run-parent', sourceId: 'source-parent' },
        { requestId: 'req-child', queryId: 'query-child' },
      ),
      {
        requestId: 'req-child',
        runId: 'run-parent',
        sourceId: 'source-parent',
        queryId: 'query-child',
      },
    );
  });

  test('omits missing and invalid IDs rather than propagating them', () => {
    assert.deepEqual(
      normalizeCorrelationContext({
        requestId: 'req-valid',
        runId: '',
        jobId: 'job with spaces',
        sourceId: `${'s'.repeat(129)}`,
        queryId: undefined,
      }),
      { requestId: 'req-valid' },
    );
    assert.equal(isValidCorrelationId('req-valid'), true);
    assert.equal(isValidCorrelationId('not valid'), false);
    assert.equal(isValidCorrelationId(undefined), false);
  });

  test('reads case-insensitive request headers and ignores malformed IDs', () => {
    assert.deepEqual(
      correlationContextFromHeaders({
        'X-Request-ID': 'req-header',
        'x-run-id': 'run-header',
        'x-job-id': 'job with spaces',
        'x-source-id': 'source-header',
      }),
      { requestId: 'req-header', runId: 'run-header', sourceId: 'source-header' },
    );
  });
});

describe('structured events', () => {
  test('has a versioned JSON-safe shape and carries optional IDs', () => {
    const event = createStructuredEvent({
      event: 'api.request.received',
      service: 'api',
      context: { requestId: 'req-1', queryId: 'query-1' },
      fields: { attempt: 1, omitted: undefined, nonFinite: Number.NaN },
    });

    assert.deepEqual(event, {
      schemaVersion: STRUCTURED_EVENT_SCHEMA_VERSION,
      event: 'api.request.received',
      level: 'info',
      service: 'api',
      requestId: 'req-1',
      queryId: 'query-1',
      data: { attempt: 1, nonFinite: null },
    });
    assert.doesNotThrow(() => JSON.parse(serializeStructuredEvent(event)));
  });

  test('redacts token, cookie, authorization, secret, and payload recursively', () => {
    const value = {
      token: 'token-value',
      cookie: 'cookie-value',
      authorization: 'Bearer raw-value',
      secret: 'secret-value',
      payload: { body: 'raw-payload' },
      nested: [{ accessToken: 'another-token', keep: 'visible' }],
    };

    assert.deepEqual(redact(value), {
      token: REDACTED_VALUE,
      cookie: REDACTED_VALUE,
      authorization: REDACTED_VALUE,
      secret: REDACTED_VALUE,
      payload: REDACTED_VALUE,
      nested: [{ accessToken: REDACTED_VALUE, keep: 'visible' }],
    });
    const serialized = JSON.stringify(redact(value));
    assert.equal(serialized.includes('raw-value'), false);
    assert.equal(serialized.includes('raw-payload'), false);
  });

  test('logger propagates context and emits JSON-safe redacted output', () => {
    const lines: string[] = [];
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const logger = createStructuredLogger({
      service: 'worker',
      context: { runId: 'run-1', jobId: 'job-1' },
      sink: (line) => lines.push(line),
      clock: () => '2026-09-01T00:00:00.000Z',
    });

    const event = logger.withContext({ sourceId: 'source-1' }).info('worker.job.started', {
      token: 'do-not-log',
      payload: { raw: 'do-not-log' },
      circular,
    });
    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;

    assert.equal(event.runId, 'run-1');
    assert.equal(event.jobId, 'job-1');
    assert.equal(event.sourceId, 'source-1');
    assert.equal(parsed.timestamp, '2026-09-01T00:00:00.000Z');
    assert.equal(JSON.stringify(parsed).includes('do-not-log'), false);
    assert.equal(JSON.stringify(parsed).includes('[Circular]'), true);
  });
});

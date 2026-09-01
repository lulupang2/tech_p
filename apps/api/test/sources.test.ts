import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createApp } from '../src/app.js';
import {
  parseErrorEnvelope,
  parseSourceDetailResponse,
  parseSourceListResponse,
} from '@techpulse/contracts';
import { type SourceRecord, type SourceRepositoryPort } from '@techpulse/domain';

describe('API-002 sources endpoints', () => {
  test('GET /api/v1/sources returns versioned source list envelope with 200 OK', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/sources', {
        headers: { 'x-request-id': 'req_sources_test_1' },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req_sources_test_1');

    const body = await response.json();
    const parsed = parseSourceListResponse(body);
    assert.equal(parsed.requestId, 'req_sources_test_1');
    assert.ok(Array.isArray(parsed.items));
    assert.ok(parsed.items.length > 0);
    assert.equal(parsed.page.limit, 20);

    const first = parsed.items[0]!;
    assert.ok(typeof first.key === 'string');
    assert.ok(typeof first.displayName === 'string');
    assert.ok(typeof first.kind === 'string');
    assert.ok(Array.isArray(first.coverageNotes));
    assert.ok(['healthy', 'stale', 'degraded', 'disabled'].includes(first.status));
  });

  test('GET /api/v1/sources supports limit and cursor pagination', async () => {
    const app = createApp();

    const response1 = await app.handle(
      new Request('http://localhost/api/v1/sources?limit=3', {
        headers: { 'x-request-id': 'req_sources_p1' },
      }),
    );

    assert.equal(response1.status, 200);
    const body1 = await response1.json();
    const page1 = parseSourceListResponse(body1);
    assert.equal(page1.items.length, 3);
    assert.equal(page1.page.limit, 3);
    assert.ok(page1.page.nextCursor !== null);

    // Fetch page 2 using returned cursor
    const response2 = await app.handle(
      new Request(`http://localhost/api/v1/sources?limit=3&cursor=${page1.page.nextCursor}`, {
        headers: { 'x-request-id': 'req_sources_p2' },
      }),
    );

    assert.equal(response2.status, 200);
    const body2 = await response2.json();
    const page2 = parseSourceListResponse(body2);
    assert.equal(page2.items.length, 3);
    assert.notEqual(page1.items[0]?.key, page2.items[0]?.key);
  });

  test('GET /api/v1/sources rejects unknown query parameters with 400 INVALID_REQUEST', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/sources?extraProp=leak', {
        headers: { 'x-request-id': 'req_sources_bad_query' },
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_sources_bad_query');
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
  });

  test('GET /api/v1/sources rejects malformed cursor with 400 INVALID_REQUEST', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/sources?cursor=not-valid-base64!', {
        headers: { 'x-request-id': 'req_sources_bad_cursor' },
      }),
    );

    assert.equal(response.status, 400);
    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_sources_bad_cursor');
    assert.equal(envelope.error.code, 'INVALID_REQUEST');
  });

  test('GET /api/v1/sources/:key returns source detail for existing source', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/sources/github_releases', {
        headers: { 'x-request-id': 'req_source_detail_ok' },
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = parseSourceDetailResponse(body);
    assert.equal(parsed.requestId, 'req_source_detail_ok');
    assert.equal(parsed.source.key, 'github_releases');
    assert.equal(parsed.source.displayName, 'GitHub Releases');
    assert.equal(parsed.source.kind, 'releases');
    assert.ok(parsed.source.coverageNotes.length > 0);
  });

  test('GET /api/v1/sources/:key returns 404 NOT_FOUND for unknown source key', async () => {
    const app = createApp();

    const response = await app.handle(
      new Request('http://localhost/api/v1/sources/non_existent_source_key', {
        headers: { 'x-request-id': 'req_source_404' },
      }),
    );

    assert.equal(response.status, 404);
    const body = await response.json();
    const envelope = parseErrorEnvelope(body);
    assert.equal(envelope.requestId, 'req_source_404');
    assert.equal(envelope.error.code, 'NOT_FOUND');
    assert.equal(envelope.error.retryable, false);
  });

  test('GET /api/v1/sources reflects disabled status when source repository disables a source', async () => {
    const mockRepo: SourceRepositoryPort = {
      findByKey: async (key: string): Promise<SourceRecord | null> => {
        if (key === 'arxiv') {
          return {
            id: 'src_arxiv',
            key: 'arxiv',
            name: 'arXiv',
            kind: 'papers',
            baseUrl: 'https://export.arxiv.org',
            enabled: false,
            scheduleConfig: {},
            policyReviewedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return null;
      },
      listEnabled: async () => [],
    };

    const app = createApp({ sourceRepository: mockRepo });

    const response = await app.handle(
      new Request('http://localhost/api/v1/sources/arxiv', {
        headers: { 'x-request-id': 'req_arxiv_disabled' },
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    const parsed = parseSourceDetailResponse(body);
    assert.equal(parsed.source.key, 'arxiv');
    assert.equal(parsed.source.status, 'disabled');
  });

  test('sources endpoints never expose credentials or internal connection strings', async () => {
    const sensitiveError = 'FATAL: postgres://user:super_secret_pwd@db/prod';
    const mockRepo: SourceRepositoryPort = {
      findByKey: async () => {
        throw new Error(sensitiveError);
      },
      listEnabled: async () => {
        throw new Error(sensitiveError);
      },
    };

    const app = createApp({ sourceRepository: mockRepo });

    const response = await app.handle(new Request('http://localhost/api/v1/sources'));
    assert.equal(response.status, 200);

    const rawText = await response.text();
    assert.doesNotMatch(rawText, /super_secret_pwd/);
    assert.doesNotMatch(rawText, /postgres:\/\//);
  });
});

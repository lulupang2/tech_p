import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { ApiClient, ApiClientError, createApiClient } from '../src/lib/api-client.js';
import type {
  AnswerRequest,
  AnswerResponse,
  HealthLiveResponse,
  HealthReadyResponse,
  SourceDetailResponse,
  SourceListResponse,
  TopicListResponse,
} from '@techpulse/contracts';

describe('ApiClient', () => {
  it('creates an instance with default and custom options', () => {
    const defaultClient = createApiClient();
    assert.ok(defaultClient instanceof ApiClient);

    const customClient = new ApiClient({
      baseUrl: 'http://localhost:3000',
      defaultHeaders: { 'X-Custom-Header': 'custom-val' },
      timeoutMs: 5000,
    });
    assert.ok(customClient instanceof ApiClient);
  });

  describe('getHealthLive', () => {
    it('returns parsed HealthLiveResponse on success', async () => {
      const mockLive: HealthLiveResponse = {
        status: 'ok',
        timestamp: '2026-09-02T00:00:00.000Z',
      };

      const client = new ApiClient({
        baseUrl: 'http://localhost:3000',
        fetch: async (url, init) => {
          assert.equal(url.toString(), 'http://localhost:3000/health/live');
          assert.equal(init?.method, 'GET');
          return new Response(JSON.stringify(mockLive), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_live_123' },
          });
        },
      });

      const result = await client.getHealthLive();
      assert.deepEqual(result, mockLive);
    });
  });

  describe('getHealthReady', () => {
    it('returns parsed HealthReadyResponse on success', async () => {
      const mockReady: HealthReadyResponse = {
        status: 'ok',
        timestamp: '2026-09-02T00:00:00.000Z',
        dependencies: {
          database: 'ok',
        },
      };

      const client = new ApiClient({
        fetch: async (url) => {
          assert.equal(url.toString(), '/health/ready');
          return new Response(JSON.stringify(mockReady), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const result = await client.getHealthReady();
      assert.deepEqual(result, mockReady);
    });
  });

  describe('listSources', () => {
    it('fetches sources and serializes query parameters', async () => {
      const mockSources: SourceListResponse = {
        requestId: 'req_sources_1',
        items: [
          {
            key: 'github_releases',
            displayName: 'GitHub Releases',
            kind: 'release_notes',
            status: 'healthy',
            freshThrough: '2026-09-02T00:00:00.000Z',
            lastSuccessfulCollectionAt: '2026-09-02T00:00:00.000Z',
            coverageNotes: ['Verified public release tags'],
          },
        ],
        page: {
          nextCursor: 'cursor_xyz',
          limit: 10,
        },
      };

      let requestedUrl = '';
      const client = new ApiClient({
        baseUrl: 'http://localhost:3000',
        fetch: async (url) => {
          requestedUrl = url.toString();
          return new Response(JSON.stringify(mockSources), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const result = await client.listSources({ limit: 10, cursor: 'prev_cursor' });
      assert.equal(
        requestedUrl,
        'http://localhost:3000/api/v1/sources?cursor=prev_cursor&limit=10',
      );
      assert.deepEqual(result, mockSources);
    });
  });

  describe('getSource', () => {
    it('fetches single source detail with URL encoding', async () => {
      const mockDetail: SourceDetailResponse = {
        requestId: 'req_detail_1',
        source: {
          key: 'npm_downloads',
          displayName: 'npm Downloads',
          kind: 'metric_timeseries',
          status: 'healthy',
          freshThrough: '2026-09-02T00:00:00.000Z',
          lastSuccessfulCollectionAt: '2026-09-02T00:00:00.000Z',
          coverageNotes: ['Daily aggregated download counts'],
        },
      };

      let requestedUrl = '';
      const client = new ApiClient({
        fetch: async (url) => {
          requestedUrl = url.toString();
          return new Response(JSON.stringify(mockDetail), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const result = await client.getSource('npm_downloads');
      assert.equal(requestedUrl, '/api/v1/sources/npm_downloads');
      assert.deepEqual(result, mockDetail);
    });
  });

  describe('listTopics', () => {
    it('searches topics with query and pagination parameters', async () => {
      const mockTopics: TopicListResponse = {
        requestId: 'req_topics_1',
        items: [
          {
            slug: 'svelte',
            displayName: 'Svelte',
            parent: 'frontend',
            aliases: ['sveltejs', 'sveltekit'],
            taxonomyVersion: '2026-09-01.1',
          },
        ],
        page: {
          nextCursor: null,
          limit: 20,
        },
      };

      let requestedUrl = '';
      const client = new ApiClient({
        baseUrl: 'http://localhost:3000',
        fetch: async (url) => {
          requestedUrl = url.toString();
          return new Response(JSON.stringify(mockTopics), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const result = await client.listTopics({ q: 'svelte', limit: 20 });
      assert.equal(requestedUrl, 'http://localhost:3000/api/v1/topics?q=svelte&limit=20');
      assert.deepEqual(result, mockTopics);
    });
  });

  describe('Error handling', () => {
    it('parses structured ErrorEnvelope from 400 Bad Request', async () => {
      const errorEnvelope = {
        requestId: 'req_err_400',
        error: {
          code: 'INVALID_REQUEST',
          message: 'Invalid pagination cursor',
          details: [{ path: 'cursor', reason: 'invalid_base64' }],
          retryable: false,
        },
      };

      const client = new ApiClient({
        fetch: async () => {
          return new Response(JSON.stringify(errorEnvelope), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_err_400' },
          });
        },
      });

      await assert.rejects(
        async () => {
          await client.listSources({ cursor: 'invalid-cursor' });
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'INVALID_REQUEST');
          assert.equal(err.message, 'Invalid pagination cursor');
          assert.equal(err.retryable, false);
          assert.equal(err.requestId, 'req_err_400');
          assert.equal(err.details.length, 1);
          assert.deepEqual(err.envelope, errorEnvelope);
          return true;
        },
      );
    });

    it('parses 404 Not Found error envelope', async () => {
      const errorEnvelope = {
        requestId: 'req_err_404',
        error: {
          code: 'NOT_FOUND',
          message: "Source 'unknown_src' was not found",
          details: [],
          retryable: false,
        },
      };

      const client = new ApiClient({
        fetch: async () => {
          return new Response(JSON.stringify(errorEnvelope), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      await assert.rejects(
        async () => {
          await client.getSource('unknown_src');
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.status, 404);
          assert.equal(err.code, 'NOT_FOUND');
          return true;
        },
      );
    });

    it('handles non-envelope 503 error responses gracefully', async () => {
      const client = new ApiClient({
        fetch: async () => {
          return new Response('Service Unavailable', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'x-request-id': 'req_503_raw' },
          });
        },
      });

      await assert.rejects(
        async () => {
          await client.getHealthReady();
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.status, 503);
          assert.equal(err.code, 'DEPENDENCY_UNAVAILABLE');
          assert.equal(err.retryable, true);
          assert.equal(err.requestId, 'req_503_raw');
          return true;
        },
      );
    });

    it('throws INVALID_RESPONSE when response fails contract schema validation', async () => {
      const invalidResponse = {
        // Missing status and timestamp
        foo: 'bar',
      };

      const client = new ApiClient({
        fetch: async () => {
          return new Response(JSON.stringify(invalidResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      await assert.rejects(
        async () => {
          await client.getHealthLive();
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.status, 200);
          assert.equal(err.code, 'INVALID_RESPONSE');
          assert.equal(err.retryable, false);
          return true;
        },
      );
    });

    it('handles network failure', async () => {
      const client = new ApiClient({
        fetch: async () => {
          throw new Error('Connection refused');
        },
      });

      await assert.rejects(
        async () => {
          await client.getHealthLive();
        },
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.status, 0);
          assert.equal(err.code, 'NETWORK_ERROR');
          assert.equal(err.retryable, true);
          assert.ok(err.message.includes('Connection refused'));
          return true;
        },
      );
    });
  });

  describe('createAnswer', () => {
    const validAnswerResponse: AnswerResponse = {
      requestId: 'req_test123',
      answerId: 'ans_test456',
      status: 'answered',
      intent: 'compare_interest',
      resolvedTimeRange: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-09-01T00:00:00Z',
        timezone: 'Asia/Seoul',
      },
      answer: 'Bun adoption has increased across deduplicated releases and mentions [C1].',
      observations: [
        {
          subject: 'Bun',
          metric: 'community_mentions',
          value: 42,
          unit: 'deduplicated_documents',
          change: 15,
        },
      ],
      citations: [
        {
          id: 'C1',
          documentRevisionId: 'rev_123',
          title: 'Bun v1.1 Release Notes',
          source: 'github_releases',
          url: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.1.0',
          publishedAt: '2026-08-15T12:00:00Z',
          excerpt: 'Bun 1.1 includes major speed improvements.',
          excerptIsVerbatim: true,
          license: {
            id: 'mit',
            name: 'MIT License',
            url: 'https://opensource.org/licenses/MIT',
            attribution: 'Oven Authors',
          },
        },
      ],
      coverage: {
        dataFreshThrough: '2026-09-01T00:00:00Z',
        sourcesUsed: 1,
        documentsConsidered: 10,
        limitations: [],
      },
    };

    it('posts answer request and returns parsed AnswerResponse on success', async () => {
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody = '';

      const mockFetch: typeof fetch = async (input, init) => {
        capturedUrl = String(input);
        capturedMethod = init?.method ?? 'GET';
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        capturedBody = String(init?.body ?? '');
        return new Response(JSON.stringify(validAnswerResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'req_test123' },
        });
      };

      const client = new ApiClient({ baseUrl: 'https://api.techpulse.dev', fetch: mockFetch });
      const request: AnswerRequest = {
        question: 'Compare Bun and Node.js interest',
        timeRange: {
          from: '2026-08-01T00:00:00Z',
          to: '2026-09-01T00:00:00Z',
        },
        timezone: 'Asia/Seoul',
        language: 'ko',
      };

      const result = await client.createAnswer(request);

      assert.equal(capturedUrl, 'https://api.techpulse.dev/api/v1/answers');
      assert.equal(capturedMethod, 'POST');
      assert.equal(capturedHeaders['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(capturedBody), request);
      assert.deepEqual(result, validAnswerResponse);
    });

    it('handles insufficient_evidence answer response', async () => {
      const insufficientResponse: AnswerResponse = {
        requestId: 'req_test789',
        answerId: 'ans_insufficient',
        status: 'insufficient_evidence',
        intent: 'trend_summary',
        resolvedTimeRange: {
          from: '2026-08-01T00:00:00Z',
          to: '2026-09-01T00:00:00Z',
          timezone: 'UTC',
        },
        answer: null,
        observations: [],
        citations: [],
        coverage: {
          dataFreshThrough: '2026-09-01T00:00:00Z',
          sourcesUsed: 0,
          documentsConsidered: 0,
          limitations: ['요청 기간의 근거가 충분하지 않습니다.'],
        },
      };

      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify(insufficientResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const client = new ApiClient({ fetch: mockFetch });
      const result = await client.createAnswer({ question: 'Unknown niche topic query' });

      assert.equal(result.status, 'insufficient_evidence');
      assert.equal(result.answer, null);
      assert.equal(result.citations.length, 0);
      assert.deepEqual(result.coverage.limitations, ['요청 기간의 근거가 충분하지 않습니다.']);
    });

    it('throws ContractValidationError wrapped in ApiClientError on schema violation', async () => {
      const invalidResponse = {
        requestId: 'req_invalid',
        status: 'answered',
        // missing answerId, resolvedTimeRange, coverage, citations, etc.
      };

      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify(invalidResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const client = new ApiClient({ fetch: mockFetch });
      await assert.rejects(
        () => client.createAnswer({ question: 'Test question' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.code, 'INVALID_RESPONSE');
          assert.ok(err.message.includes('AnswerResponse'));
          return true;
        },
      );
    });

    it('throws ApiClientError with ErrorEnvelope details when server returns 400', async () => {
      const errorEnvelope = {
        requestId: 'req_err400',
        error: {
          code: 'INVALID_REQUEST' as const,
          message: 'Question must not be empty',
          details: [{ path: 'question', reason: 'minLength' }],
          retryable: false,
        },
      };

      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify(errorEnvelope), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const client = new ApiClient({ fetch: mockFetch });
      await assert.rejects(
        () => client.createAnswer({ question: '' }),
        (err: unknown) => {
          assert.ok(err instanceof ApiClientError);
          assert.equal(err.code, 'INVALID_REQUEST');
          assert.equal(err.status, 400);
          assert.equal(err.details[0]?.path, 'question');
          return true;
        },
      );
    });
  });

  describe('getAnswerEndpointStatus', () => {
    it('reports answer endpoint as operational following API-003 integration', () => {
      const client = createApiClient();
      const status = client.getAnswerEndpointStatus();
      assert.equal(status.available, true);
      assert.ok(status.reason.length > 0);
    });
  });
});

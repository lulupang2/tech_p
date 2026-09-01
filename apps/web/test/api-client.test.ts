import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { ApiClient, ApiClientError, createApiClient } from '../src/lib/api-client.js';
import type {
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

  describe('getAnswerEndpointStatus', () => {
    it('reports answer endpoint as blocked/unavailable per API-003', () => {
      const client = createApiClient();
      const status = client.getAnswerEndpointStatus();
      assert.equal(status.available, false);
      assert.equal(status.blockedTicket, 'API-003');
      assert.ok(status.reason.length > 0);
    });
  });
});

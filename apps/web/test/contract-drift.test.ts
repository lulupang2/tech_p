import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  parseHealthLiveResponse,
  parseHealthReadyResponse,
  parseSourceDetailResponse,
  parseSourceListResponse,
  parseTopicListResponse,
  type HealthLiveResponse,
  type HealthReadyResponse,
  type SourceDetailResponse,
  type SourceListResponse,
  type TopicListResponse,
} from '@techpulse/contracts';
import { ApiClient, ApiClientError } from '../src/lib/api-client.js';

describe('API Contract Drift Validation', () => {
  it('validates HealthLiveResponse contract alignment', async () => {
    const validLive: HealthLiveResponse = {
      status: 'ok',
      timestamp: '2026-09-02T12:00:00.000Z',
    };

    assert.doesNotThrow(() => parseHealthLiveResponse(validLive));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(validLive), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.getHealthLive();
    assert.deepEqual(result, validLive);
  });

  it('validates HealthReadyResponse contract alignment', async () => {
    const validReady: HealthReadyResponse = {
      status: 'ok',
      timestamp: '2026-09-02T12:00:00.000Z',
      dependencies: {
        database: 'ok',
      },
    };

    assert.doesNotThrow(() => parseHealthReadyResponse(validReady));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(validReady), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.getHealthReady();
    assert.deepEqual(result, validReady);
  });

  it('validates SourceListResponse contract alignment and rejects extra fields', async () => {
    const validSources: SourceListResponse = {
      requestId: 'req_sources_drift',
      items: [
        {
          key: 'github_releases',
          displayName: 'GitHub Releases',
          kind: 'release_notes',
          status: 'healthy',
          freshThrough: '2026-09-02T12:00:00.000Z',
          lastSuccessfulCollectionAt: '2026-09-02T12:00:00.000Z',
          coverageNotes: ['Verified public release tags'],
        },
      ],
      page: {
        nextCursor: null,
        limit: 20,
      },
    };

    assert.doesNotThrow(() => parseSourceListResponse(validSources));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(validSources), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.listSources();
    assert.deepEqual(result, validSources);

    // If server introduces undeclared fields in items, it must fail contract validation
    const driftedPayload = {
      ...validSources,
      items: [
        {
          ...validSources.items[0],
          unknownSecretField: 'leak',
        },
      ],
    };

    const driftedClient = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(driftedPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await assert.rejects(
      async () => {
        await driftedClient.listSources();
      },
      (err: unknown) => {
        assert.ok(err instanceof ApiClientError);
        assert.equal(err.code, 'INVALID_RESPONSE');
        return true;
      },
    );
  });

  it('validates SourceDetailResponse contract alignment', async () => {
    const validDetail: SourceDetailResponse = {
      requestId: 'req_detail_drift',
      source: {
        key: 'arxiv',
        displayName: 'arXiv',
        kind: 'research_papers',
        status: 'healthy',
        freshThrough: '2026-09-02T12:00:00.000Z',
        lastSuccessfulCollectionAt: '2026-09-02T12:00:00.000Z',
        coverageNotes: ['Computer Science arXiv categories (cs.AI, cs.SE)'],
      },
    };

    assert.doesNotThrow(() => parseSourceDetailResponse(validDetail));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(validDetail), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.getSource('arxiv');
    assert.deepEqual(result, validDetail);
  });

  it('validates TopicListResponse contract alignment', async () => {
    const validTopics: TopicListResponse = {
      requestId: 'req_topics_drift',
      items: [
        {
          slug: 'postgresql',
          displayName: 'PostgreSQL',
          parent: 'database',
          aliases: ['postgres', 'pgsql'],
          taxonomyVersion: '2026-09-01.1',
        },
      ],
      page: {
        nextCursor: 'next_page_token',
        limit: 10,
      },
    };

    assert.doesNotThrow(() => parseTopicListResponse(validTopics));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(validTopics), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.listTopics();
    assert.deepEqual(result, validTopics);
  });
});

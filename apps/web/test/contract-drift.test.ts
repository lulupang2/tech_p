import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  parseAnswerResponse,
  parseHealthLiveResponse,
  parseHealthReadyResponse,
  parseSourceDetailResponse,
  parseSourceListResponse,
  parseTopicListResponse,
  type AnswerResponse,
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

  it('validates AnswerResponse contract alignment and handles answered response', async () => {
    const validAnswer: AnswerResponse = {
      requestId: 'req_ans_drift_1',
      answerId: 'ans_drift_1',
      status: 'answered',
      intent: 'compare_interest',
      resolvedTimeRange: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-09-01T00:00:00Z',
        timezone: 'Asia/Seoul',
      },
      answer: 'Bun showed rapid adoption and release cadence compared to Node.js [C1].',
      observations: [
        {
          subject: 'Bun',
          metric: 'community_mentions',
          value: 128,
          unit: 'deduplicated_documents',
          change: 22.5,
        },
      ],
      citations: [
        {
          id: 'C1',
          documentRevisionId: 'rev_bun_1',
          title: 'Bun 1.1 Announcement',
          source: 'github_releases',
          url: 'https://github.com/oven-sh/bun/releases',
          publishedAt: '2026-08-15T00:00:00Z',
          excerpt: 'Bun 1.1 brings Windows support and Node compatibility.',
          excerptIsVerbatim: true,
          license: {
            id: 'mit',
            name: 'MIT',
            url: 'https://opensource.org/licenses/MIT',
            attribution: 'Oven Authors',
          },
        },
      ],
      coverage: {
        dataFreshThrough: '2026-09-01T00:00:00Z',
        sourcesUsed: 1,
        documentsConsidered: 5,
        limitations: [],
      },
    };

    assert.doesNotThrow(() => parseAnswerResponse(validAnswer));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(validAnswer), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.createAnswer({ question: 'Bun vs Node.js comparison' });
    assert.deepEqual(result, validAnswer);
  });

  it('validates AnswerResponse contract alignment for insufficient_evidence', async () => {
    const insufficientAnswer: AnswerResponse = {
      requestId: 'req_ans_drift_2',
      answerId: 'ans_drift_2',
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

    assert.doesNotThrow(() => parseAnswerResponse(insufficientAnswer));

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(insufficientAnswer), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    const result = await client.createAnswer({ question: 'Unindexed library' });
    assert.deepEqual(result, insufficientAnswer);
  });

  it('rejects AnswerResponse with schema drift or extra fields', async () => {
    const driftedAnswer = {
      requestId: 'req_ans_drift_3',
      answerId: 'ans_drift_3',
      status: 'answered',
      intent: 'compare_interest',
      resolvedTimeRange: {
        from: '2026-08-01T00:00:00Z',
        to: '2026-09-01T00:00:00Z',
        timezone: 'UTC',
      },
      answer: 'Valid text',
      observations: [],
      citations: [],
      coverage: {
        dataFreshThrough: '2026-09-01T00:00:00Z',
        sourcesUsed: 0,
        documentsConsidered: 0,
        limitations: [],
      },
      hallucinatedField: 'drift_value',
    };

    const client = new ApiClient({
      fetch: async () =>
        new Response(JSON.stringify(driftedAnswer), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });

    await assert.rejects(
      () => client.createAnswer({ question: 'test' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiClientError);
        assert.equal(err.code, 'INVALID_RESPONSE');
        return true;
      },
    );
  });
});

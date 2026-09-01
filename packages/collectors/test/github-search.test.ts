import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  GitHubSearchCollector,
  GitHubSearchAuthenticationError,
  GitHubSearchRateLimitError,
  GitHubSearchHttpError,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  type GitHubSearchCursor,
} from '../src/index.js';
import type { CollectionContext } from '@techpulse/domain';

const SAMPLE_REPO_ITEM = {
  id: 1024,
  node_id: 'MDEwOlJlcG9zaXRvcnkxMDI0',
  name: 'techpulse-core',
  full_name: 'techpulse/techpulse-core',
  private: false,
  owner: {
    login: 'secret-developer',
    id: 9999,
    avatar_url: 'https://avatars.githubusercontent.com/u/9999',
    gravatar_id: 'secret-gravatar',
    html_url: 'https://github.com/secret-developer',
  },
  html_url: 'https://github.com/techpulse/techpulse-core',
  description: 'TechPulse collection engine',
  fork: false,
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-09-01T12:00:00Z',
  pushed_at: '2026-09-02T08:00:00Z',
  homepage: 'https://techpulse.dev',
  size: 1024,
  stargazers_count: 520,
  watchers_count: 520,
  language: 'TypeScript',
  forks_count: 42,
  open_issues_count: 5,
  topics: ['typescript', 'rss', 'collector'],
  visibility: 'public',
  default_branch: 'main',
};

const SAMPLE_ISSUE_ITEM = {
  id: 2048,
  node_id: 'MDU6SXNzdWUyMDQ4',
  number: 42,
  title: 'Discussion on TypeScript backend signals',
  body: 'RFC for metric collection pipelines',
  user: {
    login: 'pii-user-alice',
    id: 8888,
    avatar_url: 'https://avatars.githubusercontent.com/u/8888',
    html_url: 'https://github.com/pii-user-alice',
  },
  labels: [{ id: 1, name: 'enhancement' }],
  state: 'open',
  locked: false,
  assignee: {
    login: 'pii-user-bob',
    id: 7777,
  },
  assignees: [
    {
      login: 'pii-user-bob',
      id: 7777,
    },
  ],
  milestone: {
    id: 1,
    title: 'v1.0 Milestone',
    creator: {
      login: 'pii-user-charlie',
      id: 6666,
    },
  },
  comments: 28,
  created_at: '2026-08-15T10:00:00Z',
  updated_at: '2026-09-01T15:30:00Z',
  closed_at: null,
  author_association: 'MEMBER',
  reactions: {
    url: 'https://api.github.com/repos/techpulse/techpulse-core/issues/42/reactions',
    total_count: 65,
    '+1': 50,
    heart: 15,
  },
  html_url: 'https://github.com/techpulse/techpulse-core/issues/42',
};

function createJsonResponse(
  payload: unknown,
  options: {
    status?: number;
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': '30',
      'x-ratelimit-remaining': '29',
      'x-ratelimit-reset': '1788285600',
      'x-ratelimit-used': '1',
      'x-ratelimit-resource': 'search',
      ...options.headers,
    },
  });
}

describe('COL-009 GitHub Search Collector', () => {
  const baseContext: CollectionContext = {
    sourceKey: 'github_search',
    cursor: null,
  };

  describe('Missing PAT Refusal & Unauthenticated Requests (SOURCE_CATALOG §11)', () => {
    test('refuses collection immediately without making network calls when PAT is absent', async () => {
      let fetchCalled = false;
      const originalPat = process.env['GITHUB_PAT'];
      const originalToken = process.env['GITHUB_TOKEN'];
      delete process.env['GITHUB_PAT'];
      delete process.env['GITHUB_TOKEN'];

      try {
        const collector = new GitHubSearchCollector(
          {},
          {
            fetch: (async () => {
              fetchCalled = true;
              return createJsonResponse({});
            }) as typeof fetch,
          },
        );

        await assert.rejects(
          async () => {
            await collector.collect(baseContext);
          },
          (err: unknown) => {
            assert(err instanceof GitHubSearchAuthenticationError);
            assert.match(err.message, /PAT.*required/i);
            assert.match(err.message, /Unauthenticated requests are not permitted/i);
            return true;
          },
        );

        assert.equal(fetchCalled, false, 'Fetch must never be invoked when PAT is missing');
      } finally {
        if (originalPat) process.env['GITHUB_PAT'] = originalPat;
        if (originalToken) process.env['GITHUB_TOKEN'] = originalToken;
      }
    });

    test('refuses collection if PAT is whitespace only', async () => {
      let fetchCalled = false;
      const collector = new GitHubSearchCollector(
        { pat: '   ' },
        {
          fetch: (async () => {
            fetchCalled = true;
            return createJsonResponse({});
          }) as typeof fetch,
        },
      );

      await assert.rejects(async () => {
        await collector.collect(baseContext);
      }, GitHubSearchAuthenticationError);

      assert.equal(fetchCalled, false);
    });
  });

  describe('Per-Page Cap (<= 100) & 1,000 Search Results Cap', () => {
    test('clamps per_page to maximum 100 even if larger perPage or limit is requested', async () => {
      let requestedUrl = '';
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token', perPage: 250 },
        {
          fetch: (async (url: string | URL | Request) => {
            requestedUrl = url.toString();
            return createJsonResponse({
              total_count: 500,
              incomplete_results: false,
              items: [SAMPLE_REPO_ITEM],
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect({
        ...baseContext,
        limit: 500,
      });

      const parsedUrl = new URL(requestedUrl);
      assert.equal(parsedUrl.searchParams.get('per_page'), '100');
      assert.equal(result.items.length, 1);
    });

    test('enforces 1,000 max results total across pagination and stops hasMore', async () => {
      const itemsPage = Array.from({ length: 100 }, (_, i) => ({
        ...SAMPLE_REPO_ITEM,
        id: 1000 + i,
        full_name: `techpulse/repo-${i}`,
      }));

      // Simulate being on page 10 where totalFetched already reaches 900
      const cursorData: GitHubSearchCursor = {
        endpoint: 'repositories',
        query: 'topic:typescript',
        queryVersion: 'v1',
        page: 10,
        totalFetched: 900,
        lastCollectedAt: '2026-09-01T00:00:00Z',
      };
      const cursor = encodeOpaqueCursor(cursorData);

      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token', perPage: 100 },
        {
          fetch: (async () => {
            return createJsonResponse({
              total_count: 5000, // API reports 5,000 matches, but search is capped at 1,000
              incomplete_results: false,
              items: itemsPage,
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect({
        sourceKey: 'github_search',
        cursor,
      });

      assert.equal(result.items.length, 100);
      assert.equal(result.hasMore, false, 'hasMore must be false when 1,000 result cap is reached');
      assert.equal(
        result.nextCursor,
        null,
        'nextCursor must be null when 1,000 result cap is reached',
      );
    });

    test('returns empty results without request when totalFetched already equals or exceeds 1,000', async () => {
      let fetchCalled = false;
      const cursorData: GitHubSearchCursor = {
        endpoint: 'repositories',
        query: 'topic:typescript',
        queryVersion: 'v1',
        page: 11,
        totalFetched: 1000,
        lastCollectedAt: '2026-09-01T00:00:00Z',
      };
      const cursor = encodeOpaqueCursor(cursorData);

      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token' },
        {
          fetch: (async () => {
            fetchCalled = true;
            return createJsonResponse({});
          }) as typeof fetch,
        },
      );

      const result = await collector.collect({
        sourceKey: 'github_search',
        cursor,
      });

      assert.equal(fetchCalled, false);
      assert.equal(result.items.length, 0);
      assert.equal(result.hasMore, false);
      assert.equal(result.nextCursor, null);
    });
  });

  describe('Rate Throttling & 30/min Enforcement', () => {
    test('throttles consecutive requests according to minimum rate interval', async () => {
      let currentTime = 10000;
      const sleepDelays: number[] = [];

      const mockClock = {
        now: () => currentTime,
      };
      const mockSleep = async (ms: number) => {
        sleepDelays.push(ms);
        currentTime += ms;
      };

      const collector = new GitHubSearchCollector(
        {
          pat: 'ghp_test_token',
          minRequestIntervalMs: 2000, // 30 req/min = 2,000ms
        },
        {
          clock: mockClock,
          sleep: mockSleep,
          fetch: (async () => {
            return createJsonResponse({
              total_count: 10,
              incomplete_results: false,
              items: [SAMPLE_REPO_ITEM],
            });
          }) as typeof fetch,
        },
      );

      // First collection request
      await collector.collect(baseContext);
      assert.equal(sleepDelays.length, 0, 'First request should not be delayed');

      // Advance clock by 500ms (less than 2000ms minimum interval)
      currentTime += 500;

      // Second collection request
      await collector.collect(baseContext);
      assert.equal(sleepDelays.length, 1);
      assert.equal(sleepDelays[0], 1500, 'Second request must sleep for remaining 1500ms');
    });

    test('handles 403 / 429 rate limit errors with reset timestamp and remaining count', async () => {
      const resetEpochSeconds = 1788285600;
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token' },
        {
          fetch: (async () => {
            return createJsonResponse(
              { message: 'API rate limit exceeded for user' },
              {
                status: 403,
                headers: {
                  'x-ratelimit-remaining': '0',
                  'x-ratelimit-reset': String(resetEpochSeconds),
                },
              },
            );
          }) as typeof fetch,
        },
      );

      await assert.rejects(
        async () => {
          await collector.collect(baseContext);
        },
        (err: unknown) => {
          assert(err instanceof GitHubSearchRateLimitError);
          assert.equal(err.remaining, 0);
          assert.equal(err.resetAt?.getTime(), resetEpochSeconds * 1000);
          return true;
        },
      );
    });
  });

  describe('Incomplete Results Propagation', () => {
    test('propagates incomplete_results flag to item metadata and cursor payload', async () => {
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token', perPage: 1 },
        {
          fetch: (async () => {
            return createJsonResponse({
              total_count: 200,
              incomplete_results: true,
              items: [SAMPLE_REPO_ITEM],
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect(baseContext);

      assert.equal(result.items.length, 1);
      const item = result.items[0]!;
      assert.equal(item.metadata?.['incompleteResults'], true);

      assert(result.nextCursor);
      const cursor = decodeOpaqueCursor<GitHubSearchCursor>(result.nextCursor);
      assert.equal(cursor?.incompleteResults, true);
    });
  });

  describe('Query Snapshot Reproducibility & Metadata', () => {
    test('records query string, version, timestamp, rank, and totalCount snapshot metadata', async () => {
      const fixedTimestamp = 1756800000000;
      const mockClock = { now: () => fixedTimestamp };

      const collector = new GitHubSearchCollector(
        {
          pat: 'ghp_test_token',
          query: 'topic:typescript created:>2026-01-01 stars:>50',
          queryVersion: 'v2.1',
          sort: 'stars',
          order: 'desc',
        },
        {
          clock: mockClock,
          fetch: (async () => {
            return createJsonResponse({
              total_count: 42,
              incomplete_results: false,
              items: [SAMPLE_REPO_ITEM],
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect(baseContext);
      assert.equal(result.items.length, 1);
      const metadata = result.items[0]!.metadata;

      assert.equal(metadata?.['queryString'], 'topic:typescript created:>2026-01-01 stars:>50');
      assert.equal(metadata?.['queryVersion'], 'v2.1');
      assert.equal(metadata?.['collectedAt'], new Date(fixedTimestamp).toISOString());
      assert.equal(metadata?.['collectedTimestamp'], fixedTimestamp);
      assert.equal(metadata?.['searchRank'], 1);
      assert.equal(metadata?.['totalCount'], 42);
      assert.equal(metadata?.['canonicalUrl'], 'https://github.com/techpulse/techpulse-core');
      assert.equal(metadata?.['repository'], 'techpulse/techpulse-core');
      assert.equal(metadata?.['stargazersCount'], 520);
    });
  });

  describe('PII Stripping (SECURITY.md §8)', () => {
    test('strips owner object from repositories search payload before raw persistence', async () => {
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token' },
        {
          fetch: (async () => {
            return createJsonResponse({
              total_count: 1,
              incomplete_results: false,
              items: [SAMPLE_REPO_ITEM],
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect(baseContext);
      const item = result.items[0]!;

      // Verify PII is stripped from payload
      assert.equal(
        'owner' in item.payload,
        false,
        'owner must be stripped from repository payload',
      );
      assert.equal(
        JSON.stringify(item.payload).includes('secret-developer'),
        false,
        'PII login must not appear in raw payload',
      );

      // Verify non-PII fields remain intact
      assert.equal(item.payload['name'], 'techpulse-core');
      assert.equal(item.payload['full_name'], 'techpulse/techpulse-core');
      assert.equal(item.payload['stargazers_count'], 520);
    });

    test('strips user, assignee, assignees, and milestone.creator from issues search payload', async () => {
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token', endpoint: 'issues' },
        {
          fetch: (async () => {
            return createJsonResponse({
              total_count: 1,
              incomplete_results: false,
              items: [SAMPLE_ISSUE_ITEM],
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect(baseContext);
      const item = result.items[0]!;

      // Verify PII stripped
      assert.equal('user' in item.payload, false, 'user must be stripped from issue payload');
      assert.equal('assignee' in item.payload, false, 'assignee must be stripped');
      assert.equal('assignees' in item.payload, false, 'assignees must be stripped');

      const milestone = item.payload['milestone'] as Record<string, unknown> | undefined;
      assert.ok(milestone);
      assert.equal('creator' in milestone, false, 'milestone.creator must be stripped');

      const serialized = JSON.stringify(item.payload);
      assert.equal(serialized.includes('pii-user-alice'), false);
      assert.equal(serialized.includes('pii-user-bob'), false);
      assert.equal(serialized.includes('pii-user-charlie'), false);

      // Verify non-PII metadata and payload intact
      assert.equal(item.payload['number'], 42);
      assert.equal(item.payload['title'], 'Discussion on TypeScript backend signals');
      assert.equal(item.metadata?.['issueNumber'], 42);
      assert.equal(item.metadata?.['commentsCount'], 28);
      assert.equal(item.metadata?.['reactionsCount'], 65);
    });
  });

  describe('No Historical Star Backfill (SOURCE_CATALOG §11)', () => {
    test('does not make external stargazers timeline calls and captures only point-in-time snapshot', async () => {
      const requestedUrls: string[] = [];
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token', endpoint: 'repositories', query: 'stars:>500' },
        {
          fetch: (async (url: string | URL | Request) => {
            requestedUrls.push(url.toString());
            return createJsonResponse({
              total_count: 1,
              incomplete_results: false,
              items: [SAMPLE_REPO_ITEM],
            });
          }) as typeof fetch,
        },
      );

      const result = await collector.collect(baseContext);

      // Verify only the search endpoint was queried
      assert.equal(requestedUrls.length, 1);
      assert.match(requestedUrls[0]!, /^https:\/\/api\.github\.com\/search\/repositories/);
      assert.equal(
        requestedUrls.some((u) => u.includes('/stargazers')),
        false,
        'Must never call /stargazers timeline API',
      );

      // Verify snapshot point-in-time values
      assert.equal(result.items[0]!.metadata?.['stargazersCount'], 520);
      assert.equal(result.items[0]!.metadata?.['forksCount'], 42);
    });
  });

  describe('Source Policy & HTTP Error Handling', () => {
    test('throws GitHubSearchHttpError on general non-2xx responses', async () => {
      const collector = new GitHubSearchCollector(
        { pat: 'ghp_test_token' },
        {
          fetch: (async () => {
            return createJsonResponse(
              { message: 'Validation Failed: query invalid' },
              { status: 422 },
            );
          }) as typeof fetch,
        },
      );

      await assert.rejects(
        async () => {
          await collector.collect(baseContext);
        },
        (err: unknown) => {
          assert(err instanceof GitHubSearchHttpError);
          assert.equal(err.status, 422);
          assert.match(err.message, /Validation Failed/);
          return true;
        },
      );
    });
  });
});

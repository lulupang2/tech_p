import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { decodeOpaqueCursor, encodeOpaqueCursor, GitHubReleasesCollector } from '../src/index.js';

const release = {
  id: 123,
  tag_name: 'v1.2.3',
  name: 'v1.2.3',
  body: 'Release notes',
  draft: false,
  prerelease: false,
  published_at: '2026-09-01T12:00:00Z',
  created_at: '2026-08-31T12:00:00Z',
  html_url: 'https://github.com/example/project/releases/tag/v1.2.3',
  tarball_url: 'https://api.github.com/repos/example/project/tarball/v1.2.3',
  zipball_url: 'https://api.github.com/repos/example/project/zipball/v1.2.3',
  author: { login: 'octocat', id: 1 },
  assets: [
    {
      name: 'release.zip',
      uploader: { login: 'maintainer', id: 2 },
    },
  ],
};

function response(
  payload: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(options.status === 304 ? null : JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: options.headers,
  });
}

describe('COL-002 GitHub Releases collector', () => {
  test('uses authenticated conditional requests and preserves rate headers in its opaque cursor', async () => {
    let request: RequestInit | undefined;
    const collector = new GitHubReleasesCollector(
      { owner: 'example', repo: 'project', pat: 'test-pat', perPage: 1 },
      {
        fetch: async (_url, init) => {
          request = init;
          return response([release], {
            headers: {
              etag: '"release-etag"',
              link: '<https://api.github.com/repos/example/project/releases?page=2>; rel="next"',
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '4999',
              'x-ratelimit-reset': '1788285600',
              'content-length': '42',
            },
          });
        },
      },
    );

    const result = await collector.collect({ sourceKey: 'github_releases', cursor: null });

    assert.equal((request?.headers as Record<string, string>).Authorization, 'Bearer test-pat');
    assert.equal(result.hasMore, true);
    assert.equal(result.metrics?.itemsFetched, 1);
    assert.equal(result.metrics?.bytesFetched, 42);

    const cursor = decodeOpaqueCursor<{
      etag: string;
      page: number;
      rateLimit: { limit: number; remaining: number; reset: number };
    }>(result.nextCursor!);
    assert.equal(cursor.etag, '"release-etag"');
    assert.equal(cursor.page, 2);
    assert.deepEqual(cursor.rateLimit, { limit: 5000, remaining: 4999, reset: 1788285600 });
  });

  test('returns no items for an ETag 304 response without parsing a response body', async () => {
    const inputCursor = encodeOpaqueCursor({ etag: '"release-etag"' });
    let request: RequestInit | undefined;
    const collector = new GitHubReleasesCollector(
      { owner: 'example', repo: 'project' },
      {
        fetch: async (_url, init) => {
          request = init;
          return response([], { status: 304 });
        },
      },
    );

    const result = await collector.collect({ sourceKey: 'github_releases', cursor: inputCursor });

    assert.equal((request?.headers as Record<string, string>)['If-None-Match'], '"release-etag"');
    assert.deepEqual(result.items, []);
    assert.equal(result.nextCursor, inputCursor);
    assert.equal(result.metrics?.itemsFetched, 0);
  });

  test('stores published_at, never created_at, and removes GitHub author PII before raw persistence', async () => {
    const collector = new GitHubReleasesCollector(
      { owner: 'example', repo: 'project' },
      { fetch: async () => response([release]) },
    );

    const result = await collector.collect({ sourceKey: 'github_releases', cursor: null });
    const item = result.items[0]!;
    const payload = item.payload as {
      created_at?: string;
      author?: unknown;
      assets?: Array<{ uploader?: unknown }>;
    };

    assert.equal(item.externalId, '123');
    assert.equal(item.publishedAt?.toISOString(), '2026-09-01T12:00:00.000Z');
    assert.equal(item.metadata?.canonicalUrl, release.html_url);
    assert.equal(payload.created_at, undefined);
    assert.equal(payload.author, undefined);
    assert.equal(payload.assets?.[0]?.uploader, undefined);
  });

  test('excludes drafts and emits opaque incremental cursors', async () => {
    const collector = new GitHubReleasesCollector(
      { owner: 'example', repo: 'project' },
      {
        fetch: async () => response([{ ...release, draft: true, id: 122 }, release]),
      },
    );

    const result = await collector.collect({ sourceKey: 'github_releases', cursor: null });
    assert.equal(result.items.length, 1);
    assert.notEqual(result.nextCursor, '2026-09-01T12:00:00Z');
    assert.equal(
      decodeOpaqueCursor<{ lastPublishedAt: string }>(result.nextCursor!).lastPublishedAt,
      '2026-09-01T12:00:00Z',
    );
  });

  test('supports multi-target repositories (Bun, Node, Playwright, TS, React) and cycles cursors across repos', async () => {
    const requestedUrls: string[] = [];
    const collector = new GitHubReleasesCollector(
      {
        repositories: [
          { owner: 'microsoft', repo: 'playwright' },
          { owner: 'oven-sh', repo: 'bun' },
        ],
      },
      {
        fetch: async (url) => {
          requestedUrls.push(url.toString());
          if (url.toString().includes('bun')) {
            return response([
              {
                ...release,
                id: 456,
                tag_name: 'bun-v1.1.27',
                html_url: 'https://github.com/oven-sh/bun/releases/tag/bun-v1.1.27',
              },
            ]);
          }
          return response([
            {
              ...release,
              id: 123,
              tag_name: 'v1.47.0',
              html_url: 'https://github.com/microsoft/playwright/releases/tag/v1.47.0',
            },
          ]);
        },
      },
    );

    // First run: microsoft/playwright
    const run1 = await collector.collect({ sourceKey: 'github_releases', cursor: null });
    assert.equal(
      requestedUrls[0],
      'https://api.github.com/repos/microsoft/playwright/releases?per_page=30',
    );
    assert.equal(run1.items.length, 1);
    assert.equal(run1.items[0]?.metadata?.repository, 'microsoft/playwright');
    assert.ok(run1.nextCursor);

    const decoded1 = decodeOpaqueCursor<{
      repoIndex: number;
      repositoryCursors: Record<string, unknown>;
    }>(run1.nextCursor!);
    assert.equal(decoded1?.repoIndex, 1);

    // Second run: oven-sh/bun
    const run2 = await collector.collect({ sourceKey: 'github_releases', cursor: run1.nextCursor });
    assert.equal(requestedUrls[1], 'https://api.github.com/repos/oven-sh/bun/releases?per_page=30');
    assert.equal(run2.items.length, 1);
    assert.equal(run2.items[0]?.metadata?.repository, 'oven-sh/bun');
    assert.ok(run2.nextCursor);

    const decoded2 = decodeOpaqueCursor<{ repoIndex: number }>(run2.nextCursor!);
    assert.equal(decoded2?.repoIndex, 0); // cycled back to 0
  });
});

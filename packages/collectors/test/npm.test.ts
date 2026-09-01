import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  NpmRegistryCollector,
  NpmDownloadsCollector,
  NpmCollector,
  NpmRateLimitError,
  NpmPackageNotFoundError,
  NpmHttpError,
  NpmCollectorError,
} from '../src/index.js';
import type { CollectionContext } from '@techpulse/domain';

// Fixture 1: Realistic NPM Packument with PII emails (author, maintainers, publisher, _npmUser, contributors)
const SAMPLE_REGISTRY_PACKUMENT = {
  _id: 'sample-lib',
  name: 'sample-lib',
  description: 'A sample library for testing',
  'dist-tags': {
    latest: '1.2.0',
    beta: '1.3.0-beta.1',
  },
  license: 'MIT',
  author: {
    name: 'Alice Developer',
    email: 'alice@secret-domain.com',
    url: 'https://alice.dev',
  },
  _npmUser: {
    name: 'alice_npm',
    email: 'alice-personal@secret-domain.com',
  },
  maintainers: [
    { name: 'alice_npm', email: 'alice-maintainer@secret-domain.com' },
    { name: 'bob_npm', email: 'bob-maintainer@secret-domain.com' },
  ],
  contributors: [{ name: 'Charlie', email: 'charlie@secret-domain.com' }],
  time: {
    created: '2024-01-01T00:00:00.000Z',
    modified: '2024-06-15T12:00:00.000Z',
    '1.0.0': '2024-01-10T10:00:00.000Z',
    '1.2.0': '2024-06-15T12:00:00.000Z',
  },
  versions: {
    '1.0.0': {
      name: 'sample-lib',
      version: '1.0.0',
      description: 'Initial release',
      main: 'index.js',
      license: 'MIT',
      author: {
        name: 'Alice Developer',
        email: 'alice-v1@secret-domain.com',
      },
      maintainers: [{ name: 'alice_npm', email: 'alice-v1-m@secret-domain.com' }],
      _npmUser: {
        name: 'alice_npm',
        email: 'alice-v1-u@secret-domain.com',
      },
      dependencies: {
        lodash: '^4.17.21',
      },
    },
    '1.2.0': {
      name: 'sample-lib',
      version: '1.2.0',
      description: 'Updated release',
      main: 'index.js',
      types: 'index.d.ts',
      license: 'Apache-2.0',
      author: {
        name: 'Alice Developer',
        email: 'alice-v12@secret-domain.com',
      },
      maintainers: [
        { name: 'alice_npm', email: 'alice-v12-m@secret-domain.com' },
        { name: 'bob_npm', email: 'bob-v12-m@secret-domain.com' },
      ],
      publisher: {
        name: 'bob_npm',
        email: 'bob-publisher@secret-domain.com',
      },
      dependencies: {
        lodash: '^4.17.21',
        debug: '^4.3.4',
      },
      devDependencies: {
        vitest: '^1.0.0',
      },
    },
  },
};

// Fixture 2: Point downloads response
const SAMPLE_POINT_DOWNLOADS = {
  downloads: 4829103,
  start: '2026-08-25',
  end: '2026-08-31',
  package: 'typescript',
};

// Fixture 3: Range downloads response
const SAMPLE_RANGE_DOWNLOADS = {
  start: '2026-08-25',
  end: '2026-08-27',
  package: 'typescript',
  downloads: [
    { downloads: 1200000, day: '2026-08-25' },
    { downloads: 1350000, day: '2026-08-26' },
    { downloads: 1400000, day: '2026-08-27' },
  ],
};

// Fixture 4: Low volume range downloads
const SAMPLE_LOW_VOLUME_DOWNLOADS = {
  start: '2026-08-25',
  end: '2026-08-26',
  package: 'rare-niche-package',
  downloads: [
    { downloads: 42, day: '2026-08-25' },
    { downloads: 15, day: '2026-08-26' },
  ],
};

function createMockResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const textBody = typeof body === 'string' ? body : JSON.stringify(body);
  const normalizedHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[key.toLowerCase()] = value;
  }

  return {
    status,
    statusText: status === 200 ? 'OK' : status === 304 ? 'Not Modified' : 'Error',
    ok: status >= 200 && status < 300,
    headers: {
      get: (key: string) => normalizedHeaders[key.toLowerCase()] ?? null,
    },
    text: async () => textBody,
    json: async () => JSON.parse(textBody),
  } as unknown as Response;
}

describe('COL-004 npm Collector Adapter Contract Tests', () => {
  describe('NpmRegistryCollector (SOURCE_CATALOG §9 & SECURITY.md §8)', () => {
    test('fetches registry metadata and extracts version items with canonical identifiers', async () => {
      const mockFetch: typeof globalThis.fetch = async (url) => {
        assert.ok(String(url).includes('sample-lib'));
        return createMockResponse(200, SAMPLE_REGISTRY_PACKUMENT, {
          ETag: 'W/"sample-etag-123"',
          'Content-Length': '1024',
        });
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['sample-lib'],
      });

      const context: CollectionContext = {
        sourceKey: 'npm_registry',
        cursor: null,
      };

      const result = await collector.collect(context);

      assert.equal(result.sourceKey, 'npm_registry');
      assert.equal(result.items.length, 2);
      assert.equal(result.metrics?.itemsFetched, 2);
      assert.ok((result.metrics?.bytesFetched ?? 0) > 0);

      // Verify external_id format: {name}@{version}
      const item1 = result.items.find((it) => it.externalId === 'sample-lib@1.0.0');
      const item2 = result.items.find((it) => it.externalId === 'sample-lib@1.2.0');

      assert.ok(item1);
      assert.ok(item2);

      // Verify published_at matching time object
      assert.equal(item1.publishedAt?.toISOString(), '2024-01-10T10:00:00.000Z');
      assert.equal(item2.publishedAt?.toISOString(), '2024-06-15T12:00:00.000Z');

      // Verify metadata preservation
      assert.equal(item2.metadata?.['package'], 'sample-lib');
      assert.equal(item2.metadata?.['version'], '1.2.0');
      assert.equal(item2.metadata?.['license'], 'Apache-2.0');
      assert.equal(item2.metadata?.['isLatest'], true);
      assert.equal(item2.metadata?.['dependenciesCount'], 2);
      assert.equal(item2.metadata?.['devDependenciesCount'], 1);
      assert.equal(item2.metadata?.['canonicalUrl'], 'https://www.npmjs.com/package/sample-lib');
      assert.equal(item2.metadata?.['sourceKey'], 'npm_registry');
    });

    test('strips maintainer, author, and user emails from raw payload before hashing (PII Redaction)', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(200, SAMPLE_REGISTRY_PACKUMENT);
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['sample-lib'],
      });

      const result = await collector.collect({
        sourceKey: 'npm_registry',
        cursor: null,
      });

      assert.equal(result.items.length, 2);

      for (const item of result.items) {
        const payloadStr = JSON.stringify(item.payload);

        // Invariant: no secret-domain email in raw payload
        assert.equal(
          payloadStr.includes('secret-domain.com'),
          false,
          `Payload contained leaked email address: ${payloadStr}`,
        );

        // Explicitly check individual fields
        const author = item.payload['author'] as Record<string, unknown> | undefined;
        assert.equal(author?.['email'], undefined);

        const maintainers = item.payload['maintainers'] as
          Array<Record<string, unknown>> | undefined;
        if (maintainers) {
          for (const m of maintainers) {
            assert.equal(m['email'], undefined);
          }
        }

        const npmUser = item.payload['_npmUser'] as Record<string, unknown> | undefined;
        assert.equal(npmUser?.['email'], undefined);

        const publisher = item.payload['publisher'] as Record<string, unknown> | undefined;
        assert.equal(publisher?.['email'], undefined);

        // Verify rawHash is valid sha256 of sanitized payload
        assert.match(item.rawHash, /^[0-9a-f]{64}$/);
      }
    });

    test('supports conditional request (304 Not Modified) with ETag', async () => {
      let receivedIfNoneMatch: string | null = null;
      const mockFetch: typeof globalThis.fetch = async (_url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        receivedIfNoneMatch = headers?.['If-None-Match'] ?? null;
        return createMockResponse(304, '', { ETag: 'W/"sample-etag-123"' });
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['sample-lib'],
      });

      // Pass cursor with existing ETag
      const result = await collector.collect({
        sourceKey: 'npm_registry',
        cursor: Buffer.from(
          JSON.stringify({
            packageIndex: 0,
            packages: ['sample-lib'],
            etags: { 'sample-lib': 'W/"sample-etag-123"' },
          }),
        ).toString('base64url'),
      });

      assert.equal(receivedIfNoneMatch, 'W/"sample-etag-123"');
      assert.equal(result.items.length, 0);
      assert.equal(result.metrics?.itemsFetched, 0);
      assert.equal(result.hasMore, false);
    });

    test('throws NpmRateLimitError on HTTP 429 and never returns zero/empty items', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(429, 'Too Many Requests', { 'Retry-After': '60' });
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['typescript'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_registry', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmRateLimitError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterHeader, '60');
          return true;
        },
      );
    });

    test('throws NpmPackageNotFoundError on HTTP 404 and never fabricates items', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(404, { error: 'Not found' });
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['non-existent-package-xyz'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_registry', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmPackageNotFoundError);
          assert.equal(err.status, 404);
          assert.equal(err.packageName, 'non-existent-package-xyz');
          return true;
        },
      );
    });

    test('throws NpmHttpError on 500 Server Error', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(500, 'Internal Server Error');
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['typescript'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_registry', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmHttpError);
          assert.equal(err.status, 500);
          return true;
        },
      );
    });
  });

  describe('NpmDownloadsCollector (SOURCE_CATALOG §10 & Metric Invariants)', () => {
    test('collects point downloads metric preserving unit, period, and value', async () => {
      const mockFetch: typeof globalThis.fetch = async (url) => {
        assert.ok(String(url).includes('/downloads/point/last-week/typescript'));
        return createMockResponse(200, SAMPLE_POINT_DOWNLOADS);
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['typescript'],
        defaultPeriod: 'last-week',
        mode: 'point',
      });

      const result = await collector.collect({
        sourceKey: 'npm_downloads',
        cursor: null,
      });

      assert.equal(result.sourceKey, 'npm_downloads');
      assert.equal(result.items.length, 1);
      assert.equal(result.metrics?.itemsFetched, 1);

      const item = result.items[0]!;
      assert.equal(item.externalId, 'typescript:downloads:2026-08-25_2026-08-31');

      // Verify metadata preservation
      assert.equal(item.metadata?.['package'], 'typescript');
      assert.equal(item.metadata?.['metric'], 'package_downloads');
      assert.equal(item.metadata?.['metricType'], 'package_downloads');
      assert.equal(item.metadata?.['unit'], 'downloads');
      assert.equal(item.metadata?.['period'], 'last-week');
      assert.equal(item.metadata?.['start'], '2026-08-25');
      assert.equal(item.metadata?.['end'], '2026-08-31');
      assert.equal(item.metadata?.['value'], 4829103);
      assert.equal(item.metadata?.['lowVolumeWarning'], false);
      assert.equal(item.metadata?.['canonicalUrl'], 'https://www.npmjs.com/package/typescript');

      // Verify rawHash
      assert.match(item.rawHash, /^[0-9a-f]{64}$/);
    });

    test('collects range daily download observations with preserved date boundaries', async () => {
      const mockFetch: typeof globalThis.fetch = async (url) => {
        assert.ok(String(url).includes('/downloads/range/last-week/typescript'));
        return createMockResponse(200, SAMPLE_RANGE_DOWNLOADS);
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['typescript'],
        defaultPeriod: 'last-week',
        mode: 'range',
      });

      const result = await collector.collect({
        sourceKey: 'npm_downloads',
        cursor: null,
      });

      assert.equal(result.items.length, 3);
      assert.equal(result.items[0]?.externalId, 'typescript:downloads:2026-08-25');
      assert.equal(result.items[1]?.externalId, 'typescript:downloads:2026-08-26');
      assert.equal(result.items[2]?.externalId, 'typescript:downloads:2026-08-27');

      assert.equal(result.items[0]?.metadata?.['value'], 1200000);
      assert.equal(result.items[0]?.metadata?.['unit'], 'downloads');
      assert.equal(result.items[0]?.metadata?.['metric'], 'package_downloads');
      assert.equal(result.items[0]?.metadata?.['day'], '2026-08-25');
    });

    test('handles low-volume download observations (< 50) without zeroing value', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(200, SAMPLE_LOW_VOLUME_DOWNLOADS);
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['rare-niche-package'],
        mode: 'range',
      });

      const result = await collector.collect({
        sourceKey: 'npm_downloads',
        cursor: null,
      });

      assert.equal(result.items.length, 2);

      const item1 = result.items[0]!;
      assert.equal(item1.metadata?.['value'], 42);
      assert.equal(item1.metadata?.['lowVolumeWarning'], true);

      const item2 = result.items[1]!;
      assert.equal(item2.metadata?.['value'], 15);
      assert.equal(item2.metadata?.['lowVolumeWarning'], true);
    });

    test('throws NpmRateLimitError on HTTP 429 and NEVER converts rate limit to zero downloads', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(429, 'Rate limit exceeded', { 'Retry-After': '30' });
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['typescript'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_downloads', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmRateLimitError);
          assert.equal(err.status, 429);
          return true;
        },
      );
    });

    test('throws NpmPackageNotFoundError on HTTP 404 and NEVER converts missing response to zero downloads', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(404, { error: 'package not found' });
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['missing-package-xyz'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_downloads', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmPackageNotFoundError);
          assert.equal(err.status, 404);
          return true;
        },
      );
    });

    test('throws NpmPackageNotFoundError when API returns error message in 200 body', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(200, { error: 'package invalid-name not found' });
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['invalid-name'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_downloads', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmPackageNotFoundError);
          return true;
        },
      );
    });

    test('throws NpmHttpError on 503 Service Unavailable', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(503, 'Service Unavailable');
      };

      const collector = new NpmDownloadsCollector({
        fetch: mockFetch,
        defaultPackages: ['typescript'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_downloads', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmHttpError);
          assert.equal(err.status, 503);
          return true;
        },
      );
    });
  });

  describe('NpmCollector Facade Routing', () => {
    test('routes to NpmRegistryCollector when sourceKey is npm_registry', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(200, SAMPLE_REGISTRY_PACKUMENT);
      };

      const collector = new NpmCollector({
        sourceKey: 'npm_registry',
        fetch: mockFetch,
        defaultPackages: ['sample-lib'],
      });

      assert.equal(collector.sourceKey, 'npm_registry');

      const result = await collector.collect({
        sourceKey: 'npm_registry',
        cursor: null,
      });

      assert.equal(result.sourceKey, 'npm_registry');
      assert.equal(result.items.length, 2);
    });

    test('routes to NpmDownloadsCollector when sourceKey is npm_downloads', async () => {
      const mockFetch: typeof globalThis.fetch = async () => {
        return createMockResponse(200, SAMPLE_POINT_DOWNLOADS);
      };

      const collector = new NpmCollector({
        sourceKey: 'npm_downloads',
        fetch: mockFetch,
        defaultPackages: ['typescript'],
      });

      assert.equal(collector.sourceKey, 'npm_downloads');

      const result = await collector.collect({
        sourceKey: 'npm_downloads',
        cursor: null,
      });

      assert.equal(result.sourceKey, 'npm_downloads');
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.metadata?.['metric'], 'package_downloads');
    });
  });

  describe('Scoped Packages & SSRF Guard', () => {
    test('handles scoped package names (@nestjs/core) with proper URL escaping', async () => {
      let requestedUrl = '';
      const mockFetch: typeof globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return createMockResponse(200, {
          name: '@nestjs/core',
          'dist-tags': { latest: '10.0.0' },
          time: { '10.0.0': '2024-05-01T00:00:00.000Z' },
          versions: {
            '10.0.0': {
              name: '@nestjs/core',
              version: '10.0.0',
              author: { name: 'Kamil', email: 'kamil@secret.com' },
            },
          },
        });
      };

      const collector = new NpmRegistryCollector({
        fetch: mockFetch,
        defaultPackages: ['@nestjs/core'],
      });

      const result = await collector.collect({
        sourceKey: 'npm_registry',
        cursor: null,
      });

      assert.equal(requestedUrl, 'https://registry.npmjs.org/@nestjs%2Fcore');
      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]?.externalId, '@nestjs/core@10.0.0');
      assert.equal(
        (result.items[0]?.payload['author'] as Record<string, unknown> | undefined)?.['email'],
        undefined,
      );
    });

    test('rejects unpermitted scheme or SSRF host via guard', async () => {
      const collector = new NpmRegistryCollector({
        baseUrl: 'http://localhost:8080',
        defaultPackages: ['typescript'],
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'npm_registry', cursor: null });
        },
        (err: unknown) => {
          assert.ok(err instanceof NpmCollectorError);
          assert.ok(String(err).includes('URL validation failed'));
          return true;
        },
      );
    });
  });
});

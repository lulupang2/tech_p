import type {
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  CollectorPort,
  CollectorPagePort,
  CollectionPageRequest,
  CollectionPageResult,
  PolicyGuardPort,
  SourcePolicy,
} from '@techpulse/domain';
import { assertCollectableTarget, validatePageResult } from '@techpulse/domain';
import { BaseCollector } from './base.js';
import { SOURCE_POLICIES } from './policies.js';
import { encodeOpaqueCursor, decodeOpaqueCursor } from './cursor.js';
import { createHardenedFetch } from './guard.js';

/**
 * Default target packages for npm collection per SOURCE_CATALOG §9.
 */
export const DEFAULT_NPM_PACKAGES: readonly string[] = [
  'typescript',
  'react',
  'next',
  'vue',
  'vite',
  'fastify',
  '@nestjs/core',
  'elysia',
  'playwright',
  '@playwright/test',
  'bun-types',
  'langchain',
  '@langchain/langgraph',
  'pg',
  'postgres',
  'bullmq',
  'ioredis',
  'pgvector',
] as const;

/**
 * Base error class for all NPM collector errors.
 */
export class NpmCollectorError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NpmCollectorError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Error raised when NPM API returns HTTP 429 Rate Limited.
 * Ensures rate-limited responses are never interpreted as zero metrics.
 */
export class NpmRateLimitError extends NpmCollectorError {
  constructor(
    message = 'NPM API rate limit exceeded (HTTP 429)',
    public readonly status = 429,
    public readonly retryAfterHeader: string | null = null,
  ) {
    super(message);
    this.name = 'NpmRateLimitError';
  }
}

/**
 * Error raised when NPM package is not found (HTTP 404 or explicit error message).
 * Ensures missing packages are never interpreted as zero metrics or zero downloads.
 */
export class NpmPackageNotFoundError extends NpmCollectorError {
  constructor(
    public readonly packageName: string,
    message = `NPM package '${packageName}' not found (HTTP 404)`,
    public readonly status = 404,
  ) {
    super(message);
    this.name = 'NpmPackageNotFoundError';
  }
}

/**
 * Error raised for generic HTTP failure responses.
 */
export class NpmHttpError extends NpmCollectorError {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    message = `NPM HTTP request failed: ${status} ${statusText} (${url})`,
  ) {
    super(message);
    this.name = 'NpmHttpError';
  }
}

export interface NpmRegistryCollectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly guard?: PolicyGuardPort;
  readonly defaultPackages?: readonly string[];
  readonly baseUrl?: string;
}

export interface NpmRegistryCursor extends Record<string, unknown> {
  packageIndex?: number;
  packages?: readonly string[];
  etags?: Record<string, string>;
  lastCollectedAt?: string;
}

/**
 * Collector adapter for npm_registry per SOURCE_CATALOG §9 and SECURITY.md §8.
 * Fetches package and version metadata, stripping PII maintainer emails before raw hashing.
 */
export class NpmRegistryCollector
  extends BaseCollector
  implements CollectorPort, CollectorPagePort
{
  readonly sourceKey = 'npm_registry' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES.npm_registry;

  private readonly fetchFn: typeof globalThis.fetch;
  private readonly defaultPackages: readonly string[];
  private readonly baseUrl: string;

  constructor(options: NpmRegistryCollectorOptions = {}) {
    super(options.guard);
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultPackages = options.defaultPackages ?? DEFAULT_NPM_PACKAGES;
    this.baseUrl = (options.baseUrl ?? 'https://registry.npmjs.org').replace(/\/+$/, '');
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = Date.now();
    let totalBytesFetched = 0;

    // Decode cursor if provided
    let cursorData: NpmRegistryCursor = {};
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<NpmRegistryCursor>(context.cursor) ?? {};
    }

    const packages: readonly string[] =
      cursorData.packages ?? this.defaultPackages ?? DEFAULT_NPM_PACKAGES;
    const startIndex = cursorData.packageIndex ?? 0;

    if (packages.length === 0) {
      return {
        sourceKey: this.sourceKey,
        items: [],
        nextCursor: null,
        hasMore: false,
        metrics: {
          itemsFetched: 0,
          bytesFetched: 0,
          durationMs: Date.now() - startTime,
        },
      };
    }

    const limit = context.limit ?? 1;
    const targetPackages = packages.slice(startIndex, startIndex + limit);

    const fetchClient = createHardenedFetch({
      guard: this.guard,
      policy: this.policy,
      baseFetch: this.fetchFn,
    });

    const items: CollectedRawItem[] = [];
    const etags: Record<string, string> = { ...(cursorData.etags ?? {}) };

    for (const pkg of targetPackages) {
      const encodedPkg = pkg.startsWith('@')
        ? `@${encodeURIComponent(pkg.slice(1))}`
        : encodeURIComponent(pkg);
      const url = `${this.baseUrl}/${encodedPkg}`;
      const urlValidation = this.guard.validateUrl(url, this.policy);
      if (!urlValidation.valid) {
        throw new NpmCollectorError(
          `URL validation failed for npm_registry package '${pkg}': ${urlValidation.reason}`,
        );
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'Signal Archive-Collector/1.0',
      };

      if (etags[pkg]) {
        headers['If-None-Match'] = etags[pkg]!;
      }

      const requestInit: RequestInit = { headers };
      if (context.signal) {
        requestInit.signal = context.signal;
      }

      let response: Response;
      try {
        response = await fetchClient(url, requestInit);
      } catch (err) {
        if (err instanceof NpmCollectorError) throw err;
        throw new NpmCollectorError(
          `Network error fetching npm_registry for package '${pkg}': ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      if (response.status === 304) {
        continue;
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new NpmRateLimitError(
          `NPM API rate limit exceeded (HTTP 429) for package '${pkg}'`,
          429,
          retryAfter,
        );
      }

      if (response.status === 404) {
        throw new NpmPackageNotFoundError(pkg);
      }

      if (!response.ok) {
        throw new NpmHttpError(response.status, response.statusText, url);
      }

      const etagHeader = response.headers.get('etag');
      if (etagHeader) {
        etags[pkg] = etagHeader;
      }

      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw new NpmCollectorError(
          `Failed to read response body for npm_registry package '${pkg}'`,
          err,
        );
      }

      totalBytesFetched += Buffer.byteLength(text, 'utf8');

      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        throw new NpmCollectorError(
          `Failed to parse JSON document for npm_registry package '${pkg}'`,
          err,
        );
      }

      const timeMap = (doc['time'] as Record<string, string> | undefined) ?? {};
      const versionsMap =
        (doc['versions'] as Record<string, Record<string, unknown>> | undefined) ?? {};
      const distTags = (doc['dist-tags'] as Record<string, string> | undefined) ?? {};
      const latestVersion = distTags['latest'];

      const versionEntries = Object.entries(versionsMap);
      const matchingVersions: Array<{ version: string; data: Record<string, unknown> }> = [];

      if (context.timeWindow) {
        const { from, to } = context.timeWindow;
        for (const [ver, verData] of versionEntries) {
          const timeStr = timeMap[ver];
          if (!timeStr) continue;
          const pubDate = new Date(timeStr);
          if (pubDate >= from && pubDate <= to) {
            matchingVersions.push({ version: ver, data: verData });
          }
        }
      } else {
        for (const [ver, verData] of versionEntries) {
          matchingVersions.push({ version: ver, data: verData });
        }
      }

      if (matchingVersions.length === 0) {
        const publishedAtStr = timeMap['modified'] ?? timeMap['created'];
        const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;
        const externalId = `${pkg}:package`;

        const metadata: Record<string, unknown> = {
          package: pkg,
          name: doc['name'] ?? pkg,
          description: doc['description'],
          license: doc['license'],
          distTags,
          modified: timeMap['modified'],
          created: timeMap['created'],
          canonicalUrl: `https://www.npmjs.com/package/${pkg}`,
          sourceKey: this.sourceKey,
        };

        const rawItem = this.createRawItem({
          externalId,
          payload: doc,
          publishedAt,
          cursor: null,
          metadata,
        });

        items.push(rawItem);
        continue;
      }

      for (const v of matchingVersions) {
        const verStr = v.version;
        const verData = v.data;
        const publishedAtStr = timeMap[verStr];
        const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;
        const externalId = `${pkg}@${verStr}`;

        const versionPayload: Record<string, unknown> = {
          ...verData,
          _npmVersionDoc: {
            name: doc['name'] ?? pkg,
            description: doc['description'],
            distTags,
            time: publishedAtStr,
          },
        };

        const metadata: Record<string, unknown> = {
          package: pkg,
          version: verStr,
          name: verData['name'] ?? doc['name'] ?? pkg,
          description: verData['description'] ?? doc['description'],
          license: verData['license'] ?? doc['license'],
          isLatest: verStr === latestVersion,
          dependenciesCount: Object.keys(
            (verData['dependencies'] as Record<string, unknown> | undefined) ?? {},
          ).length,
          devDependenciesCount: Object.keys(
            (verData['devDependencies'] as Record<string, unknown> | undefined) ?? {},
          ).length,
          canonicalUrl: `https://www.npmjs.com/package/${pkg}`,
          sourceKey: this.sourceKey,
        };

        const rawItem = this.createRawItem({
          externalId,
          payload: versionPayload,
          publishedAt,
          cursor: null,
          metadata,
        });

        items.push(rawItem);
      }
    }

    const nextIndex = startIndex + targetPackages.length;
    const hasMore = nextIndex < packages.length;
    const nextCursor = hasMore
      ? encodeOpaqueCursor({
          packageIndex: nextIndex,
          packages,
          etags,
          lastCollectedAt: new Date().toISOString(),
        })
      : null;

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore,
      metrics: {
        itemsFetched: items.length,
        bytesFetched: totalBytesFetched,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Single-target page collector fulfilling CollectorPagePort (COV-003).
   */
  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);
    const pkg =
      request.target.selector.kind === 'package'
        ? request.target.selector.name
        : (this.defaultPackages[0] ?? 'typescript');

    const encodedPkg = pkg.startsWith('@')
      ? `@${encodeURIComponent(pkg.slice(1))}`
      : encodeURIComponent(pkg);
    const url = `${this.baseUrl}/${encodedPkg}`;

    const urlValidation = this.guard.validateUrl(url, this.policy);
    if (!urlValidation.valid) {
      throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
    }

    const fetchClient = createHardenedFetch({
      guard: this.guard,
      policy: this.policy,
      baseFetch: this.fetchFn,
    });

    const response = await fetchClient(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Signal Archive-Collector/1.0',
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retryAt = retryAfter
        ? new Date(request.now().getTime() + Number.parseInt(retryAfter, 10) * 1000)
        : new Date(request.now().getTime() + 60000);
      const result: CollectionPageResult = {
        items: [],
        nextCursor: null,
        disposition: 'deferred',
        reason: null,
        retryAt,
        requests: 1,
        bytes: 0,
      };
      validatePageResult(request.partition, result);
      return result;
    }

    if (response.status === 404) {
      throw new NpmPackageNotFoundError(pkg);
    }

    if (!response.ok) {
      throw new NpmHttpError(response.status, response.statusText, url);
    }

    const text = await response.text();
    const bytesFetched = Buffer.byteLength(text, 'utf8');
    const doc = JSON.parse(text) as Record<string, unknown>;

    const timeMap = (doc['time'] as Record<string, string> | undefined) ?? {};
    const publishedAtStr = timeMap['modified'] ?? timeMap['created'];
    const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;

    const rawItem = this.createRawItem({
      externalId: `npm_registry:${pkg}`,
      payload: doc,
      publishedAt,
      cursor: null,
      metadata: {
        package: pkg,
        canonicalUrl: `https://www.npmjs.com/package/${pkg}`,
      },
    });

    let disposition: CollectionPageResult['disposition'] = 'complete';
    let reason: string | null = null;

    if (
      request.target.capability.historyMode === 'snapshot_only' &&
      request.partition.mode === 'backfill'
    ) {
      disposition = 'partial';
      reason = 'history_unsupported';
    }

    const result: CollectionPageResult = {
      items: [rawItem],
      nextCursor: null,
      disposition,
      reason,
      retryAt: null,
      requests: 1,
      bytes: bytesFetched,
    };
    validatePageResult(request.partition, result);
    return result;
  }
}

export interface NpmDownloadsCollectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly guard?: PolicyGuardPort;
  readonly defaultPackages?: readonly string[];
  readonly defaultPeriod?: string;
  readonly mode?: 'point' | 'range';
  readonly baseUrl?: string;
}

export interface NpmDownloadsCursor extends Record<string, unknown> {
  packageIndex?: number;
  packages?: readonly string[];
  period?: string;
  mode?: 'point' | 'range';
  lastCollectedAt?: string;
}

/**
 * Collector adapter for npm_downloads per SOURCE_CATALOG §10.
 * Collects package download metrics (unit: downloads, metricType: package_downloads)
 * over period ranges or points without converting missing/error responses to zero.
 */
export class NpmDownloadsCollector
  extends BaseCollector
  implements CollectorPort, CollectorPagePort
{
  readonly sourceKey = 'npm_downloads' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES.npm_downloads;

  private readonly fetchFn: typeof globalThis.fetch;
  private readonly defaultPackages: readonly string[];
  private readonly defaultPeriod: string;
  private readonly mode: 'point' | 'range';
  private readonly baseUrl: string;

  constructor(options: NpmDownloadsCollectorOptions = {}) {
    super(options.guard);
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultPackages = options.defaultPackages ?? DEFAULT_NPM_PACKAGES;
    this.defaultPeriod = options.defaultPeriod ?? 'last-month';
    this.mode = options.mode ?? 'point';
    this.baseUrl = (options.baseUrl ?? 'https://api.npmjs.org').replace(/\/+$/, '');
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = Date.now();
    let totalBytesFetched = 0;

    let cursorData: NpmDownloadsCursor = {};
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<NpmDownloadsCursor>(context.cursor) ?? {};
    }

    const packages: readonly string[] =
      cursorData.packages ?? this.defaultPackages ?? DEFAULT_NPM_PACKAGES;
    const startIndex = cursorData.packageIndex ?? 0;
    const mode = cursorData.mode ?? this.mode;

    if (packages.length === 0) {
      return {
        sourceKey: this.sourceKey,
        items: [],
        nextCursor: null,
        hasMore: false,
        metrics: {
          itemsFetched: 0,
          bytesFetched: 0,
          durationMs: Date.now() - startTime,
        },
      };
    }

    let period = cursorData.period ?? this.defaultPeriod;
    if (context.timeWindow) {
      const fromStr = context.timeWindow.from.toISOString().slice(0, 10);
      const toStr = context.timeWindow.to.toISOString().slice(0, 10);
      period = `${fromStr}:${toStr}`;
    }

    const limit = context.limit ?? 1;
    const targetPackages = packages.slice(startIndex, startIndex + limit);

    const fetchClient = createHardenedFetch({
      guard: this.guard,
      policy: this.policy,
      baseFetch: this.fetchFn,
    });

    const items: CollectedRawItem[] = [];

    for (const pkg of targetPackages) {
      const encodedPkg = pkg.startsWith('@')
        ? `@${encodeURIComponent(pkg.slice(1))}`
        : encodeURIComponent(pkg);
      const endpoint = mode === 'point' ? 'point' : 'range';
      const url = `${this.baseUrl}/downloads/${endpoint}/${period}/${encodedPkg}`;

      const urlValidation = this.guard.validateUrl(url, this.policy);
      if (!urlValidation.valid) {
        throw new Error(
          `Security violation: URL '${url}' rejected by policy guard: ${urlValidation.reason}`,
        );
      }

      const requestInit: RequestInit = {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Signal Archive-Collector/1.0',
        },
      };
      if (context.signal) {
        requestInit.signal = context.signal;
      }

      let response: Response;
      try {
        response = await fetchClient(url, requestInit);
      } catch (err) {
        if (err instanceof NpmCollectorError) throw err;
        throw new NpmCollectorError(
          `Network error fetching npm_downloads for package '${pkg}': ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        throw new NpmRateLimitError(
          `NPM API rate limit exceeded (HTTP 429) for package '${pkg}' downloads`,
          429,
          retryAfter,
        );
      }

      if (response.status === 404) {
        throw new NpmPackageNotFoundError(pkg);
      }

      if (!response.ok) {
        throw new NpmHttpError(response.status, response.statusText, url);
      }

      let text: string;
      try {
        text = await response.text();
      } catch (err) {
        throw new NpmCollectorError(
          `Failed to read response body for npm_downloads package '${pkg}'`,
          err,
        );
      }

      totalBytesFetched += Buffer.byteLength(text, 'utf8');

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        throw new NpmCollectorError(
          `Failed to parse JSON response from npm_downloads for package '${pkg}'`,
          err,
        );
      }

      if (body['error'] && typeof body['error'] === 'string') {
        const errorMsg = body['error'];
        if (/not found/i.test(errorMsg)) {
          throw new NpmPackageNotFoundError(
            pkg,
            `NPM downloads package not found: ${errorMsg}`,
            404,
          );
        }
        throw new NpmCollectorError(`NPM downloads API returned error: ${errorMsg}`);
      }

      const pkgName = typeof body['package'] === 'string' ? body['package'] : pkg;
      const canonicalUrl = `https://www.npmjs.com/package/${pkgName}`;

      if (mode === 'point') {
        const downloads = body['downloads'];
        if (typeof downloads !== 'number' || Number.isNaN(downloads)) {
          throw new NpmCollectorError(
            `Missing or invalid downloads count in point response for package '${pkg}'`,
          );
        }

        const startStr = typeof body['start'] === 'string' ? body['start'] : period;
        const endStr = typeof body['end'] === 'string' ? body['end'] : period;
        const externalId = `${pkgName}:downloads:${startStr}_${endStr}`;
        const publishedAt = endStr ? new Date(`${endStr}T23:59:59.999Z`) : new Date();

        const metadata: Record<string, unknown> = {
          package: pkgName,
          metric: 'package_downloads',
          metricType: 'package_downloads',
          unit: 'downloads',
          period,
          start: startStr,
          end: endStr,
          value: downloads,
          lowVolumeWarning: downloads < 50,
          canonicalUrl,
          sourceKey: this.sourceKey,
        };

        const payload: Record<string, unknown> = {
          package: pkgName,
          downloads,
          start: startStr,
          end: endStr,
          period,
        };

        const rawItem = this.createRawItem({
          externalId,
          payload,
          publishedAt: !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
          cursor: null,
          metadata,
        });

        items.push(rawItem);
      } else if (mode === 'range') {
        const rangeDownloads = body['downloads'];
        if (!Array.isArray(rangeDownloads)) {
          throw new NpmCollectorError(
            `Missing or invalid downloads array in range response for package '${pkg}'`,
          );
        }

        const rangeStart = typeof body['start'] === 'string' ? body['start'] : period;
        const rangeEnd = typeof body['end'] === 'string' ? body['end'] : period;

        for (const entry of rangeDownloads) {
          if (!entry || typeof entry !== 'object') continue;
          const entryRecord = entry as Record<string, unknown>;
          const day = typeof entryRecord['day'] === 'string' ? entryRecord['day'] : null;
          const dayDownloads = entryRecord['downloads'];

          if (typeof dayDownloads !== 'number' || Number.isNaN(dayDownloads) || !day) {
            throw new NpmCollectorError(
              `Invalid daily download entry in range response for package '${pkg}'`,
            );
          }

          const externalId = `${pkgName}:downloads:${day}`;
          const publishedAt = new Date(`${day}T23:59:59.999Z`);

          const metadata: Record<string, unknown> = {
            package: pkgName,
            metric: 'package_downloads',
            metricType: 'package_downloads',
            unit: 'downloads',
            period: 'day',
            day,
            start: day,
            end: day,
            rangeStart,
            rangeEnd,
            value: dayDownloads,
            lowVolumeWarning: dayDownloads < 50,
            canonicalUrl,
            sourceKey: this.sourceKey,
          };

          const payload: Record<string, unknown> = {
            package: pkgName,
            downloads: dayDownloads,
            day,
            rangeStart,
            rangeEnd,
          };

          const rawItem = this.createRawItem({
            externalId,
            payload,
            publishedAt,
            cursor: null,
            metadata,
          });

          items.push(rawItem);
        }
      }
    }

    const nextIndex = startIndex + targetPackages.length;
    const hasMore = nextIndex < packages.length;
    const nextCursor = hasMore
      ? encodeOpaqueCursor({
          packageIndex: nextIndex,
          packages,
          period,
          mode,
          lastCollectedAt: new Date().toISOString(),
        })
      : null;

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore,
      metrics: {
        itemsFetched: items.length,
        bytesFetched: totalBytesFetched,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Single-target page collector fulfilling CollectorPagePort (COV-003).
   */
  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);
    const pkg =
      request.target.selector.kind === 'package'
        ? request.target.selector.name
        : (this.defaultPackages[0] ?? 'typescript');

    const fromDay = request.partition.window.from.toISOString().slice(0, 10);
    const toDay = new Date(request.partition.window.to.getTime() - 1).toISOString().slice(0, 10);
    const period = `${fromDay}:${toDay}`;

    const encodedPkg = pkg.startsWith('@')
      ? `@${encodeURIComponent(pkg.slice(1))}`
      : encodeURIComponent(pkg);
    const url = `${this.baseUrl}/downloads/range/${period}/${encodedPkg}`;

    const urlValidation = this.guard.validateUrl(url, this.policy);
    if (!urlValidation.valid) {
      throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
    }

    const fetchClient = createHardenedFetch({
      guard: this.guard,
      policy: this.policy,
      baseFetch: this.fetchFn,
    });

    const response = await fetchClient(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Signal Archive-Collector/1.0',
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const retryAt = retryAfter
        ? new Date(request.now().getTime() + Number.parseInt(retryAfter, 10) * 1000)
        : new Date(request.now().getTime() + 60000);
      const result: CollectionPageResult = {
        items: [],
        nextCursor: null,
        disposition: 'deferred',
        reason: null,
        retryAt,
        requests: 1,
        bytes: 0,
      };
      validatePageResult(request.partition, result);
      return result;
    }

    if (response.status === 404) {
      throw new NpmPackageNotFoundError(pkg);
    }

    if (!response.ok) {
      throw new NpmHttpError(response.status, response.statusText, url);
    }

    const text = await response.text();
    const bytesFetched = Buffer.byteLength(text, 'utf8');
    const body = JSON.parse(text) as Record<string, unknown>;

    const rangeDownloads = (body['downloads'] as Array<Record<string, unknown>> | undefined) ?? [];
    const items: CollectedRawItem[] = [];
    const canonicalUrl = `https://www.npmjs.com/package/${pkg}`;

    for (const entry of rangeDownloads) {
      const day = typeof entry['day'] === 'string' ? entry['day'] : null;
      const dayDownloads = entry['downloads'];
      if (!day || typeof dayDownloads !== 'number') continue;

      const publishedAt = new Date(`${day}T23:59:59.999Z`);
      if (
        publishedAt.getTime() < request.partition.window.from.getTime() ||
        publishedAt.getTime() >= request.partition.window.to.getTime()
      ) {
        continue;
      }

      const externalId = `npm_downloads:${pkg}:${day}`;
      const rawItem = this.createRawItem({
        externalId,
        payload: entry,
        publishedAt,
        cursor: day,
        metadata: {
          package: pkg,
          metric: 'package_downloads',
          day,
          downloads: dayDownloads,
          canonicalUrl,
        },
      });
      items.push(rawItem);
    }

    const result: CollectionPageResult = {
      items,
      nextCursor: null,
      disposition: 'complete',
      reason: null,
      retryAt: null,
      requests: 1,
      bytes: bytesFetched,
    };
    validatePageResult(request.partition, result);
    return result;
  }
}

export interface NpmCollectorOptions {
  readonly sourceKey?: 'npm_registry' | 'npm_downloads';
  readonly fetch?: typeof globalThis.fetch;
  readonly guard?: PolicyGuardPort;
  readonly defaultPackages?: readonly string[];
  readonly defaultPeriod?: string;
  readonly mode?: 'point' | 'range';
  readonly baseUrl?: string;
}

/**
 * Unified facade collector for npm sources.
 */
export class NpmCollector extends BaseCollector {
  readonly sourceKey: 'npm_registry' | 'npm_downloads';
  readonly policy: SourcePolicy;
  private readonly delegate: NpmRegistryCollector | NpmDownloadsCollector;

  constructor(options: NpmCollectorOptions = {}) {
    super(options.guard);
    this.sourceKey = options.sourceKey ?? 'npm_registry';
    if (this.sourceKey === 'npm_registry') {
      this.policy = SOURCE_POLICIES.npm_registry;
      const registryOptions: NpmRegistryCollectorOptions = {
        guard: this.guard,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.defaultPackages ? { defaultPackages: options.defaultPackages } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      };
      this.delegate = new NpmRegistryCollector(registryOptions);
    } else if (this.sourceKey === 'npm_downloads') {
      this.policy = SOURCE_POLICIES.npm_downloads;
      const downloadsOptions: NpmDownloadsCollectorOptions = {
        guard: this.guard,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.defaultPackages ? { defaultPackages: options.defaultPackages } : {}),
        ...(options.defaultPeriod ? { defaultPeriod: options.defaultPeriod } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
      };
      this.delegate = new NpmDownloadsCollector(downloadsOptions);
    } else {
      throw new Error(`Unsupported sourceKey for NpmCollector: ${this.sourceKey}`);
    }
  }

  collect(context: CollectionContext): Promise<CollectionResult> {
    return this.delegate.collect(context);
  }
}

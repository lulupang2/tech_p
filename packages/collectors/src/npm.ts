import type {
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  PolicyGuardPort,
  SourcePolicy,
} from '@techpulse/domain';
import { BaseCollector } from './base.js';
import { SOURCE_POLICIES } from './policies.js';
import { encodeOpaqueCursor, decodeOpaqueCursor } from './cursor.js';

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
export class NpmRegistryCollector extends BaseCollector {
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
    let cursorData: NpmRegistryCursor | null = null;
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<NpmRegistryCursor>(context.cursor);
    }

    const packages =
      cursorData && Array.isArray(cursorData['packages']) && cursorData['packages'].length > 0
        ? (cursorData['packages'] as readonly string[])
        : this.defaultPackages;
    const startIndex =
      typeof cursorData?.['packageIndex'] === 'number' ? cursorData['packageIndex'] : 0;
    const rawEtags = cursorData?.['etags'];
    const etags: Record<string, string> =
      rawEtags && typeof rawEtags === 'object' ? { ...(rawEtags as Record<string, string>) } : {};

    if (startIndex >= packages.length) {
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
    const items: CollectedRawItem[] = [];
    let totalBytesFetched = 0;

    for (const pkg of targetPackages) {
      const encodedPkg = encodePackageName(pkg);
      const url = `${this.baseUrl}/${encodedPkg}`;

      const validation = this.guard.validateUrl(url, this.policy);
      if (!validation.valid) {
        throw new NpmCollectorError(
          `URL validation failed for npm_registry: ${validation.reason ?? 'Unknown reason'} (${url})`,
        );
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
      };
      if (etags[pkg]) {
        headers['If-None-Match'] = etags[pkg]!;
      }

      const requestInit: RequestInit = {
        headers,
        ...(context.signal ? { signal: context.signal } : {}),
      };

      const response = await this.fetchFn(url, requestInit);

      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after') ?? null;
        throw new NpmRateLimitError(
          `NPM registry rate limit exceeded (HTTP 429) for package '${pkg}'`,
          429,
          retryAfter,
        );
      }

      if (response.status === 404) {
        throw new NpmPackageNotFoundError(
          pkg,
          `NPM package '${pkg}' not found in registry (HTTP 404)`,
          404,
        );
      }

      if (response.status === 304) {
        // ETag match: no changes, 304 Not Modified
        continue;
      }

      if (!response.ok) {
        throw new NpmHttpError(
          response.status,
          response.statusText,
          url,
          `NPM registry request failed: HTTP ${response.status} ${response.statusText} for package '${pkg}'`,
        );
      }

      const etag = response.headers?.get?.('etag');
      if (etag) {
        etags[pkg] = etag;
      }

      const text = await response.text();
      totalBytesFetched += Buffer.byteLength(text, 'utf8');

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch (err) {
        throw new NpmCollectorError(
          `Failed to parse JSON response from npm_registry for package '${pkg}'`,
          err,
        );
      }

      if (body['error'] && typeof body['error'] === 'string') {
        const errorMsg = body['error'];
        if (/not found/i.test(errorMsg)) {
          throw new NpmPackageNotFoundError(
            pkg,
            `NPM registry package not found: ${errorMsg}`,
            404,
          );
        }
        throw new NpmCollectorError(`NPM registry returned error: ${errorMsg}`);
      }

      const pkgName = typeof body['name'] === 'string' ? body['name'] : pkg;
      const versionsObj =
        body['versions'] && typeof body['versions'] === 'object'
          ? (body['versions'] as Record<string, Record<string, unknown>>)
          : {};
      const timeObj =
        body['time'] && typeof body['time'] === 'object'
          ? (body['time'] as Record<string, string>)
          : {};
      const distTags =
        body['dist-tags'] && typeof body['dist-tags'] === 'object'
          ? (body['dist-tags'] as Record<string, string>)
          : {};

      const versionKeys = Object.keys(versionsObj);

      let matchingVersions = versionKeys;
      if (context.timeWindow) {
        const fromMs = context.timeWindow.from.getTime();
        const toMs = context.timeWindow.to.getTime();
        matchingVersions = versionKeys.filter((v) => {
          const t = timeObj[v];
          if (!t) return true;
          const timeMs = new Date(t).getTime();
          return timeMs >= fromMs && timeMs <= toMs;
        });
      }

      for (const v of matchingVersions) {
        const versionData = versionsObj[v] ?? {};
        const publishedAtStr = timeObj[v] ?? timeObj['modified'];
        const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;

        const externalId = `${pkgName}@${v}`;
        const canonicalUrl = `https://www.npmjs.com/package/${pkgName}`;

        const metadata: Record<string, unknown> = {
          package: pkgName,
          version: v,
          distTags,
          isLatest: distTags['latest'] === v,
          license: versionData['license'] ?? body['license'] ?? null,
          description: versionData['description'] ?? body['description'] ?? null,
          dependenciesCount: Object.keys(
            (versionData['dependencies'] as Record<string, string>) ?? {},
          ).length,
          devDependenciesCount: Object.keys(
            (versionData['devDependencies'] as Record<string, string>) ?? {},
          ).length,
          peerDependenciesCount: Object.keys(
            (versionData['peerDependencies'] as Record<string, string>) ?? {},
          ).length,
          canonicalUrl,
          sourceKey: this.sourceKey,
        };

        const payload: Record<string, unknown> = {
          name: pkgName,
          version: v,
          description: versionData['description'] ?? body['description'],
          main: versionData['main'],
          module: versionData['module'],
          types: versionData['types'] ?? versionData['typings'],
          license: versionData['license'] ?? body['license'],
          author: versionData['author'] ?? body['author'],
          maintainers: versionData['maintainers'] ?? body['maintainers'],
          publisher: versionData['publisher'] ?? versionData['_npmUser'] ?? body['_npmUser'],
          _npmUser: versionData['_npmUser'] ?? body['_npmUser'],
          contributors: versionData['contributors'] ?? body['contributors'],
          dependencies: versionData['dependencies'],
          devDependencies: versionData['devDependencies'],
          peerDependencies: versionData['peerDependencies'],
          dist: versionData['dist'],
          repository: versionData['repository'] ?? body['repository'],
          homepage: versionData['homepage'] ?? body['homepage'],
          bugs: versionData['bugs'] ?? body['bugs'],
          keywords: versionData['keywords'] ?? body['keywords'],
          publishedAt: publishedAtStr,
        };

        const rawItem = this.createRawItem({
          externalId,
          payload,
          publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
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
export class NpmDownloadsCollector extends BaseCollector {
  readonly sourceKey = 'npm_downloads' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES.npm_downloads;

  private readonly fetchFn: typeof globalThis.fetch;
  private readonly defaultPackages: readonly string[];
  private readonly defaultPeriod: string;
  private readonly defaultMode: 'point' | 'range';
  private readonly baseUrl: string;

  constructor(options: NpmDownloadsCollectorOptions = {}) {
    super(options.guard);
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultPackages = options.defaultPackages ?? DEFAULT_NPM_PACKAGES;
    this.defaultPeriod = options.defaultPeriod ?? 'last-week';
    this.defaultMode = options.mode ?? 'point';
    this.baseUrl = (options.baseUrl ?? 'https://api.npmjs.org').replace(/\/+$/, '');
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = Date.now();
    let cursorData: NpmDownloadsCursor | null = null;
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<NpmDownloadsCursor>(context.cursor);
    }

    const packages =
      cursorData && Array.isArray(cursorData['packages']) && cursorData['packages'].length > 0
        ? (cursorData['packages'] as readonly string[])
        : this.defaultPackages;
    const startIndex =
      typeof cursorData?.['packageIndex'] === 'number' ? cursorData['packageIndex'] : 0;
    const mode =
      cursorData?.['mode'] === 'range' || cursorData?.['mode'] === 'point'
        ? cursorData['mode']
        : this.defaultMode;

    let period =
      typeof cursorData?.['period'] === 'string' ? cursorData['period'] : this.defaultPeriod;
    if (context.timeWindow) {
      const fromStr = context.timeWindow.from.toISOString().slice(0, 10);
      const toStr = context.timeWindow.to.toISOString().slice(0, 10);
      period = `${fromStr}:${toStr}`;
    }

    if (startIndex >= packages.length) {
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
    const items: CollectedRawItem[] = [];
    let totalBytesFetched = 0;

    for (const pkg of targetPackages) {
      const encodedPkg = encodePackageName(pkg);
      const url = `${this.baseUrl}/downloads/${mode}/${period}/${encodedPkg}`;

      const validation = this.guard.validateUrl(url, this.policy);
      if (!validation.valid) {
        throw new NpmCollectorError(
          `URL validation failed for npm_downloads: ${validation.reason ?? 'Unknown reason'} (${url})`,
        );
      }

      const requestInit: RequestInit = {
        headers: { Accept: 'application/json' },
        ...(context.signal ? { signal: context.signal } : {}),
      };

      const response = await this.fetchFn(url, requestInit);

      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after') ?? null;
        throw new NpmRateLimitError(
          `NPM downloads rate limit exceeded (HTTP 429) for package '${pkg}'`,
          429,
          retryAfter,
        );
      }

      if (response.status === 404) {
        throw new NpmPackageNotFoundError(
          pkg,
          `NPM downloads not found for package '${pkg}' (HTTP 404)`,
          404,
        );
      }

      if (!response.ok) {
        throw new NpmHttpError(
          response.status,
          response.statusText,
          url,
          `NPM downloads request failed: HTTP ${response.status} ${response.statusText} for package '${pkg}'`,
        );
      }

      const text = await response.text();
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
            day,
            downloads: dayDownloads,
            rangeStart,
            rangeEnd,
          };

          const rawItem = this.createRawItem({
            externalId,
            payload,
            publishedAt: !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
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

/**
 * Encodes package name safely for URLs, preserving @ for scoped packages.
 */
function encodePackageName(pkg: string): string {
  if (pkg.startsWith('@')) {
    const slashIdx = pkg.indexOf('/');
    if (slashIdx !== -1) {
      const scope = pkg.slice(0, slashIdx);
      const name = pkg.slice(slashIdx + 1);
      return `${scope}%2F${encodeURIComponent(name)}`;
    }
  }
  return encodeURIComponent(pkg);
}

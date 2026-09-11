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
import {
  assertCollectableTarget,
  decodePageCursor,
  encodePageCursor,
  validatePageResult,
} from '@techpulse/domain';
import { BaseCollector } from './base.js';
import { SOURCE_POLICIES } from './policies.js';
import { decodeOpaqueCursor, encodeOpaqueCursor } from './cursor.js';
import { createHardenedFetch } from './guard.js';

export interface GitHubReleasesConfig {
  owner?: string;
  repo?: string;
  repositories?: ReadonlyArray<{ owner: string; repo: string }>;
  pat?: string;
  perPage?: number;
}
export interface GitHubRateLimit extends Record<string, unknown> {
  limit?: number | undefined;
  remaining?: number | undefined;
  reset?: number | undefined;
}

export interface GitHubReleaseCursor extends Record<string, unknown> {
  lastPublishedAt?: string | undefined;
  etag?: string | undefined;
  page?: number | undefined;
  rateLimit?: GitHubRateLimit | undefined;
  repoIndex?: number | undefined;
  repositoryCursors?:
    | Record<
        string,
        {
          lastPublishedAt?: string | undefined;
          etag?: string | undefined;
          page?: number | undefined;
        }
      >
    | undefined;
}
export interface GitHubReleasePayload {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string;
  html_url: string;
  tarball_url: string | null;
  zipball_url: string | null;
  assets?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export class GitHubReleasesCollector
  extends BaseCollector
  implements CollectorPort, CollectorPagePort
{
  readonly sourceKey = 'github_releases' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES.github_releases;

  private readonly config: GitHubReleasesConfig;
  private readonly customFetch: typeof fetch | undefined;

  constructor(
    config: GitHubReleasesConfig,
    options?: {
      guard?: PolicyGuardPort;
      fetch?: typeof fetch;
    },
  ) {
    super(options?.guard);
    this.config = config;
    this.customFetch = options?.fetch;
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startedAt = Date.now();
    const baseFetch = this.customFetch ?? globalThis.fetch;
    const fetchFn = createHardenedFetch({ guard: this.guard, policy: this.policy, baseFetch });
    const pat = this.config.pat ?? process.env['GITHUB_PAT'];
    const perPage = this.config.perPage ?? 30;

    // Decode cursor if provided
    let cursorData: GitHubReleaseCursor = {};
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<GitHubReleaseCursor>(context.cursor) ?? {};
    }

    const repos: ReadonlyArray<{ owner: string; repo: string }> =
      this.config.repositories && this.config.repositories.length > 0
        ? this.config.repositories
        : [
            {
              owner: this.config.owner ?? 'microsoft',
              repo: this.config.repo ?? 'playwright',
            },
          ];

    const repoIndex =
      typeof cursorData.repoIndex === 'number' && cursorData.repoIndex < repos.length
        ? cursorData.repoIndex
        : 0;
    const currentRepo = repos[repoIndex]!;
    const repoKey = `${currentRepo.owner}/${currentRepo.repo}`;
    const repoCursor =
      cursorData.repositoryCursors?.[repoKey] ??
      (repos.length > 1
        ? {}
        : {
            lastPublishedAt: cursorData.lastPublishedAt,
            etag: cursorData.etag,
            page: cursorData.page,
          });

    const targetOwner = currentRepo.owner;
    const targetRepo = currentRepo.repo;
    const effectivePage = repoCursor.page ?? cursorData.page ?? 1;

    const url = new URL(`https://api.github.com/repos/${targetOwner}/${targetRepo}/releases`);
    url.searchParams.set('per_page', perPage.toString());
    if (effectivePage > 1) {
      url.searchParams.set('page', effectivePage.toString());
    }
    // SSRF URL Validation
    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Signal Archive-Collector/1.0',
    };

    if (pat) {
      headers['Authorization'] = `Bearer ${pat}`;
    }

    const effectiveEtag = repoCursor.etag ?? cursorData.etag;
    if (effectiveEtag) {
      headers['If-None-Match'] = effectiveEtag;
    }

    const request: RequestInit = { method: 'GET', headers };
    if (context.signal) {
      request.signal = context.signal;
    }
    const response = await fetchFn(url.toString(), request);

    const rateLimit = readRateLimit(response.headers);

    // Handle 304 Not Modified
    if (response.status === 304) {
      const nextRepoIndex = (repoIndex + 1) % repos.length;
      const updatedCursors = {
        ...(cursorData.repositoryCursors ?? {}),
        [repoKey]: {
          etag: effectiveEtag,
          lastPublishedAt: repoCursor.lastPublishedAt,
          page: 1,
        },
      };
      return {
        sourceKey: this.sourceKey,
        items: [],
        nextCursor:
          repos.length > 1
            ? encodeOpaqueCursor({
                ...cursorData,
                repoIndex: nextRepoIndex,
                repositoryCursors: updatedCursors,
                etag: effectiveEtag,
                rateLimit,
              })
            : context.cursor,
        hasMore: repos.length > 1,
        metrics: {
          itemsFetched: 0,
          bytesFetched: 0,
          durationMs: Date.now() - startedAt,
        },
      };
    }

    if (!response.ok) {
      throw new Error(`GitHub Releases API error ${response.status}: ${response.statusText}`);
    }

    const responseEtag = response.headers.get('etag') ?? undefined;
    const releases = (await response.json()) as GitHubReleasePayload[];

    // Parse Link header for pagination
    const linkHeader = response.headers.get('link');
    const hasNextPage = linkHeader
      ? linkHeader.includes('rel="next"')
      : releases.length === perPage;

    const items: CollectedRawItem[] = [];
    const effectiveLastPublishedAt =
      repos.length > 1
        ? repoCursor.lastPublishedAt
        : (repoCursor.lastPublishedAt ?? cursorData.lastPublishedAt);
    let latestPublishedAt = effectiveLastPublishedAt;

    for (const release of releases) {
      // Exclude draft releases
      if (release.draft) {
        continue;
      }

      const publishedAtStr = release.published_at;
      const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;

      // Track latest published_at
      if (publishedAtStr && (!latestPublishedAt || publishedAtStr > latestPublishedAt)) {
        latestPublishedAt = publishedAtStr;
      }

      // Filter by cursor incremental window if present
      if (
        effectiveLastPublishedAt &&
        publishedAtStr &&
        publishedAtStr <= effectiveLastPublishedAt
      ) {
        continue;
      }

      // Sanitize payload: never store created_at as published_at, let createRawItem strip author/assets.uploader
      const payload: Record<string, unknown> = { ...release };
      delete payload['created_at'];
      const rawItem = this.createRawItem({
        externalId: release.id.toString(),
        payload,
        publishedAt,
        cursor: release.published_at ?? release.id.toString(),
        metadata: {
          canonicalUrl: release.html_url,
          tagName: release.tag_name,
          repository: `${targetOwner}/${targetRepo}`,
        },
      });

      items.push(rawItem);
    }

    const nextRepoIndex = hasNextPage ? repoIndex : (repoIndex + 1) % repos.length;
    const updatedCursors = {
      ...(cursorData.repositoryCursors ?? {}),
      [repoKey]: {
        ...(latestPublishedAt ? { lastPublishedAt: latestPublishedAt } : {}),
        ...(responseEtag ? { etag: responseEtag } : {}),
        ...(hasNextPage ? { page: effectivePage + 1 } : { page: 1 }),
      },
    };

    const nextCursorData: GitHubReleaseCursor = {
      rateLimit,
      ...(latestPublishedAt ? { lastPublishedAt: latestPublishedAt } : {}),
      ...(responseEtag ? { etag: responseEtag } : {}),
      ...(hasNextPage ? { page: effectivePage + 1 } : {}),
      ...(repos.length > 1 ? { repoIndex: nextRepoIndex, repositoryCursors: updatedCursors } : {}),
    };

    const nextCursor = encodeOpaqueCursor(nextCursorData);

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore: hasNextPage,
      metrics: {
        itemsFetched: releases.length,
        bytesFetched: parseRateLimitHeader(response.headers.get('content-length')) ?? 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Single-target page collector fulfilling CollectorPagePort (COV-003).
   */
  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);
    const targetOwner =
      request.target.selector.kind === 'repository'
        ? request.target.selector.owner
        : (this.config.owner ?? 'microsoft');
    const targetRepo =
      request.target.selector.kind === 'repository'
        ? request.target.selector.repository
        : (this.config.repo ?? 'playwright');

    const baseFetch = this.customFetch ?? globalThis.fetch;
    const fetchFn = createHardenedFetch({ guard: this.guard, policy: this.policy, baseFetch });
    const pat = this.config.pat ?? process.env['GITHUB_PAT'];
    const perPage = request.limit > 0 ? Math.min(request.limit, 100) : (this.config.perPage ?? 30);

    // Decode cursor
    let page = 1;
    let etag: string | undefined = undefined;
    if (request.partition.cursor) {
      const decoded = decodePageCursor(request.partition, request.target.capability.cursorVersion);
      if (decoded) {
        try {
          const parsed = JSON.parse(decoded) as { page?: number; etag?: string };
          if (typeof parsed.page === 'number' && parsed.page >= 1) {
            page = parsed.page;
          }
          if (typeof parsed.etag === 'string') {
            etag = parsed.etag;
          }
        } catch {
          // Non-JSON fallback
        }
      }
    }

    const url = new URL(`https://api.github.com/repos/${targetOwner}/${targetRepo}/releases`);
    url.searchParams.set('per_page', perPage.toString());
    if (page > 1) {
      url.searchParams.set('page', page.toString());
    }

    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Signal Archive-Collector/1.0',
    };
    if (pat) {
      headers['Authorization'] = `Bearer ${pat}`;
    }
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    const requestInit: RequestInit = { method: 'GET', headers };
    if (request.signal) {
      requestInit.signal = request.signal;
    }

    const response = await fetchFn(url.toString(), requestInit);

    // Handle 304 Not Modified
    if (response.status === 304) {
      const result: CollectionPageResult = {
        items: [],
        nextCursor: null,
        disposition: 'complete',
        reason: null,
        retryAt: null,
        requests: 1,
        bytes: 0,
      };
      validatePageResult(request.partition, result);
      return result;
    }

    // Handle 403 / 429 Rate Limit
    if (response.status === 403 || response.status === 429) {
      const resetHeader = response.headers.get('x-ratelimit-reset');
      const retryAfterHeader = response.headers.get('retry-after');
      let retryAt: Date;
      if (resetHeader) {
        const resetSeconds = Number.parseInt(resetHeader, 10);
        retryAt = Number.isFinite(resetSeconds)
          ? new Date(resetSeconds * 1000)
          : new Date(request.now().getTime() + 60000);
      } else if (retryAfterHeader) {
        const afterSeconds = Number.parseInt(retryAfterHeader, 10);
        retryAt = Number.isFinite(afterSeconds)
          ? new Date(request.now().getTime() + afterSeconds * 1000)
          : new Date(request.now().getTime() + 60000);
      } else {
        retryAt = new Date(request.now().getTime() + 60000);
      }

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

    if (!response.ok) {
      throw new Error(`GitHub Releases API error ${response.status}: ${response.statusText}`);
    }

    const responseText = await response.text();
    const bytesFetched = Buffer.byteLength(responseText, 'utf8');
    const responseEtag = response.headers.get('etag') ?? undefined;
    const releases = JSON.parse(responseText) as GitHubReleasePayload[];

    const linkHeader = response.headers.get('link');
    const hasNextPage = linkHeader
      ? linkHeader.includes('rel="next"')
      : releases.length === perPage;

    const items: CollectedRawItem[] = [];
    const window = request.partition.window;
    let reachedOlderThanWindow = false;

    for (const release of releases) {
      if (release.draft) {
        continue;
      }

      const publishedAtStr = release.published_at;
      const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;
      if (!publishedAt) {
        continue;
      }

      if (publishedAt.getTime() >= window.to.getTime()) {
        continue;
      }
      if (publishedAt.getTime() < window.from.getTime()) {
        reachedOlderThanWindow = true;
        continue;
      }

      const payload: Record<string, unknown> = { ...release };
      delete payload['created_at'];
      const rawItem = this.createRawItem({
        externalId: `github_releases:${targetOwner}/${targetRepo}:${release.id}`,
        payload,
        publishedAt,
        cursor: release.published_at ?? release.id.toString(),
        metadata: {
          canonicalUrl: release.html_url,
          tagName: release.tag_name,
          repository: `${targetOwner}/${targetRepo}`,
        },
      });
      items.push(rawItem);
    }

    let disposition: CollectionPageResult['disposition'];
    let nextCursor: string | null = null;
    let reason: string | null = null;

    if (reachedOlderThanWindow) {
      disposition = 'complete';
      nextCursor = null;
    } else if (hasNextPage) {
      disposition = 'continue';
      const nextCursorPayload = JSON.stringify({
        page: page + 1,
        ...(responseEtag ? { etag: responseEtag } : {}),
      });
      nextCursor = encodePageCursor(
        request.partition,
        request.target.capability.cursorVersion,
        nextCursorPayload,
      );
    } else {
      if (
        request.target.capability.historyMode === 'feed_only' &&
        request.partition.mode === 'backfill'
      ) {
        disposition = 'partial';
        reason = 'history_unsupported';
      } else {
        disposition = 'complete';
      }
      nextCursor = null;
    }

    const result: CollectionPageResult = {
      items,
      nextCursor,
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
function readRateLimit(headers: Headers): GitHubRateLimit {
  const limit = parseRateLimitHeader(headers.get('x-ratelimit-limit'));
  const remaining = parseRateLimitHeader(headers.get('x-ratelimit-remaining'));
  const reset = parseRateLimitHeader(headers.get('x-ratelimit-reset'));

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(reset === undefined ? {} : { reset }),
  };
}

function parseRateLimitHeader(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

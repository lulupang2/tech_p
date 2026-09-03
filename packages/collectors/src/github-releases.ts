import type {
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  CollectorPort,
  PolicyGuardPort,
  SourcePolicy,
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

export class GitHubReleasesCollector extends BaseCollector implements CollectorPort {
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

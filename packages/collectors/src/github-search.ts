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

/**
 * Supported GitHub search endpoint types.
 */
export type GitHubSearchEndpoint = 'repositories' | 'issues';

/**
 * Rate limit metadata parsed from GitHub API response headers.
 */
export interface GitHubSearchRateLimit extends Record<string, unknown> {
  limit?: number | undefined;
  remaining?: number | undefined;
  reset?: number | undefined;
  used?: number | undefined;
  resource?: string | undefined;
}

/**
 * Opaque cursor data payload for stateful GitHub search pagination.
 */
export interface GitHubSearchCursor extends Record<string, unknown> {
  endpoint?: GitHubSearchEndpoint | undefined;
  query?: string | undefined;
  queryIndex?: number | undefined;
  queryVersion?: string | undefined;
  page?: number | undefined;
  totalFetched?: number | undefined;
  lastCollectedAt?: string | undefined;
  rateLimit?: GitHubSearchRateLimit | undefined;
  incompleteResults?: boolean | undefined;
}
/**
 * Configuration for GitHubSearchCollector.
 */
export interface GitHubSearchCollectorConfig {
  pat?: string;
  endpoint?: GitHubSearchEndpoint;
  query?: string;
  queries?: readonly string[];
  queryVersion?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  perPage?: number;
  maxResults?: number;
  minRequestIntervalMs?: number;
}

/**
 * Options and dependency injection for GitHubSearchCollector.
 */
export interface GitHubSearchCollectorOptions {
  guard?: PolicyGuardPort;
  fetch?: typeof fetch;
  clock?: { now(): number };
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Base error for GitHub search operations.
 */
export class GitHubSearchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitHubSearchError';
  }
}

/**
 * Error thrown when a Personal Access Token (PAT) is missing.
 * Authenticated access is mandatory per SOURCE_CATALOG §11; unauthenticated requests are refused.
 */
export class GitHubSearchAuthenticationError extends GitHubSearchError {
  constructor(
    message = 'GitHub Personal Access Token (PAT) is required for github_search collection. Unauthenticated requests are not permitted.',
  ) {
    super(message);
    this.name = 'GitHubSearchAuthenticationError';
  }
}

/**
 * Error thrown when GitHub Search rate limit is reached (30 req/min limit).
 */
export class GitHubSearchRateLimitError extends GitHubSearchError {
  readonly resetAt?: Date | undefined;
  readonly remaining?: number | undefined;

  constructor(
    message: string,
    details?: { resetAt?: Date | undefined; remaining?: number | undefined },
  ) {
    super(message);
    this.name = 'GitHubSearchRateLimitError';
    this.resetAt = details?.resetAt;
    this.remaining = details?.remaining;
  }
}

/**
 * Error thrown on non-2xx HTTP responses from GitHub Search API.
 */
export class GitHubSearchHttpError extends GitHubSearchError {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string, message?: string) {
    super(message ?? `GitHub Search API error ${status}: ${statusText}`);
    this.name = 'GitHubSearchHttpError';
    this.status = status;
    this.statusText = statusText;
  }
}

/**
 * Top-level response schema returned by the GitHub Search API.
 */
export interface GitHubSearchApiResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * Hard caps defined by GitHub Search API and source specification.
 */
export const GITHUB_SEARCH_MAX_PER_PAGE = 100;
export const GITHUB_SEARCH_MAX_RESULTS = 1000;
export const GITHUB_SEARCH_DEFAULT_RATE_INTERVAL_MS = 2000; // 30 requests/minute = 2000ms

/**
 * Authenticated GitHub Search Collector adapter implementing CollectorPort.
 * Adheres to SOURCE_CATALOG §11 and SECURITY.md §8:
 * - Refuses unauthenticated requests without PAT (no unauthenticated fallback)
 * - Restricts search to repositories and issues endpoints
 * - Enforces per_page <= 100 and total search results <= 1,000
 * - Throttles authenticated requests to 30/min
 * - Records query string, query version, and collection timestamp snapshot metadata
 * - Propagates incomplete_results flags
 * - Strips PII (owner, user, milestone.creator, assignee, assignees, author, assets.uploader)
 * - Prohibits historical star derivation / backfilling
 */
export class GitHubSearchCollector
  extends BaseCollector
  implements CollectorPort, CollectorPagePort
{
  readonly sourceKey = 'github_search' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES['github_search'];

  private readonly config: GitHubSearchCollectorConfig;
  private readonly customFetch: typeof fetch | undefined;
  private readonly clock: { now(): number };
  private readonly sleep: (ms: number) => Promise<void>;
  private lastRequestTime = 0;

  constructor(config: GitHubSearchCollectorConfig = {}, options?: GitHubSearchCollectorOptions) {
    super(options?.guard);
    this.config = config;
    this.customFetch = options?.fetch;
    this.clock = options?.clock ?? { now: () => Date.now() };
    this.sleep =
      options?.sleep ??
      ((ms: number) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startedAt = this.clock.now();

    // 1. Mandatory PAT validation: refuse immediately without making any request
    const pat = this.config.pat ?? process.env['GITHUB_PAT'] ?? process.env['GITHUB_TOKEN'];
    if (!pat || typeof pat !== 'string' || pat.trim() === '') {
      throw new GitHubSearchAuthenticationError(
        'GitHub Personal Access Token (PAT) is required for github_search collection. Unauthenticated requests are not permitted.',
      );
    }

    const fetchFn = this.customFetch ?? globalThis.fetch;

    // 2. Decode cursor if provided
    let cursorData: GitHubSearchCursor | null = null;
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<GitHubSearchCursor>(context.cursor);
    }

    const queries: readonly string[] =
      this.config.queries && this.config.queries.length > 0
        ? this.config.queries
        : [this.config.query ?? 'topic:typescript stars:>50'];

    const queryIndex =
      typeof cursorData?.queryIndex === 'number' && cursorData.queryIndex < queries.length
        ? cursorData.queryIndex
        : 0;

    const endpoint: GitHubSearchEndpoint =
      cursorData?.endpoint ?? this.config.endpoint ?? 'repositories';
    const query =
      cursorData?.query !== undefined && queries.length === 1
        ? cursorData.query
        : queries[queryIndex]!;
    const queryVersion = cursorData?.queryVersion ?? this.config.queryVersion ?? 'v1';
    const page = cursorData?.page ?? 1;
    const totalFetched = cursorData?.totalFetched ?? 0;
    // 3. Enforce result cap (1,000 max total results across search)
    const maxResultsCap = Math.min(
      GITHUB_SEARCH_MAX_RESULTS,
      this.config.maxResults ?? GITHUB_SEARCH_MAX_RESULTS,
    );

    if (
      totalFetched >= maxResultsCap ||
      (page - 1) * GITHUB_SEARCH_MAX_PER_PAGE >= GITHUB_SEARCH_MAX_RESULTS
    ) {
      return {
        sourceKey: this.sourceKey,
        items: [],
        nextCursor: null,
        hasMore: false,
        metrics: {
          itemsFetched: 0,
          bytesFetched: 0,
          durationMs: this.clock.now() - startedAt,
        },
      };
    }

    // 4. Enforce per_page cap (max 100 per GitHub Search API spec)
    const requestedPerPage = this.config.perPage ?? context.limit ?? 30;
    const perPage = Math.min(GITHUB_SEARCH_MAX_PER_PAGE, Math.max(1, requestedPerPage));

    // 5. Construct search URL
    const url = new URL(`https://api.github.com/search/${endpoint}`);
    url.searchParams.set('q', query);
    url.searchParams.set('per_page', perPage.toString());
    if (page > 1) {
      url.searchParams.set('page', page.toString());
    }
    if (this.config.sort) {
      url.searchParams.set('sort', this.config.sort);
    }
    if (this.config.order) {
      url.searchParams.set('order', this.config.order);
    }

    // 6. Source policy host & SSRF guard
    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
    }

    // 7. Rate throttle: 30 requests/minute limit for authenticated search API
    const minIntervalMs =
      this.config.minRequestIntervalMs ?? GITHUB_SEARCH_DEFAULT_RATE_INTERVAL_MS;
    const now = this.clock.now();
    const elapsed = now - this.lastRequestTime;
    if (this.lastRequestTime > 0 && elapsed < minIntervalMs) {
      const delay = minIntervalMs - elapsed;
      await this.sleep(delay);
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Signal Archive-Collector/1.0',
      Authorization: `Bearer ${pat}`,
    };

    const requestInit: RequestInit = {
      method: 'GET',
      headers,
    };
    if (context.signal) {
      requestInit.signal = context.signal;
    }

    this.lastRequestTime = this.clock.now();
    const response = await fetchFn(url.toString(), requestInit);

    const rateLimit = readRateLimit(response.headers);

    // 8. Handle rate limit errors (403 rate limit / 429)
    if (response.status === 403 || response.status === 429) {
      const resetTime = rateLimit.reset ? new Date(rateLimit.reset * 1000) : undefined;
      throw new GitHubSearchRateLimitError(
        `GitHub Search API rate limit exceeded (${response.status}): ${response.statusText}`,
        { resetAt: resetTime, remaining: rateLimit.remaining },
      );
    }

    // 9. Handle non-2xx errors
    if (!response.ok) {
      let errorMessage = response.statusText;
      try {
        const errorJson = (await response.json()) as { message?: string };
        if (errorJson?.message) {
          errorMessage = errorJson.message;
        }
      } catch {
        // Fallback to statusText
      }
      throw new GitHubSearchHttpError(
        response.status,
        response.statusText,
        `GitHub Search API error ${response.status}: ${errorMessage}`,
      );
    }

    // 10. Parse response body
    const responseData = (await response.json()) as GitHubSearchApiResponse;
    const searchItems = Array.isArray(responseData.items) ? responseData.items : [];
    const incompleteResults = Boolean(responseData.incomplete_results);
    const totalCount = typeof responseData.total_count === 'number' ? responseData.total_count : 0;

    // Slice to remaining cap if close to 1,000 result limit
    const remainingCap = Math.max(0, maxResultsCap - totalFetched);
    const itemsToProcess = searchItems.slice(0, remainingCap);

    const collectedAt = new Date(this.clock.now()).toISOString();
    const collectedTimestamp = Date.parse(collectedAt);

    const items: CollectedRawItem[] = [];

    // 11. Process and sanitize raw items with snapshot metadata & PII removal
    for (let i = 0; i < itemsToProcess.length; i++) {
      const rawItemData = itemsToProcess[i]!;
      const searchRank = totalFetched + i + 1;

      const metadata: Record<string, unknown> = {
        queryString: query,
        queryVersion,
        collectedAt,
        collectedTimestamp,
        endpoint,
        searchRank,
        totalCount,
        incompleteResults,
        canonicalUrl: rawItemData['html_url'] ?? null,
      };

      if (endpoint === 'repositories') {
        metadata['repository'] = rawItemData['full_name'];
        metadata['stargazersCount'] = rawItemData['stargazers_count'];
        metadata['forksCount'] = rawItemData['forks_count'];
        metadata['openIssuesCount'] = rawItemData['open_issues_count'];
        metadata['language'] = rawItemData['language'];
        metadata['archived'] = rawItemData['archived'];
        metadata['topics'] = rawItemData['topics'];
      } else {
        metadata['issueNumber'] = rawItemData['number'];
        metadata['state'] = rawItemData['state'];
        metadata['commentsCount'] = rawItemData['comments'];
        const reactions = rawItemData['reactions'] as Record<string, unknown> | undefined;
        if (reactions && typeof reactions === 'object') {
          metadata['reactionsCount'] = reactions['total_count'];
        }
        metadata['authorAssociation'] = rawItemData['author_association'];
      }

      const externalId = String(rawItemData['id']);
      const createdAtStr = rawItemData['created_at'] as string | undefined;
      const publishedAt = createdAtStr ? new Date(createdAtStr) : null;

      const cursorValue =
        endpoint === 'repositories'
          ? ((rawItemData['pushed_at'] as string) ?? createdAtStr ?? externalId)
          : ((rawItemData['updated_at'] as string) ?? createdAtStr ?? externalId);

      // Note: No historical stars backfilling is attempted; only point-in-time snapshot is stored
      const payload: Record<string, unknown> = { ...rawItemData };

      // BaseCollector.createRawItem removes PII (owner, user, milestone.creator, assignee, assignees, etc.)
      const rawItem = this.createRawItem({
        externalId,
        payload,
        publishedAt,
        cursor: cursorValue,
        metadata,
      });

      items.push(rawItem);
    }

    // 12. Determine pagination and next cursor
    const newTotalFetched = totalFetched + items.length;
    const reachedPageCap = page * perPage >= GITHUB_SEARCH_MAX_RESULTS;
    const reachedTotalCap = newTotalFetched >= maxResultsCap;
    const hasMore =
      !reachedPageCap &&
      !reachedTotalCap &&
      searchItems.length === perPage &&
      newTotalFetched < totalCount;

    let nextCursor: string | null = null;
    if (hasMore) {
      const nextCursorData: GitHubSearchCursor = {
        endpoint,
        query,
        ...(queries.length > 1 ? { queryIndex } : {}),
        queryVersion,
        page: page + 1,
        totalFetched: newTotalFetched,
        lastCollectedAt: collectedAt,
        rateLimit,
        incompleteResults,
      };
      nextCursor = encodeOpaqueCursor(nextCursorData);
    } else if (queries.length > 1) {
      const nextQueryIndex = (queryIndex + 1) % queries.length;
      const nextCursorData: GitHubSearchCursor = {
        endpoint,
        query: queries[nextQueryIndex]!,
        queryIndex: nextQueryIndex,
        queryVersion,
        page: 1,
        totalFetched: 0,
        lastCollectedAt: collectedAt,
        rateLimit,
        incompleteResults: false,
      };
      nextCursor = encodeOpaqueCursor(nextCursorData);
    }

    const hasMoreOutput =
      hasMore || (queries.length > 1 && (queryIndex + 1) % queries.length !== 0);

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore: hasMoreOutput,
      metrics: {
        itemsFetched: items.length,
        bytesFetched: parseContentLength(response.headers.get('content-length')),
        durationMs: this.clock.now() - startedAt,
      },
    };
  }

  /**
   * Single-target page collector fulfilling CollectorPagePort (COV-003).
   */
  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);

    const query =
      request.target.selector.kind === 'query'
        ? request.target.selector.query
        : (this.config.query ?? 'topic:ai');
    const endpoint: GitHubSearchEndpoint = this.config.endpoint ?? 'repositories';

    let page = 1;
    if (request.partition.cursor) {
      const decoded = decodePageCursor(request.partition, request.target.capability.cursorVersion);
      if (decoded) {
        try {
          const parsed = JSON.parse(decoded) as { page?: number };
          if (typeof parsed.page === 'number' && parsed.page >= 1) {
            page = parsed.page;
          }
        } catch {
          // Fallback
        }
      }
    }

    const perPage = request.limit > 0 ? Math.min(request.limit, 100) : (this.config.perPage ?? 30);
    const pat = this.config.pat ?? process.env['GITHUB_PAT'];

    const url = new URL(`https://api.github.com/search/${endpoint}`);
    url.searchParams.set('q', query);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
    if (this.config.sort) url.searchParams.set('sort', this.config.sort);
    if (this.config.order) url.searchParams.set('order', this.config.order);

    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      throw new Error(`SSRF guard rejected URL: ${urlValidation.reason}`);
    }

    const baseFetch = this.customFetch ?? globalThis.fetch;
    const fetchFn = createHardenedFetch({ guard: this.guard, policy: this.policy, baseFetch });

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Signal Archive-Collector/1.0',
    };
    if (pat) {
      headers['Authorization'] = `Bearer ${pat}`;
    }

    const response = await fetchFn(url.toString(), {
      headers,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

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
      throw new Error(`GitHub Search API error ${response.status}: ${response.statusText}`);
    }

    const responseText = await response.text();
    const bytesFetched = Buffer.byteLength(responseText, 'utf8');
    const body = JSON.parse(responseText) as GitHubSearchApiResponse;

    const items: CollectedRawItem[] = [];
    const searchItems = body.items ?? [];
    const window = request.partition.window;

    for (const item of searchItems) {
      const publishedAtStr =
        (item['created_at'] as string | undefined) ?? (item['updated_at'] as string | undefined);
      const publishedAt = publishedAtStr ? new Date(publishedAtStr) : null;
      if (publishedAt) {
        if (
          publishedAt.getTime() < window.from.getTime() ||
          publishedAt.getTime() >= window.to.getTime()
        ) {
          continue;
        }
      }

      const externalId = `github_search:${endpoint}:${String(item['id'])}`;
      const payload: Record<string, unknown> = { ...item };
      const rawItem = this.createRawItem({
        externalId,
        payload,
        publishedAt,
        cursor: String(item['id']),
        metadata: {
          canonicalUrl:
            (item['html_url'] as string | undefined) ??
            `https://github.com/${item['full_name'] as string | undefined}`,
          endpoint,
          query,
        },
      });
      items.push(rawItem);
    }

    const totalCount = body.total_count ?? 0;
    const reachedPageCap = page >= 10;
    const reachedTotalCap = page * perPage >= 1000;
    const hasMore =
      !reachedPageCap &&
      !reachedTotalCap &&
      searchItems.length === perPage &&
      page * perPage < totalCount;

    let disposition: CollectionPageResult['disposition'];
    let nextCursor: string | null = null;
    let reason: string | null = null;

    if (hasMore) {
      disposition = 'continue';
      nextCursor = encodePageCursor(
        request.partition,
        request.target.capability.cursorVersion,
        JSON.stringify({ page: page + 1 }),
      );
    } else if (reachedPageCap || reachedTotalCap) {
      if (totalCount > page * perPage) {
        disposition = 'partial';
        reason = 'result_cap';
      } else {
        disposition = 'complete';
      }
      nextCursor = null;
    } else {
      disposition = 'complete';
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

function readRateLimit(headers: Headers): GitHubSearchRateLimit {
  const limit = parseRateLimitHeader(headers.get('x-ratelimit-limit'));
  const remaining = parseRateLimitHeader(headers.get('x-ratelimit-remaining'));
  const reset = parseRateLimitHeader(headers.get('x-ratelimit-reset'));
  const used = parseRateLimitHeader(headers.get('x-ratelimit-used'));
  const resource = headers.get('x-ratelimit-resource') ?? undefined;

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(reset !== undefined ? { reset } : {}),
    ...(used !== undefined ? { used } : {}),
    ...(resource ? { resource } : {}),
  };
}

function parseRateLimitHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function parseContentLength(value: string | null): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

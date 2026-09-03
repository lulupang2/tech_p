import type {
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  PolicyGuardPort,
  SourcePolicy,
} from '@techpulse/domain';
import { BaseCollector } from './base.js';
import { SOURCE_POLICIES } from './policies.js';
import { decodeOpaqueCursor, encodeOpaqueCursor } from './cursor.js';
import { createHardenedFetch } from './guard.js';

/**
 * Options for configuring the StackExchangeCollector.
 */
export interface StackExchangeCollectorOptions {
  readonly fetchFn?: typeof fetch;
  readonly guard?: PolicyGuardPort;
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly defaultSite?: string;
  readonly defaultTag?: string;
  readonly defaultTags?: readonly string[];
  readonly defaultFilter?: string;
}

/**
 * Payload structure serialized within the opaque cursor.
 */
export interface StackExchangeCursorPayload {
  readonly site: string;
  readonly tag?: string | null;
  readonly tagIndex?: number;
  readonly page: number;
  readonly fromdate?: number;
  readonly todate?: number;
  readonly backoffSeconds?: number;
  readonly backoffUntil?: number;
  readonly quotaRemaining?: number;
  readonly [key: string]: unknown;
}

/**
 * Raw question representation from the Stack Exchange API.
 */
export interface StackExchangeRawQuestion {
  readonly question_id: number;
  readonly link: string;
  readonly title?: string;
  readonly creation_date: number; // epoch seconds
  readonly last_activity_date?: number;
  readonly last_edit_date?: number;
  readonly content_license?: string | null;
  readonly tags?: readonly string[];
  readonly score?: number;
  readonly view_count?: number;
  readonly answer_count?: number;
  readonly is_answered?: boolean;
  readonly closed_date?: number;
  readonly closed_reason?: string;
  readonly locked_date?: number;
  readonly body?: string;
  readonly owner?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/**
 * Top-level response schema returned by the Stack Exchange 2.3 API.
 */
export interface StackExchangeApiResponse {
  readonly items?: readonly StackExchangeRawQuestion[];
  readonly has_more?: boolean;
  readonly quota_max?: number;
  readonly quota_remaining?: number;
  readonly backoff?: number;
  readonly error_id?: number;
  readonly error_message?: string;
  readonly error_name?: string;
  readonly [key: string]: unknown;
}

/**
 * Detects deletion tombstone candidates based on absence in a successful re-fetch result.
 * Invariants per SOURCE_CATALOG.md §3 and DATA_PIPELINE.md §9:
 * - Rate-limit / error responses MUST NEVER be treated as deletions.
 * - Absence-based deletion ONLY records candidates from an explicitly successful re-fetch.
 * - Closed or locked items are NOT deletions and MUST NOT be candidate tombstones.
 */
export function detectTombstoneCandidates(params: {
  readonly expectedExternalIds: readonly string[];
  readonly fetchedActiveExternalIds: readonly string[];
  readonly fetchSuccess: boolean;
}): readonly string[] {
  if (!params.fetchSuccess) {
    // Rate limit or fetch failure must never cause deletion candidates
    return [];
  }
  const activeSet = new Set(params.fetchedActiveExternalIds);
  return params.expectedExternalIds.filter((id) => !activeSet.has(id));
}

/**
 * Collector adapter for Stack Exchange API (v2.3) questions.
 * Implements COL-003 according to SOURCE_CATALOG.md §3 and SECURITY.md §8.
 */
export class StackExchangeCollector extends BaseCollector {
  readonly sourceKey = 'stack_exchange' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES['stack_exchange'];

  private readonly options: StackExchangeCollectorOptions;

  constructor(options: StackExchangeCollectorOptions = {}) {
    super(options.guard);
    this.options = options;
  }

  /**
   * Collects questions from the Stack Exchange API based on site, tag, and time window parameters.
   */
  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = Date.now();

    // 1. Decode cursor payload if present
    const cursorData = context.cursor
      ? decodeOpaqueCursor<StackExchangeCursorPayload>(context.cursor)
      : null;

    const tags: readonly string[] =
      this.options.defaultTags && this.options.defaultTags.length > 0
        ? this.options.defaultTags
        : this.options.defaultTag
          ? [this.options.defaultTag]
          : [];

    const tagIndex =
      typeof cursorData?.tagIndex === 'number' && cursorData.tagIndex < tags.length
        ? cursorData.tagIndex
        : 0;

    const site = cursorData?.site ?? this.options.defaultSite ?? 'stackoverflow';
    const tag =
      cursorData?.tag !== undefined && tags.length <= 1
        ? (cursorData.tag ?? undefined)
        : tags.length > 0
          ? tags[tagIndex]
          : (this.options.defaultTag ?? undefined);
    const page = cursorData?.page ?? 1;
    const limit = context.limit ? Math.min(Math.max(context.limit, 1), 100) : 30;

    const fromdate =
      cursorData?.fromdate ??
      (context.timeWindow?.from ? Math.floor(context.timeWindow.from.getTime() / 1000) : undefined);
    const todate =
      cursorData?.todate ??
      (context.timeWindow?.to ? Math.floor(context.timeWindow.to.getTime() / 1000) : undefined);
    const filter = this.options.defaultFilter ?? 'default';

    // 2. Build URL
    const url = new URL('https://api.stackexchange.com/2.3/questions');
    url.searchParams.set('site', site);
    if (tag) {
      url.searchParams.set('tagged', tag);
    }
    url.searchParams.set('page', String(page));
    url.searchParams.set('pagesize', String(limit));
    url.searchParams.set('order', 'desc');
    url.searchParams.set('sort', 'activity');
    url.searchParams.set('filter', filter);

    if (fromdate !== undefined) {
      url.searchParams.set('fromdate', String(fromdate));
    }
    if (todate !== undefined) {
      url.searchParams.set('todate', String(todate));
    }
    if (this.options.apiKey) {
      url.searchParams.set('key', this.options.apiKey);
    }
    if (this.options.accessToken) {
      url.searchParams.set('access_token', this.options.accessToken);
    }

    // 3. Validate URL against policy guard (SSRF & allowed hosts)
    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      const safeUrl = `${url.origin}${url.pathname}`;
      throw new Error(
        `Security violation: URL '${safeUrl}' rejected by policy guard: ${urlValidation.reason}`,
      );
    }
    // 4. Perform injected fetch
    const baseFetch = this.options.fetchFn ?? globalThis.fetch;
    const fetchFn = createHardenedFetch({ guard: this.guard, policy: this.policy, baseFetch });
    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        headers: {
          Accept: 'application/json',
        },
      });
    } catch (err) {
      throw new Error(
        `Network failure while fetching Stack Exchange data: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 5. Handle HTTP status and errors (Rate-limit and errors must NEVER be treated as deletions)
    if (!response.ok) {
      throw new Error(`Stack Exchange API error: HTTP ${response.status} ${response.statusText}`);
    }

    const responseText = await response.text();
    const bytesFetched = Buffer.byteLength(responseText, 'utf8');

    let body: StackExchangeApiResponse;
    try {
      body = JSON.parse(responseText) as StackExchangeApiResponse;
    } catch (err) {
      throw new Error(
        `Failed to parse Stack Exchange JSON response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Check for API-level errors in 200 responses (e.g. throttle_violation)
    if (body.error_id !== undefined) {
      throw new Error(
        `Stack Exchange API error (${body.error_id} ${body.error_name ?? 'unknown'}): ${body.error_message ?? 'No error message provided'}`,
      );
    }

    // 6. Map questions to CollectedRawItem with PII stripping, UTC published_at, and canonical metadata
    const rawQuestions = body.items ?? [];
    const items: CollectedRawItem[] = rawQuestions.map((q) => {
      // Stable external ID with site namespace (e.g. "stackoverflow:123456")
      const externalId = `${site}:${q.question_id}`;

      // Convert epoch seconds creation_date to UTC Date
      const publishedAt =
        typeof q.creation_date === 'number' ? new Date(q.creation_date * 1000) : null;

      // content_license per-item metadata (null if missing)
      const contentLicense = q.content_license ?? null;

      const metadata: Record<string, unknown> = {
        canonical_url: q.link,
        content_license: contentLicense,
        verbatim_only: this.policy.verbatimOnly, // true per SOURCE_POLICIES.stack_exchange
        site,
        tags: q.tags ?? [],
        ...(q.title !== undefined ? { title: q.title } : {}),
        ...(q.score !== undefined ? { score: q.score } : {}),
        ...(q.view_count !== undefined ? { view_count: q.view_count } : {}),
        ...(q.answer_count !== undefined ? { answer_count: q.answer_count } : {}),
        ...(q.is_answered !== undefined ? { is_answered: q.is_answered } : {}),
        ...(q.closed_date !== undefined
          ? { closed_date: new Date(q.closed_date * 1000).toISOString() }
          : {}),
        ...(q.locked_date !== undefined
          ? { locked_date: new Date(q.locked_date * 1000).toISOString() }
          : {}),
        ...(q.last_activity_date !== undefined
          ? { last_activity_date: new Date(q.last_activity_date * 1000).toISOString() }
          : {}),
      };

      return this.createRawItem({
        externalId,
        payload: q as Record<string, unknown>,
        publishedAt,
        cursor: context.cursor,
        metadata,
      });
    });

    // 7. Calculate pagination and preserve response backoff in next cursor
    const hasMore = Boolean(body.has_more);
    const backoffSeconds = typeof body.backoff === 'number' ? body.backoff : undefined;
    const backoffUntil =
      backoffSeconds !== undefined ? Date.now() + backoffSeconds * 1000 : undefined;

    let nextCursor: string | null = null;
    if (hasMore) {
      const nextCursorPayload: StackExchangeCursorPayload = {
        site,
        tag: tag ?? null,
        ...(tags.length > 1 ? { tagIndex } : {}),
        page: page + 1,
        ...(fromdate !== undefined ? { fromdate } : {}),
        ...(todate !== undefined ? { todate } : {}),
        ...(backoffSeconds !== undefined
          ? {
              backoffSeconds,
              ...(backoffUntil !== undefined ? { backoffUntil } : {}),
            }
          : {}),
        ...(body.quota_remaining !== undefined ? { quotaRemaining: body.quota_remaining } : {}),
      };
      nextCursor = encodeOpaqueCursor(nextCursorPayload);
    } else if (tags.length > 1) {
      const nextTagIndex = (tagIndex + 1) % tags.length;
      const nextCursorPayload: StackExchangeCursorPayload = {
        site,
        tag: tags[nextTagIndex] ?? null,
        tagIndex: nextTagIndex,
        page: 1,
        ...(fromdate !== undefined ? { fromdate } : {}),
        ...(todate !== undefined ? { todate } : {}),
        ...(backoffSeconds !== undefined
          ? {
              backoffSeconds,
              ...(backoffUntil !== undefined ? { backoffUntil } : {}),
            }
          : {}),
        ...(body.quota_remaining !== undefined ? { quotaRemaining: body.quota_remaining } : {}),
      };
      nextCursor = encodeOpaqueCursor(nextCursorPayload);
    } else if (backoffSeconds !== undefined) {
      const finalCursorPayload: StackExchangeCursorPayload = {
        site,
        tag: tag ?? null,
        page,
        backoffSeconds,
        ...(backoffUntil !== undefined ? { backoffUntil } : {}),
        ...(body.quota_remaining !== undefined ? { quotaRemaining: body.quota_remaining } : {}),
      };
      nextCursor = encodeOpaqueCursor(finalCursorPayload);
    }

    const durationMs = Date.now() - startTime;
    const hasMoreOutput = hasMore || (tags.length > 1 && (tagIndex + 1) % tags.length !== 0);

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore: hasMoreOutput,
      metrics: {
        itemsFetched: items.length,
        bytesFetched,
        durationMs,
      },
    };
  }
  /**
   * Re-fetches specific questions by IDs to verify active state and identify absence-based deletions.
   * Rate limits and errors throw, guaranteeing that errors are NEVER misinterpreted as deletions.
   */
  async verifyQuestionsActive(params: {
    readonly questionIds: readonly (number | string)[];
    readonly site?: string;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly activeExternalIds: readonly string[];
    readonly tombstoneCandidates: readonly string[];
    readonly backoffSeconds?: number;
  }> {
    const site = params.site ?? this.options.defaultSite ?? 'stackoverflow';
    if (params.questionIds.length === 0) {
      return { activeExternalIds: [], tombstoneCandidates: [] };
    }

    const rawIds = params.questionIds.map((id) => {
      const str = String(id);
      return str.includes(':') ? str.split(':')[1]! : str;
    });
    const idVector = rawIds.join(';');

    const url = new URL(`https://api.stackexchange.com/2.3/questions/${idVector}`);
    url.searchParams.set('site', site);
    url.searchParams.set('pagesize', '100');
    url.searchParams.set('filter', this.options.defaultFilter ?? 'default');
    if (this.options.apiKey) {
      url.searchParams.set('key', this.options.apiKey);
    }
    if (this.options.accessToken) {
      url.searchParams.set('access_token', this.options.accessToken);
    }

    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      throw new Error(`Security violation: URL rejected: ${urlValidation.reason}`);
    }

    const baseFetch = this.options.fetchFn ?? globalThis.fetch;
    const fetchFn = createHardenedFetch({ guard: this.guard, policy: this.policy, baseFetch });
    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      throw new Error(
        `Network error during verification re-fetch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `Verification re-fetch failed with HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const text = await response.text();
    const data = JSON.parse(text) as StackExchangeApiResponse;

    if (data.error_id !== undefined) {
      throw new Error(
        `Verification re-fetch API error ${data.error_id} (${data.error_name}): ${data.error_message}`,
      );
    }

    const fetchedItems = data.items ?? [];
    const activeExternalIds = fetchedItems.map((q) => `${site}:${q.question_id}`);
    const expectedExternalIds = params.questionIds.map((id) => {
      const str = String(id);
      return str.includes(':') ? str : `${site}:${str}`;
    });

    const tombstoneCandidates = detectTombstoneCandidates({
      expectedExternalIds,
      fetchedActiveExternalIds: activeExternalIds,
      fetchSuccess: true,
    });

    return {
      activeExternalIds,
      tombstoneCandidates,
      ...(data.backoff !== undefined ? { backoffSeconds: data.backoff } : {}),
    };
  }
}

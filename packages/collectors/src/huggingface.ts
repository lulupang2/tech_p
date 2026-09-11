import { Buffer } from 'node:buffer';
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

export const DEFAULT_HUGGINGFACE_LIMIT = 20;
export const DEFAULT_HUGGINGFACE_BASE_URL = 'https://huggingface.co';

export type HuggingFaceEntityType = 'models' | 'datasets' | 'all';
export type HuggingFaceSort = 'downloads' | 'lastModified' | 'createdAt' | 'likes';

export interface HuggingFaceRateLimitInfo {
  readonly limit?: number | undefined;
  readonly remaining?: number | undefined;
  readonly reset?: number | undefined;
}

/**
 * Base error class for Hugging Face Hub collector errors.
 */
export class HuggingFaceCollectorError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'HuggingFaceCollectorError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Error thrown when Hugging Face API responds with HTTP 429 Rate Limited.
 * Encapsulates Retry-After delay calculations and ensures rate-limited responses
 * are never misinterpreted as successful zero-metric results.
 */
export class HuggingFaceRateLimitError extends HuggingFaceCollectorError {
  readonly status = 429;

  constructor(
    message = 'Hugging Face Hub API rate limit exceeded (HTTP 429)',
    public readonly retryAfterHeader: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
    public readonly resetAt: Date | null = null,
    public readonly rateLimit: HuggingFaceRateLimitInfo | null = null,
  ) {
    super(message);
    this.name = 'HuggingFaceRateLimitError';
  }
}

/**
 * Error thrown for general HTTP failures from the Hugging Face API.
 */
export class HuggingFaceHttpError extends HuggingFaceCollectorError {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    message = `Hugging Face HTTP request failed: ${status} ${statusText} (${url})`,
  ) {
    super(message);
    this.name = 'HuggingFaceHttpError';
  }
}

/**
 * Error thrown when a requested Hugging Face model or dataset is not found (HTTP 404).
 */
export class HuggingFaceItemNotFoundError extends HuggingFaceCollectorError {
  constructor(
    public readonly itemId: string,
    public readonly entityType: 'model' | 'dataset',
    message = `Hugging Face ${entityType} '${itemId}' not found (HTTP 404)`,
    public readonly status = 404,
  ) {
    super(message);
    this.name = 'HuggingFaceItemNotFoundError';
  }
}

export interface HuggingFaceCollectorOptions {
  readonly fetchFn?: typeof fetch;
  readonly guard?: PolicyGuardPort;
  readonly token?: string;
  readonly baseUrl?: string;
  readonly defaultLimit?: number;
  readonly defaultEntityType?: HuggingFaceEntityType;
  readonly defaultSort?: HuggingFaceSort;
  readonly targetModels?: readonly string[];
  readonly targetDatasets?: readonly string[];
  readonly search?: string;
  readonly filter?: string;
}

export interface HuggingFaceCursor extends Record<string, unknown> {
  entityType?: HuggingFaceEntityType;
  page?: number;
  offset?: number;
  targetIndex?: number;
  targetType?: 'models' | 'datasets';
  lastModified?: string;
  lastCreatedAt?: string;
  lastExternalId?: string;
  rateLimit?: HuggingFaceRateLimitInfo;
  backoffSeconds?: number;
  backoffUntil?: number;
}

/**
 * Parses HTTP Retry-After header as integer seconds or HTTP-date string.
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  nowMs = Date.now(),
): { seconds: number | null; resetAt: Date | null } {
  if (!headerValue || headerValue.trim() === '') {
    return { seconds: null, resetAt: null };
  }

  const trimmed = headerValue.trim();

  // Try parsing as integer seconds
  if (/^\d+$/.test(trimmed)) {
    const seconds = Math.max(0, parseInt(trimmed, 10));
    const resetAt = new Date(nowMs + seconds * 1000);
    return { seconds, resetAt };
  }

  // Try parsing as HTTP Date string
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diffMs = dateMs - nowMs;
    const seconds = Math.max(0, Math.ceil(diffMs / 1000));
    return { seconds, resetAt: new Date(dateMs) };
  }

  return { seconds: null, resetAt: null };
}

/**
 * Reads rate limit metadata from Hugging Face API response headers.
 */
export function readHuggingFaceRateLimit(headers: Headers): HuggingFaceRateLimitInfo | null {
  const limitHeader =
    headers.get('x-ratelimit-limit') ??
    headers.get('ratelimit-limit') ??
    headers.get('x-rate-limit-limit');
  const remainingHeader =
    headers.get('x-ratelimit-remaining') ??
    headers.get('ratelimit-remaining') ??
    headers.get('x-rate-limit-remaining');
  const resetHeader =
    headers.get('x-ratelimit-reset') ??
    headers.get('ratelimit-reset') ??
    headers.get('x-rate-limit-reset');

  if (!limitHeader && !remainingHeader && !resetHeader) {
    return null;
  }

  const limit = limitHeader ? parseInt(limitHeader, 10) : undefined;
  const remaining = remainingHeader ? parseInt(remainingHeader, 10) : undefined;
  const reset = resetHeader ? parseInt(resetHeader, 10) : undefined;

  return {
    ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
    ...(remaining !== undefined && !Number.isNaN(remaining) ? { remaining } : {}),
    ...(reset !== undefined && !Number.isNaN(reset) ? { reset } : {}),
  };
}

/**
 * Builds standard external ID for Hugging Face items: `{namespace}/{repo}` + commit SHA.
 * Follows SOURCE_CATALOG §12 contract.
 */
export function buildHuggingFaceExternalId(id: string, sha?: string | null): string {
  const trimmedId = id.trim();
  const cleanSha = sha && sha.trim() !== '' ? sha.trim() : 'head';
  return `${trimmedId}:${cleanSha}`;
}

/**
 * Sanitizes and extracts metric-only payload from raw Hub API item.
 * Strictly strips model card prose, README, description, cardData, widgetData,
 * siblings text, and namespace-identifying author/user PII per SOURCE_CATALOG §12 and SECURITY.md §8.
 */
export function extractHuggingFaceMetricPayload(
  rawItem: Record<string, unknown>,
  entityType: 'model' | 'dataset',
): Record<string, unknown> {
  const id = String(rawItem['id'] ?? rawItem['modelId'] ?? rawItem['_id'] ?? '');
  const sha = typeof rawItem['sha'] === 'string' ? rawItem['sha'] : null;

  const downloads = typeof rawItem['downloads'] === 'number' ? rawItem['downloads'] : 0;
  const downloadsAllTime =
    typeof rawItem['downloadsAllTime'] === 'number' ? rawItem['downloadsAllTime'] : undefined;
  const likes = typeof rawItem['likes'] === 'number' ? rawItem['likes'] : 0;

  const createdAt =
    typeof rawItem['createdAt'] === 'string'
      ? rawItem['createdAt']
      : rawItem['createdAt'] instanceof Date
        ? (rawItem['createdAt'] as Date).toISOString()
        : null;

  const lastModified =
    typeof rawItem['lastModified'] === 'string'
      ? rawItem['lastModified']
      : rawItem['lastModified'] instanceof Date
        ? (rawItem['lastModified'] as Date).toISOString()
        : null;

  const isPrivate = Boolean(rawItem['private']);
  const gated = rawItem['gated'];
  const disabled = rawItem['disabled'] !== undefined ? Boolean(rawItem['disabled']) : undefined;

  const tags = Array.isArray(rawItem['tags'])
    ? rawItem['tags'].filter((t): t is string => typeof t === 'string')
    : undefined;
  const pipelineTag =
    typeof rawItem['pipeline_tag'] === 'string' ? rawItem['pipeline_tag'] : undefined;
  const libraryName =
    typeof rawItem['library_name'] === 'string' ? rawItem['library_name'] : undefined;

  const payload: Record<string, unknown> = {
    id,
    entityType,
    sha,
    downloads,
    likes,
    createdAt,
    lastModified,
    private: isPrivate,
    metricType: 'model_activity',
  };

  if (downloadsAllTime !== undefined) {
    payload['downloadsAllTime'] = downloadsAllTime;
  }
  if (gated !== undefined) {
    payload['gated'] = gated;
  }
  if (disabled !== undefined) {
    payload['disabled'] = disabled;
  }
  if (tags && tags.length > 0) {
    payload['tags'] = tags;
  }
  if (pipelineTag !== undefined) {
    payload['pipeline_tag'] = pipelineTag;
  }
  if (libraryName !== undefined) {
    payload['library_name'] = libraryName;
  }

  return payload;
}

/**
 * Hugging Face Hub metric-only collector adapter fulfilling CollectorPort.
 * Implements COL-010 per SOURCE_CATALOG §12 and SECURITY.md §8:
 * - Metric-only collection: model/dataset download, likes, creation/update metrics only
 * - NEVER retains model card, README, descriptions, or personal namespace PII
 * - Token optional authentication: sends Authorization Bearer header only when token is provided
 * - Rate limit awareness: handles HTTP 429 with Retry-After calculation and backoff tracking
 * - Correct mapping of createdAt (publishedAt) and lastModified timestamps
 * - External ID structured as {namespace}/{repo} + commit SHA
 */
export class HuggingFaceCollector
  extends BaseCollector
  implements CollectorPort, CollectorPagePort
{
  readonly sourceKey = 'huggingface_hub' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES['huggingface_hub'];

  private readonly fetchFn: typeof fetch;
  private readonly token: string | undefined;
  private readonly baseUrl: string;
  private readonly defaultLimit: number;
  private readonly defaultEntityType: HuggingFaceEntityType;
  private readonly defaultSort: HuggingFaceSort;
  private readonly targetModels: readonly string[] | undefined;
  private readonly targetDatasets: readonly string[] | undefined;
  private readonly search: string | undefined;
  private readonly filter: string | undefined;

  constructor(options: HuggingFaceCollectorOptions = {}) {
    super(options.guard);
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.token =
      options.token ??
      (typeof process !== 'undefined'
        ? process.env?.['HUGGINGFACE_TOKEN'] || process.env?.['HF_TOKEN']
        : undefined);
    this.baseUrl = (options.baseUrl ?? DEFAULT_HUGGINGFACE_BASE_URL).replace(/\/+$/, '');
    this.defaultLimit = options.defaultLimit ?? DEFAULT_HUGGINGFACE_LIMIT;
    this.defaultEntityType = options.defaultEntityType ?? 'models';
    this.defaultSort = options.defaultSort ?? 'downloads';
    this.targetModels = options.targetModels;
    this.targetDatasets = options.targetDatasets;
    this.search = options.search;
    this.filter = options.filter;
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = Date.now();

    // 1. Decode cursor if provided
    let cursorData: HuggingFaceCursor | null = null;
    if (context.cursor) {
      cursorData = decodeOpaqueCursor<HuggingFaceCursor>(context.cursor);
    }

    const limit = context.limit ?? this.defaultLimit;
    const entityType =
      cursorData?.entityType ??
      (this.defaultEntityType === 'all' ? 'models' : this.defaultEntityType);

    // If explicit target models or datasets are configured, collect detail items
    if (
      (this.targetModels && this.targetModels.length > 0) ||
      (this.targetDatasets && this.targetDatasets.length > 0)
    ) {
      return this.collectTargetItems(context, cursorData, startTime);
    }

    // 2. Build List API URL
    const endpointType = entityType === 'datasets' ? 'datasets' : 'models';
    const url = new URL(`${this.baseUrl}/api/${endpointType}`);
    url.searchParams.set('full', 'true');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('sort', this.defaultSort);
    url.searchParams.set('direction', '-1');

    if (this.search) {
      url.searchParams.set('search', this.search);
    }
    if (this.filter) {
      url.searchParams.set('filter', this.filter);
    }

    const page = cursorData?.page ?? 1;
    const offset = cursorData?.offset ?? (page - 1) * limit;
    if (offset > 0) {
      url.searchParams.set('offset', String(offset));
    }

    // 3. Security validation: SSRF & allowed hosts policy guard
    const urlValidation = this.guard.validateUrl(url.toString(), this.policy);
    if (!urlValidation.valid) {
      throw new HuggingFaceCollectorError(
        `Security violation: URL '${url.toString()}' rejected by policy guard: ${urlValidation.reason ?? 'Forbidden host/scheme'}`,
      );
    }

    // 4. Build Request Headers (Conditional Authorization)
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'Signal Archive-Collector/1.0',
    };

    if (this.token && this.token.trim() !== '') {
      headers['Authorization'] = `Bearer ${this.token.trim()}`;
    }

    const requestInit: RequestInit = {
      method: 'GET',
      headers,
    };
    if (context.signal) {
      requestInit.signal = context.signal;
    }

    // 5. Execute Injected Fetch
    let response: Response;
    try {
      response = await this.fetchFn(url.toString(), requestInit);
    } catch (err) {
      throw new HuggingFaceCollectorError(
        `Network failure while fetching Hugging Face Hub: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    // 6. Read rate limit headers
    const rateLimit = readHuggingFaceRateLimit(response.headers);

    // 7. Handle 429 Rate Limit
    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('retry-after');
      const { seconds, resetAt } = parseRetryAfter(retryAfterHeader);
      throw new HuggingFaceRateLimitError(
        `Hugging Face API rate limit exceeded (HTTP 429). Retry after ${seconds ?? 'unknown'} seconds`,
        retryAfterHeader,
        seconds,
        resetAt,
        rateLimit,
      );
    }

    // 8. Handle HTTP errors
    if (!response.ok) {
      throw new HuggingFaceHttpError(response.status, response.statusText, url.toString());
    }

    const responseText = await response.text();
    const bytesFetched = Buffer.byteLength(responseText, 'utf8');

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(responseText);
    } catch (err) {
      throw new HuggingFaceCollectorError(
        `Failed to parse Hugging Face Hub JSON response: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const rawList = Array.isArray(parsedBody)
      ? (parsedBody as Array<Record<string, unknown>>)
      : parsedBody &&
          typeof parsedBody === 'object' &&
          Array.isArray((parsedBody as { items?: unknown }).items)
        ? (parsedBody as { items: Array<Record<string, unknown>> }).items
        : [];

    const items: CollectedRawItem[] = [];
    const entitySingular = endpointType === 'datasets' ? 'dataset' : 'model';

    for (const raw of rawList) {
      if (!raw || typeof raw !== 'object') continue;

      const rawRecord = raw as Record<string, unknown>;
      const repoId = String(
        rawRecord['id'] ?? rawRecord['modelId'] ?? rawRecord['_id'] ?? '',
      ).trim();
      if (!repoId) continue;

      const sha = typeof rawRecord['sha'] === 'string' ? rawRecord['sha'].trim() : null;
      const externalId = buildHuggingFaceExternalId(repoId, sha);

      // Extract ONLY metrics and metadata; exclude model card/README/descriptions/PII
      const metricPayload = extractHuggingFaceMetricPayload(rawRecord, entitySingular);

      // Map publishedAt: createdAt per SOURCE_CATALOG §12, fallback to lastModified
      const createdAtStr =
        typeof rawRecord['createdAt'] === 'string' ? rawRecord['createdAt'] : null;
      const lastModifiedStr =
        typeof rawRecord['lastModified'] === 'string' ? rawRecord['lastModified'] : null;

      let publishedAt: Date | null = null;
      if (createdAtStr) {
        const d = new Date(createdAtStr);
        if (!Number.isNaN(d.getTime())) publishedAt = d;
      }
      if (!publishedAt && lastModifiedStr) {
        const d = new Date(lastModifiedStr);
        if (!Number.isNaN(d.getTime())) publishedAt = d;
      }

      const metadata: Record<string, unknown> = {
        source: 'huggingface_hub',
        entityType: entitySingular,
        repoId,
        sha: sha ?? null,
        createdAt: createdAtStr,
        lastModified: lastModifiedStr,
        canonicalUrl: `https://huggingface.co/${entitySingular === 'dataset' ? 'datasets/' : ''}${repoId}`,
        metricType: 'model_activity',
      };

      const rawItem = this.createRawItem({
        externalId,
        payload: metricPayload,
        publishedAt,
        cursor: null,
        metadata,
      });

      items.push(rawItem);
    }

    // 9. Determine Next Cursor & Pagination
    const hasMore = rawList.length >= limit;
    let nextCursor: string | null = null;

    if (hasMore) {
      const nextOffset = offset + rawList.length;
      const lastExternalId = items[items.length - 1]?.externalId;
      const nextCursorPayload: HuggingFaceCursor = {
        entityType,
        page: page + 1,
        offset: nextOffset,
        ...(lastExternalId ? { lastExternalId } : {}),
        ...(rateLimit ? { rateLimit } : {}),
      };
      nextCursor = encodeOpaqueCursor(nextCursorPayload);
    } else if (this.defaultEntityType === 'all' && entityType === 'models') {
      // Transition from models to datasets when collecting 'all'
      const nextCursorPayload: HuggingFaceCursor = {
        entityType: 'datasets',
        page: 1,
        offset: 0,
        ...(rateLimit ? { rateLimit } : {}),
      };
      nextCursor = encodeOpaqueCursor(nextCursorPayload);
    }

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore: hasMore || (this.defaultEntityType === 'all' && entityType === 'models'),
      metrics: {
        itemsFetched: items.length,
        bytesFetched,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Helper to collect explicit target model/dataset items one by one.
   */
  private async collectTargetItems(
    context: CollectionContext,
    cursorData: HuggingFaceCursor | null,
    startTime: number,
  ): Promise<CollectionResult> {
    const models = this.targetModels ?? [];
    const datasets = this.targetDatasets ?? [];

    const targetType = cursorData?.targetType ?? (models.length > 0 ? 'models' : 'datasets');
    const targetList = targetType === 'models' ? models : datasets;
    const startIndex = cursorData?.targetIndex ?? 0;
    const limit = context.limit ?? 1;

    if (startIndex >= targetList.length) {
      if (targetType === 'models' && datasets.length > 0) {
        // Transition to datasets
        const nextCursor = encodeOpaqueCursor({
          targetType: 'datasets',
          targetIndex: 0,
        });
        return {
          sourceKey: this.sourceKey,
          items: [],
          nextCursor,
          hasMore: true,
          metrics: {
            itemsFetched: 0,
            bytesFetched: 0,
            durationMs: Date.now() - startTime,
          },
        };
      }

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

    const currentTargets = targetList.slice(startIndex, startIndex + limit);
    const items: CollectedRawItem[] = [];
    let totalBytes = 0;
    let lastRateLimit: HuggingFaceRateLimitInfo | null = null;

    for (const targetId of currentTargets) {
      const entitySingular = targetType === 'models' ? 'model' : 'dataset';
      const endpoint = targetType === 'models' ? 'models' : 'datasets';
      const url = `${this.baseUrl}/api/${endpoint}/${encodeURIComponent(targetId)}`;

      const urlValidation = this.guard.validateUrl(url, this.policy);
      if (!urlValidation.valid) {
        throw new HuggingFaceCollectorError(
          `Security violation: URL '${url}' rejected by policy guard: ${urlValidation.reason ?? 'Forbidden host/scheme'}`,
        );
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': 'Signal Archive-Collector/1.0',
      };
      if (this.token && this.token.trim() !== '') {
        headers['Authorization'] = `Bearer ${this.token.trim()}`;
      }

      const response = await this.fetchFn(url, {
        method: 'GET',
        headers,
        ...(context.signal ? { signal: context.signal } : {}),
      });

      lastRateLimit = readHuggingFaceRateLimit(response.headers);

      if (response.status === 429) {
        const retryAfterHeader = response.headers.get('retry-after');
        const { seconds, resetAt } = parseRetryAfter(retryAfterHeader);
        throw new HuggingFaceRateLimitError(
          `Hugging Face API rate limit exceeded (HTTP 429). Retry after ${seconds ?? 'unknown'} seconds`,
          retryAfterHeader,
          seconds,
          resetAt,
          lastRateLimit,
        );
      }

      if (response.status === 404) {
        throw new HuggingFaceItemNotFoundError(targetId, entitySingular);
      }

      if (!response.ok) {
        throw new HuggingFaceHttpError(response.status, response.statusText, url);
      }

      const text = await response.text();
      totalBytes += Buffer.byteLength(text, 'utf8');

      const rawRecord = JSON.parse(text) as Record<string, unknown>;
      const repoId = String(rawRecord['id'] ?? rawRecord['modelId'] ?? targetId).trim();
      const sha = typeof rawRecord['sha'] === 'string' ? rawRecord['sha'].trim() : null;
      const externalId = buildHuggingFaceExternalId(repoId, sha);

      const metricPayload = extractHuggingFaceMetricPayload(rawRecord, entitySingular);

      const createdAtStr =
        typeof rawRecord['createdAt'] === 'string' ? rawRecord['createdAt'] : null;
      const lastModifiedStr =
        typeof rawRecord['lastModified'] === 'string' ? rawRecord['lastModified'] : null;

      let publishedAt: Date | null = null;
      if (createdAtStr) {
        const d = new Date(createdAtStr);
        if (!Number.isNaN(d.getTime())) publishedAt = d;
      }
      if (!publishedAt && lastModifiedStr) {
        const d = new Date(lastModifiedStr);
        if (!Number.isNaN(d.getTime())) publishedAt = d;
      }

      const metadata: Record<string, unknown> = {
        source: 'huggingface_hub',
        entityType: entitySingular,
        repoId,
        sha: sha ?? null,
        createdAt: createdAtStr,
        lastModified: lastModifiedStr,
        canonicalUrl: `https://huggingface.co/${entitySingular === 'dataset' ? 'datasets/' : ''}${repoId}`,
        metricType: 'model_activity',
      };

      const rawItem = this.createRawItem({
        externalId,
        payload: metricPayload,
        publishedAt,
        cursor: null,
        metadata,
      });

      items.push(rawItem);
    }

    const nextIndex = startIndex + currentTargets.length;
    let nextCursor: string | null = null;
    let hasMore = false;
    if (nextIndex < targetList.length) {
      hasMore = true;
      nextCursor = encodeOpaqueCursor({
        targetType,
        targetIndex: nextIndex,
        ...(lastRateLimit ? { rateLimit: lastRateLimit } : {}),
      });
    } else if (targetType === 'models' && datasets.length > 0) {
      hasMore = true;
      nextCursor = encodeOpaqueCursor({
        targetType: 'datasets',
        targetIndex: 0,
        ...(lastRateLimit ? { rateLimit: lastRateLimit } : {}),
      });
    }

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore,
      metrics: {
        itemsFetched: items.length,
        bytesFetched: totalBytes,
        durationMs: Date.now() - startTime,
      },
    };
  }

  /**
   * Single-target page collector fulfilling CollectorPagePort (COV-003).
   */
  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);

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

    const res = await this.collect({
      sourceKey: 'huggingface_hub',
      cursor: encodeOpaqueCursor({ page }),
      timeWindow: request.partition.window,
      limit: request.limit,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    let disposition: CollectionPageResult['disposition'] = 'complete';
    let nextCursor: string | null = null;

    if (res.hasMore) {
      disposition = 'continue';
      nextCursor = encodePageCursor(
        request.partition,
        request.target.capability.cursorVersion,
        JSON.stringify({ page: page + 1 }),
      );
    } else {
      disposition = 'complete';
      nextCursor = null;
    }

    const result: CollectionPageResult = {
      items: res.items,
      nextCursor,
      disposition,
      reason: null,
      retryAt: null,
      requests: 1,
      bytes: res.metrics?.bytesFetched ?? 0,
    };
    validatePageResult(request.partition, result);
    return result;
  }
}

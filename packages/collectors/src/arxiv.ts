import { BaseCollector } from './base.js';
import { SOURCE_POLICIES } from './policies.js';
import { encodeOpaqueCursor, decodeOpaqueCursor } from './cursor.js';
import type {
  CollectionContext,
  CollectionResult,
  PolicyGuardPort,
  SourcePolicy,
} from '@techpulse/domain';

/**
 * Cursor payload for paginating arXiv search results.
 */
export interface ArxivCursor extends Record<string, unknown> {
  readonly start: number;
  readonly searchQuery: string;
  readonly maxResults: number;
}

/**
 * Configuration options for ArxivCollector.
 */
export interface ArxivCollectorOptions {
  readonly guard?: PolicyGuardPort;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;
  readonly baseUrl?: string;
  readonly requestSpacingMs?: number;
  readonly cacheTtlMs?: number;
  readonly defaultCategories?: readonly string[];
  readonly defaultMaxResults?: number;
}

/**
 * Parsed paper entry from arXiv Atom XML response.
 */
export interface ParsedArxivEntry {
  readonly id: string;
  readonly arxivId: string;
  readonly title: string;
  readonly summary: string;
  readonly published: string;
  readonly updated: string;
  readonly authors: readonly { readonly name: string }[];
  readonly primaryCategory?: string;
  readonly categories: readonly string[];
  readonly canonicalUrl: string;
  readonly doi?: string;
  readonly comment?: string;
  readonly journalRef?: string;
}

/**
 * Parsed feed structure from arXiv Atom XML response.
 */
export interface ParsedArxivFeed {
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly entries: readonly ParsedArxivEntry[];
}

/**
 * Extracts arXiv ID preserving version suffix (e.g. "2401.12345v2" or "cs/0101001v1").
 */
export function extractArxivId(idStr: string): string {
  const match = idStr.match(/^https?:\/\/arxiv\.org\/abs\/(.+)$/i);
  return match && match[1] ? match[1].trim() : idStr.trim();
}

/**
 * Decodes standard XML entities and numeric entities.
 */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Cleans XML text: strips internal tags, decodes entities, sanitizes decoded HTML tags, and normalizes whitespace.
 */
export function cleanXmlText(text: string): string {
  const withoutXmlTags = text.replace(/<[^>]+>/g, '');
  const decoded = decodeXmlEntities(withoutXmlTags);
  const sanitized = decoded.replace(/<[^>]+>/g, '');
  return sanitized.replace(/\s+/g, ' ').trim();
}

/**
 * Formats a Date object to arXiv query date format: YYYYMMDDHHMMSS (UTC).
 */
export function formatArxivDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}${h}${min}${s}`;
}

/**
 * Parses an arXiv Atom 1.0 XML response feed into strongly-typed entries.
 * Note: PDF / fulltext links (<link title="pdf" ...>) are explicitly ignored.
 */
export function parseArxivFeed(xml: string): ParsedArxivFeed {
  const totalResultsMatch = xml.match(
    /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/i,
  );
  const totalResults =
    totalResultsMatch && totalResultsMatch[1] ? parseInt(totalResultsMatch[1], 10) : 0;

  const startIndexMatch = xml.match(/<opensearch:startIndex[^>]*>(\d+)<\/opensearch:startIndex>/i);
  const startIndex = startIndexMatch && startIndexMatch[1] ? parseInt(startIndexMatch[1], 10) : 0;

  const itemsPerPageMatch = xml.match(
    /<opensearch:itemsPerPage[^>]*>(\d+)<\/opensearch:itemsPerPage>/i,
  );
  const itemsPerPage =
    itemsPerPageMatch && itemsPerPageMatch[1] ? parseInt(itemsPerPageMatch[1], 10) : 0;

  const entries: ParsedArxivEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    if (!entryXml) continue;

    const idRaw = entryXml.match(/<id>([\s\S]*?)<\/id>/i)?.[1]?.trim() ?? '';
    const arxivId = extractArxivId(idRaw);

    const titleRaw = entryXml.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
    const title = cleanXmlText(titleRaw);

    const summaryRaw = entryXml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ?? '';
    const summary = cleanXmlText(summaryRaw);

    const published = entryXml.match(/<published>([\s\S]*?)<\/published>/i)?.[1]?.trim() ?? '';
    const updated = entryXml.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1]?.trim() ?? '';

    // Extract minimal author names (CC0 metadata), omitting affiliations and emails
    const authors: { name: string }[] = [];
    const authorRegex = /<author>([\s\S]*?)<\/author>/gi;
    let authorMatch: RegExpExecArray | null;
    while ((authorMatch = authorRegex.exec(entryXml)) !== null) {
      const authorBlock = authorMatch[1];
      if (!authorBlock) continue;
      const nameRaw = authorBlock.match(/<name>([\s\S]*?)<\/name>/i)?.[1] ?? '';
      const name = cleanXmlText(nameRaw);
      if (name) {
        authors.push({ name });
      }
    }

    // Extract category terms
    const categories: string[] = [];
    const catRegex = /<category\s+[^>]*term="([^"]+)"/gi;
    let catMatch: RegExpExecArray | null;
    while ((catMatch = catRegex.exec(entryXml)) !== null) {
      const term = catMatch[1]?.trim();
      if (term && !categories.includes(term)) {
        categories.push(term);
      }
    }

    // Extract primary category
    const primaryCatMatch = entryXml.match(/<arxiv:primary_category\s+[^>]*term="([^"]+)"/i);
    const primaryCategory =
      primaryCatMatch && primaryCatMatch[1] ? primaryCatMatch[1].trim() : categories[0];

    // Optional metadata: DOI, Comment, Journal Ref
    const doiMatch = entryXml.match(/<arxiv:doi>([\s\S]*?)<\/arxiv:doi>/i);
    const doi = doiMatch && doiMatch[1] ? cleanXmlText(doiMatch[1]) : undefined;

    const commentMatch = entryXml.match(/<arxiv:comment>([\s\S]*?)<\/arxiv:comment>/i);
    const comment = commentMatch && commentMatch[1] ? cleanXmlText(commentMatch[1]) : undefined;

    const journalRefMatch = entryXml.match(/<arxiv:journal_ref>([\s\S]*?)<\/arxiv:journal_ref>/i);
    const journalRef =
      journalRefMatch && journalRefMatch[1] ? cleanXmlText(journalRefMatch[1]) : undefined;

    const canonicalUrl = `http://arxiv.org/abs/${arxivId}`;

    const entry: ParsedArxivEntry = {
      id: idRaw,
      arxivId,
      title,
      summary,
      published,
      updated,
      authors,
      categories,
      canonicalUrl,
      ...(primaryCategory ? { primaryCategory } : {}),
      ...(doi ? { doi } : {}),
      ...(comment ? { comment } : {}),
      ...(journalRef ? { journalRef } : {}),
    };

    entries.push(entry);
  }

  return {
    totalResults,
    startIndex,
    itemsPerPage,
    entries,
  };
}

/**
 * arXiv Collector Adapter (COL-006).
 *
 * Implements:
 * - Single connection / serialized network requests
 * - 3-second request spacing (rate limiting per arXiv API TOU)
 * - 1-day caching for identical queries
 * - Atom/XML parsing extracting abstract only (no PDF/fulltext)
 * - v1/v2 external ID preservation
 * - published -> publishedAt, updated -> metadata separation
 */
export class ArxivCollector extends BaseCollector {
  readonly sourceKey = 'arxiv' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES['arxiv'];

  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly baseUrl: string;
  private readonly requestSpacingMs: number;
  private readonly cacheTtlMs: number;
  private readonly defaultCategories: readonly string[];
  private readonly defaultMaxResults: number;

  // 1-day identical query cache
  private readonly queryCache = new Map<
    string,
    { timestamp: number; xmlText: string; status: number }
  >();

  // Single connection concurrency mutex & request spacing state
  private lastRequestTime = 0;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(options: ArxivCollectorOptions = {}) {
    super(options.guard);
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleepFn =
      options.sleep ??
      ((ms) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, ms);
        return promise;
      });
    this.nowFn = options.clock ?? (() => Date.now());
    this.baseUrl = options.baseUrl ?? 'http://export.arxiv.org/api/query';
    this.requestSpacingMs = options.requestSpacingMs ?? 3000;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.defaultCategories = options.defaultCategories ?? [
      'cs.AI',
      'cs.CL',
      'cs.IR',
      'cs.LG',
      'cs.SE',
    ];
    this.defaultMaxResults = options.defaultMaxResults ?? 25;
  }

  /**
   * Clears in-memory query cache (useful for testing and memory management).
   */
  clearCache(): void {
    this.queryCache.clear();
  }

  /**
   * Executes a collection run step.
   */
  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = this.nowFn();

    // 1. Build query URL from context (or cursor)
    const { url, start, maxResults, searchQuery } = this.buildQueryUrl(context);

    // 2. Execute network request with single connection, 3s spacing, and 1-day cache
    const response = await this.executeRequest(url, context.signal);

    // 3. Parse Atom XML feed
    const feed = parseArxivFeed(response.text);

    // 4. Map parsed entries to CollectedRawItem
    const items = feed.entries.map((entry) => {
      const payload: Record<string, unknown> = {
        id: entry.id,
        arxivId: entry.arxivId,
        title: entry.title,
        summary: entry.summary,
        canonicalUrl: entry.canonicalUrl,
        authors: entry.authors,
        categories: entry.categories,
        published: entry.published,
        updated: entry.updated,
        license: 'CC0-1.0',
      };

      if (entry.primaryCategory) payload['primaryCategory'] = entry.primaryCategory;
      if (entry.doi) payload['doi'] = entry.doi;
      if (entry.comment) payload['comment'] = entry.comment;
      if (entry.journalRef) payload['journalRef'] = entry.journalRef;

      const metadata: Record<string, unknown> = {
        updated: entry.updated || null,
        categories: entry.categories,
        license: 'CC0-1.0',
      };

      if (entry.primaryCategory) metadata['primaryCategory'] = entry.primaryCategory;
      if (entry.doi) metadata['doi'] = entry.doi;
      if (entry.comment) metadata['comment'] = entry.comment;
      if (entry.journalRef) metadata['journalRef'] = entry.journalRef;

      return this.createRawItem({
        externalId: entry.arxivId,
        payload,
        publishedAt: entry.published ? new Date(entry.published) : null,
        cursor: context.cursor,
        metadata,
      });
    });

    // 5. Determine cursor and pagination
    const nextStart = start + items.length;
    const hasMore =
      feed.totalResults > 0
        ? nextStart < feed.totalResults && items.length > 0
        : items.length === maxResults;

    const nextCursor = hasMore
      ? encodeOpaqueCursor({
          start: nextStart,
          searchQuery,
          maxResults,
        })
      : null;

    const durationMs = this.nowFn() - startTime;

    return {
      sourceKey: this.sourceKey,
      items,
      nextCursor,
      hasMore,
      metrics: {
        itemsFetched: items.length,
        bytesFetched: response.bytesFetched,
        durationMs,
      },
    };
  }

  /**
   * Builds the query URL based on context cursor or fresh search criteria.
   */
  private buildQueryUrl(context: CollectionContext): {
    url: string;
    start: number;
    maxResults: number;
    searchQuery: string;
  } {
    let start = 0;
    let searchQuery = '';
    let maxResults = context.limit ?? this.defaultMaxResults;

    if (context.cursor) {
      const decoded = decodeOpaqueCursor<ArxivCursor>(context.cursor);
      if (decoded && typeof decoded.start === 'number' && typeof decoded.searchQuery === 'string') {
        start = decoded.start;
        searchQuery = decoded.searchQuery;
        if (typeof decoded.maxResults === 'number' && !context.limit) {
          maxResults = decoded.maxResults;
        }
      }
    }

    if (!searchQuery) {
      const catClause = this.defaultCategories.map((c) => `cat:${c}`).join(' OR ');

      if (context.timeWindow) {
        const fromStr = formatArxivDate(context.timeWindow.from);
        const toStr = formatArxivDate(context.timeWindow.to);
        const dateClause = `submittedDate:[${fromStr} TO ${toStr}]`;
        searchQuery = `(${catClause}) AND ${dateClause}`;
      } else {
        searchQuery = catClause;
      }
    }

    const urlObj = new URL(this.baseUrl);
    urlObj.searchParams.set('search_query', searchQuery);
    urlObj.searchParams.set('start', String(start));
    urlObj.searchParams.set('max_results', String(maxResults));
    urlObj.searchParams.set('sortBy', 'submittedDate');
    urlObj.searchParams.set('sortOrder', 'descending');

    return {
      url: urlObj.toString(),
      start,
      maxResults,
      searchQuery,
    };
  }

  /**
   * Acquires the single connection lock.
   */
  private acquireLock(): Promise<() => void> {
    const { promise: nextLock, resolve: release } = Promise.withResolvers<void>();
    const currentLock = this.lockPromise;
    this.lockPromise = currentLock.then(() => nextLock);
    return currentLock.then(() => release);
  }

  /**
   * Executes network fetch with SSRF guard, 1-day cache, serialized lock, and 3s spacing.
   */
  private async executeRequest(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; bytesFetched: number; fromCache: boolean }> {
    // 1. Fast path: check 1-day cache
    const now = this.nowFn();
    const cached = this.queryCache.get(url);
    if (cached && now - cached.timestamp < this.cacheTtlMs) {
      return {
        text: cached.xmlText,
        bytesFetched: 0,
        fromCache: true,
      };
    }

    // 2. Validate URL against source policy (SSRF and host allowlist)
    const validation = this.guard.validateUrl(url, this.policy);
    if (!validation.valid) {
      throw new Error(`Policy violation for ${this.sourceKey}: ${validation.reason}`);
    }

    // 3. Acquire single connection lock
    const release = await this.acquireLock();
    try {
      // 4. Re-check cache in case a queued concurrent request populated it
      const postLockNow = this.nowFn();
      const cachedAfterLock = this.queryCache.get(url);
      if (cachedAfterLock && postLockNow - cachedAfterLock.timestamp < this.cacheTtlMs) {
        return {
          text: cachedAfterLock.xmlText,
          bytesFetched: 0,
          fromCache: true,
        };
      }

      // 5. Enforce 3-second spacing between outbound HTTP request starts
      const elapsed = postLockNow - this.lastRequestTime;
      if (elapsed < this.requestSpacingMs && this.lastRequestTime > 0) {
        const waitMs = this.requestSpacingMs - elapsed;
        await this.sleepFn(waitMs);
      }

      // Record request start timestamp for rate limiting
      this.lastRequestTime = this.nowFn();

      // 6. Outbound fetch with exactOptionalPropertyTypes safe init
      const fetchInit: RequestInit | undefined = signal ? { signal } : undefined;
      const response = await this.fetchFn(url, fetchInit);
      if (!response.ok) {
        throw new Error(
          `arXiv API request failed with status ${response.status}: ${response.statusText}`,
        );
      }

      const text = await response.text();
      const bytesFetched = Buffer.byteLength(text, 'utf8');

      // 7. Save to 1-day cache
      this.queryCache.set(url, {
        timestamp: this.lastRequestTime,
        xmlText: text,
        status: response.status,
      });

      return {
        text,
        bytesFetched,
        fromCache: false,
      };
    } finally {
      release();
    }
  }
}

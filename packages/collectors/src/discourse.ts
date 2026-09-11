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

/**
 * Cutoff date for license segregation per SOURCE_CATALOG.md §4:
 * Posts created before 2020-07-17 are under CC BY-NC-SA 3.0 and must not be stored.
 * Posts created on or after 2020-07-17 are under MIT / Apache-2.0.
 */
export const DISCOURSE_LICENSE_CUTOFF_DATE = new Date('2020-07-17T00:00:00.000Z');

/**
 * Standard disallowed path patterns for Discourse robots.txt and privacy protection.
 * Requests matching these paths must be rejected before network transmission.
 */
export const DISCOURSE_DISALLOWED_PATH_PATTERNS: readonly RegExp[] = [
  /\.rss$/i,
  /\/search(?:\/|$|\?)/i,
  /\/admin(?:\/|$|\?)/i,
  /\/g(?:\/|$|\?)/i,
  /\/my(?:\/|$|\?)/i,
  /\/u(?:\/|$|\?)/i,
  /\/users(?:\/|$|\?)/i,
  /\/badges(?:\/|$|\?)/i,
  /\/session(?:\/|$|\?)/i,
  /\/invites(?:\/|$|\?)/i,
  /\/auth(?:\/|$|\?)/i,
  /\/email(?:\/|$|\?)/i,
  /\/uploads(?:\/|$|\?)/i,
  /\/user-api-keys(?:\/|$|\?)/i,
  /\/review(?:\/|$|\?)/i,
  /\/logs(?:\/|$|\?)/i,
  /\/raw\//i,
  /\/site(?:\/|$|\?)/i,
  /\/groups(?:\/|$|\?)/i,
];

/**
 * Permitted endpoint pathname patterns for Discourse collector:
 * Only latest topics and topic details are allowed.
 */
export const DISCOURSE_ALLOWED_ENDPOINT_PATTERNS: readonly RegExp[] = [
  /^\/latest\.json$/i,
  /^\/t\/(?:[a-zA-Z0-9_.-]+\/)?\d+(?:\/\d+)?\.json$/i,
];

/**
 * Representation of a single post in a Discourse topic stream.
 */
export interface DiscoursePost {
  readonly id: number;
  readonly name?: string;
  readonly username?: string;
  readonly avatar_template?: string;
  readonly created_at: string;
  readonly cooked: string;
  readonly post_number: number;
  readonly post_type: number;
  readonly updated_at?: string;
  readonly reply_count?: number;
  readonly reply_to_post_number?: number | null;
  readonly score?: number;
  readonly topic_id: number;
  readonly topic_slug?: string;
  readonly display_username?: string;
  readonly user_id?: number;
  readonly hidden?: boolean;
  readonly deleted_at?: string | null;
  readonly deleted_by?: unknown;
  readonly user_deleted?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Summary topic object returned in Discourse topic lists (e.g. /latest.json).
 */
export interface DiscourseTopic {
  readonly id: number;
  readonly title: string;
  readonly fancy_title?: string;
  readonly slug: string;
  readonly posts_count: number;
  readonly created_at: string;
  readonly last_posted_at?: string;
  readonly views?: number;
  readonly reply_count?: number;
  readonly like_count?: number;
  readonly visible?: boolean;
  readonly closed?: boolean;
  readonly archived?: boolean;
  readonly deleted_at?: string | null;
  readonly deleted_by?: unknown;
  readonly user_deleted?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Detailed topic response returned by /t/{id}.json.
 */
export interface DiscourseTopicDetails extends DiscourseTopic {
  readonly post_stream?: {
    readonly posts?: readonly DiscoursePost[];
    readonly stream?: readonly number[];
    readonly [key: string]: unknown;
  };
  readonly details?: {
    readonly created_by?: Record<string, unknown>;
    readonly last_poster?: Record<string, unknown>;
    readonly participants?: readonly Record<string, unknown>[];
    readonly [key: string]: unknown;
  };
  readonly tags?: readonly string[];
  readonly word_count?: number;
}

/**
 * Response schema of GET /latest.json.
 */
export interface DiscourseLatestResponse {
  readonly users?: readonly Record<string, unknown>[];
  readonly topic_list?: {
    readonly can_create_topic?: boolean;
    readonly more_topics_url?: string;
    readonly per_page?: number;
    readonly topics?: readonly DiscourseTopic[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

/**
 * Opaque cursor structure for pagination across Discourse latest listings.
 */
export interface DiscourseCursorPayload extends Record<string, unknown> {
  readonly page: number;
  readonly lastPostedAt?: string | null;
  readonly lastTopicId?: number | null;
  readonly processedTopicIds?: readonly number[];
}

/**
 * Detected tombstone signals from deleted posts or topics.
 */
export interface DiscourseTombstoneSignal {
  readonly isTombstone: boolean;
  readonly deletedAt: string | null;
  readonly deletedBy: unknown;
  readonly userDeleted: boolean;
  readonly reason?: string;
}

/**
 * Configuration options for the Discourse collector.
 */
export interface DiscourseCollectorOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly guard?: PolicyGuardPort;
  readonly maxTopicsPerPage?: number;
  readonly defaultOrder?: 'default' | 'created' | 'activity';
  readonly defaultAscending?: boolean;
  readonly includeTombstones?: boolean;
  readonly ignoreLicenseCutoff?: boolean;
}

// ---------------------------------------------------------------------------
// Custom Error Hierarchy
// ---------------------------------------------------------------------------

export class DiscourseCollectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscourseCollectorError';
  }
}

export class DiscourseRateLimitError extends DiscourseCollectorError {
  constructor(
    message = 'Discourse API rate limit exceeded (HTTP 429)',
    public readonly status = 429,
    public readonly retryAfterHeader: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'DiscourseRateLimitError';
  }
}

export class DiscourseRobotsDisallowedError extends DiscourseCollectorError {
  constructor(
    public readonly requestedUrl: string,
    public readonly matchedDisallowPattern: string,
    message = `Request blocked by robots.txt disallow rule: ${requestedUrl} matches '${matchedDisallowPattern}'`,
  ) {
    super(message);
    this.name = 'DiscourseRobotsDisallowedError';
  }
}

export class DiscourseHttpError extends DiscourseCollectorError {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string,
    message = `Discourse API request failed: HTTP ${status} ${statusText} for ${url}`,
  ) {
    super(message);
    this.name = 'DiscourseHttpError';
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Checks whether a given publication date is before the 2020-07-17 license cutoff date.
 */
export function isBeforeLicenseCutoff(
  dateInput: Date | string | number | null | undefined,
): boolean {
  if (!dateInput) return true;
  const date =
    typeof dateInput === 'object' && dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return true;
  return date.getTime() < DISCOURSE_LICENSE_CUTOFF_DATE.getTime();
}

/**
 * Parses HTTP Retry-After header into seconds and milliseconds.
 * Supports both integer seconds ("60") and HTTP-date formats ("Wed, 21 Oct 2026 07:28:00 GMT").
 */
export function parseRetryAfterHeader(
  headerValue: string | null | undefined,
  nowMs = Date.now(),
): { seconds: number | null; delayMs: number | null } {
  if (!headerValue || typeof headerValue !== 'string') {
    return { seconds: null, delayMs: null };
  }

  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    return { seconds, delayMs: seconds * 1000 };
  }

  const parsedDate = new Date(trimmed);
  if (!Number.isNaN(parsedDate.getTime())) {
    const diffMs = Math.max(0, parsedDate.getTime() - nowMs);
    const seconds = Math.ceil(diffMs / 1000);
    return { seconds, delayMs: diffMs };
  }

  return { seconds: null, delayMs: null };
}

/**
 * Validates a target Discourse URL against robots.txt disallow rules and permitted endpoints.
 */
export function validateDiscourseEndpoint(urlString: string): {
  valid: boolean;
  reason?: string;
  matchedPattern?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  const pathname = parsed.pathname;
  const fullPath = parsed.pathname + parsed.search;

  // 1. Check robots.txt disallowed paths
  for (const pattern of DISCOURSE_DISALLOWED_PATH_PATTERNS) {
    if (pattern.test(pathname) || pattern.test(fullPath)) {
      return {
        valid: false,
        reason: `Path '${pathname}' is blocked by robots.txt disallow rule`,
        matchedPattern: pattern.toString(),
      };
    }
  }

  // 2. Check permitted endpoint patterns
  const isAllowedEndpoint = DISCOURSE_ALLOWED_ENDPOINT_PATTERNS.some((pattern) =>
    pattern.test(pathname),
  );

  if (!isAllowedEndpoint) {
    return {
      valid: false,
      reason: `Endpoint '${pathname}' is not a permitted Discourse collection endpoint (only /latest.json and /t/{id}.json allowed)`,
    };
  }

  return { valid: true };
}

/**
 * Detects tombstone deletion signals on a topic, topic details, or post object.
 */
export function detectDiscourseTombstone(
  item: DiscourseTopic | DiscourseTopicDetails | DiscoursePost | Record<string, unknown>,
): DiscourseTombstoneSignal | null {
  if (!item || typeof item !== 'object') return null;

  const deletedAt = (item.deleted_at as string | null | undefined) ?? null;
  const userDeleted = Boolean(item.user_deleted);
  const deletedBy = item.deleted_by ?? null;
  const postType = typeof item.post_type === 'number' ? item.post_type : undefined;

  // post_type 4 in Discourse is small_action / tombstone
  const isTombstone = Boolean(deletedAt) || userDeleted || Boolean(deletedBy) || postType === 4;

  if (!isTombstone) {
    return null;
  }

  let reason = 'Explicit deletion tombstone';
  if (userDeleted) {
    reason = 'Post or topic deleted by user';
  } else if (deletedAt) {
    reason = `Deleted at ${deletedAt}`;
  } else if (postType === 4) {
    reason = 'Tombstone action post type';
  }

  return {
    isTombstone: true,
    deletedAt,
    deletedBy,
    userDeleted,
    reason,
  };
}

/**
 * Decodes standard HTML entities.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCharCode(parseInt(code, 10));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    });
}

/**
 * Sanitizes cooked HTML from Discourse posts and extracts clean, injection-safe text.
 * Strictly removes:
 * - <script>, <style>, <noscript>, <template>, <iframe>, <object>, <embed>, <svg>, <canvas>
 * - Hidden elements (style display:none, visibility:hidden, opacity:0, font-size:0, hidden, aria-hidden, sr-only, d-none)
 * - HTML comments
 * - Images, figures, media tags
 * - Preserves code blocks with language, blockquotes, lists, headings, and clean text.
 */
export function extractTextFromCookedHtml(cookedHtml: string): string {
  if (!cookedHtml || typeof cookedHtml !== 'string') {
    return '';
  }

  let html = cookedHtml;

  // 1. Remove HTML comments
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Remove script, style, noscript, template, iframe, object, embed, svg, canvas with content
  html = html.replace(
    /<(script|style|noscript|template|iframe|object|embed|svg|canvas)\b[\s\S]*?<\/\1>/gi,
    '',
  );
  // Also remove self-closing or lone tags
  html = html.replace(
    /<(script|style|noscript|template|iframe|object|embed|svg|canvas)\b[^>]*\/?>/gi,
    '',
  );

  // 3. Remove hidden elements (CSS style, attributes, prompt-injection hidden text)
  // Matches elements with style="...display:\s*none...", "visibility:\s*hidden", "opacity:\s*0", "font-size:\s*0"
  html = html.replace(
    /<([a-zA-Z0-9_-]+)\b[^>]*\bstyle\s*=\s*["'][^"']*\b(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  // Matches elements with hidden attribute or aria-hidden="true"
  html = html.replace(
    /<([a-zA-Z0-9_-]+)\b[^>]*\b(?:hidden|aria-hidden\s*=\s*["']true["'])[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  // Matches elements with sr-only, d-none, invisible, hidden CSS classes
  html = html.replace(
    /<([a-zA-Z0-9_-]+)\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:sr-only|d-none|invisible|hidden|prompt-hidden|secret-instruction)\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );

  // 4. Remove all images, pictures, figures, audio, video tags
  html = html.replace(/<(img|picture|figure|video|audio|source|track)\b[^>]*\/?>/gi, '');
  html = html.replace(/<(picture|figure|video|audio)\b[\s\S]*?<\/\1>/gi, '');

  // 5. Convert code blocks: <pre><code class="lang-rust">...</code></pre>
  html = html.replace(
    /<pre\b[^>]*><code\b(?:\s+class=["'](?:lang-|language-)?([a-zA-Z0-9_-]+)["'])?[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    (_, lang, codeContent) => {
      const cleanCode = decodeHtmlEntities(codeContent).trim();
      const language = lang ? lang.trim() : '';
      return `\n\n\`\`\`${language}\n${cleanCode}\n\`\`\`\n\n`;
    },
  );

  // 6. Convert inline code <code>...</code>
  html = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    const inline = decodeHtmlEntities(code)
      .replace(/[\r\n]+/g, ' ')
      .trim();
    return `\`${inline}\``;
  });

  // 7. Convert blockquotes and Discourse quote asides: <aside class="quote">...<blockquote>...</blockquote></aside>
  html = html.replace(
    /<aside\b[^>]*class=["'][^"']*quote[^"']*["'][^>]*>[\s\S]*?<\/aside>/gi,
    (aside) => {
      // Extract inner text or blockquote
      const inner = aside.replace(/<aside\b[^>]*>|<\/aside>/gi, '');
      const cleanInner = inner.replace(/<[^>]+>/g, ' ').trim();
      return `\n\n> ${decodeHtmlEntities(cleanInner)}\n\n`;
    },
  );
  html = html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, quoteContent) => {
    const cleanQuote = quoteContent.replace(/<[^>]+>/g, ' ').trim();
    return `\n\n> ${decodeHtmlEntities(cleanQuote)}\n\n`;
  });

  // 8. Convert headings
  html = html.replace(
    /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi,
    (_, t) => `\n\n# ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );
  html = html.replace(
    /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi,
    (_, t) => `\n\n## ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );
  html = html.replace(
    /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi,
    (_, t) => `\n\n### ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );
  html = html.replace(
    /<h4\b[^>]*>([\s\S]*?)<\/h4>/gi,
    (_, t) => `\n\n#### ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );
  html = html.replace(
    /<h5\b[^>]*>([\s\S]*?)<\/h5>/gi,
    (_, t) => `\n\n##### ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );
  html = html.replace(
    /<h6\b[^>]*>([\s\S]*?)<\/h6>/gi,
    (_, t) => `\n\n###### ${t.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );

  // 9. Convert list items
  html = html.replace(
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    (_, item) => `\n* ${item.replace(/<[^>]+>/g, '').trim()}`,
  );

  // 10. Convert paragraphs and line breaks
  html = html.replace(/<br\s*\/?>/gi, '\n');
  html = html.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    (_, p) => `\n\n${p.replace(/<[^>]+>/g, '').trim()}\n\n`,
  );
  html = html.replace(/<hr\s*\/?>/gi, '\n\n---\n\n');

  // 11. Remove all remaining HTML tags
  html = html.replace(/<[^>]+>/g, '');

  // 12. Decode HTML entities
  html = decodeHtmlEntities(html);

  // 13. Clean up excessive whitespace while preserving paragraph separation
  const lines = html.split(/\r?\n/).map((l) => l.trim());
  const normalized = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return normalized;
}

/**
 * Deeply strips Discourse user PII from payload structures.
 */
export function stripDiscoursePii<T extends Record<string, unknown>>(data: T): T {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const PII_KEYS: Record<string, true> = {
    username: true,
    name: true,
    user_id: true,
    avatar_template: true,
    display_username: true,
    last_poster_username: true,
    user_title: true,
  };

  function clean(val: unknown): unknown {
    if (val === null || val === undefined) return val;
    if (Array.isArray(val)) {
      return val.map(clean);
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (PII_KEYS[k]) {
          continue;
        }
        if (k === 'created_by' || k === 'last_poster') {
          // If object has user fields, strip them
          if (v && typeof v === 'object') {
            const userObj = { ...(v as Record<string, unknown>) };
            for (const pKey of Object.keys(PII_KEYS)) {
              delete userObj[pKey];
            }
            delete userObj['id'];
            out[k] = clean(userObj);
          }
          continue;
        }
        if (k === 'participants' && Array.isArray(v)) {
          out[k] = v.map((p) => {
            if (p && typeof p === 'object') {
              const pObj = { ...(p as Record<string, unknown>) };
              for (const pKey of Object.keys(PII_KEYS)) {
                delete pObj[pKey];
              }
              delete pObj['id'];
              return clean(pObj);
            }
            return clean(p);
          });
          continue;
        }
        out[k] = clean(v);
      }
      return out;
    }
    return val;
  }

  return clean(data) as T;
}

// ---------------------------------------------------------------------------
// DiscourseCollector Class
// ---------------------------------------------------------------------------

/**
 * Discourse forum collector adapter for users.rust-lang.org.
 * Implements COL-007 adhering to SOURCE_CATALOG.md §4 and SECURITY.md §8:
 * - Only /latest.json and /t/{id}.json endpoints
 * - Robots disallow paths rejected before network egress
 * - 429 Retry-After header parsing and rate limit error signaling
 * - License cutoff: content created before 2020-07-17 is excluded from raw storage
 * - Tombstone signals captured for deleted topics and posts
 * - HTML sanitized and converted to clean text (removing hidden/script prompt injection instructions)
 * - Username, real name, user_id, avatar_template PII stripped before raw item creation
 */
export class DiscourseCollector extends BaseCollector implements CollectorPort, CollectorPagePort {
  readonly sourceKey = 'users_rust_lang' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES['users_rust_lang'];

  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly options: DiscourseCollectorOptions;

  constructor(options: DiscourseCollectorOptions = {}) {
    super(options.guard);
    this.options = options;
    this.baseUrl = (options.baseUrl ?? 'https://users.rust-lang.org').replace(/\/$/, '');
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  /**
   * Collects topics from users.rust-lang.org via /latest.json and /t/{id}.json.
   */
  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startedAt = Date.now();
    let totalBytesFetched = 0;

    // 1. Decode cursor payload if present
    const cursorData = context.cursor
      ? decodeOpaqueCursor<DiscourseCursorPayload>(context.cursor)
      : null;

    const page = cursorData?.page ?? 0;
    const limit = context.limit ?? 30;

    // 2. Construct and validate the latest.json request URL
    const latestUrl = new URL(`${this.baseUrl}/latest.json`);
    latestUrl.searchParams.set('page', String(page));
    if (this.options.defaultOrder) {
      latestUrl.searchParams.set('order', this.options.defaultOrder);
    }
    if (this.options.defaultAscending !== undefined) {
      latestUrl.searchParams.set('ascending', String(this.options.defaultAscending));
    }

    const latestUrlString = latestUrl.toString();

    // 3. Security Guard and Robots validation
    this.assertUrlPermitted(latestUrlString);

    // 4. Fetch /latest.json
    const latestResponse = await this.performFetch(latestUrlString, context.signal);
    totalBytesFetched += latestResponse.bytes;

    const latestData = latestResponse.data as DiscourseLatestResponse;
    const candidateTopics = latestData.topic_list?.topics ?? [];
    const moreTopicsUrl = latestData.topic_list?.more_topics_url;

    const collectedItems: CollectedRawItem[] = [];
    let lastProcessedTopicId: number | null = cursorData?.lastTopicId ?? null;
    let lastPostedAt: string | null = cursorData?.lastPostedAt ?? null;

    // 5. Process candidate topics
    for (const topicSummary of candidateTopics) {
      if (collectedItems.length >= limit) {
        break;
      }

      // Check license cutoff unless ignoreLicenseCutoff is enabled
      if (!this.options.ignoreLicenseCutoff && isBeforeLicenseCutoff(topicSummary.created_at)) {
        continue;
      }
      // Check time window if provided
      if (context.timeWindow) {
        const topicCreated = new Date(topicSummary.created_at);
        if (
          !Number.isNaN(topicCreated.getTime()) &&
          (topicCreated < context.timeWindow.from || topicCreated > context.timeWindow.to)
        ) {
          continue;
        }
      }

      // Fetch topic details: GET /t/{id}.json
      const topicDetailUrl = `${this.baseUrl}/t/${topicSummary.id}.json`;
      this.assertUrlPermitted(topicDetailUrl);

      const topicResponse = await this.performFetch(topicDetailUrl, context.signal);
      totalBytesFetched += topicResponse.bytes;

      const topicDetails = topicResponse.data as DiscourseTopicDetails;

      // Extract posts, sanitize HTML to clean text, and detect tombstones
      const topicTombstone = detectDiscourseTombstone(topicDetails);
      const posts = topicDetails.post_stream?.posts ?? [];

      const sanitizedPosts = posts.map((post) => {
        const postTombstone = detectDiscourseTombstone(post);
        const cleanText = extractTextFromCookedHtml(post.cooked ?? '');
        return {
          id: post.id,
          post_number: post.post_number,
          post_type: post.post_type,
          created_at: post.created_at,
          updated_at: post.updated_at,
          reply_count: post.reply_count,
          score: post.score,
          cooked_text: cleanText,
          is_tombstone: Boolean(postTombstone),
          tombstone: postTombstone ?? undefined,
        };
      });

      // Topic-level combined text
      const fullText = sanitizedPosts
        .map((p) => `Post #${p.post_number}:\n${p.cooked_text}`)
        .join('\n\n');

      const isTombstone = Boolean(topicTombstone) || sanitizedPosts.some((p) => p.is_tombstone);

      // Deep PII stripping
      const rawPayload = stripDiscoursePii({
        id: topicDetails.id,
        title: topicDetails.title,
        slug: topicDetails.slug,
        posts_count: topicDetails.posts_count,
        created_at: topicDetails.created_at,
        last_posted_at: topicDetails.last_posted_at,
        views: topicDetails.views,
        like_count: topicDetails.like_count,
        visible: topicDetails.visible,
        closed: topicDetails.closed,
        archived: topicDetails.archived,
        tags: topicDetails.tags,
        sanitized_content: fullText,
        sanitized_posts: sanitizedPosts,
        is_tombstone: isTombstone,
        tombstone: topicTombstone ?? undefined,
      });

      // Construct item cursor
      const itemCursor = encodeOpaqueCursor({
        page,
        lastTopicId: topicDetails.id,
        lastPostedAt: topicDetails.last_posted_at ?? topicDetails.created_at,
      });

      // Create validated CollectedRawItem (BaseCollector handles PII strip & hash validation)
      const rawItem = this.createRawItem({
        externalId: String(topicDetails.id),
        payload: rawPayload,
        publishedAt: topicDetails.created_at ? new Date(topicDetails.created_at) : null,
        cursor: itemCursor,
        metadata: {
          sourceKey: this.sourceKey,
          canonicalUrl: `https://users.rust-lang.org/t/${topicDetails.slug || 'topic'}/${topicDetails.id}`,
          title: topicDetails.title,
          postsCount: topicDetails.posts_count,
          license: 'MIT',
          isTombstone,
          ...(topicTombstone ? { tombstone: topicTombstone } : {}),
        },
      });

      collectedItems.push(rawItem);
      lastProcessedTopicId = topicDetails.id;
      lastPostedAt = topicDetails.last_posted_at ?? topicDetails.created_at;
    }

    const hasMore = Boolean(moreTopicsUrl) && candidateTopics.length > 0;
    const nextCursor = hasMore
      ? encodeOpaqueCursor({
          page: page + 1,
          lastTopicId: lastProcessedTopicId,
          lastPostedAt,
        })
      : null;

    return {
      sourceKey: this.sourceKey,
      items: collectedItems,
      nextCursor,
      hasMore,
      metrics: {
        itemsFetched: collectedItems.length,
        bytesFetched: totalBytesFetched,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Fetches and parses a single topic by ID with all policy, PII, and license checks applied.
   */
  async collectTopic(
    topicId: number | string,
    signal?: AbortSignal,
  ): Promise<CollectedRawItem | null> {
    const topicUrl = `${this.baseUrl}/t/${topicId}.json`;
    this.assertUrlPermitted(topicUrl);

    const res = await this.performFetch(topicUrl, signal);
    const topicDetails = res.data as DiscourseTopicDetails;

    // License cutoff check unless ignoreLicenseCutoff is enabled
    if (!this.options.ignoreLicenseCutoff && isBeforeLicenseCutoff(topicDetails.created_at)) {
      return null;
    }
    const topicTombstone = detectDiscourseTombstone(topicDetails);
    const posts = topicDetails.post_stream?.posts ?? [];

    const sanitizedPosts = posts.map((post) => {
      const postTombstone = detectDiscourseTombstone(post);
      const cleanText = extractTextFromCookedHtml(post.cooked ?? '');
      return {
        id: post.id,
        post_number: post.post_number,
        post_type: post.post_type,
        created_at: post.created_at,
        updated_at: post.updated_at,
        reply_count: post.reply_count,
        score: post.score,
        cooked_text: cleanText,
        is_tombstone: Boolean(postTombstone),
        tombstone: postTombstone ?? undefined,
      };
    });

    const fullText = sanitizedPosts
      .map((p) => `Post #${p.post_number}:\n${p.cooked_text}`)
      .join('\n\n');

    const isTombstone = Boolean(topicTombstone) || sanitizedPosts.some((p) => p.is_tombstone);

    const rawPayload = stripDiscoursePii({
      id: topicDetails.id,
      title: topicDetails.title,
      slug: topicDetails.slug,
      posts_count: topicDetails.posts_count,
      created_at: topicDetails.created_at,
      last_posted_at: topicDetails.last_posted_at,
      views: topicDetails.views,
      like_count: topicDetails.like_count,
      visible: topicDetails.visible,
      closed: topicDetails.closed,
      archived: topicDetails.archived,
      tags: topicDetails.tags,
      sanitized_content: fullText,
      sanitized_posts: sanitizedPosts,
      is_tombstone: isTombstone,
      tombstone: topicTombstone ?? undefined,
    });

    return this.createRawItem({
      externalId: String(topicDetails.id),
      payload: rawPayload,
      publishedAt: topicDetails.created_at ? new Date(topicDetails.created_at) : null,
      cursor: null,
      metadata: {
        sourceKey: this.sourceKey,
        canonicalUrl: `https://users.rust-lang.org/t/${topicDetails.slug || 'topic'}/${topicDetails.id}`,
        title: topicDetails.title,
        postsCount: topicDetails.posts_count,
        license: 'MIT',
        isTombstone,
        ...(topicTombstone ? { tombstone: topicTombstone } : {}),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Asserts that a target URL is permitted by both policy guard and robots disallow rules.
   */
  private assertUrlPermitted(urlString: string): void {
    // 1. SSRF & Scheme & Host Guard
    const guardResult = this.guard.validateUrl(urlString, this.policy);
    if (!guardResult.valid) {
      throw new DiscourseCollectorError(
        `Discourse URL security validation failed: ${guardResult.reason}`,
      );
    }

    // 2. Robots Disallow & Permitted Endpoints Guard
    const endpointResult = validateDiscourseEndpoint(urlString);
    if (!endpointResult.valid) {
      if (endpointResult.matchedPattern) {
        throw new DiscourseRobotsDisallowedError(
          urlString,
          endpointResult.matchedPattern,
          endpointResult.reason,
        );
      }
      throw new DiscourseCollectorError(
        endpointResult.reason ?? 'Discourse endpoint access denied',
      );
    }
  }

  /**
   * Executes HTTP fetch with 429 Retry-After parsing and response decoding.
   */
  private async performFetch(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ data: Record<string, unknown>; bytes: number; headers: Headers }> {
    this.assertUrlPermitted(url);

    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Signal Archive-Collector/1.0',
      },
      ...(signal ? { signal } : {}),
    });

    if (response.status === 429) {
      const retryAfterHeader = response.headers?.get?.('retry-after') ?? null;
      const parsed = parseRetryAfterHeader(retryAfterHeader);
      throw new DiscourseRateLimitError(
        `Discourse API rate limit exceeded (HTTP 429) for ${url}. Retry-After: ${retryAfterHeader ?? 'none'}`,
        429,
        retryAfterHeader,
        parsed.seconds,
        parsed.delayMs,
      );
    }

    if (!response.ok) {
      throw new DiscourseHttpError(response.status, response.statusText, url);
    }

    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new DiscourseCollectorError(`Failed to parse JSON response from ${url}`);
    }

    return { data, bytes, headers: response.headers };
  }

  /**
   * Single-target page collector fulfilling CollectorPagePort (COV-003).
   */
  async collectPage(request: CollectionPageRequest): Promise<CollectionPageResult> {
    assertCollectableTarget(request.target);

    let page = 0;
    if (request.partition.cursor) {
      const decoded = decodePageCursor(request.partition, request.target.capability.cursorVersion);
      if (decoded) {
        try {
          const parsed = JSON.parse(decoded) as { page?: number };
          if (typeof parsed.page === 'number' && parsed.page >= 0) {
            page = parsed.page;
          }
        } catch {
          // Fallback
        }
      }
    }

    const res = await this.collect({
      sourceKey: 'users_rust_lang',
      cursor: encodeOpaqueCursor({ page }),
      timeWindow: request.partition.window,
      limit: request.limit,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
    });

    let disposition: CollectionPageResult['disposition'] = 'complete';
    let nextCursor: string | null = null;
    let reason: string | null = null;

    if (res.hasMore) {
      disposition = 'continue';
      nextCursor = encodePageCursor(
        request.partition,
        request.target.capability.cursorVersion,
        JSON.stringify({ page: page + 1 }),
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
      items: res.items,
      nextCursor,
      disposition,
      reason,
      retryAt: null,
      requests: 1,
      bytes: res.metrics?.bytesFetched ?? 0,
    };
    validatePageResult(request.partition, result);
    return result;
  }
}

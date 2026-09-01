import type {
  SourcePolicy,
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  PolicyGuardPort,
  SourceKey,
} from '@techpulse/domain';
import { BaseCollector } from './base.js';
import { DefaultPolicyGuard } from './guard.js';
import { SOURCE_POLICIES } from './policies.js';
import { encodeOpaqueCursor, decodeOpaqueCursor } from './cursor.js';

/**
 * License attribution metadata contract.
 */
export interface ArticleLicenseConfig {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly attribution: string;
}

export type ArticleDiscoveryType = 'rss' | 'atom' | 'feed' | 'html_index';

export interface ArticleDiscoveryConfig {
  readonly type: ArticleDiscoveryType;
  readonly url: string;
  readonly linkPattern?: RegExp | string;
}

/**
 * Configuration for the unified Article collector.
 */
export interface ArticleSourceConfig {
  readonly sourceKey: SourceKey;
  readonly discovery: ArticleDiscoveryConfig;
  readonly license: ArticleLicenseConfig;
  readonly contentSelector?: string;
  readonly externalIdExtractor?: (entry: DiscoveredArticleEntry, articleUrl: string) => string;
}

export interface DiscoveredArticleEntry {
  readonly externalId: string;
  readonly url: string;
  readonly title?: string | undefined;
  readonly publishedAt?: Date | null;
  readonly metadata?: Record<string, unknown>;
}

export interface ArticleDiscoveryResult {
  readonly entries: readonly DiscoveredArticleEntry[];
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly notModified: boolean;
  readonly bytesFetched: number;
}

export interface ExtractedArticle {
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly publishedAt: Date | null;
  readonly license: ArticleLicenseConfig;
  readonly metadata?: Record<string, unknown>;
}

export interface ArticleCursorData extends Record<string, unknown> {
  readonly etag?: string | null;
  readonly lastModified?: string | null;
  readonly lastPublishedAt?: string | null;
  readonly lastExternalId?: string | null;
  readonly processedUrls?: readonly string[];
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ArticleCollectorOptions {
  readonly fetch?: FetchLike;
  readonly guard?: PolicyGuardPort;
  readonly config?: Partial<ArticleSourceConfig>;
}

// ---------------------------------------------------------------------------
// Predefined Default Configurations for Article Sources
// ---------------------------------------------------------------------------

export const REACT_BLOG_CONFIG: ArticleSourceConfig = {
  sourceKey: 'react_blog',
  discovery: {
    type: 'rss',
    url: 'https://react.dev/rss.xml',
  },
  license: {
    id: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution:
      'Portions of this page are reproduced from work created and shared by the React team and used according to terms described in the Creative Commons 4.0 Attribution License.',
  },
  externalIdExtractor: (entry, articleUrl) => {
    try {
      const parsed = new URL(articleUrl);
      return parsed.pathname.replace(/\/$/, '') || articleUrl;
    } catch {
      return entry.externalId || articleUrl;
    }
  },
};

export const CHROME_RELEASE_NOTES_CONFIG: ArticleSourceConfig = {
  sourceKey: 'chrome_release_notes',
  discovery: {
    type: 'html_index',
    url: 'https://developer.chrome.com/release-notes',
    linkPattern: /\/release-notes\/(\d+)/i,
  },
  license: {
    id: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution:
      'Portions of this page are reproduced from work created and shared by Google and used according to terms described in the Creative Commons 4.0 Attribution License.',
  },
  externalIdExtractor: (entry, articleUrl) => {
    const match = articleUrl.match(/\/release-notes\/(\d+)/i);
    if (match?.[1]) {
      return `chrome-release-notes-${match[1]}`;
    }
    return entry.externalId || articleUrl;
  },
};

export const DEFAULT_ARTICLE_CONFIGS: Readonly<
  Record<'chrome_release_notes' | 'react_blog', ArticleSourceConfig>
> = {
  chrome_release_notes: CHROME_RELEASE_NOTES_CONFIG,
  react_blog: REACT_BLOG_CONFIG,
};

// ---------------------------------------------------------------------------
// Lightweight AST / DOM HTML & XML Parser
// ---------------------------------------------------------------------------

export interface HtmlNode {
  readonly type: 'element' | 'text' | 'comment' | 'root';
  readonly tag?: string;
  readonly attrs?: Record<string, string>;
  readonly children?: HtmlNode[];
  readonly text?: string;
}

const VOID_ELEMENTS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

const RAW_TEXT_ELEMENTS: Record<string, true> = {
  script: true,
  style: true,
};

/**
 * Decodes common HTML / XML character references.
 */
export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isNaN(code) ? _ : String.fromCharCode(code);
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isNaN(code) ? _ : String.fromCharCode(code);
    });
}

/**
 * Parses an XML or HTML string into a lightweight DOM tree.
 */
export function parseXmlOrHtml(input: string): HtmlNode {
  const root: { type: 'root'; children: HtmlNode[] } = { type: 'root', children: [] };
  const stack: {
    node:
      | { type: 'element'; tag: string; attrs: Record<string, string>; children: HtmlNode[] }
      | typeof root;
  }[] = [{ node: root }];

  let pos = 0;
  const len = input.length;

  while (pos < len) {
    const nextLt = input.indexOf('<', pos);
    if (nextLt === -1) {
      const text = input.slice(pos);
      if (text.length > 0) {
        stack[stack.length - 1]!.node.children.push({
          type: 'text',
          text: decodeHtmlEntities(text),
        });
      }
      break;
    }

    if (nextLt > pos) {
      const text = input.slice(pos, nextLt);
      stack[stack.length - 1]!.node.children.push({
        type: 'text',
        text: decodeHtmlEntities(text),
      });
    }

    pos = nextLt;

    // CDATA Section <![CDATA[ ... ]]>
    if (input.startsWith('<![CDATA[', pos)) {
      const cdataEnd = input.indexOf(']]>', pos + 9);
      if (cdataEnd === -1) {
        const text = input.slice(pos + 9);
        stack[stack.length - 1]!.node.children.push({ type: 'text', text });
        pos = len;
      } else {
        const text = input.slice(pos + 9, cdataEnd);
        stack[stack.length - 1]!.node.children.push({ type: 'text', text });
        pos = cdataEnd + 3;
      }
      continue;
    }

    // Comment <!-- ... -->
    if (input.startsWith('<!--', pos)) {
      const commentEnd = input.indexOf('-->', pos + 4);
      if (commentEnd === -1) {
        pos = len;
      } else {
        const comment = input.slice(pos + 4, commentEnd);
        stack[stack.length - 1]!.node.children.push({ type: 'comment', text: comment });
        pos = commentEnd + 3;
      }
      continue;
    }

    // DOCTYPE or XML Declaration <!DOCTYPE ...> or <?xml ...?>
    if (input.startsWith('<!', pos) || input.startsWith('<?', pos)) {
      const tagEnd = input.indexOf('>', pos);
      if (tagEnd === -1) {
        pos = len;
      } else {
        pos = tagEnd + 1;
      }
      continue;
    }

    // End tag </tag>
    if (input.startsWith('</', pos)) {
      const tagEnd = input.indexOf('>', pos + 2);
      if (tagEnd === -1) {
        pos = len;
        continue;
      }
      const rawTag = input
        .slice(pos + 2, tagEnd)
        .trim()
        .toLowerCase();
      const tagName = rawTag.split(/\s+/)[0] ?? '';

      // Pop until matching tag
      for (let i = stack.length - 1; i > 0; i--) {
        const entry = stack[i]!;
        if ('tag' in entry.node && entry.node.tag === tagName) {
          stack.length = i;
          break;
        }
      }

      pos = tagEnd + 1;
      continue;
    }

    // Start tag <tag ...>
    const tagEnd = input.indexOf('>', pos + 1);
    if (tagEnd === -1) {
      pos = len;
      break;
    }

    const tagContent = input.slice(pos + 1, tagEnd).trim();
    const isSelfClosing = tagContent.endsWith('/') || tagContent.endsWith('?');
    const cleanContent = isSelfClosing ? tagContent.slice(0, -1).trim() : tagContent;

    const match = cleanContent.match(/^([a-zA-Z0-9_\-:]+)([\s\S]*)$/);
    if (!match) {
      pos = tagEnd + 1;
      continue;
    }

    const tagName = match[1]!.toLowerCase();
    const attrString = match[2] ?? '';
    const attrs = parseAttributes(attrString);

    const elemNode: {
      type: 'element';
      tag: string;
      attrs: Record<string, string>;
      children: HtmlNode[];
    } = {
      type: 'element',
      tag: tagName,
      attrs,
      children: [],
    };

    stack[stack.length - 1]!.node.children.push(elemNode);
    pos = tagEnd + 1;

    // Handle void elements or self-closing tags
    if (isSelfClosing || VOID_ELEMENTS[tagName]) {
      continue;
    }

    // Handle raw text elements like <script>, <style>
    if (RAW_TEXT_ELEMENTS[tagName]) {
      const closeTag = `</${tagName}>`;
      const closeIdx = input.toLowerCase().indexOf(closeTag, pos);
      if (closeIdx === -1) {
        const rawContent = input.slice(pos);
        elemNode.children.push({ type: 'text', text: rawContent });
        pos = len;
      } else {
        const rawContent = input.slice(pos, closeIdx);
        elemNode.children.push({ type: 'text', text: rawContent });
        pos = closeIdx + closeTag.length;
      }
      continue;
    }

    stack.push({ node: elemNode });
  }

  return root;
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_\-:]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(attrStr)) !== null) {
    const key = match[1]!.toLowerCase();
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = decodeHtmlEntities(val);
  }

  return attrs;
}

/**
 * Recursively queries all nodes matching a predicate.
 */
export function findNodes(root: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode[] {
  const results: HtmlNode[] = [];

  function walk(node: HtmlNode) {
    if (predicate(node)) {
      results.push(node);
    }
    if (node.children) {
      for (const child of node.children) {
        walk(child);
      }
    }
  }

  walk(root);
  return results;
}

/**
 * Finds the first node matching a predicate.
 */
export function findFirst(root: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode | null {
  if (predicate(root)) return root;
  if (root.children) {
    for (const child of root.children) {
      const found = findFirst(child, predicate);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Gets concatenated text content from a node, ignoring script, style, and comments.
 */
export function getTextContent(node: HtmlNode): string {
  if (node.type === 'text') {
    return node.text ?? '';
  }
  if (node.type === 'comment') {
    return '';
  }
  if (node.tag && (node.tag === 'script' || node.tag === 'style')) {
    return '';
  }
  if (node.children) {
    return node.children.map(getTextContent).join('');
  }
  return '';
}

// ---------------------------------------------------------------------------
// Discovery Phase (API / Structural Separation)
// ---------------------------------------------------------------------------

export class ArticleDiscoveryService {
  private readonly fetchFn: FetchLike;
  private readonly guard: PolicyGuardPort;

  constructor(fetchFn?: FetchLike, guard?: PolicyGuardPort) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.guard = guard ?? new DefaultPolicyGuard();
  }

  /**
   * Executes discovery against the target source according to its policy & configuration.
   */
  async discover(
    config: ArticleSourceConfig,
    policy: SourcePolicy,
    cursorData?: ArticleCursorData | null,
    signal?: AbortSignal,
  ): Promise<ArticleDiscoveryResult> {
    const discoveryUrl = config.discovery.url;

    // 1. SSRF and Allowed Host Guard validation
    const validation = this.guard.validateUrl(discoveryUrl, policy);
    if (!validation.valid) {
      throw new Error(
        `Discovery URL security validation failed for source ${policy.sourceKey}: ${validation.reason}`,
      );
    }

    // 2. Prepare conditional headers (ETag / If-None-Match, If-Modified-Since)
    const headers: Record<string, string> = {
      Accept:
        config.discovery.type === 'rss' ||
        config.discovery.type === 'atom' ||
        config.discovery.type === 'feed'
          ? 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8'
          : 'text/html, application/xhtml+xml;q=0.9, */*;q=0.8',
    };

    if (cursorData?.etag) {
      headers['If-None-Match'] = cursorData.etag;
    }
    if (cursorData?.lastModified) {
      headers['If-Modified-Since'] = cursorData.lastModified;
    }

    // 3. Fetch feed or index
    const response = await this.fetchFn(discoveryUrl, {
      method: 'GET',
      headers,
      ...(signal ? { signal } : {}),
    });

    // 4. Handle 304 Not Modified
    if (response.status === 304) {
      return {
        entries: [],
        etag: cursorData?.etag ?? response.headers.get('etag') ?? null,
        lastModified: cursorData?.lastModified ?? response.headers.get('last-modified') ?? null,
        notModified: true,
        bytesFetched: 0,
      };
    }

    if (!response.ok) {
      throw new Error(
        `Failed to discover articles from ${discoveryUrl}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const responseText = await response.text();
    const bytesFetched = Buffer.byteLength(responseText, 'utf8');
    const responseEtag = response.headers.get('etag') ?? null;
    const responseLastModified = response.headers.get('last-modified') ?? null;

    let entries: DiscoveredArticleEntry[] = [];

    if (
      config.discovery.type === 'rss' ||
      config.discovery.type === 'atom' ||
      config.discovery.type === 'feed'
    ) {
      entries = this.discoverFromRssXml(responseText, discoveryUrl);
    } else {
      entries = this.discoverFromHtmlIndex(
        responseText,
        discoveryUrl,
        config.discovery.linkPattern,
      );
    }

    return {
      entries,
      etag: responseEtag,
      lastModified: responseLastModified,
      notModified: false,
      bytesFetched,
    };
  }

  /**
   * Parses RSS / Atom XML into discovered article entries.
   */
  discoverFromRssXml(xml: string, baseUrl?: string): DiscoveredArticleEntry[] {
    const root = parseXmlOrHtml(xml);
    const entries: DiscoveredArticleEntry[] = [];

    // Find RSS <item> tags or Atom <entry> tags
    const items = findNodes(
      root,
      (node) => node.type === 'element' && (node.tag === 'item' || node.tag === 'entry'),
    );

    for (const item of items) {
      const titleNode = findFirst(item, (n) => n.type === 'element' && n.tag === 'title');
      const title = titleNode ? getTextContent(titleNode).trim() : undefined;

      // Link in RSS is <link>URL</link>, in Atom is <link href="URL" />
      const linkNode = findFirst(item, (n) => n.type === 'element' && n.tag === 'link');
      let link = '';
      if (linkNode) {
        link = (linkNode.attrs?.['href'] ?? getTextContent(linkNode)).trim();
      }

      // GUID in RSS is <guid>, ID in Atom is <id>
      const guidNode = findFirst(
        item,
        (n) => n.type === 'element' && (n.tag === 'guid' || n.tag === 'id'),
      );
      const guid = guidNode ? getTextContent(guidNode).trim() : undefined;

      // PubDate in RSS is <pubDate>, in Atom is <published> or <updated>
      const dateNode = findFirst(
        item,
        (n) =>
          n.type === 'element' &&
          (n.tag === 'pubdate' || n.tag === 'published' || n.tag === 'updated'),
      );
      let publishedAt: Date | null = null;
      if (dateNode) {
        const rawDate = getTextContent(dateNode).trim();
        const parsedDate = new Date(rawDate);
        if (!Number.isNaN(parsedDate.getTime())) {
          publishedAt = parsedDate;
        }
      }

      if (!link && guid && (guid.startsWith('http://') || guid.startsWith('https://'))) {
        link = guid;
      }

      if (link) {
        let absoluteUrl = link;
        if (baseUrl && !link.startsWith('http://') && !link.startsWith('https://')) {
          try {
            absoluteUrl = new URL(link, baseUrl).toString();
          } catch {
            absoluteUrl = link;
          }
        }

        const externalId = guid || absoluteUrl;
        entries.push({
          externalId,
          url: absoluteUrl,
          ...(title !== undefined ? { title } : {}),
          publishedAt,
        });
      }
    }

    return entries;
  }

  /**
   * Parses an HTML index page looking for article/release note links.
   */
  discoverFromHtmlIndex(
    html: string,
    baseUrl: string,
    pattern?: RegExp | string,
  ): DiscoveredArticleEntry[] {
    const root = parseXmlOrHtml(html);
    const links = findNodes(
      root,
      (node) => node.type === 'element' && node.tag === 'a' && !!node.attrs?.['href'],
    );

    const regex = pattern
      ? typeof pattern === 'string'
        ? new RegExp(pattern, 'i')
        : pattern
      : null;

    const seenUrls = new Set<string>();
    const entries: DiscoveredArticleEntry[] = [];

    for (const a of links) {
      const href = a.attrs?.['href']?.trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(href, baseUrl).toString();
      } catch {
        continue;
      }

      if (regex && !regex.test(href) && !regex.test(absoluteUrl)) {
        continue;
      }

      if (seenUrls.has(absoluteUrl)) {
        continue;
      }
      seenUrls.add(absoluteUrl);

      const title = getTextContent(a).trim() || undefined;
      entries.push({
        externalId: absoluteUrl,
        url: absoluteUrl,
        ...(title !== undefined ? { title } : {}),
        publishedAt: null,
      });
    }

    return entries;
  }
}

// ---------------------------------------------------------------------------
// Extraction Phase (API / Structural Separation)
// ---------------------------------------------------------------------------

export class ArticleExtractionService {
  private readonly fetchFn: FetchLike;
  private readonly guard: PolicyGuardPort;

  constructor(fetchFn?: FetchLike, guard?: PolicyGuardPort) {
    this.fetchFn = fetchFn ?? globalThis.fetch;
    this.guard = guard ?? new DefaultPolicyGuard();
  }

  /**
   * Fetches the article HTML from the given URL, enforces policy, and extracts clean text & metadata.
   */
  async extractFromUrl(
    url: string,
    config: ArticleSourceConfig,
    policy: SourcePolicy,
    discovered?: DiscoveredArticleEntry,
    signal?: AbortSignal,
  ): Promise<{ article: ExtractedArticle; bytesFetched: number }> {
    // 1. SSRF and Allowed Host Guard validation
    const validation = this.guard.validateUrl(url, policy);
    if (!validation.valid) {
      throw new Error(
        `Article URL security validation failed for source ${policy.sourceKey}: ${validation.reason}`,
      );
    }

    // 2. Fetch page HTML
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.8',
      },
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch article from ${url}: HTTP ${response.status} ${response.statusText}`,
      );
    }

    const html = await response.text();
    const bytesFetched = Buffer.byteLength(html, 'utf8');

    const article = this.extractFromHtml(html, url, config, discovered);
    return { article, bytesFetched };
  }

  /**
   * Extracts clean structured text, title, published date, and license metadata from HTML.
   * STRICTLY strips all images, SVGs, picture tags, image URLs, and trademark asset metadata.
   */
  extractFromHtml(
    html: string,
    url: string,
    config: ArticleSourceConfig,
    discovered?: DiscoveredArticleEntry,
  ): ExtractedArticle {
    const root = parseXmlOrHtml(html);

    // 1. Extract Title
    const title = this.extractTitle(root, discovered);

    // 2. Extract Published Date (DOM-based extraction)
    const publishedAt = this.extractPublishedDate(root, url, discovered);

    // 3. Extract Clean Content (NO images, NO trademark assets)
    const body = this.extractCleanBodyText(root);

    // 4. Formulate License & Attribution Metadata
    const license: ArticleLicenseConfig = {
      id: config.license.id,
      name: config.license.name,
      url: config.license.url,
      attribution: config.license.attribution,
    };

    return {
      title,
      body,
      url,
      publishedAt,
      license,
    };
  }

  private extractTitle(root: HtmlNode, discovered?: DiscoveredArticleEntry): string {
    // Check og:title meta
    const metaOg = findFirst(
      root,
      (n) =>
        n.type === 'element' &&
        n.tag === 'meta' &&
        (n.attrs?.['property'] === 'og:title' || n.attrs?.['name'] === 'og:title'),
    );
    if (metaOg?.attrs?.['content']?.trim()) {
      return metaOg.attrs['content'].trim();
    }

    // Check <h1> in document
    const h1 = findFirst(root, (n) => n.type === 'element' && n.tag === 'h1');
    if (h1) {
      const h1Text = getTextContent(h1).trim();
      if (h1Text) return h1Text;
    }

    // Check <title> tag
    const titleTag = findFirst(root, (n) => n.type === 'element' && n.tag === 'title');
    if (titleTag) {
      const titleText = getTextContent(titleTag).trim();
      if (titleText) return titleText;
    }

    return discovered?.title ?? 'Untitled Article';
  }

  /**
   * DOM-based extraction for published date.
   * Handles:
   * - Chrome release notes "Stable release date: August 25th, 2026" in DOM structure
   * - <time datetime="..."> tag
   * - <meta property="article:published_time">
   * - Slug dates (e.g. /blog/2024/12/05/...)
   */
  private extractPublishedDate(
    root: HtmlNode,
    url: string,
    discovered?: DiscoveredArticleEntry,
  ): Date | null {
    // 1. Check DOM for Chrome release notes "Stable release date"
    const chromeDate = this.extractChromeReleaseDate(root);
    if (chromeDate) {
      return chromeDate;
    }

    // 2. Check <time> element datetime attribute
    const timeElem = findFirst(
      root,
      (n) => n.type === 'element' && n.tag === 'time' && !!n.attrs?.['datetime'],
    );
    if (timeElem?.attrs?.['datetime']) {
      const parsed = new Date(timeElem.attrs['datetime']);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    // 3. Check <meta property="article:published_time">
    const metaPublished = findFirst(
      root,
      (n) =>
        n.type === 'element' &&
        n.tag === 'meta' &&
        (n.attrs?.['property'] === 'article:published_time' ||
          n.attrs?.['name'] === 'date' ||
          n.attrs?.['name'] === 'publish_date'),
    );
    if (metaPublished?.attrs?.['content']) {
      const parsed = new Date(metaPublished.attrs['content']);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    // 4. Check URL slug date pattern /YYYY/MM/DD/ (e.g. React blog /blog/2024/12/05/...)
    const slugDateMatch = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
    if (slugDateMatch) {
      const year = parseInt(slugDateMatch[1]!, 10);
      const month = parseInt(slugDateMatch[2]!, 10) - 1;
      const day = parseInt(slugDateMatch[3]!, 10);
      return new Date(Date.UTC(year, month, day));
    }

    // 5. Fallback to discovered published date
    if (discovered?.publishedAt) {
      return discovered.publishedAt;
    }

    return null;
  }

  /**
   * DOM-based extractor for "Stable release date" text in Chrome release notes pages.
   */
  private extractChromeReleaseDate(root: HtmlNode): Date | null {
    const candidates = findNodes(
      root,
      (n) => n.type === 'element' && /Stable release date/i.test(getTextContent(n)),
    );

    for (const elem of candidates) {
      const text = getTextContent(elem);
      const dateMatch = text.match(
        /Stable release date:?\s*([A-Za-z]+ \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{4}-\d{2}-\d{2})/i,
      );
      if (dateMatch?.[1]) {
        const cleanedDateStr = dateMatch[1].replace(/(\d+)(st|nd|rd|th)/i, '$1');
        const parsed = new Date(`${cleanedDateStr} UTC`);
        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
        const directParsed = new Date(cleanedDateStr);
        if (!Number.isNaN(directParsed.getTime())) {
          return directParsed;
        }
      }
    }

    return null;
  }

  /**
   * Extracts clean structured text, completely stripping image tags, picture elements,
   * SVGs, image URLs, and trademark asset references.
   */
  private extractCleanBodyText(root: HtmlNode): string {
    // Find main content container (<article>, <main>, or fallback to <body>/root)
    const contentRoot =
      findFirst(root, (n) => n.type === 'element' && n.tag === 'article') ||
      findFirst(root, (n) => n.type === 'element' && n.tag === 'main') ||
      findFirst(root, (n) => n.type === 'element' && n.tag === 'body') ||
      root;

    function renderNode(node: HtmlNode): string {
      if (node.type === 'text') {
        return node.text ?? '';
      }
      if (node.type === 'comment') {
        return '';
      }
      if (!node.tag) {
        return node.children ? node.children.map(renderNode).join('') : '';
      }

      const tag = node.tag.toLowerCase();

      // STRICTLY EXCLUDE: Scripts, styles, and non-content tags
      if (
        tag === 'script' ||
        tag === 'style' ||
        tag === 'noscript' ||
        tag === 'template' ||
        tag === 'iframe' ||
        tag === 'nav' ||
        tag === 'footer' ||
        tag === 'header' ||
        tag === 'head'
      ) {
        return '';
      }

      // STRICTLY EXCLUDE: All images, picture, svg, figures, media, and trademark asset tags
      if (
        tag === 'img' ||
        tag === 'picture' ||
        tag === 'svg' ||
        tag === 'figure' ||
        tag === 'video' ||
        tag === 'audio' ||
        tag === 'canvas' ||
        tag === 'source' ||
        tag === 'track' ||
        tag === 'map' ||
        tag === 'area'
      ) {
        return '';
      }

      const innerText = node.children ? node.children.map(renderNode).join('') : '';

      switch (tag) {
        case 'h1':
          return `\n\n# ${innerText.trim()}\n\n`;
        case 'h2':
          return `\n\n## ${innerText.trim()}\n\n`;
        case 'h3':
          return `\n\n### ${innerText.trim()}\n\n`;
        case 'h4':
          return `\n\n#### ${innerText.trim()}\n\n`;
        case 'h5':
        case 'h6':
          return `\n\n##### ${innerText.trim()}\n\n`;
        case 'p':
          return `\n\n${innerText.trim()}\n\n`;
        case 'li':
          return `\n* ${innerText.trim()}`;
        case 'ul':
        case 'ol':
          return `\n${innerText}\n`;
        case 'blockquote':
          return `\n\n> ${innerText.trim()}\n\n`;
        case 'pre':
          return `\n\n\`\`\`\n${innerText.trim()}\n\`\`\`\n\n`;
        case 'code':
          return `\`${innerText}\``;
        case 'br':
          return '\n';
        case 'hr':
          return '\n\n---\n\n';
        case 'a': {
          const href = node.attrs?.['href'] ?? '';
          const trimmed = innerText.trim();
          // Exclude links that point directly to image assets or trademarks (.png, .jpg, .svg, .gif, .webp, .ico)
          if (/\.(png|jpe?g|svg|gif|webp|ico|bmp)(\?.*)?$/i.test(href)) {
            return trimmed;
          }
          if (trimmed && href && !href.startsWith('javascript:')) {
            return `[${trimmed}](${href})`;
          }
          return trimmed;
        }
        default:
          return innerText;
      }
    }

    const rawRendered = renderNode(contentRoot);

    // Normalize whitespace & remove any leftover image markdown
    return rawRendered
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // remove any markdown image syntax
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n+/g, '\n\n')
      .trim();
  }
}

// ---------------------------------------------------------------------------
// Unified Article Collector
// ---------------------------------------------------------------------------

export class ArticleCollector extends BaseCollector {
  readonly sourceKey: SourceKey;
  readonly policy: SourcePolicy;
  readonly config: ArticleSourceConfig;
  readonly discoveryService: ArticleDiscoveryService;
  readonly extractionService: ArticleExtractionService;

  constructor(
    configOrKey: ArticleSourceConfig | 'chrome_release_notes' | 'react_blog' | SourceKey,
    options?: ArticleCollectorOptions,
  ) {
    const resolvedConfig =
      typeof configOrKey === 'string'
        ? (DEFAULT_ARTICLE_CONFIGS[configOrKey as 'chrome_release_notes' | 'react_blog'] ?? {
            sourceKey: configOrKey,
            discovery: {
              type: 'rss' as const,
              url: `https://${configOrKey}.org/feed.xml`,
            },
            license: {
              id: 'CC-BY-4.0',
              name: 'Creative Commons Attribution 4.0 International',
              url: 'https://creativecommons.org/licenses/by/4.0/',
              attribution: 'Attribution required under CC-BY-4.0',
            },
          })
        : configOrKey;

    const mergedConfig: ArticleSourceConfig = options?.config
      ? { ...resolvedConfig, ...options.config }
      : resolvedConfig;

    const guard = options?.guard ?? new DefaultPolicyGuard();
    super(guard);

    this.sourceKey = mergedConfig.sourceKey;
    this.config = mergedConfig;
    this.policy = SOURCE_POLICIES[this.sourceKey];

    const fetchFn = options?.fetch ?? globalThis.fetch;
    this.discoveryService = new ArticleDiscoveryService(fetchFn, this.guard);
    this.extractionService = new ArticleExtractionService(fetchFn, this.guard);
  }

  /**
   * Phase 1: Feed/Index Discovery
   */
  async discover(context: CollectionContext): Promise<ArticleDiscoveryResult> {
    const cursorData = context.cursor
      ? decodeOpaqueCursor<ArticleCursorData>(context.cursor)
      : null;

    return this.discoveryService.discover(this.config, this.policy, cursorData, context.signal);
  }

  /**
   * Phase 2: Article Extraction
   */
  async extract(
    entry: DiscoveredArticleEntry,
    signal?: AbortSignal,
  ): Promise<{ article: ExtractedArticle; bytesFetched: number }> {
    return this.extractionService.extractFromUrl(
      entry.url,
      this.config,
      this.policy,
      entry,
      signal,
    );
  }

  /**
   * Executes collection run step:
   * 1. Discovery phase (with ETag/304 conditional request support)
   * 2. Extraction phase per entry (with host policy validation and image/asset stripping)
   * 3. Raw item construction and metric tracking
   */
  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startTime = Date.now();
    let totalBytesFetched = 0;

    // 1. Perform discovery
    const discoveryResult = await this.discover(context);
    totalBytesFetched += discoveryResult.bytesFetched;

    // 2. Handle 304 Not Modified
    if (discoveryResult.notModified) {
      return {
        sourceKey: this.sourceKey,
        items: [],
        nextCursor: context.cursor,
        hasMore: false,
        metrics: {
          itemsFetched: 0,
          bytesFetched: totalBytesFetched,
          durationMs: Date.now() - startTime,
        },
      };
    }

    const previousCursor = context.cursor
      ? decodeOpaqueCursor<ArticleCursorData>(context.cursor)
      : null;
    const processedUrls = new Set<string>(previousCursor?.processedUrls ?? []);

    const collectedItems: CollectedRawItem[] = [];
    const limit = context.limit ?? 20;

    // 3. Extract each discovered article entry
    for (const entry of discoveryResult.entries) {
      if (collectedItems.length >= limit) {
        break;
      }

      if (processedUrls.has(entry.url)) {
        continue;
      }

      const { article, bytesFetched } = await this.extract(entry, context.signal);
      totalBytesFetched += bytesFetched;

      // Extract stable externalId
      const externalId = this.config.externalIdExtractor
        ? this.config.externalIdExtractor(entry, article.url)
        : entry.externalId || article.url;

      // Create payload containing body text and license/attribution ONLY (no image URLs or trademark assets)
      const payload: Record<string, unknown> = {
        title: article.title,
        body: article.body,
        url: article.url,
        publishedAt: article.publishedAt ? article.publishedAt.toISOString() : null,
        license: {
          id: article.license.id,
          name: article.license.name,
          url: article.license.url,
          attribution: article.license.attribution,
        },
      };

      const rawItem = this.createRawItem({
        externalId,
        payload,
        publishedAt: article.publishedAt,
        cursor: null,
        metadata: {
          sourceKey: this.sourceKey,
          canonicalUrl: article.url,
          licenseId: article.license.id,
        },
      });

      collectedItems.push(rawItem);
      processedUrls.add(entry.url);
    }

    // 4. Construct Next Cursor
    const nextCursorData: ArticleCursorData = {
      etag: discoveryResult.etag,
      lastModified: discoveryResult.lastModified,
      lastPublishedAt:
        collectedItems.length > 0
          ? (collectedItems[collectedItems.length - 1]?.publishedAt?.toISOString() ?? null)
          : (previousCursor?.lastPublishedAt ?? null),
      lastExternalId:
        collectedItems.length > 0
          ? (collectedItems[collectedItems.length - 1]?.externalId ?? null)
          : (previousCursor?.lastExternalId ?? null),
      processedUrls: Array.from(processedUrls),
    };

    return {
      sourceKey: this.sourceKey,
      items: collectedItems,
      nextCursor: encodeOpaqueCursor(nextCursorData),
      hasMore: false,
      metrics: {
        itemsFetched: collectedItems.length,
        bytesFetched: totalBytesFetched,
        durationMs: Date.now() - startTime,
      },
    };
  }
}

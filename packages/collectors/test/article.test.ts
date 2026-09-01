import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ArticleCollector,
  ArticleDiscoveryService,
  ArticleExtractionService,
  REACT_BLOG_CONFIG,
  CHROME_RELEASE_NOTES_CONFIG,
  encodeOpaqueCursor,
  decodeOpaqueCursor,
  type ArticleCursorData,
  type DiscoveredArticleEntry,
  type FetchLike,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Realistic HTML & RSS Fixtures
// ---------------------------------------------------------------------------

const REACT_RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>React Blog</title>
    <link>https://react.dev/blog</link>
    <description>The latest React news and updates</description>
    <item>
      <title><![CDATA[React 19 Release]]></title>
      <link>https://react.dev/blog/2024/12/05/react-19</link>
      <guid isPermaLink="true">https://react.dev/blog/2024/12/05/react-19</guid>
      <pubDate>Thu, 05 Dec 2024 00:00:00 GMT</pubDate>
      <description><![CDATA[In our React 19 Release Post, we shared the new features in React 19.]]></description>
    </item>
    <item>
      <title>React 19 Beta</title>
      <link>https://react.dev/blog/2024/04/25/react-19-beta</link>
      <guid>https://react.dev/blog/2024/04/25/react-19-beta</guid>
      <pubDate>Thu, 25 Apr 2024 00:00:00 GMT</pubDate>
      <description>React 19 Beta is now available on npm!</description>
    </item>
  </channel>
</rss>`;

const REACT_ARTICLE_HTML_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>React 19 – React</title>
  <meta property="og:title" content="React 19" />
  <meta property="article:published_time" content="2024-12-05T00:00:00.000Z" />
</head>
<body>
  <nav><a href="/">Home</a><a href="/blog">Blog</a></nav>
  <main>
    <article>
      <h1>React 19</h1>
      <div class="author-info">
        <span>By The React Team</span>
        <img src="https://react.dev/images/authors/react-team.png" alt="React Team Avatar" />
      </div>
      <p>React 19 is now available on npm!</p>
      <picture>
        <source srcset="https://react.dev/images/blog/react-19-banner.webp" />
        <img src="https://react.dev/images/blog/react-19-banner.png" alt="React 19 Banner" />
      </picture>
      <h2>What is new in React 19</h2>
      <p>In React 19, we are adding support for Actions, async transitions, and Server Components.</p>
      <ul>
        <li>Action hooks: <code>useActionState</code></li>
        <li>Optimistic UI: <code>useOptimistic</code></li>
        <li>Asset loading improvements</li>
      </ul>
      <svg width="24" height="24" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/></svg>
      <figure>
        <img src="https://react.dev/images/diagram.svg" alt="Architecture Diagram" />
        <figcaption>Figure 1: React 19 Component Tree</figcaption>
      </figure>
      <p>For more details, check out the <a href="https://react.dev/reference/react">API reference</a> or <a href="https://react.dev/images/logo.png">brand logo</a>.</p>
    </article>
  </main>
  <footer>Copyright 2024 Meta</footer>
</body>
</html>`;

const CHROME_INDEX_HTML_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Chrome Release Notes</title></head>
<body>
  <h1>Chrome Release Notes</h1>
  <ul class="release-list">
    <li><a href="/release-notes/152">Chrome 152 Release Notes</a></li>
    <li><a href="https://developer.chrome.com/release-notes/151">Chrome 151 Release Notes</a></li>
    <li><a href="/release-notes/150">Chrome 150 Release Notes</a></li>
    <li><a href="/other-page">Unrelated Page</a></li>
  </ul>
</body>
</html>`;

const CHROME_ARTICLE_HTML_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Chrome 152 release notes | Chrome for Developers</title>
  <meta property="og:title" content="Chrome 152 release notes" />
</head>
<body>
  <header>
    <img src="https://developer.chrome.com/images/branding/chrome-logo.svg" alt="Chrome Logo" />
  </header>
  <main>
    <article>
      <h1>Chrome 152 release notes</h1>
      <p><strong>Stable release date:</strong> August 25th, 2026</p>
      <p>Chrome 152 is rolling out to the Stable channel for Windows, Mac, and Linux.</p>
      <h2>HTML and DOM</h2>
      <p>Support for declarative shadow DOM improvements and updated WebGPU features.</p>
      <svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" /></svg>
      <img src="https://developer.chrome.com/assets/chrome152-hero.png" alt="Chrome 152 Features" />
      <pre><code>const adapter = await navigator.gpu.requestAdapter();</code></pre>
      <p>See <a href="https://developer.chrome.com/blog/webgpu-updates">WebGPU updates</a> for details.</p>
    </article>
  </main>
</body>
</html>`;

describe('COL-008 Article Collector (RSS/HTTP)', () => {
  // -------------------------------------------------------------------------
  // 1. Discovery and Extraction Separation
  // -------------------------------------------------------------------------
  describe('Phase Separation (Discovery vs Extraction)', () => {
    test('discovery service extracts entries from RSS feed XML without fetching articles', () => {
      const discoveryService = new ArticleDiscoveryService();
      const entries = discoveryService.discoverFromRssXml(
        REACT_RSS_FIXTURE,
        'https://react.dev/rss.xml',
      );

      assert.equal(entries.length, 2);
      assert.equal(entries[0]!.externalId, 'https://react.dev/blog/2024/12/05/react-19');
      assert.equal(entries[0]!.url, 'https://react.dev/blog/2024/12/05/react-19');
      assert.equal(entries[0]!.title, 'React 19 Release');
      assert.equal(entries[0]!.publishedAt?.toISOString(), '2024-12-05T00:00:00.000Z');

      assert.equal(entries[1]!.url, 'https://react.dev/blog/2024/04/25/react-19-beta');
      assert.equal(entries[1]!.title, 'React 19 Beta');
    });

    test('discovery service extracts entries from HTML index page', () => {
      const discoveryService = new ArticleDiscoveryService();
      const entries = discoveryService.discoverFromHtmlIndex(
        CHROME_INDEX_HTML_FIXTURE,
        'https://developer.chrome.com/release-notes',
        /\/release-notes\/(\d+)/i,
      );

      assert.equal(entries.length, 3);
      assert.equal(entries[0]!.url, 'https://developer.chrome.com/release-notes/152');
      assert.equal(entries[1]!.url, 'https://developer.chrome.com/release-notes/151');
      assert.equal(entries[2]!.url, 'https://developer.chrome.com/release-notes/150');
    });

    test('extraction service parses article HTML directly into clean text and metadata', () => {
      const extractionService = new ArticleExtractionService();
      const article = extractionService.extractFromHtml(
        REACT_ARTICLE_HTML_FIXTURE,
        'https://react.dev/blog/2024/12/05/react-19',
        REACT_BLOG_CONFIG,
      );

      assert.equal(article.title, 'React 19');
      assert.equal(article.publishedAt?.toISOString(), '2024-12-05T00:00:00.000Z');
      assert.equal(article.license.id, 'CC-BY-4.0');
      assert(article.body.includes('# React 19'));
      assert(article.body.includes('What is new in React 19'));
      assert(article.body.includes('* Action hooks: `useActionState`'));
    });
  });

  // -------------------------------------------------------------------------
  // 2. Both Source Configurations (react_blog & chrome_release_notes)
  // -------------------------------------------------------------------------
  describe('Dual Source Configuration and Execution', () => {
    test('collects react_blog articles using injected fetch', async () => {
      const mockFetch: FetchLike = async (input) => {
        const url = String(input);
        if (url === 'https://react.dev/rss.xml') {
          return new Response(REACT_RSS_FIXTURE, {
            status: 200,
            headers: {
              'Content-Type': 'application/rss+xml',
              etag: 'W/"react-rss-v1"',
            },
          });
        }
        if (url === 'https://react.dev/blog/2024/12/05/react-19') {
          return new Response(REACT_ARTICLE_HTML_FIXTURE, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        if (url === 'https://react.dev/blog/2024/04/25/react-19-beta') {
          return new Response(
            '<html><body><article><h1>React 19 Beta</h1><p>Beta notes</p></article></body></html>',
            { status: 200, headers: { 'Content-Type': 'text/html' } },
          );
        }
        return new Response('Not Found', { status: 404 });
      };

      const collector = new ArticleCollector('react_blog', { fetch: mockFetch });
      const result = await collector.collect({
        sourceKey: 'react_blog',
        cursor: null,
        limit: 1,
      });

      assert.equal(result.sourceKey, 'react_blog');
      assert.equal(result.items.length, 1);
      assert.equal(result.metrics?.itemsFetched, 1);
      assert(result.metrics?.bytesFetched > 0);

      const item = result.items[0]!;
      assert.equal(item.externalId, '/blog/2024/12/05/react-19');
      assert.equal(item.publishedAt?.toISOString(), '2024-12-05T00:00:00.000Z');
      assert.equal(item.rawHash.length, 64);

      const payload = item.payload as Record<string, unknown>;
      assert.equal(payload['title'], 'React 19');
      assert((payload['license'] as Record<string, string>)['id'] === 'CC-BY-4.0');
      assert((payload['license'] as Record<string, string>)['attribution'].includes('React team'));

      // Verify next cursor contains etag
      const cursor = decodeOpaqueCursor<ArticleCursorData>(result.nextCursor!);
      assert.equal(cursor?.etag, 'W/"react-rss-v1"');
      assert(cursor?.processedUrls?.includes('https://react.dev/blog/2024/12/05/react-19'));
    });

    test('collects chrome_release_notes with DOM-based date extraction and stable ID', async () => {
      const mockFetch: FetchLike = async (input) => {
        const url = String(input);
        if (url === 'https://developer.chrome.com/release-notes') {
          return new Response(CHROME_INDEX_HTML_FIXTURE, {
            status: 200,
            headers: {
              'Content-Type': 'text/html',
              etag: 'W/"chrome-index-v152"',
            },
          });
        }
        if (url === 'https://developer.chrome.com/release-notes/152') {
          return new Response(CHROME_ARTICLE_HTML_FIXTURE, {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('Not Found', { status: 404 });
      };

      const collector = new ArticleCollector(CHROME_RELEASE_NOTES_CONFIG, {
        fetch: mockFetch,
      });
      const result = await collector.collect({
        sourceKey: 'chrome_release_notes',
        cursor: null,
        limit: 1,
      });

      assert.equal(result.sourceKey, 'chrome_release_notes');
      assert.equal(result.items.length, 1);

      const item = result.items[0]!;
      assert.equal(item.externalId, 'chrome-release-notes-152');
      // "August 25th, 2026" DOM extracted as UTC Date
      assert.equal(item.publishedAt?.toISOString(), '2026-08-25T00:00:00.000Z');
      assert.equal(item.rawHash.length, 64);

      const payload = item.payload as Record<string, unknown>;
      assert.equal(payload['title'], 'Chrome 152 release notes');
      assert((payload['body'] as string).includes('HTML and DOM'));
      assert((payload['body'] as string).includes('navigator.gpu.requestAdapter()'));
      assert((payload['license'] as Record<string, string>)['id'] === 'CC-BY-4.0');
      assert((payload['license'] as Record<string, string>)['attribution'].includes('Google'));
    });
  });

  // -------------------------------------------------------------------------
  // 3. Conditional Request (ETag / 304 Not Modified)
  // -------------------------------------------------------------------------
  describe('Conditional Requests (ETag / 304)', () => {
    test('sends If-None-Match header and returns 0 items on 304 response', async () => {
      let ifNoneMatchHeader: string | null = null;

      const mockFetch: FetchLike = async (input, init) => {
        const url = String(input);
        if (url === 'https://react.dev/rss.xml') {
          const headers = init?.headers as Record<string, string> | undefined;
          ifNoneMatchHeader = headers?.['If-None-Match'] ?? null;

          if (ifNoneMatchHeader === 'W/"react-rss-etag-123"') {
            return new Response(null, {
              status: 304,
              statusText: 'Not Modified',
              headers: { etag: 'W/"react-rss-etag-123"' },
            });
          }
        }
        return new Response('Error', { status: 500 });
      };

      const collector = new ArticleCollector('react_blog', { fetch: mockFetch });
      const initialCursor = encodeOpaqueCursor({
        etag: 'W/"react-rss-etag-123"',
        processedUrls: ['https://react.dev/blog/2024/12/05/react-19'],
      });

      const result = await collector.collect({
        sourceKey: 'react_blog',
        cursor: initialCursor,
      });

      assert.equal(ifNoneMatchHeader, 'W/"react-rss-etag-123"');
      assert.equal(result.items.length, 0);
      assert.equal(result.hasMore, false);
      assert.equal(result.metrics?.itemsFetched, 0);
      assert.equal(result.nextCursor, initialCursor);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Image & Asset Omission (SECURITY §8, SOURCE_CATALOG §6/§7)
  // -------------------------------------------------------------------------
  describe('Image and Asset Omission Guard', () => {
    test('strips all <img>, <svg>, <picture>, <figure>, image URLs and trademark asset links', () => {
      const extractionService = new ArticleExtractionService();
      const article = extractionService.extractFromHtml(
        REACT_ARTICLE_HTML_FIXTURE,
        'https://react.dev/blog/2024/12/05/react-19',
        REACT_BLOG_CONFIG,
      );

      // Verify no image or svg tags in body
      assert(!article.body.includes('<img'));
      assert(!article.body.includes('<svg'));
      assert(!article.body.includes('<picture'));
      assert(!article.body.includes('<figure'));

      // Verify no image URLs are stored
      assert(!article.body.includes('react-team.png'));
      assert(!article.body.includes('react-19-banner.webp'));
      assert(!article.body.includes('react-19-banner.png'));
      assert(!article.body.includes('diagram.svg'));
      assert(!article.body.includes('logo.png'));

      // Verify markdown links to non-images are kept, but direct image links are stripped of href
      assert(article.body.includes('[API reference](https://react.dev/reference/react)'));
      assert(!article.body.includes('(https://react.dev/images/logo.png)'));
      assert(article.body.includes('brand logo')); // Text retained, link URL stripped
    });
  });

  // -------------------------------------------------------------------------
  // 5. License Attribution Metadata Preservation
  // -------------------------------------------------------------------------
  describe('License & Attribution Metadata', () => {
    test('preserves CC-BY-4.0 license metadata for both sources', () => {
      const extractionService = new ArticleExtractionService();

      const reactArticle = extractionService.extractFromHtml(
        REACT_ARTICLE_HTML_FIXTURE,
        'https://react.dev/blog/2024/12/05/react-19',
        REACT_BLOG_CONFIG,
      );
      assert.deepEqual(reactArticle.license, REACT_BLOG_CONFIG.license);
      assert.equal(reactArticle.license.id, 'CC-BY-4.0');
      assert(reactArticle.license.attribution.includes('React team'));

      const chromeArticle = extractionService.extractFromHtml(
        CHROME_ARTICLE_HTML_FIXTURE,
        'https://developer.chrome.com/release-notes/152',
        CHROME_RELEASE_NOTES_CONFIG,
      );
      assert.deepEqual(chromeArticle.license, CHROME_RELEASE_NOTES_CONFIG.license);
      assert.equal(chromeArticle.license.id, 'CC-BY-4.0');
      assert(chromeArticle.license.attribution.includes('Google'));
    });
  });

  // -------------------------------------------------------------------------
  // 6. Security and Allowed Host Enforcement (THR-001)
  // -------------------------------------------------------------------------
  describe('Allowed Host and SSRF Security Enforcement', () => {
    test('rejects discovery request pointing to unauthorized or malicious host', async () => {
      const fakeFetch: FetchLike = async () => new Response('OK');
      const maliciousConfig = {
        ...REACT_BLOG_CONFIG,
        discovery: {
          type: 'rss' as const,
          url: 'https://evil.com/feed.xml',
        },
      };

      const collector = new ArticleCollector(maliciousConfig, { fetch: fakeFetch });

      await assert.rejects(async () => {
        await collector.collect({
          sourceKey: 'react_blog',
          cursor: null,
        });
      }, /Security validation failed|not in the allowed hosts/i);
    });

    test('rejects extraction of article pointing to SSRF internal address', async () => {
      const fakeFetch: FetchLike = async () => new Response('OK');
      const collector = new ArticleCollector('react_blog', { fetch: fakeFetch });

      const maliciousEntry: DiscoveredArticleEntry = {
        externalId: 'ssrf-1',
        url: 'https://169.254.169.254/latest/meta-data/',
      };

      await assert.rejects(async () => {
        await collector.extract(maliciousEntry);
      }, /SSRF guard|forbidden internal/i);
    });
  });
});

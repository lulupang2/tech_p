import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  RedditCollector,
  REDDIT_LICENSE,
  RedditSecurityError,
  RedditLoginOrCaptchaDetectedError,
  RedditRobotsDisallowedError,
  type PlaywrightBrowser,
  type PlaywrightBrowserContext,
  type PlaywrightPage,
  type PlaywrightLocator,
  type PlaywrightRoute,
  type PlaywrightRequest,
  type PlaywrightResponse,
} from '../src/index.js';

// ============================================================================
// HTML Fixtures
// ============================================================================

const REDDIT_PAGE_HTML_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>TypeScript Discussions on Reddit</title>
</head>
<body>
  <header>
    <h1>r/typescript</h1>
  </header>
  <main>
    <section class="posts-feed">
      <article role="article" id="t3_abc123" score="142" comment-count="38">
        <div class="post-header">
          <span class="author">u/super_coder_99</span>
          <img class="avatar" src="https://www.reddit.com/avatar/super_coder.png" alt="Avatar of super_coder_99" />
          <time datetime="2026-09-01T10:00:00.000Z">Sep 1, 2026</time>
        </div>
        <h2 role="heading">
          <a role="link" href="/r/typescript/comments/abc123/understanding_typescript_58/">Understanding TypeScript 5.8 Features and Performance Optimizations</a>
        </h2>
        <div class="post-content" slot="text-body">
          <p>TypeScript 5.8 brings major type checking performance improvements across large monorepos.</p>
          <p>The new flag --erasableSyntaxOnly ensures seamless interoperability with native Node/Bun loaders.</p>
        </div>
      </article>

      <article role="article" id="t3_def456" score="89" comment-count="12">
        <div class="post-header">
          <a class="author-link" href="/user/playwright_fan">u/playwright_fan</a>
          <div data-testid="avatar">Avatar</div>
          <time datetime="2026-09-01T12:00:00.000Z">Sep 1, 2026</time>
        </div>
        <h2 role="heading">
          <a role="link" href="https://www.reddit.com/r/typescript/comments/def456/playwright_e2e_testing_best_practices/">Playwright E2E Testing Best Practices in 2026</a>
        </h2>
        <div class="post-content">
          <p>We migrated our integration test suites to use semantic Playwright locators.</p>
          <p>Here are the key takeaways regarding role-based querying and locator isolation.</p>
        </div>
      </article>
    </section>
  </main>
</body>
</html>`;

const REDDIT_LOGIN_CHALLENGE_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Log in to Reddit</title></head>
<body>
  <h1 role="heading">Log in to Reddit</h1>
  <form action="/login" method="post">
    <input type="text" name="username" placeholder="Username" />
    <input type="password" name="password" placeholder="Password" />
    <button type="submit">Log In</button>
  </form>
</body>
</html>`;

const REDDIT_CAPTCHA_CHALLENGE_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Verification Challenge</title></head>
<body>
  <h1 role="heading">Verify you are human</h1>
  <div class="cf-turnstile" data-sitekey="reddit-cf-key"></div>
  <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>
</body>
</html>`;

// ============================================================================
// In-Memory Test DOM & Fake Playwright Browser Driver
// ============================================================================

interface FakeDomElement {
  tag: string;
  attributes: Record<string, string>;
  text: string;
  children: FakeDomElement[];
}

function parseSimpleHtml(html: string): FakeDomElement[] {
  const elements: FakeDomElement[] = [];

  // Match articles
  const articleRegex = /<article([^>]*)>([\s\S]*?)<\/article>/gi;
  let articleMatch: RegExpExecArray | null;
  while ((articleMatch = articleRegex.exec(html)) !== null) {
    const rawAttrs = articleMatch[1]!;
    const body = articleMatch[2]!;
    const attrs: Record<string, string> = {};

    const attrRegex = /([a-z0-9_-]+)="([^"]*)"/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(rawAttrs)) !== null) {
      attrs[m[1]!] = m[2]!;
    }

    const children: FakeDomElement[] = [];

    // Extract headings
    const headingMatch = /<h[1-4]([^>]*)>([\s\S]*?)<\/h[1-4]>/i.exec(body);
    if (headingMatch) {
      const headingAttrs: Record<string, string> = {};
      let hm: RegExpExecArray | null;
      while ((hm = attrRegex.exec(headingMatch[1]!)) !== null) {
        headingAttrs[hm[1]!] = hm[2]!;
      }
      children.push({
        tag: 'h2',
        attributes: { role: 'heading', ...headingAttrs },
        text: headingMatch[2]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract links
    const aRegex = /<a([^>]*)>([\s\S]*?)<\/a>/gi;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = aRegex.exec(body)) !== null) {
      const aAttrs: Record<string, string> = {};
      let am: RegExpExecArray | null;
      while ((am = attrRegex.exec(aMatch[1]!)) !== null) {
        aAttrs[am[1]!] = am[2]!;
      }
      children.push({
        tag: 'a',
        attributes: { role: 'link', ...aAttrs },
        text: aMatch[2]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract paragraphs
    const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRegex.exec(body)) !== null) {
      children.push({
        tag: 'p',
        attributes: { role: 'paragraph' },
        text: pMatch[2]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract time
    const timeMatch = /<time([^>]*)>([\s\S]*?)<\/time>/i.exec(body);
    if (timeMatch) {
      const timeAttrs: Record<string, string> = {};
      let tm: RegExpExecArray | null;
      while ((tm = attrRegex.exec(timeMatch[1]!)) !== null) {
        timeAttrs[tm[1]!] = tm[2]!;
      }
      children.push({
        tag: 'time',
        attributes: timeAttrs,
        text: timeMatch[2]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract author / avatar elements
    const authorMatch = /<span class="author">([\s\S]*?)<\/span>/i.exec(body);
    if (authorMatch) {
      children.push({
        tag: 'span',
        attributes: { class: 'author' },
        text: authorMatch[1]!.trim(),
        children: [],
      });
    }

    elements.push({
      tag: 'article',
      attributes: { role: 'article', ...attrs },
      text: body
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
      children,
    });
  }

  // Top level headings, inputs, iframes
  if (/<h1[^>]*>([\s\S]*?)<\/h1>/i.test(html)) {
    const h1Text = /<h1[^>]*>([\s\S]*?)<\/h1>/i
      .exec(html)![1]!
      .replace(/<[^>]*>/g, '')
      .trim();
    elements.push({
      tag: 'h1',
      attributes: { role: 'heading' },
      text: h1Text,
      children: [],
    });
  }

  if (/<input[^>]*type="password"[^>]*>/i.test(html)) {
    elements.push({
      tag: 'input',
      attributes: { type: 'password' },
      text: '',
      children: [],
    });
  }

  if (/<iframe[^>]*src="([^"]*)"[^>]*>/i.test(html)) {
    const src = /<iframe[^>]*src="([^"]*)"[^>]*>/i.exec(html)![1]!;
    elements.push({
      tag: 'iframe',
      attributes: { src },
      text: '',
      children: [],
    });
  }

  if (/<div[^>]*class="cf-turnstile"[^>]*>/i.test(html)) {
    elements.push({
      tag: 'div',
      attributes: { class: 'cf-turnstile', 'data-sitekey': 'reddit-cf-key' },
      text: '',
      children: [],
    });
  }

  return elements;
}

class FakeLocator implements PlaywrightLocator {
  constructor(private readonly matchingElements: FakeDomElement[]) {}

  async innerText(): Promise<string> {
    if (this.matchingElements.length === 0) return '';
    return this.matchingElements[0]!.text;
  }

  async allInnerTexts(): Promise<string[]> {
    return this.matchingElements.map((el) => el.text);
  }

  async textContent(): Promise<string | null> {
    if (this.matchingElements.length === 0) return null;
    return this.matchingElements[0]!.text;
  }

  async getAttribute(name: string): Promise<string | null> {
    if (this.matchingElements.length === 0) return null;
    return this.matchingElements[0]!.attributes[name] ?? null;
  }

  async count(): Promise<number> {
    return this.matchingElements.length;
  }

  async all(): Promise<PlaywrightLocator[]> {
    return this.matchingElements.map((el) => new FakeLocator([el]));
  }

  first(): PlaywrightLocator {
    return new FakeLocator(this.matchingElements.slice(0, 1));
  }

  nth(index: number): PlaywrightLocator {
    return new FakeLocator(this.matchingElements.slice(index, index + 1));
  }

  locator(selector: string): PlaywrightLocator {
    const found: FakeDomElement[] = [];
    for (const el of this.matchingElements) {
      if (selector === 'h1, h2, h3, a[slot="title"]') {
        found.push(...el.children.filter((c) => ['h1', 'h2', 'h3', 'a'].includes(c.tag)));
      } else if (selector.includes('time')) {
        found.push(...el.children.filter((c) => c.tag === 'time'));
      } else if (selector.includes('input[type="password"]')) {
        if (el.tag === 'input' && el.attributes['type'] === 'password') found.push(el);
      } else if (selector.includes('iframe') || selector.includes('cf-turnstile')) {
        if (
          el.tag === 'iframe' ||
          el.attributes['class']?.includes('cf-turnstile') ||
          el.attributes['data-sitekey']
        ) {
          found.push(el);
        }
      } else if (selector.includes('text-body') || selector.includes('usertext-body')) {
        found.push(...el.children.filter((c) => c.tag === 'p'));
      }
    }
    return new FakeLocator(found);
  }

  getByRole(role: string, options?: { name?: string | RegExp }): PlaywrightLocator {
    const found: FakeDomElement[] = [];

    const check = (el: FakeDomElement) => {
      let matchesRole = el.attributes['role'] === role;
      if (role === 'article' && el.tag === 'article') matchesRole = true;
      if (role === 'heading' && /^h[1-6]$/i.test(el.tag)) matchesRole = true;
      if (role === 'paragraph' && el.tag === 'p') matchesRole = true;
      if (role === 'link' && el.tag === 'a') matchesRole = true;

      if (matchesRole) {
        if (options?.name) {
          const pattern =
            typeof options.name === 'string' ? new RegExp(options.name, 'i') : options.name;
          if (pattern.test(el.text)) {
            found.push(el);
          }
        } else {
          found.push(el);
        }
      }

      for (const child of el.children) {
        check(child);
      }
    };

    for (const el of this.matchingElements) {
      check(el);
    }

    return new FakeLocator(found);
  }

  getByText(text: string | RegExp): PlaywrightLocator {
    const pattern = typeof text === 'string' ? new RegExp(text, 'i') : text;
    const found = this.matchingElements.filter((el) => pattern.test(el.text));
    return new FakeLocator(found);
  }
}

class FakePage implements PlaywrightPage {
  private currentUrl: string = 'https://www.reddit.com/r/typescript/';
  private domElements: FakeDomElement[] = [];
  private htmlContent: string = '';
  private popupListeners: Array<(popup: PlaywrightPage) => void> = [];
  private downloadListeners: Array<(download: unknown) => void> = [];

  constructor(htmlFixture: string, initialUrl?: string) {
    this.htmlContent = htmlFixture;
    this.domElements = parseSimpleHtml(htmlFixture);
    if (initialUrl) this.currentUrl = initialUrl;
  }

  url(): string {
    return this.currentUrl;
  }

  async goto(url: string): Promise<PlaywrightResponse | null> {
    this.currentUrl = url;
    return {
      status: () => 200,
      url: () => this.currentUrl,
      headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => this.htmlContent,
      body: async () => Buffer.from(this.htmlContent, 'utf8'),
      ok: () => true,
    };
  }

  locator(selector: string): PlaywrightLocator {
    return new FakeLocator(this.domElements).locator(selector);
  }

  getByRole(role: string, options?: { name?: string | RegExp }): PlaywrightLocator {
    return new FakeLocator(this.domElements).getByRole(role, options);
  }

  getByText(text: string | RegExp): PlaywrightLocator {
    return new FakeLocator(this.domElements).getByText(text);
  }

  async content(): Promise<string> {
    return this.htmlContent;
  }

  async close(): Promise<void> {}

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === 'popup') this.popupListeners.push(listener as (p: PlaywrightPage) => void);
    if (event === 'download') this.downloadListeners.push(listener);
    return this;
  }
}

class FakeBrowserContext implements PlaywrightBrowserContext {
  private routes: Array<{
    pattern: string | RegExp | ((url: URL) => boolean);
    handler: (route: PlaywrightRoute) => Promise<void> | void;
  }> = [];

  constructor(private readonly page: FakePage) {}

  async newPage(): Promise<PlaywrightPage> {
    return this.page;
  }

  async route(
    pattern: string | RegExp | ((url: URL) => boolean),
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<void> {
    this.routes.push({ pattern, handler });
  }

  async close(): Promise<void> {}

  async triggerRoute(url: string): Promise<boolean> {
    let aborted = false;
    const fakeRequest: PlaywrightRequest = {
      url: () => url,
      method: () => 'GET',
      headers: () => ({}),
    };
    const fakeRoute: PlaywrightRoute = {
      request: () => fakeRequest,
      abort: async () => {
        aborted = true;
      },
      continue: async () => {},
      fulfill: async () => {},
    };

    for (const r of this.routes) {
      await r.handler(fakeRoute);
    }
    return !aborted;
  }
}

class FakeBrowser implements PlaywrightBrowser {
  constructor(private readonly context: FakeBrowserContext) {}

  async newContext(): Promise<PlaywrightBrowserContext> {
    return this.context;
  }

  async close(): Promise<void> {}
}

function createFakeEnvironment(html: string, url = 'https://www.reddit.com/r/typescript/') {
  const fakePage = new FakePage(html, url);
  const fakeContext = new FakeBrowserContext(fakePage);
  const fakeBrowser = new FakeBrowser(fakeContext);
  return { fakePage, fakeContext, fakeBrowser };
}

// ============================================================================
// Test Suite: Reddit Playwright ArticleCollector
// ============================================================================

describe('Reddit Playwright ArticleCollector (COL-005 Pattern)', () => {
  test('stops before navigation when robots.txt disallows all agents', async () => {
    const { fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);
    const collector = new RedditCollector({
      browser: fakeBrowser,
      robotsFetcher: async () => 'User-agent: *\nDisallow: /\n',
    });

    await assert.rejects(
      collector.collect({ runId: 'run-robots-blocked', sourceKey: 'reddit', cursor: null }),
      (error: unknown) =>
        error instanceof RedditRobotsDisallowedError && error.code === 'REDDIT_ROBOTS_DISALLOWED',
    );
  });
  describe('Semantic Locator & Extraction', () => {
    test('extracts Reddit posts using semantic locators (getByRole)', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { subreddit: 'typescript' },
      });

      const result = await collector.collect({
        runId: 'run-reddit-1',
        sourceKey: 'reddit',
        cursor: null,
      });

      assert.equal(result.sourceKey, 'reddit');
      assert.equal(result.items.length, 2);

      const firstItem = result.items[0]!;
      assert.equal(firstItem.externalId, 'reddit-post-abc123');
      assert.equal(
        firstItem.payload['title'],
        'Understanding TypeScript 5.8 Features and Performance Optimizations',
      );
      assert.ok(
        (firstItem.payload['body'] as string).includes('TypeScript 5.8 brings major type checking'),
      );
      assert.ok((firstItem.payload['body'] as string).includes('--erasableSyntaxOnly'));
      assert.equal(firstItem.payload['score'], 142);
      assert.equal(firstItem.payload['commentCount'], 38);
      assert.equal(firstItem.publishedAt?.toISOString(), '2026-09-01T10:00:00.000Z');

      const secondItem = result.items[1]!;
      assert.equal(secondItem.externalId, 'reddit-post-def456');
      assert.equal(secondItem.payload['title'], 'Playwright E2E Testing Best Practices in 2026');
      assert.ok((secondItem.payload['body'] as string).includes('semantic Playwright locators'));
    });

    test('strictly strips username, avatar, and PII from payload and metadata', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { subreddit: 'typescript' },
      });

      const result = await collector.collect({
        runId: 'run-reddit-2',
        sourceKey: 'reddit',
        cursor: null,
      });

      for (const item of result.items) {
        // Confirm PII fields are completely stripped
        assert.equal(item.payload['author'], undefined);
        assert.equal(item.payload['username'], undefined);
        assert.equal(item.payload['user'], undefined);
        assert.equal(item.payload['avatar'], undefined);
        assert.equal(item.payload['author_fullname'], undefined);
        assert.equal(item.payload['author_flair_text'], undefined);

        // Confirm metadata does not contain user identifiers
        assert.equal((item.metadata as Record<string, unknown>)['author'], undefined);
        assert.equal((item.metadata as Record<string, unknown>)['username'], undefined);

        // Confirm body text does not leak raw author name
        assert.ok(!(item.payload['body'] as string).includes('u/super_coder_99'));
        assert.ok(!(item.payload['body'] as string).includes('u/playwright_fan'));
      }
    });

    test('stores approved Reddit license attribution on payload and metadata', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { subreddit: 'typescript' },
      });

      const result = await collector.collect({
        runId: 'run-reddit-3',
        sourceKey: 'reddit',
        cursor: null,
      });

      for (const item of result.items) {
        const payloadLicense = item.payload['license'] as typeof REDDIT_LICENSE;
        assert.deepEqual(payloadLicense, REDDIT_LICENSE);
        assert.equal(payloadLicense.id, 'reddit-user-agreement');

        const metaLicense = item.metadata?.['license'] as typeof REDDIT_LICENSE;
        assert.deepEqual(metaLicense, REDDIT_LICENSE);
        assert.equal(metaLicense.id, 'reddit-user-agreement');
      }
    });

    test('implements ArticleCollector pattern phases: discover and extract', async () => {
      const { fakePage } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector();

      // Phase 1: Discover
      const discovered = await collector.discover(fakePage, 'https://www.reddit.com/r/typescript/');
      assert.equal(discovered.length, 2);
      assert.equal(discovered[0]!.id, 'abc123');
      assert.equal(
        discovered[0]!.title,
        'Understanding TypeScript 5.8 Features and Performance Optimizations',
      );
      assert.equal(discovered[1]!.id, 'def456');

      // Phase 2: Extract
      const extracted = await collector.extract(
        discovered[0]!.locator!,
        discovered[0]!,
        'typescript',
      );
      assert.equal(extracted.id, 'abc123');
      assert.ok(extracted.body.includes('TypeScript 5.8 brings major type checking'));
      assert.equal(extracted.license.id, 'reddit-user-agreement');
    });
  });

  describe('Security & Policy Guarding', () => {
    test('aborts collection if login challenge is detected (No bypass allowed)', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_LOGIN_CHALLENGE_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { subreddit: 'typescript' },
      });

      await assert.rejects(
        collector.collect({
          runId: 'run-login-test',
          sourceKey: 'reddit',
          cursor: null,
        }),
        (err: unknown) => {
          assert.ok(err instanceof RedditLoginOrCaptchaDetectedError);
          return true;
        },
      );
    });

    test('aborts collection if CAPTCHA challenge is detected', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_CAPTCHA_CHALLENGE_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { subreddit: 'typescript' },
      });

      await assert.rejects(
        collector.collect({
          runId: 'run-captcha-test',
          sourceKey: 'reddit',
          cursor: null,
        }),
        (err: unknown) => {
          assert.ok(err instanceof RedditLoginOrCaptchaDetectedError);
          return true;
        },
      );
    });

    test('rejects target URL violating host allowlist or scheme', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { url: 'https://evil-unauthorized-domain.com/r/typescript/' },
      });

      await assert.rejects(
        collector.collect({
          runId: 'run-evil-url',
          sourceKey: 'reddit',
          cursor: null,
        }),
        RedditSecurityError,
      );
    });

    test('route handler aborts requests to unauthorized domains (SSRF prevention)', async () => {
      const { fakeContext, fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
      });

      await collector.collect({
        runId: 'run-route-test',
        sourceKey: 'reddit',
        cursor: null,
      });

      // Test route filter
      const allowed = await fakeContext.triggerRoute('https://www.reddit.com/r/typescript/');
      assert.equal(allowed, true);

      const blocked = await fakeContext.triggerRoute('https://malicious-tracking.com/pixel.gif');
      assert.equal(blocked, false);
    });
  });

  describe('Pagination & Cursor Management', () => {
    test('creates deterministic cursor and respects maxItems option', async () => {
      const { fakeBrowser } = createFakeEnvironment(REDDIT_PAGE_HTML_FIXTURE);

      const collector = new RedditCollector({
        browser: fakeBrowser,
        config: { maxItems: 1 },
      });

      const result = await collector.collect({
        runId: 'run-max-items',
        sourceKey: 'reddit',
        cursor: null,
      });

      assert.equal(result.items.length, 1);
      assert.equal(result.items[0]!.externalId, 'reddit-post-abc123');
      assert.ok(result.nextCursor);
    });
  });
});

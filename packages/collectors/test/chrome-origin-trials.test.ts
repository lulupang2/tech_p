import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  ChromeOriginTrialsCollector,
  DEFAULT_ORIGIN_TRIALS_URL,
  CHROME_ORIGIN_TRIALS_LICENSE,
  OriginTrialsSecurityError,
  LoginOrCaptchaDetectedError,
  redactTraceData,
  redactTraceHeaders,
  redactTraceUrl,
  verifyNonJsFetchRequiresJavascript,
  decodeOpaqueCursor,
  type PlaywrightBrowser,
  type PlaywrightBrowserContext,
  type PlaywrightPage,
  type PlaywrightLocator,
  type PlaywrightRoute,
  type PlaywrightRequest,
  type PlaywrightResponse,
  type PlaywrightDownload,
  type ChromeOriginTrialsCursor,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Realistic HTML Fixtures
// ---------------------------------------------------------------------------

const ORIGIN_TRIALS_HTML_FIXTURE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Chrome Origin Trials | Chrome for Developers</title>
</head>
<body>
  <header>
    <h1>Chrome Origin Trials</h1>
    <p>Get early access to experimental web platform features in Google Chrome.</p>
  </header>
  <main>
    <section class="trials-list">
      <article class="trial-card" data-trial-id="webgpu-subgroups" data-status="Active">
        <h2>WebGPU Subgroups</h2>
        <p class="description">Enables subgroup operations in WGSL for SIMD-style parallel computations within compute shaders.</p>
        <span class="status">Active</span>
        <span class="milestones">Chrome 128 to 134</span>
        <div class="links">
          <a href="/origintrials/#/view_trial/webgpu-subgroups">View Trial Details</a>
          <a href="https://developer.chrome.com/docs/web-platform/webgpu-subgroups">Documentation</a>
          <a href="https://issues.chromium.org/issues/new?component=WebGPU">Feedback</a>
          <a href="https://chromestatus.com/feature/5144865181466624">ChromeStatus</a>
        </div>
        <ul class="features">
          <li class="feature">WGSL Subgroup Matrix Operations</li>
          <li class="feature">Subgroup Broadcast and Shuffle</li>
        </ul>
      </article>

      <article class="trial-card" data-trial-id="compute-pressure" data-status="Active">
        <h2>Compute Pressure API</h2>
        <p class="description">Provides high-level states that represent the CPU load on the system.</p>
        <span class="status">Active</span>
        <span class="milestones">Chrome 120 to 125</span>
        <div class="links">
          <a href="https://developer.chrome.com/origintrials/#/view_trial/compute-pressure">View Trial Details</a>
          <a href="https://developer.chrome.com/docs/web-platform/compute-pressure">Documentation</a>
          <a href="https://w3c.github.io/compute-pressure/">Specification Standard</a>
        </div>
        <ul class="features">
          <li class="feature">CPU Pressure State Reporting</li>
        </ul>
      </article>

      <article class="trial-card" data-trial-id="deprecation-mutation-events" data-status="Deprecated">
        <h2>Mutation Events Deprecation Trial</h2>
        <p class="description">Provides temporary extension for deprecated DOM Mutation Events (DOMSubtreeModified, etc.).</p>
        <span class="status">Deprecated</span>
        <span class="milestones">Chrome 127 to 134</span>
        <div class="links">
          <a href="/origintrials/#/view_trial/deprecation-mutation-events">View Trial</a>
          <a href="https://groups.google.com/a/chromium.org/g/blink-dev/c/intent-to-deprecate">Intent to Deprecate</a>
        </div>
      </article>
    </section>
  </main>
</body>
</html>`;

const NON_JS_RAW_RESPONSE_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Chrome Origin Trials</title></head>
<body>
  <noscript>
    <p>This page requires Javascript.</p>
  </noscript>
  <div id="app"></div>
</body>
</html>`;

const LOGIN_CHALLENGE_HTML_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Sign In - Google Accounts</title></head>
<body>
  <h1>Sign in to continue to Origin Trials</h1>
  <form action="/login" method="post">
    <input type="email" name="email" placeholder="Email" />
    <input type="password" name="password" placeholder="Password" />
    <button type="submit">Sign In</button>
  </form>
</body>
</html>`;

const CAPTCHA_CHALLENGE_HTML_FIXTURE = `<!DOCTYPE html>
<html>
<head><title>Bot Verification</title></head>
<body>
  <h1>Verify you are human</h1>
  <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe>
  <div class="cf-turnstile" data-sitekey="test-key"></div>
</body>
</html>`;

// ---------------------------------------------------------------------------
// In-Memory Test DOM & Fake Playwright Browser Driver
// ---------------------------------------------------------------------------

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

    // Extract headings (h1..h4)
    const headingMatch = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(body);
    if (headingMatch) {
      children.push({
        tag: 'h2',
        attributes: { role: 'heading' },
        text: headingMatch[1]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract paragraphs
    const pRegex = /<p([^>]*)>([\s\S]*?)<\/p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRegex.exec(body)) !== null) {
      children.push({
        tag: 'p',
        attributes: {},
        text: pMatch[2]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract spans (status, milestones)
    const spanRegex = /<span([^>]*)class="([^"]*)"[^>]*>([\s\S]*?)<\/span>/gi;
    let spanMatch: RegExpExecArray | null;
    while ((spanMatch = spanRegex.exec(body)) !== null) {
      children.push({
        tag: 'span',
        attributes: { class: spanMatch[2]! },
        text: spanMatch[3]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract links
    const aRegex = /<a([^>]*)href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = aRegex.exec(body)) !== null) {
      children.push({
        tag: 'a',
        attributes: { href: aMatch[2]! },
        text: aMatch[3]!.replace(/<[^>]*>/g, '').trim(),
        children: [],
      });
    }

    // Extract list items
    const liRegex = /<li([^>]*)class="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
    let liMatch: RegExpExecArray | null;
    while ((liMatch = liRegex.exec(body)) !== null) {
      children.push({
        tag: 'li',
        attributes: { class: liMatch[2]! },
        text: liMatch[3]!.replace(/<[^>]*>/g, '').trim(),
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

  // Also check top-level headings, password inputs, iframes for login/captcha tests
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

  return elements;
}

function createFakeLocator(elements: FakeDomElement[]): PlaywrightLocator {
  return {
    async innerText(): Promise<string> {
      return elements[0]?.text ?? '';
    },
    async allInnerTexts(): Promise<string[]> {
      return elements.map((e) => e.text);
    },
    async textContent(): Promise<string | null> {
      return elements[0]?.text ?? null;
    },
    async getAttribute(name: string): Promise<string | null> {
      return elements[0]?.attributes[name] ?? null;
    },
    async count(): Promise<number> {
      return elements.length;
    },
    async all(): Promise<PlaywrightLocator[]> {
      return elements.map((e) => createFakeLocator([e]));
    },
    first(): PlaywrightLocator {
      return createFakeLocator(elements.slice(0, 1));
    },
    nth(index: number): PlaywrightLocator {
      return createFakeLocator(elements.slice(index, index + 1));
    },
    locator(selector: string): PlaywrightLocator {
      const matched: FakeDomElement[] = [];
      const lowerSel = selector.trim().toLowerCase();

      // Check password inputs
      if (lowerSel.includes('password')) {
        for (const el of elements) {
          if (el.tag === 'input' && el.attributes['type'] === 'password') {
            matched.push(el);
          }
          for (const c of el.children) {
            if (c.tag === 'input' && c.attributes['type'] === 'password') {
              matched.push(c);
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check CAPTCHA / bot challenge
      if (
        lowerSel.includes('recaptcha') ||
        lowerSel.includes('turnstile') ||
        lowerSel.includes('hcaptcha')
      ) {
        for (const el of elements) {
          if (
            el.tag === 'iframe' ||
            el.attributes['class']?.includes('turnstile') ||
            el.attributes['class']?.includes('recaptcha') ||
            el.attributes['class']?.includes('h-captcha')
          ) {
            matched.push(el);
          }
          for (const c of el.children) {
            if (
              c.tag === 'iframe' ||
              c.attributes['class']?.includes('turnstile') ||
              c.attributes['class']?.includes('recaptcha') ||
              c.attributes['class']?.includes('h-captcha')
            ) {
              matched.push(c);
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check for links: 'a'
      if (lowerSel === 'a' || lowerSel.split(',').some((s) => s.trim() === 'a')) {
        for (const el of elements) {
          if (el.tag === 'a') matched.push(el);
          matched.push(...el.children.filter((c) => c.tag === 'a'));
        }
        return createFakeLocator(matched);
      }

      // Check for paragraphs / descriptions
      if (lowerSel.includes('description') || lowerSel.split(',').some((s) => s.trim() === 'p')) {
        for (const el of elements) {
          for (const c of el.children) {
            if (
              c.tag === 'p' ||
              c.attributes['class']?.includes('description') ||
              'data-description' in c.attributes
            ) {
              matched.push(c);
            }
          }
          if (matched.length === 0) {
            if (el.tag === 'p' || el.attributes['class']?.includes('description')) {
              matched.push(el);
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check for status
      if (lowerSel.includes('status') || lowerSel.includes('badge')) {
        for (const el of elements) {
          for (const c of el.children) {
            if (
              c.attributes['class']?.includes('status') ||
              c.attributes['class']?.includes('badge') ||
              'data-status' in c.attributes
            ) {
              matched.push(c);
            }
          }
          if (matched.length === 0) {
            if (
              el.attributes['class']?.includes('status') ||
              el.attributes['class']?.includes('badge')
            ) {
              matched.push(el);
            } else if (el.attributes['data-status']) {
              matched.push({
                tag: 'span',
                attributes: { class: 'status' },
                text: el.attributes['data-status'],
                children: [],
              });
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check for milestones / duration
      if (lowerSel.includes('milestone') || lowerSel.includes('duration')) {
        for (const el of elements) {
          for (const c of el.children) {
            if (
              c.attributes['class']?.includes('milestone') ||
              c.attributes['class']?.includes('duration') ||
              'data-milestone' in c.attributes
            ) {
              matched.push(c);
            }
          }
          if (matched.length === 0) {
            if (
              el.attributes['class']?.includes('milestone') ||
              el.attributes['class']?.includes('duration')
            ) {
              matched.push(el);
            } else if (el.attributes['data-milestone']) {
              matched.push({
                tag: 'span',
                attributes: { class: 'milestone' },
                text: el.attributes['data-milestone'],
                children: [],
              });
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check for feature / list items
      if (lowerSel.includes('feature') || lowerSel.split(',').some((s) => s.trim() === 'li')) {
        for (const el of elements) {
          for (const c of el.children) {
            if (
              c.tag === 'li' ||
              c.attributes['class']?.includes('feature') ||
              'data-feature' in c.attributes
            ) {
              matched.push(c);
            }
          }
          if (matched.length === 0) {
            if (el.tag === 'li' || el.attributes['class']?.includes('feature')) {
              matched.push(el);
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check for headings / trial names
      if (
        lowerSel.includes('trial-name') ||
        lowerSel.includes('h1') ||
        lowerSel.includes('h2') ||
        lowerSel.includes('h3') ||
        lowerSel.includes('h4')
      ) {
        for (const el of elements) {
          for (const c of el.children) {
            if (
              c.tag === 'h1' ||
              c.tag === 'h2' ||
              c.tag === 'h3' ||
              c.tag === 'h4' ||
              c.attributes['class']?.includes('trial-name')
            ) {
              matched.push(c);
            }
          }
          if (matched.length === 0) {
            if (
              el.tag === 'h1' ||
              el.tag === 'h2' ||
              el.tag === 'h3' ||
              el.tag === 'h4' ||
              el.attributes['class']?.includes('trial-name')
            ) {
              matched.push(el);
            }
          }
        }
        return createFakeLocator(matched);
      }

      // Check for trial-card or section
      if (
        lowerSel.includes('trial-card') ||
        lowerSel.includes('data-trial-id') ||
        lowerSel.includes('trial')
      ) {
        for (const el of elements) {
          if (
            el.tag === 'article' ||
            el.attributes['class']?.includes('trial-card') ||
            'data-trial-id' in el.attributes
          ) {
            matched.push(el);
          }
        }
        return createFakeLocator(matched);
      }

      return createFakeLocator(matched);
    },
    getByRole(
      role: string,
      options?:
        | {
            name?: string | RegExp | undefined;
            level?: number | undefined;
            exact?: boolean | undefined;
          }
        | undefined,
    ): PlaywrightLocator {
      const matched: FakeDomElement[] = [];

      for (const el of elements) {
        if (role === 'article' && el.tag === 'article') {
          matched.push(el);
        } else if (role === 'heading') {
          if (el.tag === 'h1' || el.tag === 'h2') {
            if (options?.name) {
              const matches =
                typeof options.name === 'string'
                  ? el.text.toLowerCase().includes(options.name.toLowerCase())
                  : options.name.test(el.text);
              if (matches) matched.push(el);
            } else {
              matched.push(el);
            }
          }
          // Search in children
          for (const c of el.children) {
            if (c.tag === 'h1' || c.tag === 'h2') {
              if (options?.name) {
                const matches =
                  typeof options.name === 'string'
                    ? c.text.toLowerCase().includes(options.name.toLowerCase())
                    : options.name.test(c.text);
                if (matches) matched.push(c);
              } else {
                matched.push(c);
              }
            }
          }
        } else if (role === 'link') {
          for (const c of el.children) {
            if (c.tag === 'a') {
              matched.push(c);
            }
          }
        }
      }
      return createFakeLocator(matched);
    },
    getByText(
      text: string | RegExp,
      options?: { exact?: boolean | undefined } | undefined,
    ): PlaywrightLocator {
      const matched = elements.filter((e) => {
        if (typeof text === 'string') {
          return options?.exact ? e.text === text : e.text.includes(text);
        }
        return text.test(e.text);
      });
      return createFakeLocator(matched);
    },
  };
}

export interface FakeBrowserEnvironmentOptions {
  html?: string;
  status?: number;
  navUrl?: string;
  onPopup?: (page: PlaywrightPage) => void;
  onDownload?: (download: PlaywrightDownload) => void;
  routeRequests?: string[];
  contextOptions?: { acceptDownloads?: boolean };
}

export function createFakePlaywrightEnvironment(options: FakeBrowserEnvironmentOptions = {}) {
  const html = options.html ?? ORIGIN_TRIALS_HTML_FIXTURE;
  const status = options.status ?? 200;
  let currentUrl = options.navUrl ?? DEFAULT_ORIGIN_TRIALS_URL;
  const routeHandlers: Array<(route: PlaywrightRoute) => Promise<void> | void> = [];
  const popupListeners: Array<(p: PlaywrightPage) => void> = [];
  const downloadListeners: Array<(d: PlaywrightDownload) => void> = [];
  let tracingStarted = false;
  let tracingStopped = false;
  let tracingPath: string | undefined;
  let contextCreatedOptions: { acceptDownloads?: boolean } | undefined;

  const parsedDom = parseSimpleHtml(html);

  const fakePage: PlaywrightPage = {
    async goto(url: string): Promise<PlaywrightResponse | null> {
      currentUrl = url;

      // Simulate route handlers
      if (options.routeRequests) {
        for (const reqUrl of options.routeRequests) {
          const req: PlaywrightRequest = {
            url: () => reqUrl,
            method: () => 'GET',
            headers: () => ({ accept: 'text/html' }),
          };
          const route: PlaywrightRoute = {
            request: () => req,
            abort: async () => {},
            continue: async () => {},
            fulfill: async () => {},
          };
          for (const handler of routeHandlers) {
            await handler(route);
          }
        }
      }

      // Simulate popup / download events if handlers registered
      if (options.onPopup) {
        options.onPopup(fakePage);
        for (const l of popupListeners) l(fakePage);
      }
      if (options.onDownload) {
        const download: PlaywrightDownload = {
          failure: async () => 'Download blocked by policy',
          url: () => 'https://developer.chrome.com/downloads/file.bin',
          suggestedFilename: () => 'file.bin',
          cancel: async () => {},
        };
        options.onDownload(download);
        for (const l of downloadListeners) l(download);
      }

      const resp: PlaywrightResponse = {
        status: () => status,
        url: () => currentUrl,
        headers: () => ({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => html,
        body: async () => Buffer.from(html, 'utf8'),
        ok: () => status >= 200 && status < 300,
      };
      return resp;
    },
    url: () => currentUrl,
    locator(selector: string) {
      return createFakeLocator(parsedDom).locator(selector);
    },
    getByRole(
      role: string,
      opts?:
        | {
            name?: string | RegExp | undefined;
            level?: number | undefined;
            exact?: boolean | undefined;
          }
        | undefined,
    ) {
      return createFakeLocator(parsedDom).getByRole(role, opts);
    },
    getByText(text: string | RegExp, opts?: { exact?: boolean | undefined } | undefined) {
      return createFakeLocator(parsedDom).getByText(text, opts);
    },
    content: async () => html,
    close: async () => {},
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event === 'popup') popupListeners.push(listener as (p: PlaywrightPage) => void);
      if (event === 'download') downloadListeners.push(listener as (d: PlaywrightDownload) => void);
      return this;
    },
  };

  const fakeContext: PlaywrightBrowserContext = {
    async newPage() {
      return fakePage;
    },
    async route(_urlPattern, handler) {
      routeHandlers.push(handler);
    },
    tracing: {
      async start() {
        tracingStarted = true;
      },
      async stop(opts?: { path?: string | undefined } | undefined) {
        tracingStopped = true;
        tracingPath = opts?.path;
      },
    },
    async close() {},
  };

  const fakeBrowser: PlaywrightBrowser = {
    async newContext(
      opts?:
        | {
            acceptDownloads?: boolean | undefined;
            userAgent?: string | undefined;
            viewport?: { width: number; height: number } | undefined;
            [key: string]: unknown;
          }
        | undefined,
    ) {
      contextCreatedOptions = opts;
      return fakeContext;
    },
    async close() {},
    version: () => 'Chromium 130.0.0.0',
  };

  return {
    fakeBrowser,
    fakeContext,
    fakePage,
    getTracingState: () => ({ tracingStarted, tracingStopped, tracingPath }),
    getContextOptions: () => contextCreatedOptions,
  };
}

// ---------------------------------------------------------------------------
// Test Suites
// ---------------------------------------------------------------------------

describe('COL-005 Chrome Origin Trials Playwright Collector', () => {
  describe('Semantic Locator & Trial Data Extraction (SOURCE_CATALOG §8)', () => {
    test('extracts origin trials preserving text-only payload, publishedAt null, and CC BY license', async () => {
      const { fakeBrowser } = createFakePlaywrightEnvironment();
      const collector = new ChromeOriginTrialsCollector({ browser: fakeBrowser });

      const result = await collector.collect({
        sourceKey: 'chrome_origin_trials',
        cursor: null,
      });

      assert.equal(result.sourceKey, 'chrome_origin_trials');
      assert.equal(result.items.length, 3);
      assert.equal(result.hasMore, false);
      assert.equal(result.metrics?.itemsFetched, 3);
      assert.ok((result.metrics?.bytesFetched ?? 0) > 0);
      assert.ok((result.metrics?.durationMs ?? 0) >= 0);

      // Item 1: WebGPU Subgroups
      const item1 = result.items[0]!;
      assert.equal(item1.externalId, 'chrome-origin-trial-webgpu-subgroups');
      assert.equal(item1.publishedAt, null); // Strictly null per SOURCE_CATALOG §8
      assert.ok(/^[a-f0-9]{64}$/.test(item1.rawHash)); // 64-char sha256 hex
      assert.equal(item1.metadata?.['source'], 'chrome_origin_trials');
      assert.deepEqual(item1.metadata?.['license'], CHROME_ORIGIN_TRIALS_LICENSE);

      const payload1 = item1.payload as Record<string, unknown>;
      assert.equal(payload1['name'], 'WebGPU Subgroups');
      assert.equal(payload1['status'], 'Active');
      assert.equal(payload1['experimentType'], 'Origin Trial');
      assert.deepEqual(payload1['milestones'], {
        start: 128,
        end: 134,
        rawText: 'Chrome 128 to 134',
      });
      assert.equal(
        payload1['originTrialUrl'],
        'https://developer.chrome.com/origintrials/#/view_trial/webgpu-subgroups',
      );
      assert.equal(
        payload1['documentationUrl'],
        'https://developer.chrome.com/docs/web-platform/webgpu-subgroups',
      );
      assert.equal(
        payload1['feedbackUrl'],
        'https://issues.chromium.org/issues/new?component=WebGPU',
      );
      assert.equal(
        payload1['chromeStatusUrl'],
        'https://chromestatus.com/feature/5144865181466624',
      );
      assert.deepEqual(payload1['features'], [
        'WGSL Subgroup Matrix Operations',
        'Subgroup Broadcast and Shuffle',
      ]);

      // Item 2: Compute Pressure API
      const item2 = result.items[1]!;
      assert.equal(item2.externalId, 'chrome-origin-trial-compute-pressure');
      assert.equal(item2.publishedAt, null);
      const payload2 = item2.payload as Record<string, unknown>;
      assert.equal(payload2['name'], 'Compute Pressure API');
      assert.equal(payload2['status'], 'Active');
      assert.deepEqual(payload2['milestones'], {
        start: 120,
        end: 125,
        rawText: 'Chrome 120 to 125',
      });

      // Item 3: Mutation Events Deprecation Trial
      const item3 = result.items[2]!;
      assert.equal(item3.externalId, 'chrome-origin-trial-deprecation-mutation-events');
      const payload3 = item3.payload as Record<string, unknown>;
      assert.equal(payload3['name'], 'Mutation Events Deprecation Trial');
      assert.equal(payload3['status'], 'Deprecated');
      assert.equal(payload3['experimentType'], 'Deprecation Trial');

      // Next cursor should be present and valid
      assert.ok(result.nextCursor);
      const decodedCursor = decodeOpaqueCursor<ChromeOriginTrialsCursor>(result.nextCursor!);
      assert.equal(
        decodedCursor?.lastCollectedId,
        'chrome-origin-trial-deprecation-mutation-events',
      );
      assert.equal(decodedCursor?.totalCollected, 3);
    });

    test('supports filterStatus and maxItems configuration', async () => {
      const { fakeBrowser } = createFakePlaywrightEnvironment();
      const collector = new ChromeOriginTrialsCollector({
        browser: fakeBrowser,
        config: { filterStatus: 'Deprecated', maxItems: 1 },
      });

      const result = await collector.collect({
        sourceKey: 'chrome_origin_trials',
        cursor: null,
      });

      assert.equal(result.items.length, 1);
      const item = result.items[0]!;
      assert.equal(item.payload['status'], 'Deprecated');
      assert.equal(item.payload['name'], 'Mutation Events Deprecation Trial');
    });
  });

  describe('Security Policies (SECURITY.md §4.2 & THR-001/002)', () => {
    test('enforces acceptDownloads: false and popup/download interception', async () => {
      let popupHandled = false;
      let downloadHandled = false;

      const { fakeBrowser, getContextOptions } = createFakePlaywrightEnvironment({
        onPopup: () => {
          popupHandled = true;
        },
        onDownload: () => {
          downloadHandled = true;
        },
      });

      const collector = new ChromeOriginTrialsCollector({ browser: fakeBrowser });
      const result = await collector.collect({
        sourceKey: 'chrome_origin_trials',
        cursor: null,
      });

      assert.equal(getContextOptions()?.acceptDownloads, false);
      assert.equal(popupHandled, true);
      assert.equal(downloadHandled, true);

      // Security counts recorded in metadata
      const secMeta = result.items[0]?.metadata?.['security'] as Record<string, number>;
      assert.equal(secMeta['popupsBlocked'], 1);
      assert.equal(secMeta['downloadsBlocked'], 1);
    });

    test('blocks routes outside allowedHosts (SSRF prevention THR-001)', async () => {
      const { fakeBrowser } = createFakePlaywrightEnvironment({
        routeRequests: [
          'https://developer.chrome.com/origintrials/bundle.js',
          'http://127.0.0.1:8080/evil.js',
          'https://evil.attacker.com/steal.png',
          'http://169.254.169.254/latest/meta-data/',
        ],
      });

      const collector = new ChromeOriginTrialsCollector({ browser: fakeBrowser });
      const result = await collector.collect({
        sourceKey: 'chrome_origin_trials',
        cursor: null,
      });

      const secMeta = result.items[0]?.metadata?.['security'] as Record<string, number>;
      assert.equal(secMeta['disallowedHostsAborted'], 3);
    });

    test('rejects disallowed target URL scheme and external host before launch', async () => {
      const { fakeBrowser } = createFakePlaywrightEnvironment();

      // Disallowed scheme: http://
      const collectorHttp = new ChromeOriginTrialsCollector({
        browser: fakeBrowser,
        config: { url: 'http://developer.chrome.com/origintrials/' },
      });
      await assert.rejects(
        () => collectorHttp.collect({ sourceKey: 'chrome_origin_trials', cursor: null }),
        (err: unknown) => err instanceof OriginTrialsSecurityError,
      );

      // Disallowed host: evil.com
      const collectorEvil = new ChromeOriginTrialsCollector({
        browser: fakeBrowser,
        config: { url: 'https://evil.com/origintrials/' },
      });
      await assert.rejects(
        () => collectorEvil.collect({ sourceKey: 'chrome_origin_trials', cursor: null }),
        (err: unknown) => err instanceof OriginTrialsSecurityError,
      );
    });

    test('aborts without bypass when login or CAPTCHA challenge is detected', async () => {
      // 1. Password input form challenge
      const { fakeBrowser: loginBrowser } = createFakePlaywrightEnvironment({
        html: LOGIN_CHALLENGE_HTML_FIXTURE,
      });
      const loginCollector = new ChromeOriginTrialsCollector({ browser: loginBrowser });

      await assert.rejects(
        () => loginCollector.collect({ sourceKey: 'chrome_origin_trials', cursor: null }),
        (err: unknown) => {
          assert.ok(err instanceof LoginOrCaptchaDetectedError);
          assert.equal(err.code, 'LOGIN_OR_CAPTCHA_DETECTED');
          return true;
        },
      );

      // 2. Turnstile/CAPTCHA challenge
      const { fakeBrowser: captchaBrowser } = createFakePlaywrightEnvironment({
        html: CAPTCHA_CHALLENGE_HTML_FIXTURE,
      });
      const captchaCollector = new ChromeOriginTrialsCollector({ browser: captchaBrowser });

      await assert.rejects(
        () => captchaCollector.collect({ sourceKey: 'chrome_origin_trials', cursor: null }),
        (err: unknown) => {
          assert.ok(err instanceof LoginOrCaptchaDetectedError);
          assert.equal(err.code, 'LOGIN_OR_CAPTCHA_DETECTED');
          return true;
        },
      );
    });

    test('enforces tracing controls and records trace path when configured', async () => {
      const { fakeBrowser, getTracingState } = createFakePlaywrightEnvironment();
      const collector = new ChromeOriginTrialsCollector({
        browser: fakeBrowser,
        tracing: { enabled: true, path: '/tmp/trace.zip' },
      });

      await collector.collect({ sourceKey: 'chrome_origin_trials', cursor: null });

      const tracingState = getTracingState();
      assert.equal(tracingState.tracingStarted, true);
      assert.equal(tracingState.tracingStopped, true);
      assert.equal(tracingState.tracingPath, '/tmp/trace.zip');
    });
  });

  describe('Trace Artifact Redaction (SECURITY.md §4.2)', () => {
    test('redacts sensitive HTTP headers from trace artifacts', () => {
      const headers = {
        'content-type': 'application/json',
        authorization: 'Bearer secret-jwt-token-123',
        Cookie: 'session=abc; token=def',
        'X-Api-Key': 'key-99999',
        Accept: 'text/html',
      };

      const redacted = redactTraceHeaders(headers);
      assert.equal(redacted['content-type'], 'application/json');
      assert.equal(redacted['Accept'], 'text/html');
      assert.equal(redacted['authorization'], '[REDACTED]');
      assert.equal(redacted['Cookie'], '[REDACTED]');
      assert.equal(redacted['X-Api-Key'], '[REDACTED]');
    });

    test('redacts sensitive query parameters from trace URLs', () => {
      const url =
        'https://developer.chrome.com/origintrials/?token=secret123&category=webgpu&session=sess999';
      const redacted = redactTraceUrl(url);

      assert.ok(!redacted.includes('secret123'));
      assert.ok(!redacted.includes('sess999'));
      assert.ok(redacted.includes('token=%5BREDACTED%5D') || redacted.includes('token=[REDACTED]'));
      assert.ok(redacted.includes('category=webgpu'));
    });

    test('redacts nested trace objects, tokens, and PATs recursively', () => {
      const traceData = {
        traceId: 'tr-001',
        request: {
          url: 'https://developer.chrome.com/api?token=abc12345',
          headers: {
            authorization: 'Bearer ghp_1111222233334444555566667777888899990000',
            host: 'developer.chrome.com',
          },
        },
        metadata: {
          secretKey: 'top-secret',
          info: 'Normal message with Bearer eyJhbGciOiJIUzI1NiJ9.test and github_pat_11AAAAAA_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        },
      };

      const redacted = redactTraceData(traceData) as typeof traceData;
      assert.equal(redacted.traceId, 'tr-001');
      assert.equal(redacted.request.headers.authorization, '[REDACTED]');
      assert.equal(redacted.request.headers.host, 'developer.chrome.com');
      assert.equal(redacted.metadata.secretKey, '[REDACTED]');
      assert.ok(!redacted.metadata.info.includes('eyJhbGciOiJIUzI1NiJ9'));
      assert.ok(!redacted.metadata.info.includes('github_pat_11AAAAAA'));
      assert.ok(redacted.metadata.info.includes('[REDACTED]'));
    });
  });

  describe('Non-JS Fetch Fallback Impossibility (SOURCE_CATALOG §8)', () => {
    test('verifies static fetch yields JS requirement message and rejects plain fetch fallback', async () => {
      const fakeFetch: typeof fetch = async () => {
        return new Response(NON_JS_RAW_RESPONSE_FIXTURE, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      };

      const verification = await verifyNonJsFetchRequiresJavascript(fakeFetch);

      assert.equal(verification.requiresJavascript, true);
      assert.equal(verification.fallbackPossible, false);
      assert.ok(verification.reason.includes('requires JavaScript'));
    });
  });
});

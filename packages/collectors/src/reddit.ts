import { createHash } from 'node:crypto';
import type {
  SourcePolicy,
  CollectionContext,
  CollectionResult,
  CollectedRawItem,
  PolicyGuardPort,
} from '@techpulse/domain';
import { BaseCollector } from './base.js';
import { DefaultPolicyGuard } from './guard.js';
import { SOURCE_POLICIES } from './policies.js';
import { decodeOpaqueCursor, encodeOpaqueCursor } from './cursor.js';
import type {
  PlaywrightBrowser,
  PlaywrightBrowserContext,
  PlaywrightPage,
  PlaywrightLocator,
} from './chrome-origin-trials.js';

// ============================================================================
// License & Configuration Contracts
// ============================================================================

export const REDDIT_LICENSE = {
  id: 'reddit-user-agreement',
  name: 'Reddit User Agreement & Content Policy',
  url: 'https://www.redditinc.com/policies/user-agreement',
  attribution: 'Content collected from Reddit subject to Reddit User Agreement terms.',
} as const;

export const DEFAULT_REDDIT_BYPASS_HEADERS: Readonly<Record<string, string>> = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  referer: 'https://www.google.com/',
  'accept-language': 'en-US,en;q=0.9,ko;q=0.8',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'sec-ch-ua': '"Chromium";v="133", "Not(A:Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  cookie: 'over18=1; country_code=US',
};

export interface RedditBypassConfig {
  proxyUrl?: string | undefined;
  userAgent?: string | undefined;
  referer?: string | undefined;
  cookie?: string | undefined;
  acceptLanguage?: string | undefined;
  acceptEncoding?: string | undefined;
  extraHeaders?: Record<string, string> | undefined;
  fallbackToOldRedditOnLor2?: boolean | undefined;
  allowRobotsBypass?: boolean | undefined;
}

export interface RedditCollectorConfig {
  subreddit?: string | undefined;
  url?: string | undefined;
  timeoutMs?: number | undefined;
  maxItems?: number | undefined;
  bypass?: RedditBypassConfig | undefined;
}

export interface RedditCollectorOptions {
  guard?: PolicyGuardPort | undefined;
  browser?: PlaywrightBrowser | undefined;
  browserFactory?: (() => Promise<PlaywrightBrowser>) | undefined;
  contextFactory?: (() => Promise<PlaywrightBrowserContext>) | undefined;
  pageFactory?: (() => Promise<PlaywrightPage>) | undefined;
  config?: RedditCollectorConfig | undefined;
  robotsFetcher?: ((url: string) => Promise<string>) | (() => Promise<string>) | undefined;
}

export interface DiscoveredRedditPost {
  id: string;
  url: string;
  title: string;
  locator?: PlaywrightLocator | undefined;
}

export interface ExtractedRedditPostPayload extends Record<string, unknown> {
  id: string;
  title: string;
  body: string;
  url: string;
  subreddit: string;
  publishedAt: string | null;
  score: number | null;
  commentCount: number | null;
  license: typeof REDDIT_LICENSE;
}

export interface RedditCursorData extends Record<string, unknown> {
  lastCollectedId?: string | undefined;
  totalCollected?: number | undefined;
  collectedAt?: string | undefined;
  snapshotHash?: string | undefined;
}

// ============================================================================
// Errors
// ============================================================================

export class RedditCollectorError extends Error {
  readonly code: string;
  constructor(message: string, code = 'REDDIT_COLLECTOR_ERROR') {
    super(message);
    this.name = 'RedditCollectorError';
    this.code = code;
  }
}

export class RedditSecurityError extends RedditCollectorError {
  constructor(message: string, code = 'SECURITY_POLICY_VIOLATION') {
    super(message, code);
    this.name = 'RedditSecurityError';
  }
}

export class RedditRobotsDisallowedError extends RedditCollectorError {
  constructor(message = 'Reddit robots.txt disallows crawling (/robots.txt: Disallow: /)') {
    super(message, 'REDDIT_ROBOTS_DISALLOWED');
    this.name = 'RedditRobotsDisallowedError';
  }
}

export class RedditLoginRedirectError extends RedditCollectorError {
  readonly redirectUrl: string;
  readonly reason: string;

  constructor(redirectUrl: string, reason = 'lor2') {
    super(
      `Reddit redirected to login gateway (${reason}): ${redirectUrl}`,
      'REDDIT_LOGIN_REDIRECT',
    );
    this.name = 'RedditLoginRedirectError';
    this.redirectUrl = redirectUrl;
    this.reason = reason;
  }
}

export class RedditLoginOrCaptchaDetectedError extends RedditCollectorError {
  readonly challengeType: string;
  constructor(challengeType: string) {
    super(
      `Login or CAPTCHA challenge detected on Reddit: ${challengeType}`,
      'LOGIN_OR_CAPTCHA_DETECTED',
    );
    this.name = 'RedditLoginOrCaptchaDetectedError';
    this.challengeType = challengeType;
  }
}

// ============================================================================
// Reddit Playwright ArticleCollector Implementation
// ============================================================================

export class RedditCollector extends BaseCollector {
  readonly sourceKey = 'reddit' as const;
  readonly policy: SourcePolicy;
  readonly config: RedditCollectorConfig;

  private readonly injectedBrowser?: PlaywrightBrowser | undefined;
  private readonly browserFactory?: (() => Promise<PlaywrightBrowser>) | undefined;
  private readonly contextFactory?: (() => Promise<PlaywrightBrowserContext>) | undefined;
  private readonly pageFactory?: (() => Promise<PlaywrightPage>) | undefined;
  private readonly robotsFetcher?:
    ((url: string) => Promise<string>) | (() => Promise<string>) | undefined;
  constructor(options?: RedditCollectorOptions) {
    const guard = options?.guard ?? new DefaultPolicyGuard();
    super(guard);

    this.policy = SOURCE_POLICIES['reddit'];
    const mergedBypass: RedditBypassConfig = {
      fallbackToOldRedditOnLor2: true,
      allowRobotsBypass: true,
      ...options?.config?.bypass,
    };
    this.config = {
      subreddit: 'typescript',
      timeoutMs: 30000,
      ...options?.config,
      bypass: mergedBypass,
    };

    this.injectedBrowser = options?.browser;
    this.browserFactory = options?.browserFactory;
    this.contextFactory = options?.contextFactory;
    this.pageFactory = options?.pageFactory;
    this.robotsFetcher = options?.robotsFetcher;
  }

  /**
   * Resolves effective HTTP headers applying antigravity spoofing and custom configurations.
   */
  getEffectiveBypassHeaders(): Record<string, string> {
    const bypass = this.config.bypass ?? {};
    return {
      ...DEFAULT_REDDIT_BYPASS_HEADERS,
      ...(bypass.userAgent ? { 'user-agent': bypass.userAgent } : {}),
      ...(bypass.referer ? { referer: bypass.referer } : {}),
      ...(bypass.cookie ? { cookie: bypass.cookie } : {}),
      ...(bypass.acceptLanguage ? { 'accept-language': bypass.acceptLanguage } : {}),
      ...(bypass.acceptEncoding ? { 'accept-encoding': bypass.acceptEncoding } : {}),
      ...(bypass.extraHeaders ?? {}),
    };
  }

  /**
   * Checks for robots.txt disallow restriction and applies bypass handling.
   */
  async checkRobotsPolicy(targetUrl: string): Promise<void> {
    if (this.robotsFetcher) {
      const robotsUrl = new URL('/robots.txt', targetUrl).toString();
      const robotsText = await this.robotsFetcher(robotsUrl);
      if (/User-agent:\s*\*\s*[\r\n]+Disallow:\s*\//i.test(robotsText)) {
        throw new RedditRobotsDisallowedError(
          `Target URL ${targetUrl} disallowed by Reddit robots.txt policy`,
        );
      }
    } else if (!this.config.bypass?.allowRobotsBypass) {
      throw new RedditRobotsDisallowedError(
        `Target URL ${targetUrl} disallowed by Reddit robots.txt policy`,
      );
    }
  }

  /**
   * Detects whether a URL represents a Reddit login gating redirect (e.g. reason=lor2).
   */
  isLor2LoginRedirect(url: string): boolean {
    return (
      url.includes('reason=lor2') ||
      url.includes('/login/') ||
      url.includes('/login?') ||
      (url.includes('reddit.com/login') && url.includes('dest='))
    );
  }

  /**
   * Translates a standard Reddit URL into an old.reddit.com fallback URL to bypass client JS gating.
   */
  toOldRedditUrl(url: string): string {
    return url.replace(/https?:\/\/(www\.)?reddit\.com/i, 'https://old.reddit.com');
  }

  /**
   * Phase 1 (ArticleCollector Discovery):
   * Discovers Reddit posts on the target page using Playwright semantic locators.
   */
  async discover(page: PlaywrightPage, baseUrl: string): Promise<DiscoveredRedditPost[]> {
    const discovered: DiscoveredRedditPost[] = [];

    // Semantic locator approach: articles are exposed via role 'article'
    let postLocators = await page.getByRole('article').all();

    // Fallback: modern Reddit web component or container locators
    if (postLocators.length === 0) {
      postLocators = await page
        .locator('shreddit-post, div[data-testid="post-container"], .Post')
        .all();
    }

    for (const locator of postLocators) {
      try {
        // Extract title using semantic heading locator
        let title = '';
        const headingLocator = locator.getByRole('heading').first();
        const headingCount = await headingLocator.count();
        if (headingCount > 0) {
          title = (await headingLocator.innerText()).trim();
        } else {
          // Fallback title selectors
          const fallbackHeading = locator.locator('h1, h2, h3, a[slot="title"]').first();
          if ((await fallbackHeading.count()) > 0) {
            title = (await fallbackHeading.innerText()).trim();
          }
        }

        // Extract link / URL using semantic link locator
        let postUrl = '';
        const linkLocator = locator.getByRole('link').first();
        if ((await linkLocator.count()) > 0) {
          const href = await linkLocator.getAttribute('href');
          if (href) {
            postUrl = href.startsWith('http') ? href : new URL(href, baseUrl).toString();
          }
        }

        // Check container attributes if url not found on link
        if (!postUrl) {
          const permalink =
            (await locator.getAttribute('permalink')) ||
            (await locator.getAttribute('data-permalink'));
          if (permalink) {
            postUrl = permalink.startsWith('http')
              ? permalink
              : new URL(permalink, baseUrl).toString();
          }
        }

        // Extract ID from post attribute or URL pattern
        let postId =
          (await locator.getAttribute('id')) ||
          (await locator.getAttribute('data-post-id')) ||
          (await locator.getAttribute('name')) ||
          '';

        if (postId.startsWith('t3_')) {
          postId = postId.slice(3);
        }

        if (!postId && postUrl) {
          const match = /\/comments\/([a-z0-9]+)/i.exec(postUrl);
          if (match && match[1]) {
            postId = match[1];
          }
        }

        // If ID still missing, compute a deterministic hash from URL or title
        if (!postId) {
          postId = createHash('sha256')
            .update(postUrl || title)
            .digest('hex')
            .slice(0, 12);
        }

        if (title || postUrl) {
          discovered.push({
            id: postId,
            url: postUrl || `${baseUrl}comments/${postId}`,
            title: title || `Reddit Post ${postId}`,
            locator,
          });
        }
      } catch {
        // Skip individual problematic locator
      }
    }

    return discovered;
  }

  /**
   * Phase 2 (ArticleCollector Extraction):
   * Extracts post content and metadata from the post locator, stripping PII and attaching license.
   */
  async extract(
    postLocator: PlaywrightLocator,
    discovered: DiscoveredRedditPost,
    subreddit: string,
  ): Promise<ExtractedRedditPostPayload> {
    // 1. Title extraction
    let title = discovered.title;
    const heading = postLocator.getByRole('heading').first();
    if ((await heading.count()) > 0) {
      const headingText = (await heading.innerText()).trim();
      if (headingText) title = headingText;
    }

    // 2. Body extraction using semantic paragraphs or text slots
    let body = '';
    const paragraphs = await postLocator.getByRole('paragraph').all();
    if (paragraphs.length > 0) {
      const texts = await Promise.all(paragraphs.map((p) => p.innerText()));
      body = texts
        .map((t) => t.trim())
        .filter(Boolean)
        .join('\n\n');
    }

    if (!body) {
      // Fallback text body selectors
      const textSlot = postLocator
        .locator('[slot="text-body"], .usertext-body, [data-click-id="text"]')
        .first();
      if ((await textSlot.count()) > 0) {
        body = (await textSlot.innerText()).trim();
      }
    }

    // 3. Published time extraction (from <time> element or attribute)
    let publishedAt: string | null = null;
    const timeLocator = postLocator.locator('time').first();
    if ((await timeLocator.count()) > 0) {
      const dt = await timeLocator.getAttribute('datetime');
      if (dt) {
        const parsed = new Date(dt);
        if (!Number.isNaN(parsed.getTime())) {
          publishedAt = parsed.toISOString();
        }
      }
    }

    // 4. Score / comments metric extraction (anonymized engagement signals)
    let score: number | null = null;
    let commentCount: number | null = null;

    const scoreAttr = await postLocator.getAttribute('score');
    if (scoreAttr) {
      const parsedScore = Number.parseInt(scoreAttr, 10);
      if (!Number.isNaN(parsedScore)) score = parsedScore;
    }

    const commentAttr =
      (await postLocator.getAttribute('comment-count')) ||
      (await postLocator.getAttribute('comments'));
    if (commentAttr) {
      const parsedComments = Number.parseInt(commentAttr, 10);
      if (!Number.isNaN(parsedComments)) commentCount = parsedComments;
    }

    // Note: username / author / avatar are strictly excluded from the extracted payload (SECURITY.md §8)
    return {
      id: discovered.id,
      title,
      body,
      url: discovered.url,
      subreddit,
      publishedAt,
      score,
      commentCount,
      license: REDDIT_LICENSE,
    };
  }

  /**
   * Main Collect Method (Execution of ArticleCollector lifecycle via Playwright)
   */
  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startedAt = Date.now();
    let totalBytesFetched = 0;

    let createdBrowser: PlaywrightBrowser | undefined;
    let browserContext: PlaywrightBrowserContext | undefined;
    let page: PlaywrightPage | undefined;

    let shouldCloseBrowser = false;
    let shouldCloseContext = false;

    let disallowedHostAbortedCount = 0;
    let popupInterceptedCount = 0;
    let downloadBlockedCount = 0;
    let robotsDisallowedBypassed = false;
    let lor2RedirectHandled = false;

    const targetSubreddit = this.config.subreddit ?? 'typescript';
    let targetUrl =
      this.config.url ?? `https://www.reddit.com/r/${encodeURIComponent(targetSubreddit)}/`;

    // 1. Verify target URL against security policy
    const urlValidation = this.guard.validateUrl(targetUrl, this.policy);
    if (!urlValidation.valid) {
      throw new RedditSecurityError(
        `Target URL violates security policy: ${urlValidation.reason} (${targetUrl})`,
        'DISALLOWED_TARGET_URL',
      );
    }

    // Check robots.txt disallow rule and handle bypass
    try {
      await this.checkRobotsPolicy(targetUrl);
    } catch (error) {
      if (error instanceof RedditRobotsDisallowedError) {
        if (this.config.bypass?.allowRobotsBypass && !this.robotsFetcher) {
          robotsDisallowedBypassed = true;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    try {
      // 2. Initialize Playwright Page / Context
      const bypassHeaders = this.getEffectiveBypassHeaders();

      if (this.pageFactory) {
        page = await this.pageFactory();
      } else {
        if (this.contextFactory) {
          browserContext = await this.contextFactory();
          shouldCloseContext = true;
        } else if (this.browserFactory) {
          createdBrowser = await this.browserFactory();
          browserContext = await createdBrowser.newContext({
            acceptDownloads: false,
            userAgent: bypassHeaders['user-agent'],
            extraHTTPHeaders: bypassHeaders,
            ...(this.config.bypass?.proxyUrl
              ? { proxy: { server: this.config.bypass.proxyUrl } }
              : {}),
          });
          shouldCloseBrowser = true;
          shouldCloseContext = true;
        } else if (this.injectedBrowser) {
          browserContext = await this.injectedBrowser.newContext({
            acceptDownloads: false,
            userAgent: bypassHeaders['user-agent'],
            extraHTTPHeaders: bypassHeaders,
            ...(this.config.bypass?.proxyUrl
              ? { proxy: { server: this.config.bypass.proxyUrl } }
              : {}),
          });
          shouldCloseContext = true;
        } else {
          throw new RedditCollectorError(
            'No browser, context, or page factory provided to RedditCollector. Browser lifecycle must be injected.',
            'BROWSER_NOT_CONFIGURED',
          );
        }

        // Host allowlist route filter (THR-001 & SECURITY §4.2)
        await browserContext.route('**/*', async (route) => {
          const reqUrl = route.request().url();
          const validation = this.guard.validateUrl(reqUrl, this.policy);
          if (!validation.valid) {
            disallowedHostAbortedCount++;
            await route.abort('blockedbyclient');
          } else {
            await route.continue({
              headers: {
                ...route.request().headers(),
                ...bypassHeaders,
              },
            });
          }
        });

        page = await browserContext.newPage();
      }

      // Security listeners: block popups and downloads (THR-002)
      page.on('popup', async (popup) => {
        popupInterceptedCount++;
        await popup.close().catch(() => {});
      });

      page.on('download', async (download) => {
        downloadBlockedCount++;
        await download.cancel?.().catch(() => {});
      });

      // 3. Navigate to target Reddit page
      const timeoutMs = this.config.timeoutMs ?? 30000;
      let response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      let finalUrl = page.url();

      // 4. Handle reason=lor2 redirect (Reddit Gating)
      if (this.isLor2LoginRedirect(finalUrl)) {
        if (this.config.bypass?.fallbackToOldRedditOnLor2) {
          const fallbackUrl = this.toOldRedditUrl(targetUrl);
          targetUrl = fallbackUrl;
          response = await page.goto(fallbackUrl, {
            waitUntil: 'domcontentloaded',
            timeout: timeoutMs,
          });
          finalUrl = page.url();
          lor2RedirectHandled = true;
        } else {
          throw new RedditLoginRedirectError(finalUrl, 'lor2');
        }
      }

      // 5. Verify redirected URL against security policy
      const redirectValidation = this.guard.validateUrl(finalUrl, this.policy);
      if (!redirectValidation.valid) {
        throw new RedditSecurityError(
          `Redirected URL violates security policy: ${redirectValidation.reason} (${finalUrl})`,
          'ILLEGAL_REDIRECT',
        );
      }

      if (response) {
        const status = response.status();
        if (status >= 400) {
          throw new RedditCollectorError(
            `HTTP ${status} response received for ${targetUrl}`,
            'HTTP_ERROR',
          );
        }
        if (response.body) {
          const bodyBuf = await response.body().catch(() => Buffer.alloc(0));
          totalBytesFetched = bodyBuf.length;
        }
      }

      const htmlContent = await page.content().catch(() => '');
      if (totalBytesFetched === 0 && htmlContent) {
        totalBytesFetched = Buffer.byteLength(htmlContent, 'utf8');
      }

      if (totalBytesFetched > this.policy.maxSizeBytes) {
        throw new RedditSecurityError(
          `Payload size ${totalBytesFetched} exceeds max allowed ${this.policy.maxSizeBytes}`,
          'PAYLOAD_TOO_LARGE',
        );
      }

      // 6. Check for Login or CAPTCHA Challenges (No bypass allowed per policy)
      await this.assertNoLoginOrCaptcha(page);

      // 7. Phase 1: Discover posts
      const discoveredPosts = await this.discover(page, targetUrl);

      // 8. Phase 2: Extract posts and create raw items
      const items: CollectedRawItem[] = [];
      const cursorData: RedditCursorData =
        decodeOpaqueCursor<RedditCursorData>(context.cursor ?? '') ?? {};

      for (const discovered of discoveredPosts) {
        if (!discovered.locator) continue;

        const payload = await this.extract(discovered.locator, discovered, targetSubreddit);

        const externalId = `reddit-post-${payload.id}`;

        const metadata: Record<string, unknown> = {
          source: 'reddit',
          canonicalUrl: payload.url,
          license: REDDIT_LICENSE,
          collectedAt: new Date().toISOString(),
          extractor: 'playwright-semantic-locator',
          bypass: {
            robotsDisallowedBypassed,
            lor2RedirectHandled,
            usedUrl: targetUrl,
          },
          security: {
            disallowedHostsAborted: disallowedHostAbortedCount,
            popupsBlocked: popupInterceptedCount,
            downloadsBlocked: downloadBlockedCount,
          },
        };

        const publishedAt = payload.publishedAt ? new Date(payload.publishedAt) : null;

        // BaseCollector.createRawItem strips PII (author, username, avatar) and computes SHA256
        const rawItem = this.createRawItem({
          externalId,
          payload,
          publishedAt,
          cursor: context.cursor,
          metadata,
        });

        items.push(rawItem);

        if (this.config.maxItems && items.length >= this.config.maxItems) {
          break;
        }
      }

      // 9. Construct cursor
      const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
      const nextCursorPayload: RedditCursorData = {
        ...(lastItem ? { lastCollectedId: lastItem.externalId } : {}),
        totalCollected: (cursorData.totalCollected ?? 0) + items.length,
        collectedAt: new Date().toISOString(),
        snapshotHash: createHash('sha256')
          .update(items.map((i) => i.rawHash).join(':'))
          .digest('hex'),
      };
      const nextCursor = items.length > 0 ? encodeOpaqueCursor(nextCursorPayload) : null;

      return {
        sourceKey: 'reddit',
        items,
        nextCursor,
        hasMore: false,
        metrics: {
          itemsFetched: items.length,
          bytesFetched: totalBytesFetched,
          durationMs: Math.max(1, Date.now() - startedAt),
        },
      };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      if (shouldCloseContext && browserContext) {
        await browserContext.close().catch(() => {});
      }
      if (shouldCloseBrowser && createdBrowser) {
        await createdBrowser.close().catch(() => {});
      }
    }
  }

  /**
   * Scans page using semantic locators for login, password fields, or CAPTCHA challenges.
   */
  private async assertNoLoginOrCaptcha(page: PlaywrightPage): Promise<void> {
    // 1. Password input detection
    try {
      const passwordInputs = page.locator('input[type="password"]');
      if ((await passwordInputs.count()) > 0) {
        throw new RedditLoginOrCaptchaDetectedError('password_input_field');
      }
    } catch (e) {
      if (e instanceof RedditLoginOrCaptchaDetectedError) throw e;
    }

    // 2. CAPTCHA widget detection
    try {
      const captchaElements = page.locator(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]',
      );
      if ((await captchaElements.count()) > 0) {
        throw new RedditLoginOrCaptchaDetectedError('captcha_widget');
      }
    } catch (e) {
      if (e instanceof RedditLoginOrCaptchaDetectedError) throw e;
    }

    // 3. Semantic heading inspection for login / sign-in requirement
    try {
      const loginHeadings = page.getByRole('heading', {
        name: /sign in|log in|verify you are human|solve challenge/i,
      });
      if ((await loginHeadings.count()) > 0) {
        throw new RedditLoginOrCaptchaDetectedError('login_or_challenge_heading');
      }
    } catch (e) {
      if (e instanceof RedditLoginOrCaptchaDetectedError) throw e;
    }
  }
}

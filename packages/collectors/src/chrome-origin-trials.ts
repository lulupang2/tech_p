import { createHash } from 'node:crypto';
import type {
  CollectorPort,
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

// ============================================================================
// Playwright Structural Interfaces (Decoupled, zero-dependency browser abstraction)
// ============================================================================

export interface PlaywrightRequest {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  resourceType?(): string;
}

export interface PlaywrightRoute {
  request(): PlaywrightRequest;
  abort(errorCode?: string): Promise<void>;
  continue(overrides?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  }): Promise<void>;
  fulfill(response: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    contentType?: string;
  }): Promise<void>;
}

export interface PlaywrightResponse {
  status(): number;
  url(): string;
  headers(): Record<string, string>;
  text(): Promise<string>;
  body?(): Promise<Buffer>;
  ok(): boolean;
}

export interface PlaywrightLocator {
  innerText(): Promise<string>;
  allInnerTexts(): Promise<string[]>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  count(): Promise<number>;
  all(): Promise<PlaywrightLocator[]>;
  first(): PlaywrightLocator;
  nth(index: number): PlaywrightLocator;
  locator(selector: string): PlaywrightLocator;
  getByRole(
    role: string,
    options?:
      | {
          name?: string | RegExp | undefined;
          level?: number | undefined;
          exact?: boolean | undefined;
        }
      | undefined,
  ): PlaywrightLocator;
  getByText(
    text: string | RegExp,
    options?: { exact?: boolean | undefined } | undefined,
  ): PlaywrightLocator;
  getByTestId?(testId: string | RegExp): PlaywrightLocator;
  getByLabel?(label: string | RegExp): PlaywrightLocator;
  filter?(
    options:
      { hasText?: string | RegExp | undefined; has?: PlaywrightLocator | undefined } | undefined,
  ): PlaywrightLocator;
  isVisible?(): Promise<boolean>;
}

export interface PlaywrightDownload {
  failure(): Promise<string | null>;
  url(): string;
  suggestedFilename(): string;
  cancel?(): Promise<void>;
}

export interface PlaywrightPage {
  goto(
    url: string,
    options?:
      | {
          waitUntil?: ('load' | 'domcontentloaded' | 'networkidle' | 'commit') | undefined;
          timeout?: number | undefined;
        }
      | undefined,
  ): Promise<PlaywrightResponse | null>;
  url(): string;
  locator(selector: string): PlaywrightLocator;
  getByRole(
    role: string,
    options?:
      | {
          name?: string | RegExp | undefined;
          level?: number | undefined;
          exact?: boolean | undefined;
        }
      | undefined,
  ): PlaywrightLocator;
  getByText(
    text: string | RegExp,
    options?: { exact?: boolean | undefined } | undefined,
  ): PlaywrightLocator;
  getByTestId?(testId: string | RegExp): PlaywrightLocator;
  getByLabel?(label: string | RegExp): PlaywrightLocator;
  content(): Promise<string>;
  close(): Promise<void>;
  on(event: 'popup', listener: (page: PlaywrightPage) => void): this;
  on(event: 'download', listener: (download: PlaywrightDownload) => void): this;
  on(
    event: 'request' | 'response' | 'dialog' | string,
    listener: (...args: unknown[]) => void,
  ): this;
  off?(event: string, listener: (...args: unknown[]) => void): this;
}

export interface PlaywrightTracing {
  start(
    options?:
      | {
          screenshots?: boolean | undefined;
          snapshots?: boolean | undefined;
          sources?: boolean | undefined;
          name?: string | undefined;
        }
      | undefined,
  ): Promise<void>;
  stop(options?: { path?: string | undefined } | undefined): Promise<void>;
}

export interface PlaywrightBrowserContext {
  newPage(): Promise<PlaywrightPage>;
  route(
    url: string | RegExp | ((url: URL) => boolean),
    handler: (route: PlaywrightRoute) => Promise<void> | void,
  ): Promise<void>;
  tracing?: PlaywrightTracing | undefined;
  close(): Promise<void>;
}

export interface PlaywrightBrowser {
  newContext(
    options?:
      | {
          acceptDownloads?: boolean | undefined;
          userAgent?: string | undefined;
          viewport?: { width: number; height: number } | undefined;
          [key: string]: unknown;
        }
      | undefined,
  ): Promise<PlaywrightBrowserContext>;
  close(): Promise<void>;
  version?(): string;
}

// ============================================================================
// Configuration & Data Types
// ============================================================================

export const DEFAULT_ORIGIN_TRIALS_URL = 'https://developer.chrome.com/origintrials/';

export const CHROME_ORIGIN_TRIALS_LICENSE = {
  id: 'CC-BY-4.0',
  name: 'Creative Commons Attribution 4.0 International',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution:
    'Portions of this page are modifications based on work created and shared by Google and used according to terms described in the Creative Commons 4.0 Attribution License.',
} as const;

export interface ChromeOriginTrialsConfig {
  url?: string | undefined;
  timeoutMs?: number | undefined;
  filterStatus?: string | undefined;
  maxItems?: number | undefined;
}

export interface ChromeOriginTrialsTracingConfig {
  enabled?: boolean | undefined;
  path?: string | undefined;
  screenshots?: boolean | undefined;
  snapshots?: boolean | undefined;
}

export interface ChromeOriginTrialsCollectorOptions {
  guard?: PolicyGuardPort | undefined;
  browser?: PlaywrightBrowser | undefined;
  browserFactory?: (() => Promise<PlaywrightBrowser>) | undefined;
  contextFactory?: (() => Promise<PlaywrightBrowserContext>) | undefined;
  pageFactory?: (() => Promise<PlaywrightPage>) | undefined;
  config?: ChromeOriginTrialsConfig | undefined;
  tracing?: ChromeOriginTrialsTracingConfig | undefined;
  fetch?: typeof fetch | undefined;
}

export interface ChromeOriginTrialMilestones {
  start: string | number | null;
  end: string | number | null;
  rawText: string | null;
}

export interface ChromeOriginTrialPayload extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  status: string;
  milestones: ChromeOriginTrialMilestones | null;
  originTrialUrl: string;
  documentationUrl: string | null;
  feedbackUrl: string | null;
  intentToTrialUrl: string | null;
  chromeStatusUrl: string | null;
  standardsUrl: string | null;
  experimentType: string | null;
  features: string[];
}

export interface ChromeOriginTrialsCursor extends Record<string, unknown> {
  lastCollectedId?: string | undefined;
  totalCollected?: number | undefined;
  collectedAt?: string | undefined;
  snapshotHash?: string | undefined;
}

// ============================================================================
// Errors
// ============================================================================

export class OriginTrialsCollectorError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ORIGIN_TRIALS_COLLECTOR_ERROR') {
    super(message);
    this.name = 'OriginTrialsCollectorError';
    this.code = code;
  }
}

export class OriginTrialsSecurityError extends OriginTrialsCollectorError {
  constructor(message: string, code = 'SECURITY_POLICY_VIOLATION') {
    super(message, code);
    this.name = 'OriginTrialsSecurityError';
  }
}

export class LoginOrCaptchaDetectedError extends OriginTrialsSecurityError {
  constructor(indicator: string) {
    super(
      `Login or CAPTCHA challenge detected on origin trials page (${indicator}). Bypassing or automating login/CAPTCHA is strictly prohibited by security policy.`,
      'LOGIN_OR_CAPTCHA_DETECTED',
    );
    this.name = 'LoginOrCaptchaDetectedError';
  }
}

// ============================================================================
// Trace Artifact Redaction Utilities
// ============================================================================

export interface TraceRedactionOptions {
  headersToRedact?: readonly string[] | undefined;
  queryParamKeysToRedact?: readonly string[] | undefined;
  redactPii?: boolean | undefined;
}

const DEFAULT_SENSITIVE_HEADERS = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'apikey',
  'token',
  'secret',
] as const;

const DEFAULT_SENSITIVE_PARAMS = [
  'token',
  'secret',
  'key',
  'auth',
  'access_token',
  'refresh_token',
  'code',
  'session',
  'password',
  'signature',
] as const;

export function redactTraceHeaders(
  headers: Record<string, string>,
  options?: TraceRedactionOptions,
): Record<string, string> {
  const sensitiveHeaders = options?.headersToRedact ?? DEFAULT_SENSITIVE_HEADERS;
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (sensitiveHeaders.some((s) => lower === s || lower.includes(s))) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function redactTraceUrl(urlString: string, options?: TraceRedactionOptions): string {
  try {
    const url = new URL(urlString);
    const sensitiveParams = options?.queryParamKeysToRedact ?? DEFAULT_SENSITIVE_PARAMS;
    let modified = false;

    for (const key of Array.from(url.searchParams.keys())) {
      const lower = key.toLowerCase();
      if (sensitiveParams.some((s) => lower === s || lower.includes(s))) {
        url.searchParams.set(key, '[REDACTED]');
        modified = true;
      }
    }

    return modified ? url.toString() : urlString;
  } catch {
    return urlString;
  }
}

export function redactTraceData<T>(data: T, options?: TraceRedactionOptions): T {
  if (data === null || data === undefined) {
    return data;
  }

  if (typeof data === 'string') {
    let result = redactTraceUrl(data, options);
    // Redact Bearer tokens and GitHub PATs from arbitrary string output
    result = result.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    result = result.replace(/ghp_[A-Za-z0-9]{36,}/g, 'ghp_[REDACTED]');
    result = result.replace(/github_pat_[A-Za-z0-9_]{50,}/g, 'github_pat_[REDACTED]');
    return result as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactTraceData(item, options)) as unknown as T;
  }

  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
      const lowerKey = k.toLowerCase();

      if (lowerKey === 'headers' && v && typeof v === 'object' && !Array.isArray(v)) {
        sanitized[k] = redactTraceHeaders(v as Record<string, string>, options);
      } else if (
        DEFAULT_SENSITIVE_HEADERS.some((s) => lowerKey === s || lowerKey.includes(s)) ||
        DEFAULT_SENSITIVE_PARAMS.some((s) => lowerKey === s || lowerKey.includes(s)) ||
        options?.headersToRedact?.some(
          (s) => lowerKey === s.toLowerCase() || lowerKey.includes(s.toLowerCase()),
        ) ||
        options?.queryParamKeysToRedact?.some(
          (s) => lowerKey === s.toLowerCase() || lowerKey.includes(s.toLowerCase()),
        )
      ) {
        sanitized[k] = '[REDACTED]';
      } else {
        sanitized[k] = redactTraceData(v, options);
      }
    }

    return sanitized as T;
  }

  return data;
}

// ============================================================================
// Non-JS Fetch Fallback Verification Helper
// ============================================================================

export interface NonJsFetchVerificationResult {
  readonly requiresJavascript: boolean;
  readonly status: number;
  readonly byteLength: number;
  readonly fallbackPossible: boolean;
  readonly reason: string;
}

export async function verifyNonJsFetchRequiresJavascript(
  fetchFn: typeof fetch = globalThis.fetch,
  url: string = DEFAULT_ORIGIN_TRIALS_URL,
): Promise<NonJsFetchVerificationResult> {
  const response = await fetchFn(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  const text = await response.text();
  const byteLength = Buffer.byteLength(text, 'utf8');
  const hasJsRequirement =
    /requires Javascript/i.test(text) ||
    /<noscript>/i.test(text) ||
    /enable JavaScript/i.test(text) ||
    (byteLength < 5000 && !/<article/i.test(text) && !/trial/i.test(text));

  return {
    requiresJavascript: hasJsRequirement,
    status: response.status,
    byteLength,
    fallbackPossible: !hasJsRequirement && text.includes('trial-card'),
    reason: hasJsRequirement
      ? 'HTML response requires JavaScript execution to render client-side origin trials dashboard. Plain HTTP fetch fallback is not possible.'
      : 'Page rendered static content without JavaScript requirement.',
  };
}

// ============================================================================
// Chrome Origin Trials Playwright Collector
// ============================================================================

export class ChromeOriginTrialsCollector extends BaseCollector implements CollectorPort {
  readonly sourceKey = 'chrome_origin_trials' as const;
  readonly policy: SourcePolicy = SOURCE_POLICIES.chrome_origin_trials;

  private readonly config: ChromeOriginTrialsConfig;
  private readonly injectedBrowser: PlaywrightBrowser | undefined;
  private readonly browserFactory: (() => Promise<PlaywrightBrowser>) | undefined;
  private readonly contextFactory: (() => Promise<PlaywrightBrowserContext>) | undefined;
  private readonly pageFactory: (() => Promise<PlaywrightPage>) | undefined;
  private readonly tracingConfig: ChromeOriginTrialsTracingConfig | undefined;

  constructor(options?: ChromeOriginTrialsCollectorOptions) {
    super(options?.guard ?? new DefaultPolicyGuard());
    this.config = options?.config ?? {};
    this.injectedBrowser = options?.browser;
    this.browserFactory = options?.browserFactory;
    this.contextFactory = options?.contextFactory;
    this.pageFactory = options?.pageFactory;
    this.tracingConfig = options?.tracing;
  }

  async collect(context: CollectionContext): Promise<CollectionResult> {
    const startedAt = Date.now();
    const targetUrl = this.config.url ?? DEFAULT_ORIGIN_TRIALS_URL;

    // 1. Enforce URL policy (THR-001 SSRF & scheme check)
    const urlValidation = this.guard.validateUrl(targetUrl, this.policy);
    if (!urlValidation.valid) {
      throw new OriginTrialsSecurityError(
        `Target URL violates security policy: ${urlValidation.reason}`,
        'INVALID_TARGET_URL',
      );
    }

    if (context.signal?.aborted) {
      throw new Error('Collection aborted by signal');
    }

    let browserContext: PlaywrightBrowserContext | null = null;
    let createdBrowser: PlaywrightBrowser | null = null;
    let page: PlaywrightPage | null = null;
    let shouldCloseContext = false;
    let shouldCloseBrowser = false;

    // Security metrics & counters
    let disallowedHostAbortedCount = 0;
    let popupInterceptedCount = 0;
    let downloadBlockedCount = 0;
    let totalBytesFetched = 0;

    try {
      // 2. Obtain Page / Context / Browser lifecycle via injection
      if (this.pageFactory) {
        page = await this.pageFactory();
      } else {
        if (this.contextFactory) {
          browserContext = await this.contextFactory();
          shouldCloseContext = true;
        } else if (this.browserFactory) {
          createdBrowser = await this.browserFactory();
          browserContext = await createdBrowser.newContext({ acceptDownloads: false });
          shouldCloseContext = true;
          shouldCloseBrowser = true;
        } else if (this.injectedBrowser) {
          browserContext = await this.injectedBrowser.newContext({ acceptDownloads: false });
          shouldCloseContext = true;
        } else {
          throw new OriginTrialsCollectorError(
            'No browser, context, or page factory provided to ChromeOriginTrialsCollector. Browser lifecycle must be injected.',
            'BROWSER_NOT_CONFIGURED',
          );
        }

        // 3. Configure browser security policies on context
        // Host allowlist route filter (THR-001 & SECURITY §4.2)
        await browserContext.route('**/*', async (route) => {
          const reqUrl = route.request().url();
          const validation = this.guard.validateUrl(reqUrl, this.policy);
          if (!validation.valid) {
            disallowedHostAbortedCount++;
            await route.abort('blockedbyclient');
          } else {
            await route.continue();
          }
        });

        // Start tracing if configured
        if (this.tracingConfig?.enabled && browserContext.tracing) {
          await browserContext.tracing.start({
            screenshots: this.tracingConfig.screenshots ?? false,
            snapshots: this.tracingConfig.snapshots ?? true,
            sources: false,
          });
        }

        page = await browserContext.newPage();
      }

      // 4. Attach page-level security interceptors (THR-002: download/popup block)
      page.on('popup', async (popup) => {
        popupInterceptedCount++;
        await popup.close().catch(() => {});
      });

      page.on('download', async (download) => {
        downloadBlockedCount++;
        await download.cancel?.().catch(() => {});
      });

      // 5. Navigate to origin trials page
      const timeoutMs = this.config.timeoutMs ?? 30000;
      const response = await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // 6. Verify response status & final URL redirect security
      const finalUrl = page.url();
      const redirectValidation = this.guard.validateUrl(finalUrl, this.policy);
      if (!redirectValidation.valid) {
        throw new OriginTrialsSecurityError(
          `Redirected URL violates security policy: ${redirectValidation.reason} (${finalUrl})`,
          'ILLEGAL_REDIRECT',
        );
      }

      if (response) {
        const status = response.status();
        if (status >= 400) {
          throw new OriginTrialsCollectorError(
            `HTTP ${status} response received for ${targetUrl}`,
            'HTTP_ERROR',
          );
        }
        if (response.body) {
          const bodyBuf = await response.body().catch(() => Buffer.alloc(0));
          totalBytesFetched = bodyBuf.length;
        }
      }

      // Check page content size limit
      const htmlContent = await page.content().catch(() => '');
      if (totalBytesFetched === 0 && htmlContent) {
        totalBytesFetched = Buffer.byteLength(htmlContent, 'utf8');
      }

      if (totalBytesFetched > this.policy.maxSizeBytes) {
        throw new OriginTrialsSecurityError(
          `Payload size ${totalBytesFetched} exceeds max allowed ${this.policy.maxSizeBytes}`,
          'PAYLOAD_TOO_LARGE',
        );
      }

      // 7. Security check: Abort on login or CAPTCHA challenge (Strictly no bypass)
      await this.assertNoLoginOrCaptcha(page);

      // 8. Extract trial entries using semantic locators
      const extractedTrials = await this.extractTrials(page, targetUrl);

      // 9. Transform into validated CollectedRawItems
      const items: CollectedRawItem[] = [];
      const cursorData: ChromeOriginTrialsCursor =
        decodeOpaqueCursor<ChromeOriginTrialsCursor>(context.cursor ?? '') ?? {};

      for (const trial of extractedTrials) {
        // Deterministic external ID: stable trial ID if present, otherwise sha256 hash of name
        const externalId = trial.id
          ? `chrome-origin-trial-${trial.id}`
          : `chrome-origin-trial-${createHash('sha256')
              .update(trial.name.trim().toLowerCase())
              .digest('hex')
              .slice(0, 16)}`;

        // Filter if max items or specific status requested
        if (
          this.config.filterStatus &&
          trial.status.toLowerCase() !== this.config.filterStatus.toLowerCase()
        ) {
          continue;
        }

        // publishedAt is strictly NULL per SOURCE_CATALOG §8 and EXP-001
        const publishedAt: Date | null = null;

        const metadata: Record<string, unknown> = {
          source: 'chrome_origin_trials',
          canonicalUrl: trial.originTrialUrl || targetUrl,
          license: CHROME_ORIGIN_TRIALS_LICENSE,
          collectedAt: new Date().toISOString(),
          extractor: 'playwright',
          security: {
            disallowedHostsAborted: disallowedHostAbortedCount,
            popupsBlocked: popupInterceptedCount,
            downloadsBlocked: downloadBlockedCount,
          },
        };

        const rawItem = this.createRawItem({
          externalId,
          payload: trial,
          publishedAt,
          cursor: context.cursor,
          metadata,
        });

        items.push(rawItem);

        if (this.config.maxItems && items.length >= this.config.maxItems) {
          break;
        }
      }

      // Generate next cursor
      const lastItem = items.length > 0 ? items[items.length - 1] : undefined;
      const nextCursorPayload: ChromeOriginTrialsCursor = {
        ...(lastItem ? { lastCollectedId: lastItem.externalId } : {}),
        totalCollected: (cursorData.totalCollected ?? 0) + items.length,
        collectedAt: new Date().toISOString(),
        snapshotHash: createHash('sha256')
          .update(items.map((i) => i.rawHash).join(':'))
          .digest('hex'),
      };
      const nextCursor = items.length > 0 ? encodeOpaqueCursor(nextCursorPayload) : null;

      // 10. Stop tracing if enabled
      if (this.tracingConfig?.enabled && browserContext?.tracing) {
        const tracePath = this.tracingConfig.path;
        await browserContext.tracing.stop(tracePath ? { path: tracePath } : {});
      }

      return {
        sourceKey: 'chrome_origin_trials',
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
      // 11. Clean up resources
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
   * Throws LoginOrCaptchaDetectedError if any challenge is observed.
   */
  private async assertNoLoginOrCaptcha(page: PlaywrightPage): Promise<void> {
    // 1. Password input detection
    try {
      const passwordInputs = page.locator('input[type="password"]');
      const count = await passwordInputs.count();
      if (count > 0) {
        throw new LoginOrCaptchaDetectedError('password_input_field');
      }
    } catch (e) {
      if (e instanceof LoginOrCaptchaDetectedError) throw e;
    }

    // 2. CAPTCHA / bot challenge iframe or class detection
    try {
      const captchaElements = page.locator(
        'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]',
      );
      const count = await captchaElements.count();
      if (count > 0) {
        throw new LoginOrCaptchaDetectedError('captcha_widget');
      }
    } catch (e) {
      if (e instanceof LoginOrCaptchaDetectedError) throw e;
    }

    // 3. Semantic heading inspection for login / sign-in requirement
    try {
      const loginHeadings = page.getByRole('heading', {
        name: /sign in|log in|verify you are human|solve challenge/i,
      });
      const count = await loginHeadings.count();
      if (count > 0) {
        throw new LoginOrCaptchaDetectedError('login_or_challenge_heading');
      }
    } catch (e) {
      if (e instanceof LoginOrCaptchaDetectedError) throw e;
    }
  }

  /**
   * Extracts Origin Trial cards using semantic locators (getByRole('article'), getByRole('heading'), etc.).
   */
  private async extractTrials(
    page: PlaywrightPage,
    baseUrl: string,
  ): Promise<ChromeOriginTrialPayload[]> {
    const trials: ChromeOriginTrialPayload[] = [];

    // Attempt 1: Locate via semantic role 'article'
    let cardLocators = await page.getByRole('article').all();

    // Fallback attempt: if no articles, check listitems or sections or cards
    if (cardLocators.length === 0) {
      const listItems = await page.getByRole('listitem').all();
      if (listItems.length > 0) {
        cardLocators = listItems;
      } else {
        cardLocators = await page.locator('.trial-card, [data-trial-id], section.trial').all();
      }
    }

    for (const card of cardLocators) {
      // 1. Extract trial name via semantic heading
      let name = '';
      try {
        const heading = card.getByRole('heading');
        const count = await heading.count();
        if (count > 0) {
          name = (await heading.first().innerText()).trim();
        }
      } catch {
        // fallback
      }

      if (!name) {
        try {
          const titleElem = card.locator('h1, h2, h3, h4, .trial-name, [data-trial-name]').first();
          if ((await titleElem.count()) > 0) {
            name = (await titleElem.innerText()).trim();
          }
        } catch {
          // ignore
        }
      }

      if (!name) {
        continue; // Skip card without identifiable name
      }

      // 2. Extract description
      let description = '';
      try {
        const pLoc = card.locator('p, .description, [data-description]').first();
        if ((await pLoc.count()) > 0) {
          description = (await pLoc.innerText()).trim();
        }
      } catch {
        // ignore
      }

      // 3. Extract status
      let status = 'Active';
      try {
        const dataStatus = await card.getAttribute('data-status');
        if (dataStatus) {
          status = dataStatus.trim();
        } else {
          const statusLoc = card.locator('.status, .badge, .trial-status').first();
          if ((await statusLoc.count()) > 0) {
            status = (await statusLoc.innerText()).trim();
          } else {
            // Check text patterns for status
            const cardText = await card.innerText();
            if (/deprecated/i.test(cardText)) status = 'Deprecated';
            else if (/completed|ended|closed/i.test(cardText)) status = 'Completed';
            else if (/upcoming/i.test(cardText)) status = 'Upcoming';
          }
        }

        if (status.length > 50 || status.includes('\n')) {
          const match = status.match(/Active|Deprecated|Completed|Upcoming|Ended|Closed/i);
          if (match) {
            status = match[0]!;
          }
        }
      } catch {
        // default to Active
      }

      // 4. Extract milestone information
      let milestones: ChromeOriginTrialMilestones | null = null;
      try {
        const milestoneLoc = card.locator('.milestones, [data-milestone], .duration').first();
        let rawMilestoneText = '';
        if ((await milestoneLoc.count()) > 0) {
          rawMilestoneText = (await milestoneLoc.innerText()).trim();
        } else {
          const cardText = await card.innerText();
          const match = cardText.match(/Chrome\s+(\d+)\s*(?:to|-)\s*(\d+)/i);
          if (match) {
            rawMilestoneText = match[0];
          }
        }

        if (rawMilestoneText) {
          const match = rawMilestoneText.match(/(\d+)\s*(?:to|-)\s*(\d+)/);
          milestones = {
            start: match ? Number(match[1]) : null,
            end: match ? Number(match[2]) : null,
            rawText: rawMilestoneText,
          };
        }
      } catch {
        // ignore
      }

      // 5. Extract links (canonical trial url, docs, feedback, chromestatus, standards)
      let trialId = '';
      let originTrialUrl = '';
      let documentationUrl: string | null = null;
      let feedbackUrl: string | null = null;
      let intentToTrialUrl: string | null = null;
      let chromeStatusUrl: string | null = null;
      let standardsUrl: string | null = null;

      try {
        const dataId = await card.getAttribute('data-trial-id');
        if (dataId) trialId = dataId;
      } catch {
        // ignore
      }

      try {
        const links = await card.locator('a').all();
        for (const link of links) {
          const href = (await link.getAttribute('href')) || '';
          const linkText = (await link.innerText().catch(() => '')).toLowerCase();

          if (href.includes('#/view_trial/') || href.includes('origintrials/#/')) {
            originTrialUrl = this.resolveUrl(href, baseUrl);
            const idMatch = href.match(/view_trial\/([^/?#]+)/);
            if (idMatch && !trialId) {
              trialId = idMatch[1]!;
            }
          } else if (
            /doc|guide|spec/i.test(linkText) ||
            href.includes('developer.chrome.com/docs')
          ) {
            documentationUrl = this.resolveUrl(href, baseUrl);
          } else if (
            /feedback|issue|bug/i.test(linkText) ||
            href.includes('issues.chromium.org') ||
            href.includes('crbug.com')
          ) {
            feedbackUrl = this.resolveUrl(href, baseUrl);
          } else if (
            /intent/i.test(linkText) ||
            href.includes('groups.google.com/a/chromium.org')
          ) {
            intentToTrialUrl = this.resolveUrl(href, baseUrl);
          } else if (href.includes('chromestatus.com')) {
            chromeStatusUrl = this.resolveUrl(href, baseUrl);
          } else if (
            /standard|w3c|whatwg/i.test(linkText) ||
            href.includes('w3.org') ||
            href.includes('whatwg.org')
          ) {
            standardsUrl = this.resolveUrl(href, baseUrl);
          }
        }
      } catch {
        // ignore
      }

      if (!originTrialUrl && trialId) {
        originTrialUrl = `https://developer.chrome.com/origintrials/#/view_trial/${trialId}`;
      } else if (!originTrialUrl) {
        originTrialUrl = baseUrl;
      }

      // 6. Extract features list
      const features: string[] = [];
      try {
        const featureItems = await card.locator('.feature, [data-feature], li').all();
        for (const f of featureItems) {
          const text = (await f.innerText()).trim();
          if (text && text.length < 100 && !features.includes(text)) {
            features.push(text);
          }
        }
      } catch {
        // ignore
      }

      // 7. Experiment type
      let experimentType = 'Origin Trial';
      if (/deprecation/i.test(status) || /deprecation/i.test(name)) {
        experimentType = 'Deprecation Trial';
      }

      // Clean all string inputs to ensure strict text-only payload
      trials.push({
        id: trialId || createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 16),
        name: this.sanitizeText(name),
        description: this.sanitizeText(description),
        status: this.sanitizeText(status),
        milestones,
        originTrialUrl,
        documentationUrl,
        feedbackUrl,
        intentToTrialUrl,
        chromeStatusUrl,
        standardsUrl,
        experimentType,
        features: features.map((f) => this.sanitizeText(f)),
      });
    }

    return trials;
  }

  private resolveUrl(href: string, baseUrl: string): string {
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href;
    }
  }

  private sanitizeText(text: string): string {
    return text
      .replace(/<[^>]*>/g, '') // strip HTML tags
      .replace(/\s+/g, ' ')
      .trim();
  }
}

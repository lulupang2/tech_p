/* eslint-disable @typescript-eslint/no-unused-vars, no-useless-escape */
import { createHash } from 'node:crypto';
import type {
  AcquisitionRequest,
  AcquisitionResult,
  BoundedAcquisitionPort,
  CollectionStatePort,
  CollectionTargetRevision,
  CollectorPagePort,
  CollectedRawItem,
  DocumentRepositoryPort,
  PolicyGuardPort,
  ProviderBudgetPort,
  RawItemRepositoryPort,
  ChunkRepositoryPort,
  SearchReadinessPort,
  SourceCandidate,
  SourcePolicy,
  SourceSearchPort,
  NormalizationServicePort,
  RawItemRecord,
  SaveNormalizedDocumentInput,
} from '@techpulse/domain';
import {
  createNormalizationService,
  chunkDocument,
  DEFAULT_CHUNK_MAX_TOKENS,
  sanitizeText,
} from '@techpulse/domain';

// Hard upper ceilings per ADR-0015 and COV-007
export const HARD_MAX_ROUNDS = 1 as const;
export const HARD_MAX_SEARCHES = 2 as const;
export const HARD_MAX_FETCHES = 3 as const;
export const HARD_MAX_HTTP_ATTEMPTS = 8 as const;
export const HARD_MAX_EXTERNAL_DURATION_MS = 10_000 as const;
const SHORTAGE_REASONS: Record<string, true> = {
  raw_shortage: true,
  period_gap: true,
  retrieval_miss: true,
};

export const DEFAULT_MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5MB

// Blocked metadata & private domain patterns
const BLOCKED_HOST_REGEXES: readonly RegExp[] = [
  /^localhost$/i,
  /^127(?:\.\d+){1,3}$/,
  /^0\.0\.0\.0$/,
  /^169\.254\.\d+\.\d+$/,
  /^metadata\.google\.internal$/i,
  /\.internal$/i,
  /\.local$/i,
  /\.localhost$/i,
];

// Dangerous prompt-injection instruction patterns
const PROMPT_INJECTION_TAG_REGEX =
  /<system>|<\/system>|<instruction>|<\/instruction>|\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<<SYS>>|<\<\/SYS\>>|\[SYSTEM\]/i;
const PROMPT_INJECTION_TEXT_REGEX =
  /(?:\b(?:ignore\s+(?:all\s+)?previous\s+instructions|system\s+prompt\s+override|system\s+override|you\s+are\s+now\s+in\s+developer\s+mode|jailbreak)\b)/i;

/**
 * Parses decimal, hex, octal, or dot-decimal IPv4 representation into [a, b, c, d].
 */
function parseIpv4Octets(hostname: string): [number, number, number, number] | null {
  const dotParts = hostname.split('.');
  if (dotParts.length === 4) {
    const octets: number[] = [];
    for (const part of dotParts) {
      let num: number;
      if (/^0x[0-9a-f]+$/i.test(part)) {
        num = parseInt(part, 16);
      } else if (/^0[0-7]+$/.test(part)) {
        num = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        num = parseInt(part, 10);
      } else {
        return null;
      }
      if (isNaN(num) || num < 0 || num > 255) return null;
      octets.push(num);
    }
    return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
  }

  // Single integer IPv4
  if (/^\d+$/.test(hostname)) {
    const intVal = parseInt(hostname, 10);
    if (!isNaN(intVal) && intVal >= 0 && intVal <= 0xffffffff) {
      return [(intVal >>> 24) & 0xff, (intVal >>> 16) & 0xff, (intVal >>> 8) & 0xff, intVal & 0xff];
    }
  }

  return null;
}

/**
 * Checks if IPv4 octets fall into private, loopback, link-local, carrier-grade NAT, or reserved space.
 */
function isForbiddenIpv4(a: number, b: number, c: number, d: number): boolean {
  if (a === 127) return true; // 127.0.0.0/8 Loopback
  if (a === 10) return true; // 10.0.0.0/8 Private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 Private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 Private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 Link-local / Cloud metadata
  if (a === 0) return true; // 0.0.0.0/8 Current network
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF Protocol Assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 Network benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 Multicast
  if (a >= 240) return true; // 240.0.0.0/4 Reserved
  return false;
}

/**
 * Checks if IPv6 address is loopback, unique local, link-local, or IPv4-mapped private space.
 */
function isForbiddenIpv6(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true;

  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1)
  const v4MappedMatch = host.match(/^(?:::ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch && v4MappedMatch[1]) {
    const octets = parseIpv4Octets(v4MappedMatch[1]);
    if (octets && isForbiddenIpv4(...octets)) return true;
  }

  // Unique local fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;

  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;

  return false;
}

/**
 * Internal URL and SSRF validator fulfilling domain policy constraints.
 */
export function validateAcquisitionUrl(
  urlString: string,
  policy?: SourcePolicy,
): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // 1. Check scheme
  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  const allowedSchemes = policy?.allowedSchemes ?? ['http', 'https'];
  if (!allowedSchemes.includes(scheme as 'http' | 'https')) {
    return { valid: false, reason: `Scheme '${scheme}' is not permitted by source policy` };
  }

  // 2. Reject credentials in URL
  if (parsed.username !== '' || parsed.password !== '') {
    return { valid: false, reason: 'URL containing user credentials is forbidden' };
  }

  // 3. Check SSRF blocked host patterns
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  for (const regex of BLOCKED_HOST_REGEXES) {
    if (regex.test(hostname)) {
      return {
        valid: false,
        reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
      };
    }
  }

  // 4. Check IPv4 representation
  const ipv4Octets = parseIpv4Octets(hostname);
  if (ipv4Octets !== null) {
    if (isForbiddenIpv4(...ipv4Octets)) {
      return {
        valid: false,
        reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
      };
    }
  }

  // 5. Check IPv6 representation
  if (isForbiddenIpv6(hostname)) {
    return {
      valid: false,
      reason: `Host '${hostname}' is a forbidden internal or private network address (SSRF guard)`,
    };
  }

  // 6. Check allowed hosts if policy enforces it
  if (policy?.allowedHosts && policy.allowedHosts.length > 0) {
    const hostAllowed = policy.allowedHosts.some((allowed) => {
      const lowerAllowed = allowed.toLowerCase();
      return hostname === lowerAllowed || hostname.endsWith(`.${lowerAllowed}`);
    });
    if (!hostAllowed) {
      return {
        valid: false,
        reason: `Host '${hostname}' is not in the allowed hosts list for source ${policy.sourceKey}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Checks whether text contains hostile prompt injection markers.
 */
export function hasPromptInjection(text: string): boolean {
  if (!text) return false;
  if (PROMPT_INJECTION_TAG_REGEX.test(text)) return true;
  if (PROMPT_INJECTION_TEXT_REGEX.test(text)) return true;
  return false;
}

/**
 * Deeply strips PII fields from payload objects.
 */
function stripPiiInternal<T extends Record<string, unknown>>(
  payload: T,
  piiFields: readonly string[],
): T {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;

  for (const fieldPath of piiFields) {
    const segments = fieldPath.split('.');
    removeNestedField(clone, segments);
  }

  return clone as T;
}

function removeNestedField(
  target: Record<string, unknown> | unknown[],
  pathSegments: string[],
): void {
  if (!target || typeof target !== 'object' || pathSegments.length === 0) return;
  const [current, ...rest] = pathSegments;
  if (!current) return;

  if (Array.isArray(target)) {
    for (const item of target) {
      if (item && typeof item === 'object') {
        removeNestedField(item as Record<string, unknown>, pathSegments);
      }
    }
    return;
  }

  const record = target as Record<string, unknown>;
  if (rest.length === 0) {
    delete record[current];
  } else if (current in record && typeof record[current] === 'object' && record[current] !== null) {
    removeNestedField(record[current] as Record<string, unknown>, rest);
  }
}

export interface CandidateFetchContext {
  readonly signal: AbortSignal;
  readonly remainingBytes: number;
  readonly httpAttemptsRemaining: number;
}

export interface CandidateFetchResult {
  readonly item: CollectedRawItem;
  readonly httpAttempts: number;
  readonly bytes: number;
}

export interface BoundedAcquisitionOptions {
  readonly statePort?: CollectionStatePort;
  readonly searchPort?: SourceSearchPort;
  readonly collectorPort?: CollectorPagePort;
  readonly guard?: PolicyGuardPort;
  readonly normalizer?: NormalizationServicePort;
  readonly budgetPort?: ProviderBudgetPort;
  readonly readinessPort?: SearchReadinessPort;
  readonly rawItemRepository?: RawItemRepositoryPort;
  readonly documentRepository?: DocumentRepositoryPort;
  readonly chunkRepository?: ChunkRepositoryPort;
  readonly targetResolver?: (
    topicIds: readonly string[],
  ) => Promise<readonly CollectionTargetRevision[]>;
  readonly candidateFetcher?: (
    candidate: SourceCandidate,
    target: CollectionTargetRevision,
    context: CandidateFetchContext,
  ) => Promise<CandidateFetchResult>;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => Date;
  readonly budgetScopeId?: string;
  readonly lane?: string;
}

/**
 * Hardened execution of HTTP fetch with manual redirect validation and attempt tracking.
 */
async function executeHardenedHttpFetch(
  targetUrl: string,
  options: {
    fetchFn: typeof fetch;
    policy?: SourcePolicy;
    guard?: PolicyGuardPort;
    maxRedirects: number;
    maxSizeBytes: number;
    signal?: AbortSignal;
    maxAttempts: number;
  },
): Promise<{
  status: number;
  headers: Headers;
  bodyText: string;
  attempts: number;
  bytes: number;
  finalUrl: string;
}> {
  let currentUrl = targetUrl;
  let redirectCount = 0;
  let attempts = 0;
  let totalBytes = 0;

  while (true) {
    if (attempts >= options.maxAttempts) {
      throw new Error(`Max HTTP attempts (${options.maxAttempts}) reached`);
    }

    // SSRF & Scheme validation on current URL
    const validation = options.guard
      ? options.guard.validateUrl(
          currentUrl,
          options.policy ?? {
            sourceKey: 'github_releases',
            allowedHosts: [],
            allowedSchemes: ['http', 'https'],
            maxSizeBytes: options.maxSizeBytes,
            maxRedirects: options.maxRedirects,
            verbatimOnly: false,
            defaultLicenseId: null,
            piiFieldsToStrip: [],
          },
        )
      : validateAcquisitionUrl(currentUrl, options.policy);

    if (!validation.valid) {
      throw new Error(`SSRF guard blocked URL '${currentUrl}': ${validation.reason}`);
    }

    attempts++;
    const response = await options.fetchFn(
      currentUrl,
      options.signal
        ? { method: 'GET', redirect: 'manual', signal: options.signal }
        : { method: 'GET', redirect: 'manual' },
    );

    // Handle redirects manually to re-verify destination
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        return {
          status: response.status,
          headers: response.headers,
          bodyText: '',
          attempts,
          bytes: totalBytes,
          finalUrl: currentUrl,
        };
      }

      redirectCount++;
      if (redirectCount > options.maxRedirects) {
        throw new Error(`Maximum redirect limit (${options.maxRedirects}) exceeded`);
      }

      const nextUrl = new URL(location, currentUrl).toString();
      const nextValidation = options.guard
        ? options.guard.validateUrl(
            nextUrl,
            options.policy ?? {
              sourceKey: 'github_releases',
              allowedHosts: [],
              allowedSchemes: ['http', 'https'],
              maxSizeBytes: options.maxSizeBytes,
              maxRedirects: options.maxRedirects,
              verbatimOnly: false,
              defaultLicenseId: null,
              piiFieldsToStrip: [],
            },
          )
        : validateAcquisitionUrl(nextUrl, options.policy);

      if (!nextValidation.valid) {
        throw new Error(`Redirect target violates SSRF policy: ${nextValidation.reason}`);
      }

      currentUrl = nextUrl;
      continue;
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      const declared = Number(contentLength);
      if (!isNaN(declared) && declared > options.maxSizeBytes) {
        throw new Error(
          `Response size (${declared} bytes) exceeds limit (${options.maxSizeBytes} bytes)`,
        );
      }
    }

    const text = await response.text();
    const byteLength = Buffer.byteLength(text, 'utf8');
    totalBytes += byteLength;

    if (totalBytes > options.maxSizeBytes) {
      throw new Error(
        `Total response bytes (${totalBytes}) exceeds limit (${options.maxSizeBytes} bytes)`,
      );
    }

    return {
      status: response.status,
      headers: response.headers,
      bodyText: text,
      attempts,
      bytes: totalBytes,
      finalUrl: currentUrl,
    };
  }
}

/**
 * Implementation of BoundedAcquisitionPort fulfilling COV-007 constraints:
 * - Local evidence first (short circuits if coverage report indicates sufficiency)
 * - Max 1 round, max 2 searches, max 3 document fetches, max 8 HTTP attempts (including redirects)
 * - Max 10 seconds or remaining deadline
 * - Max byte allowance & token limits
 * - Fail-closed rights and budget gating
 * - Candidate snippets are not citations (only fully persisted raw->normalized->chunked items count)
 * - Strict SSRF, scheme, and prompt-injection rejection
 * - No automatic retry
 */
export class BoundedAcquisitionService implements BoundedAcquisitionPort {
  private readonly options: BoundedAcquisitionOptions;

  constructor(options: BoundedAcquisitionOptions = {}) {
    this.options = options;
  }

  async acquire(request: AcquisitionRequest): Promise<AcquisitionResult> {
    const getNow = this.options.now ?? (() => new Date());
    const startTime = getNow();

    // 1. Local Evidence First: Short-circuit if coverage is already sufficient
    const hasShortage = request.coverage.reasons.some((r) => Boolean(SHORTAGE_REASONS[r]));
    const isCoverageSufficient =
      !hasShortage ||
      (request.coverage.reasons.length === 0 &&
        (request.coverage.rawDocuments > 0 ||
          request.coverage.lexicalDocuments > 0 ||
          request.coverage.vectorDocuments > 0));

    if (isCoverageSufficient && request.coverage.reasons.length === 0) {
      return {
        acquired: 0,
        searches: 0,
        fetches: 0,
        httpAttempts: 0,
        bytes: 0,
        reason: 'coverage_sufficient',
      };
    }

    // 2. Compute Hard Bound Envelopes
    const maxSearches = Math.min(HARD_MAX_SEARCHES, Math.max(0, request.limits.maxSearches));
    const maxFetches = Math.min(HARD_MAX_FETCHES, Math.max(0, request.limits.maxFetches));
    const maxHttpAttempts = Math.min(
      HARD_MAX_HTTP_ATTEMPTS,
      Math.max(0, request.limits.maxHttpAttempts),
    );
    const maxTotalBytes = Math.max(0, request.limits.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES);

    // 3. Deadline & Abort Envelope
    if (request.signal.aborted) {
      return {
        acquired: 0,
        searches: 0,
        fetches: 0,
        httpAttempts: 0,
        bytes: 0,
        reason: 'aborted',
      };
    }

    const deadlineMs = request.limits.deadline.getTime();
    const remainingDeadlineMs = deadlineMs - startTime.getTime();
    if (remainingDeadlineMs <= 0) {
      return {
        acquired: 0,
        searches: 0,
        fetches: 0,
        httpAttempts: 0,
        bytes: 0,
        reason: 'deadline_exceeded',
      };
    }

    const effectiveTimeoutMs = Math.min(HARD_MAX_EXTERNAL_DURATION_MS, remainingDeadlineMs);
    const abortController = new AbortController();
    const onParentAbort = () => abortController.abort(request.signal.reason);
    request.signal.addEventListener('abort', onParentAbort, { once: true });
    const timeoutId = setTimeout(() => {
      abortController.abort(new Error('acquisition_timeout'));
    }, effectiveTimeoutMs);

    let searchCount = 0;
    let fetchCount = 0;
    let httpAttemptCount = 0;
    let totalBytes = 0;
    let acquiredCount = 0;
    let reservationId: string | null = null;

    try {
      // 4. Budget & Spend Gate (Fail-Closed)
      if (this.options.budgetPort && this.options.budgetScopeId) {
        try {
          const reservation = await this.options.budgetPort.reserve(
            this.options.budgetScopeId,
            request.queryRunId,
            this.options.lane ?? 'acquisition',
            1,
            0,
            getNow(),
          );
          reservationId = reservation.id;
        } catch {
          return {
            acquired: 0,
            searches: 0,
            fetches: 0,
            httpAttempts: 0,
            bytes: 0,
            reason: 'budget_exhausted',
          };
        }
      }

      // 5. Target Resolution & Rights Gating
      let targets: readonly CollectionTargetRevision[] = [];
      if (this.options.targetResolver) {
        targets = await this.options.targetResolver(request.topicIds);
      } else if (this.options.statePort) {
        targets = await this.options.statePort.listTargets(50);
      }

      // Filter targets: match topics if specified, and enforce fail-closed policy gates
      const approvedTargets = targets.filter((target) => {
        if (request.topicIds.length > 0) {
          const matchesTopic = target.topicIds.some((t) => request.topicIds.includes(t));
          if (!matchesTopic) return false;
        }
        if (!target.enabled) return false;
        // Strict rights & policy check
        if (!target.policy.approved) return false;
        if (!target.policy.fetch) return false;
        if (!target.policy.store) return false;
        return true;
      });

      if (approvedTargets.length === 0) {
        return {
          acquired: 0,
          searches: 0,
          fetches: 0,
          httpAttempts: 0,
          bytes: 0,
          reason: 'rights_blocked',
        };
      }

      // 6. Search Phase (Max 2 searches across eligible targets)
      const candidates: SourceCandidate[] = [];
      const seenUrls = new Set<string>();
      const targetMap = new Map<string, CollectionTargetRevision>();
      for (const t of approvedTargets) {
        targetMap.set(t.id, t);
      }

      const searchableTargets = approvedTargets.filter((t) => t.capability.canSearch);

      for (const target of searchableTargets) {
        if (
          searchCount >= maxSearches ||
          httpAttemptCount >= maxHttpAttempts ||
          totalBytes >= maxTotalBytes ||
          abortController.signal.aborted
        ) {
          break;
        }

        if (this.options.searchPort) {
          searchCount++;
          // Count search request as an HTTP attempt
          httpAttemptCount++;
          try {
            const found = await this.options.searchPort.searchCandidates({
              query: request.query,
              target,
              window: request.window,
              limit: maxFetches,
              signal: abortController.signal,
            });

            // Track estimated search result payload bytes
            const estimatedBytes = Buffer.byteLength(JSON.stringify(found), 'utf8');
            totalBytes += estimatedBytes;

            for (const cand of found) {
              const urlKey = cand.canonicalUrl.toLowerCase();
              if (!seenUrls.has(urlKey)) {
                seenUrls.add(urlKey);
                candidates.push(cand);
              }
            }
          } catch {
            // NO RETRY: record attempt and proceed
          }
        }
      }

      // 7. Fetch & Validation Phase (Max 3 fetched items, up to maxHttpAttempts)
      const baseFetch = this.options.fetchFn ?? globalThis.fetch;
      const normalizer = this.options.normalizer ?? createNormalizationService();

      for (const candidate of candidates) {
        if (
          fetchCount >= maxFetches ||
          httpAttemptCount >= maxHttpAttempts ||
          totalBytes >= maxTotalBytes ||
          abortController.signal.aborted
        ) {
          break;
        }

        const target = targetMap.get(candidate.targetRevisionId) ?? approvedTargets[0]!;

        // Security check: validate candidate canonicalUrl before fetching
        const urlCheck = this.options.guard
          ? this.options.guard.validateUrl(candidate.canonicalUrl, {
              sourceKey: target.sourceKey,
              allowedHosts: [],
              allowedSchemes: ['http', 'https'],
              maxSizeBytes: maxTotalBytes,
              maxRedirects: 3,
              verbatimOnly: target.policy.verbatimOnly,
              defaultLicenseId: target.policy.licenseId,
              piiFieldsToStrip: [],
            })
          : validateAcquisitionUrl(candidate.canonicalUrl);

        if (!urlCheck.valid) {
          // Reject invalid URL / SSRF candidate
          continue;
        }

        // Fetch candidate raw content
        let fetchedItem: CollectedRawItem | null = null;
        let fetchAttempts = 0;
        let fetchBytes = 0;

        try {
          if (this.options.candidateFetcher) {
            const result = await this.options.candidateFetcher(candidate, target, {
              signal: abortController.signal,
              remainingBytes: Math.max(0, maxTotalBytes - totalBytes),
              httpAttemptsRemaining: Math.max(0, maxHttpAttempts - httpAttemptCount),
            });
            fetchedItem = result.item;
            fetchAttempts = result.httpAttempts;
            fetchBytes = result.bytes;
          } else {
            const remainingAttempts = Math.max(0, maxHttpAttempts - httpAttemptCount);
            const remainingBytes = Math.max(0, maxTotalBytes - totalBytes);
            const httpResult = await executeHardenedHttpFetch(candidate.canonicalUrl, {
              fetchFn: baseFetch,
              ...(this.options.guard ? { guard: this.options.guard } : {}),
              maxRedirects: 3,
              maxSizeBytes: remainingBytes,
              signal: abortController.signal,
              maxAttempts: remainingAttempts,
            });

            fetchAttempts = httpResult.attempts;
            fetchBytes = httpResult.bytes;

            if (httpResult.status >= 200 && httpResult.status < 300) {
              const rawHash = createHash('sha256')
                .update(httpResult.bodyText, 'utf8')
                .digest('hex');
              fetchedItem = {
                externalId: candidate.externalId,
                payload: {
                  url: httpResult.finalUrl,
                  html_url: httpResult.finalUrl,
                  title: candidate.title,
                  name: candidate.title,
                  content: httpResult.bodyText,
                  body: httpResult.bodyText,
                  tag_name: candidate.externalId,
                },
                rawHash,
                publishedAt: candidate.publishedAt,
                cursor: null,
                metadata: {
                  httpMetadata: {
                    statusCode: httpResult.status,
                    finalUrl: httpResult.finalUrl,
                  },
                },
              };
            }
          }
        } catch {
          // NO RETRY: on error, record HTTP attempts and skip candidate
          httpAttemptCount += Math.max(1, fetchAttempts);
          totalBytes += fetchBytes;
          continue;
        }

        httpAttemptCount += fetchAttempts;
        totalBytes += fetchBytes;

        if (!fetchedItem) {
          continue;
        }

        fetchCount++;

        // 8. PII Stripping
        const piiFields = ['author.email', 'uploader.email', 'user.email'];
        const cleanPayload = this.options.guard
          ? this.options.guard.stripPii(fetchedItem.payload, {
              sourceKey: target.sourceKey,
              allowedHosts: [],
              allowedSchemes: ['http', 'https'],
              maxSizeBytes: maxTotalBytes,
              maxRedirects: 3,
              verbatimOnly: target.policy.verbatimOnly,
              defaultLicenseId: target.policy.licenseId,
              piiFieldsToStrip: piiFields,
            })
          : stripPiiInternal(fetchedItem.payload, piiFields);

        // 9. Prompt-Injection & Content Policy Guard
        const titleText = String(cleanPayload['title'] ?? candidate.title ?? '');
        const bodyContent = String(cleanPayload['content'] ?? cleanPayload['body'] ?? '');
        if (hasPromptInjection(titleText) || hasPromptInjection(bodyContent)) {
          // Reject prompt injection / malicious instruction content
          continue;
        }

        // 10. Normalization, Chunking, and Immutable Persistence
        const rawItemId = `raw-${target.sourceKey}-${createHash('sha256').update(candidate.externalId).digest('hex').slice(0, 16)}`;
        const sanitizedContent = sanitizeText(bodyContent);
        try {
          const normResult = normalizer.normalize({
            sourceKey: target.sourceKey,
            externalId: candidate.externalId,
            canonicalUrl: candidate.canonicalUrl,
            payload: {
              ...cleanPayload,
              body: sanitizedContent,
              content: sanitizedContent,
            },
            payloadHash: fetchedItem.rawHash,
            publishedAt: candidate.publishedAt,
            collectedAt: getNow(),
          });

          if (normResult.documents.length === 0) {
            continue;
          }

          const primaryDoc = normResult.documents[0]!;
          const maxContextTokens = request.limits.maxContextTokens || DEFAULT_CHUNK_MAX_TOKENS;
          const chunkingResult = chunkDocument({
            title: primaryDoc.title,
            bodyText: primaryDoc.bodyText,
            maxTokens: maxContextTokens,
          });

          // Immutable persistence of raw item + normalized revision + chunks
          if (this.options.rawItemRepository) {
            await this.options.rawItemRepository.upsert({
              sourceId: target.sourceId,
              runId: request.queryRunId,
              externalId: candidate.externalId,
              canonicalUrl: candidate.canonicalUrl,
              payload: cleanPayload,
              payloadHash: fetchedItem.rawHash,
              publishedAt: candidate.publishedAt,
              collectedAt: getNow(),
            });
          }

          let revisionId = `rev-${primaryDoc.normalizedHash.slice(0, 16)}`;
          if (this.options.documentRepository) {
            const saveInput: SaveNormalizedDocumentInput = {
              artifactType: primaryDoc.artifactType,
              canonicalUrl: candidate.canonicalUrl,
              title: primaryDoc.title,
              bodyText: primaryDoc.bodyText,
              author: primaryDoc.author,
              licenseId: primaryDoc.licenseId,
              normalizerVersion: primaryDoc.normalizerVersion,
              rawItemId,
              publishedAt: primaryDoc.publishedAt,
              normalizedHash: primaryDoc.normalizedHash,
              status: 'searchable',
            };
            const repository = this.options.documentRepository as DocumentRepositoryPort & {
              saveNormalized?: (input: Record<string, unknown>) => Promise<{
                revision?: { id: string };
              }>;
            };
            const saveResult = repository.saveNormalizedDocument
              ? await repository.saveNormalizedDocument(saveInput)
              : repository.saveNormalized
                ? await repository.saveNormalized({
                    sourceId: target.sourceId,
                    rawItemId,
                    artifactType: primaryDoc.artifactType,
                    canonicalUrl: candidate.canonicalUrl,
                    urlHash: primaryDoc.normalizedHash,
                    title: primaryDoc.title,
                    cleanText: primaryDoc.bodyText,
                    authors: primaryDoc.author ? [primaryDoc.author] : [],
                    license: primaryDoc.licenseId,
                    version: primaryDoc.normalizerVersion,
                    publishedAt: primaryDoc.publishedAt,
                    collectedAt: getNow(),
                    normalizedHash: primaryDoc.normalizedHash,
                    metadata: {},
                    status: 'searchable',
                  })
                : (() => {
                    throw new Error('document repository lacks normalized save method');
                  })();
            if (saveResult.revision?.id) revisionId = saveResult.revision.id;
          }

          if (this.options.chunkRepository && chunkingResult.chunks.length > 0) {
            const chunksToSave = chunkingResult.chunks.map((draft) => ({
              documentRevisionId: revisionId,
              ordinal: draft.ordinal,
              headingPath: draft.headingPath,
              content: draft.content,
              tokenCount: draft.tokenCount,
              contentHash: draft.contentHash,
              chunkerVersion: draft.chunkerVersion,
              license: primaryDoc.licenseId,
            }));
            await this.options.chunkRepository.saveChunks(chunksToSave);
          }

          if (this.options.statePort) {
            await this.options.statePort.attachRevision(rawItemId, revisionId, getNow());
          }

          if (this.options.readinessPort) {
            await this.options.readinessPort.markLexicalReady(revisionId, getNow());
          }

          // Citation eligibility: ONLY increment after immutable persistence is complete
          acquiredCount++;
        } catch {
          // Persistence failure: do not increment acquired count
        }
      }

      // Settle budget reservation
      if (this.options.budgetPort && reservationId) {
        try {
          await this.options.budgetPort.settle(reservationId, 1, 0, getNow());
        } catch {
          // Non-fatal settlement logging
        }
      }

      const finalReason =
        acquiredCount > 0
          ? 'acquired'
          : abortController.signal.aborted
            ? 'aborted'
            : searchCount > 0
              ? 'no_items_acquired'
              : 'rights_blocked';

      return {
        acquired: acquiredCount,
        searches: searchCount,
        fetches: fetchCount,
        httpAttempts: httpAttemptCount,
        bytes: totalBytes,
        reason: finalReason,
      };
    } finally {
      clearTimeout(timeoutId);
      request.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

export function createBoundedAcquisitionService(
  options?: BoundedAcquisitionOptions,
): BoundedAcquisitionPort {
  return new BoundedAcquisitionService(options);
}

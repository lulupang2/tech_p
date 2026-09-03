import { createHash } from 'node:crypto';
import type { SourceKey } from './collector.js';
import type { RawItemRecord } from './repository.js';
import { sanitizeHtml, sanitizeText } from './sanitizer.js';

export const NORMALIZER_VERSION = 'v1.0.0' as const;

export type ArtifactType = 'article' | 'release_note' | 'forum_post' | 'qa_post' | 'paper';

export type NormalizedMetricType =
  | 'community_mentions'
  | 'issue_discussion'
  | 'repo_attention'
  | 'source_diversity'
  | 'release_activity'
  | 'paper_activity'
  | 'model_activity'
  | 'package_downloads';

export type DocumentRevisionStatus =
  'pending' | 'processing' | 'searchable' | 'quarantined' | 'tombstoned';

/**
 * Normalized document representation ready for deduplication and persistence.
 */
export interface NormalizedDocument {
  readonly artifactType: ArtifactType;
  readonly canonicalUrl: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly author: string | null;
  readonly language: string;
  readonly publishedAt: Date | null;
  readonly licenseId: string | null;
  readonly normalizedHash: string;
  readonly normalizerVersion: string;
  readonly status: DocumentRevisionStatus;
  readonly rawItemId: string | null;
}

/**
 * Normalized time-series or count metric observation.
 */
export interface NormalizedMetricObservation {
  readonly subjectKey: string;
  readonly metricType: NormalizedMetricType;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly value: number;
  readonly unit: string;
  readonly sourceKey: SourceKey;
  readonly rawItemId: string | null;
  readonly querySignature: string | null;
  readonly isIncomplete: boolean;
}

/**
 * Normalization result containing normalized documents and metric observations.
 */
export interface NormalizationResult {
  readonly sourceKey: SourceKey;
  readonly externalId: string;
  readonly rawItemId: string | null;
  readonly documents: readonly NormalizedDocument[];
  readonly metrics: readonly NormalizedMetricObservation[];
  readonly normalizerVersion: string;
  readonly normalizedAt: Date;
}

/**
 * Inbound raw item input representation accepted by NormalizationServicePort.
 */
export interface RawItemInput {
  readonly id?: string | null;
  readonly sourceId?: string;
  readonly sourceKey?: SourceKey;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly publishedAt?: Date | string | number | null;
  readonly collectedAt?: Date | string | null;
  readonly httpMetadata?: Record<string, unknown>;
  readonly rightsMetadata?: Record<string, unknown>;
}

/**
 * Port contract for the deterministic normalization service.
 */
export interface NormalizationServicePort {
  readonly normalizerVersion: string;
  normalize(rawItem: RawItemRecord | RawItemInput, sourceKeyHint?: SourceKey): NormalizationResult;
  normalizeBatch(
    rawItems: readonly (RawItemRecord | RawItemInput)[],
    sourceKeyHint?: SourceKey,
  ): readonly NormalizationResult[];
  computeNormalizedHash(doc: {
    artifactType: ArtifactType | string;
    canonicalUrl: string | null;
    title: string;
    bodyText: string;
    language: string;
    publishedAt: Date | null;
    licenseId: string | null;
    author: string | null;
  }): string;
}

export interface NormalizationServiceOptions {
  readonly normalizerVersion?: string;
  readonly defaultLanguage?: string;
  readonly relaxedRightsMode?: boolean;
}

/**
 * Deterministically computes a 64-character SHA-256 hex digest for a normalized document.
 */
export function computeNormalizedHash(doc: {
  artifactType: ArtifactType | string;
  canonicalUrl: string | null;
  title: string;
  bodyText: string;
  language: string;
  publishedAt: Date | null;
  licenseId: string | null;
  author: string | null;
}): string {
  const canonical = [
    doc.artifactType,
    doc.canonicalUrl ?? '',
    doc.title.trim(),
    doc.bodyText.trim(),
    doc.language,
    doc.publishedAt ? doc.publishedAt.toISOString() : 'null',
    doc.licenseId ?? 'null',
    doc.author ?? 'null',
  ].join('\n');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Normalizes license strings into standardized slug identifiers (e.g. 'CC BY-SA 4.0' -> 'cc-by-sa-4.0').
 */
export function normalizeLicenseSlug(rawLicense: string | null | undefined): string | null {
  if (!rawLicense || typeof rawLicense !== 'string') {
    return null;
  }

  const trimmed = rawLicense.trim();
  if (trimmed.length === 0) return null;

  const normalized = trimmed
    .toLowerCase()
    .replace(/\s+/gu, '-')
    .replace(/[^a-z0-9.-]/gu, '');

  if (normalized.length === 0) return null;
  return normalized;
}

/**
 * Parses dates strictly into valid UTC Date objects, returning null if unknown, invalid, or ambiguous.
 */
export function parseDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Handle epoch seconds vs epoch milliseconds
    const ms = value < 100_000_000_000 ? value * 1000 : value;
    const date = new Date(ms);
    return isNaN(date.getTime()) ? null : date;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;

    // Check for obvious non-date placeholders
    const lower = trimmed.toLowerCase();
    if (
      lower === 'null' ||
      lower === 'undefined' ||
      lower === 'unknown' ||
      lower === 'ambiguous' ||
      lower === 'n/a' ||
      lower === 'tbd'
    ) {
      return null;
    }

    // Try standard ISO / Date parse
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) {
      return date;
    }

    // Try parsing "Month DD, YYYY" or "Month DDth, YYYY" (e.g., "August 25th, 2026")
    const ordinalCleaned = trimmed.replace(/(\d+)(?:st|nd|rd|th)/giu, '$1');
    const ordinalDate = new Date(ordinalCleaned);
    if (!isNaN(ordinalDate.getTime())) {
      return ordinalDate;
    }
  }

  return null;
}

function extractRepoSubject(
  canonicalUrl: string | null | undefined,
  fallback = 'github_releases',
): string {
  if (!canonicalUrl) return fallback;
  const match = /github\.com\/([^/]+\/[^/]+)/iu.exec(canonicalUrl);
  return match?.[1] ? match[1] : fallback;
}

/**
 * Creates the default deterministic NormalizationService implementation.
 */
export function createNormalizationService(
  options: NormalizationServiceOptions = {},
): NormalizationServicePort {
  const normalizerVersion = options.normalizerVersion ?? NORMALIZER_VERSION;
  const defaultLanguage = options.defaultLanguage ?? 'en';
  const relaxedRightsMode = options.relaxedRightsMode ?? false;
  function resolveSourceKey(
    rawItem: RawItemRecord | RawItemInput,
    sourceKeyHint?: SourceKey,
  ): SourceKey {
    if (sourceKeyHint) return sourceKeyHint;
    if ('sourceKey' in rawItem && typeof rawItem.sourceKey === 'string') {
      return rawItem.sourceKey;
    }
    const url = rawItem.canonicalUrl ?? '';
    if (url.includes('github.com') && url.includes('/releases')) return 'github_releases';
    if (url.includes('stackoverflow.com') || url.includes('stackexchange.com'))
      return 'stack_exchange';
    if (url.includes('users.rust-lang.org')) return 'users_rust_lang';
    if (url.includes('arxiv.org')) return 'arxiv';
    if (url.includes('developer.chrome.com/release-notes')) return 'chrome_release_notes';
    if (url.includes('react.dev/blog')) return 'react_blog';
    if (url.includes('developer.chrome.com/origintrials')) return 'chrome_origin_trials';
    if (url.includes('npmjs.com') || url.includes('registry.npmjs.org')) return 'npm_registry';
    if (url.includes('api.npmjs.org/downloads')) return 'npm_downloads';
    if (url.includes('api.github.com/search')) return 'github_search';
    if (url.includes('huggingface.co')) return 'huggingface_hub';
    return 'github_releases';
  }

  function normalize(
    rawItem: RawItemRecord | RawItemInput,
    sourceKeyHint?: SourceKey,
  ): NormalizationResult {
    const sourceKey = resolveSourceKey(rawItem, sourceKeyHint);
    const externalId = rawItem.externalId;
    const rawItemId = (rawItem as { id?: string | null }).id ?? null;
    const collectedAt = parseDateOrNull(rawItem.collectedAt) ?? new Date();
    const payload = (
      typeof rawItem.payload === 'object' &&
      rawItem.payload !== null &&
      !Array.isArray(rawItem.payload)
        ? rawItem.payload
        : {}
    ) as Record<string, unknown>;

    const documents: NormalizedDocument[] = [];
    const metrics: NormalizedMetricObservation[] = [];

    switch (sourceKey) {
      case 'github_releases': {
        // 1. github_releases: release_note document + release_activity metric
        // Note: created_at is the commit date, published_at is the true release date.
        // If published_at is missing or null, publishedAt MUST be null.
        const tagName = typeof payload['tag_name'] === 'string' ? payload['tag_name'] : '';
        const rawName = typeof payload['name'] === 'string' ? payload['name'] : null;
        const titleText =
          rawName && rawName.trim().length > 0 ? rawName : tagName || `Release ${externalId}`;
        const title = sanitizeText(titleText);

        const rawBody = typeof payload['body'] === 'string' ? payload['body'] : null;
        const bodyText =
          rawBody && rawBody.trim().length > 0
            ? sanitizeHtml(rawBody)
            : `Release ${tagName || externalId}`;

        const rawPub = payload['published_at'] ?? rawItem.publishedAt;
        const publishedAt = parseDateOrNull(rawPub);

        const canonicalUrl =
          typeof payload['html_url'] === 'string' && payload['html_url'].startsWith('http')
            ? payload['html_url']
            : rawItem.canonicalUrl;

        const licenseId = normalizeLicenseSlug(
          (rawItem.rightsMetadata?.['license_id'] as string | undefined) ??
            (payload['license'] as string | undefined) ??
            null,
        );

        const artifactType: ArtifactType = 'release_note';
        const author: string | null = null; // Author PII is strictly stripped per SECURITY.md §8

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });

        const subjectKey = extractRepoSubject(canonicalUrl, 'github_releases');
        const metricDate = publishedAt ?? collectedAt;

        metrics.push({
          subjectKey,
          metricType: 'release_activity',
          windowStart: metricDate,
          windowEnd: metricDate,
          value: 1,
          unit: 'releases',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'stack_exchange': {
        // 2. stack_exchange: qa_post document + community_mentions metric
        const rawTitle =
          typeof payload['title'] === 'string' ? payload['title'] : `Question ${externalId}`;
        const title = sanitizeText(rawTitle);

        const rawBody =
          typeof payload['body'] === 'string'
            ? payload['body']
            : typeof payload['body_markdown'] === 'string'
              ? payload['body_markdown']
              : rawTitle;
        const bodyText = sanitizeHtml(rawBody);

        const creationDateRaw = payload['creation_date'] ?? rawItem.publishedAt;
        const publishedAt = parseDateOrNull(creationDateRaw);

        const canonicalUrl =
          typeof payload['link'] === 'string' && payload['link'].startsWith('http')
            ? payload['link']
            : rawItem.canonicalUrl;

        // License handling per SOURCE_CATALOG.md §3, §14:
        // content_license must be preserved. If missing, licenseId is null.
        const contentLicense =
          typeof payload['content_license'] === 'string' ? payload['content_license'] : null;
        const licenseId = normalizeLicenseSlug(contentLicense);

        // Author attribution allowed only when content_license is present
        let author: string | null = null;
        if (contentLicense && typeof payload['owner'] === 'object' && payload['owner'] !== null) {
          const ownerObj = payload['owner'] as Record<string, unknown>;
          const displayName = ownerObj['display_name'];
          if (typeof displayName === 'string' && displayName.trim().length > 0) {
            author = sanitizeText(displayName);
          }
        }

        const artifactType: ArtifactType = 'qa_post';

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });

        const tags = Array.isArray(payload['tags'])
          ? (payload['tags'] as unknown[]).filter((t): t is string => typeof t === 'string')
          : [];
        const subjectKey = tags[0] ?? 'stack_exchange';
        const metricDate = publishedAt ?? collectedAt;
        const score = typeof payload['score'] === 'number' ? payload['score'] : 1;

        metrics.push({
          subjectKey,
          metricType: 'community_mentions',
          windowStart: metricDate,
          windowEnd: metricDate,
          value: score,
          unit: 'mentions',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'users_rust_lang': {
        // 3. users_rust_lang (Discourse): forum_post document + community_mentions metric
        const rawTitle =
          typeof payload['title'] === 'string' ? payload['title'] : 'Discourse Topic';
        const title = sanitizeText(rawTitle);

        let cookedContent = '';
        const postStream = payload['post_stream'];
        if (
          typeof postStream === 'object' &&
          postStream !== null &&
          Array.isArray((postStream as Record<string, unknown>)['posts'])
        ) {
          const posts = (postStream as Record<string, unknown>)['posts'] as unknown[];
          const firstPost = posts[0];
          if (typeof firstPost === 'object' && firstPost !== null) {
            const postObj = firstPost as Record<string, unknown>;
            cookedContent =
              typeof postObj['cooked'] === 'string'
                ? postObj['cooked']
                : typeof postObj['raw'] === 'string'
                  ? postObj['raw']
                  : '';
          }
        }
        if (!cookedContent) {
          cookedContent =
            typeof payload['cooked'] === 'string'
              ? payload['cooked']
              : typeof payload['raw'] === 'string'
                ? payload['raw']
                : rawTitle;
        }

        const bodyText = sanitizeHtml(cookedContent);

        const createdAtRaw = payload['created_at'] ?? rawItem.publishedAt;
        const publishedAt = parseDateOrNull(createdAtRaw);

        const slug = typeof payload['slug'] === 'string' ? payload['slug'] : '';
        const topicId = payload['id'] ?? externalId;
        const canonicalUrl =
          slug && topicId
            ? `https://users.rust-lang.org/t/${slug}/${topicId}`
            : rawItem.canonicalUrl;

        const licenseCutoff = new Date('2020-07-17T00:00:00.000Z');
        const licenseId =
          relaxedRightsMode || (publishedAt && publishedAt >= licenseCutoff)
            ? 'mit-or-apache-2.0'
            : null;
        const artifactType: ArtifactType = 'forum_post';
        const author: string | null = null; // User PII stripped per SECURITY.md §8

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });

        const postsCount = typeof payload['posts_count'] === 'number' ? payload['posts_count'] : 1;
        const metricDate = publishedAt ?? collectedAt;

        metrics.push({
          subjectKey: 'rust',
          metricType: 'community_mentions',
          windowStart: metricDate,
          windowEnd: metricDate,
          value: postsCount,
          unit: 'posts',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'arxiv': {
        // 4. arxiv: paper document + paper_activity metric
        const rawTitle =
          typeof payload['title'] === 'string' ? payload['title'] : `arXiv Paper ${externalId}`;
        const title = sanitizeText(rawTitle);

        const rawSummary = typeof payload['summary'] === 'string' ? payload['summary'] : '';
        const bodyText = sanitizeText(rawSummary);

        const publishedRaw = payload['published'] ?? rawItem.publishedAt;
        const publishedAt = parseDateOrNull(publishedRaw);

        const canonicalUrl =
          typeof payload['canonical_url'] === 'string'
            ? payload['canonical_url']
            : `http://arxiv.org/abs/${externalId}`;

        // Authors minimal extraction
        let author: string | null = null;
        if (Array.isArray(payload['authors']) && payload['authors'].length > 0) {
          const firstAuthor = payload['authors'][0];
          if (typeof firstAuthor === 'object' && firstAuthor !== null) {
            const authorObj = firstAuthor as Record<string, unknown>;
            if (typeof authorObj['name'] === 'string') {
              author = sanitizeText(authorObj['name']);
            }
          }
        }

        const licenseId = 'cc0-1.0'; // arXiv metadata is CC0 1.0
        const artifactType: ArtifactType = 'paper';

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });

        const categories = Array.isArray(payload['categories']) ? payload['categories'] : [];
        const primaryCat =
          typeof payload['primary_category'] === 'string'
            ? payload['primary_category']
            : typeof categories[0] === 'string'
              ? categories[0]
              : 'cs.AI';
        const metricDate = publishedAt ?? collectedAt;

        metrics.push({
          subjectKey: primaryCat,
          metricType: 'paper_activity',
          windowStart: metricDate,
          windowEnd: metricDate,
          value: 1,
          unit: 'papers',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'chrome_release_notes': {
        // 5. chrome_release_notes: release_note document + release_activity metric
        const version = payload['version'] ?? externalId.replace(/^chrome-release-notes-/u, '');
        const rawTitle =
          typeof payload['title'] === 'string'
            ? payload['title']
            : `Chrome ${version} Release Notes`;
        const title = sanitizeText(rawTitle);

        const rawHtml =
          typeof payload['html'] === 'string'
            ? payload['html']
            : typeof payload['body'] === 'string'
              ? payload['body']
              : typeof payload['content'] === 'string'
                ? payload['content']
                : typeof payload['text'] === 'string'
                  ? payload['text']
                  : '';
        const bodyText = sanitizeHtml(rawHtml);

        const pubRaw =
          payload['published_at'] ?? payload['stable_release_date'] ?? rawItem.publishedAt;
        const publishedAt = parseDateOrNull(pubRaw);

        const canonicalUrl =
          typeof payload['url'] === 'string' && payload['url'].startsWith('http')
            ? payload['url']
            : `https://developer.chrome.com/release-notes/${version}`;

        const licenseId = 'cc-by-4.0';
        const author: string | null = null;
        const artifactType: ArtifactType = 'release_note';

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });

        const metricDate = publishedAt ?? collectedAt;
        metrics.push({
          subjectKey: 'chrome',
          metricType: 'release_activity',
          windowStart: metricDate,
          windowEnd: metricDate,
          value: 1,
          unit: 'releases',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'react_blog': {
        // 6. react_blog: article document
        const rawTitle = typeof payload['title'] === 'string' ? payload['title'] : 'React Blog';
        const title = sanitizeText(rawTitle);

        const rawContent =
          typeof payload['html'] === 'string'
            ? payload['html']
            : typeof payload['body'] === 'string'
              ? payload['body']
              : typeof payload['content'] === 'string'
                ? payload['content']
                : typeof payload['text'] === 'string'
                  ? payload['text']
                  : '';
        const bodyText = sanitizeHtml(rawContent);

        const pubRaw = payload['published_at'] ?? rawItem.publishedAt;
        const publishedAt = parseDateOrNull(pubRaw);

        const canonicalUrl =
          typeof payload['url'] === 'string' && payload['url'].startsWith('http')
            ? payload['url']
            : rawItem.canonicalUrl;

        let author: string | null = null;
        if (typeof payload['author'] === 'string' && payload['author'].trim().length > 0) {
          author = sanitizeText(payload['author']);
        }

        const licenseId = 'cc-by-4.0';
        const artifactType: ArtifactType = 'article';

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });
        break;
      }

      case 'chrome_origin_trials': {
        // 7. chrome_origin_trials: article document with published_at explicitly null
        const displayName =
          typeof payload['displayName'] === 'string'
            ? payload['displayName']
            : typeof payload['name'] === 'string'
              ? payload['name']
              : 'Chrome Origin Trial';
        const title = sanitizeText(displayName);

        const description =
          typeof payload['description'] === 'string' ? sanitizeHtml(payload['description']) : '';
        const startMilestone = payload['startMilestone'] ?? 'N/A';
        const endMilestone = payload['endMilestone'] ?? 'N/A';
        const status = typeof payload['status'] === 'string' ? payload['status'] : 'Active';

        const structuredLines = [
          `Origin Trial: ${title}`,
          `Status: ${status}`,
          `Milestones: Start Chrome ${startMilestone}, End Chrome ${endMilestone}`,
        ];
        if (description) {
          structuredLines.push('', description);
        }

        const bodyText = sanitizeText(structuredLines.join('\n'));

        // Per SOURCE_CATALOG.md §8: Origin trials have milestones, not publication dates. published_at is ALWAYS null.
        const publishedAt: Date | null = null;

        const canonicalUrl = rawItem.canonicalUrl || 'https://developer.chrome.com/origintrials/';
        const licenseId = 'cc-by-4.0';
        const author: string | null = null;
        const artifactType: ArtifactType = 'article';

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });
        break;
      }

      case 'npm_registry': {
        // 8. npm_registry: release_note document + release_activity metric
        const name =
          typeof payload['name'] === 'string'
            ? payload['name']
            : (externalId.split('@')[0] ?? 'package');
        const version =
          typeof payload['version'] === 'string'
            ? payload['version']
            : (externalId.split('@')[1] ?? '0.0.0');
        const title = `${name}@${version}`;

        const rawDesc = typeof payload['description'] === 'string' ? payload['description'] : '';
        const bodyText = sanitizeText(rawDesc || `Release version ${version} of ${name}`);

        let pubDateRaw: unknown = rawItem.publishedAt;
        if (typeof payload['time'] === 'string') {
          pubDateRaw = payload['time'];
        } else if (
          typeof payload['time'] === 'object' &&
          payload['time'] !== null &&
          typeof (payload['time'] as Record<string, unknown>)[version] === 'string'
        ) {
          pubDateRaw = (payload['time'] as Record<string, unknown>)[version];
        }

        const publishedAt = parseDateOrNull(pubDateRaw);
        const canonicalUrl = `https://www.npmjs.com/package/${name}`;
        const licenseId =
          typeof payload['license'] === 'string' ? normalizeLicenseSlug(payload['license']) : null;
        const author: string | null = null; // Email/PII stripped per SECURITY.md §8
        const artifactType: ArtifactType = 'release_note';

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title,
          bodyText,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });

        const metricDate = publishedAt ?? collectedAt;
        metrics.push({
          subjectKey: name,
          metricType: 'release_activity',
          windowStart: metricDate,
          windowEnd: metricDate,
          value: 1,
          unit: 'releases',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'npm_downloads': {
        // 9. npm_downloads: package_downloads metric only (0 documents)
        const packageName =
          typeof payload['package'] === 'string'
            ? payload['package']
            : typeof payload['packageName'] === 'string'
              ? payload['packageName']
              : externalId;

        const downloads = typeof payload['downloads'] === 'number' ? payload['downloads'] : 0;
        const startDate = parseDateOrNull(payload['start']) ?? collectedAt;
        const endDate = parseDateOrNull(payload['end']) ?? collectedAt;

        metrics.push({
          subjectKey: packageName,
          metricType: 'package_downloads',
          windowStart: startDate,
          windowEnd: endDate,
          value: downloads,
          unit: 'downloads',
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });
        break;
      }

      case 'github_search': {
        // 10. github_search: repo_attention or issue_discussion metric
        const searchType = typeof payload['type'] === 'string' ? payload['type'] : 'repositories';
        const metricType: NormalizedMetricType =
          searchType === 'issues' ? 'issue_discussion' : 'repo_attention';

        const query = typeof payload['query'] === 'string' ? payload['query'] : externalId;
        const topic = typeof payload['topic'] === 'string' ? payload['topic'] : query;
        const totalCount = typeof payload['total_count'] === 'number' ? payload['total_count'] : 0;
        const isIncomplete = Boolean(payload['incomplete_results'] ?? false);
        const querySignature =
          typeof payload['query_signature'] === 'string' ? payload['query_signature'] : query;

        metrics.push({
          subjectKey: topic,
          metricType,
          windowStart: collectedAt,
          windowEnd: collectedAt,
          value: totalCount,
          unit: searchType === 'issues' ? 'comments' : 'stars',
          sourceKey,
          rawItemId,
          querySignature,
          isIncomplete,
        });

        if (relaxedRightsMode) {
          const titleText = `GitHub Search Signals: ${topic}`;
          const searchDocTitle = sanitizeText(titleText);
          const searchDocBody = sanitizeHtml(
            typeof payload['description'] === 'string' && payload['description'].trim().length > 0
              ? payload['description']
              : `GitHub search results for ${topic}. Total matching repositories: ${totalCount}. Query: ${query}.`,
          );
          const searchArtifactType: ArtifactType = 'article';
          const searchLicenseId = null;
          const searchAuthor: string | null = null;
          const searchNormalizedHash = computeNormalizedHash({
            artifactType: searchArtifactType,
            canonicalUrl: rawItem.canonicalUrl,
            title: searchDocTitle,
            bodyText: searchDocBody,
            language: defaultLanguage,
            publishedAt: collectedAt,
            licenseId: searchLicenseId,
            author: searchAuthor,
          });

          documents.push({
            artifactType: searchArtifactType,
            canonicalUrl: rawItem.canonicalUrl,
            title: searchDocTitle,
            bodyText: searchDocBody,
            author: searchAuthor,
            language: defaultLanguage,
            publishedAt: collectedAt,
            licenseId: searchLicenseId,
            normalizedHash: searchNormalizedHash,
            normalizerVersion,
            status: 'pending',
            rawItemId,
          });
        }
        break;
      }

      case 'huggingface_hub': {
        // 11. huggingface_hub: model_activity metric only (0 documents, model cards not stored)
        const subjectKey =
          typeof payload['id'] === 'string'
            ? payload['id']
            : typeof payload['modelId'] === 'string'
              ? payload['modelId']
              : externalId;

        const downloads =
          typeof payload['downloads'] === 'number' ? payload['downloads'] : undefined;
        const likes = typeof payload['likes'] === 'number' ? payload['likes'] : undefined;

        let value = 1;
        let unit = 'models';

        if (downloads !== undefined) {
          value = downloads;
          unit = 'downloads';
        } else if (likes !== undefined) {
          value = likes;
          unit = 'likes';
        }

        const createdAt = parseDateOrNull(payload['createdAt']) ?? collectedAt;

        metrics.push({
          subjectKey,
          metricType: 'model_activity',
          windowStart: createdAt,
          windowEnd: createdAt,
          value,
          unit,
          sourceKey,
          rawItemId,
          querySignature: null,
          isIncomplete: false,
        });

        if (relaxedRightsMode) {
          const modelTitle = sanitizeText(`Hugging Face Model: ${subjectKey}`);
          const pipelineTag =
            typeof payload['pipeline_tag'] === 'string' ? payload['pipeline_tag'] : '';
          const tags = Array.isArray(payload['tags'])
            ? (payload['tags'] as string[]).join(', ')
            : '';
          const modelBody = sanitizeHtml(
            typeof payload['description'] === 'string' && payload['description'].trim().length > 0
              ? payload['description']
              : `Open source AI model ${subjectKey} on Hugging Face Hub. Pipeline: ${pipelineTag || 'general'}. Tags: ${tags || 'none'}. Downloads: ${downloads ?? 0}, Likes: ${likes ?? 0}.`,
          );
          const hfArtifactType: ArtifactType = 'article';
          const hfLicenseId =
            typeof payload['license'] === 'string'
              ? normalizeLicenseSlug(payload['license'])
              : 'apache-2.0';
          const hfAuthor: string | null = null;
          const hfNormalizedHash = computeNormalizedHash({
            artifactType: hfArtifactType,
            canonicalUrl: rawItem.canonicalUrl || `https://huggingface.co/${subjectKey}`,
            title: modelTitle,
            bodyText: modelBody,
            language: defaultLanguage,
            publishedAt: createdAt,
            licenseId: hfLicenseId,
            author: hfAuthor,
          });

          documents.push({
            artifactType: hfArtifactType,
            canonicalUrl: rawItem.canonicalUrl || `https://huggingface.co/${subjectKey}`,
            title: modelTitle,
            bodyText: modelBody,
            author: hfAuthor,
            language: defaultLanguage,
            publishedAt: createdAt,
            licenseId: hfLicenseId,
            normalizedHash: hfNormalizedHash,
            normalizerVersion,
            status: 'pending',
            rawItemId,
          });
        }
        break;
      }
      default: {
        // Fallback generic normalization
        const genericTitle = sanitizeText(
          typeof payload['title'] === 'string' ? payload['title'] : externalId,
        );
        const genericBody = sanitizeHtml(
          typeof payload['body'] === 'string'
            ? payload['body']
            : typeof payload['text'] === 'string'
              ? payload['text']
              : '',
        );
        const publishedAt = parseDateOrNull(rawItem.publishedAt);
        const canonicalUrl = rawItem.canonicalUrl;
        const licenseId = normalizeLicenseSlug(
          (rawItem.rightsMetadata?.['license_id'] as string) ?? null,
        );
        const artifactType: ArtifactType = 'article';
        const author: string | null = null;

        const normalizedHash = computeNormalizedHash({
          artifactType,
          canonicalUrl,
          title: genericTitle,
          bodyText: genericBody,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          author,
        });

        documents.push({
          artifactType,
          canonicalUrl,
          title: genericTitle,
          bodyText: genericBody,
          author,
          language: defaultLanguage,
          publishedAt,
          licenseId,
          normalizedHash,
          normalizerVersion,
          status: 'pending',
          rawItemId,
        });
        break;
      }
    }

    return {
      sourceKey,
      externalId,
      rawItemId,
      documents,
      metrics,
      normalizerVersion,
      normalizedAt: new Date(),
    };
  }

  function normalizeBatch(
    rawItems: readonly (RawItemRecord | RawItemInput)[],
    sourceKeyHint?: SourceKey,
  ): readonly NormalizationResult[] {
    return rawItems.map((item) => normalize(item, sourceKeyHint));
  }

  return {
    normalizerVersion,
    normalize,
    normalizeBatch,
    computeNormalizedHash,
  };
}

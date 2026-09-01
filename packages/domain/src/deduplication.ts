import { createHash } from 'node:crypto';
import type { SourceKey } from './collector.js';

export const DEDUPLICATION_ALGORITHM_VERSION = 'v1.0.0' as const;
export const DEDUPLICATION_STAGE = 'deduplication' as const;

const TRACKING_QUERY_PARAM_PREFIXES: readonly string[] = ['utm_', 'ga_', 'hsa_'] as const;

const TRACKING_QUERY_PARAMS: Record<string, true> = {
  utm_source: true,
  utm_medium: true,
  utm_campaign: true,
  utm_term: true,
  utm_content: true,
  utm_id: true,
  utm_name: true,
  utm_reader: true,
  utm_source_platform: true,
  utm_creative_format: true,
  utm_marketing_tactic: true,
  fbclid: true,
  gclid: true,
  yclid: true,
  igshid: true,
  msclkid: true,
  mc_cid: true,
  mc_eid: true,
  dclid: true,
  twclid: true,
  wbraid: true,
  gbraid: true,
  _ga: true,
  _gl: true,
  ref: true,
  ref_src: true,
  source: true,
  spm: true,
  from_feed: true,
};

/**
 * Deterministically normalizes a canonical URL:
 * - Scheme: lowercased, only http/https allowed
 * - Host: lowercased, default ports (80/443) removed
 * - Path: redundant slashes collapsed, trailing slash removed (root '/' preserved)
 * - Query: tracking params (utm_*, fbclid, etc.) removed, keys sorted alphabetically
 * - Fragment: removed
 */
export function normalizeCanonicalUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // Only allow http and https protocols
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') {
    return null;
  }
  parsed.protocol = protocol;

  // Lowercase hostname
  parsed.hostname = parsed.hostname.toLowerCase();

  // Remove standard default ports
  if (
    (protocol === 'http:' && parsed.port === '80') ||
    (protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  // Pathname normalization
  let pathname = parsed.pathname.replace(/\/+/gu, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }
  parsed.pathname = pathname;

  // Filter out tracking query parameters
  const entries = Array.from(parsed.searchParams.entries());
  const filteredEntries: [string, string][] = [];

  for (const [key, value] of entries) {
    const lowerKey = key.toLowerCase();
    const isTracking =
      Boolean(TRACKING_QUERY_PARAMS[lowerKey]) ||
      TRACKING_QUERY_PARAM_PREFIXES.some((prefix) => lowerKey.startsWith(prefix));

    if (!isTracking) {
      filteredEntries.push([key, value]);
    }
  }

  // Sort query parameters alphabetically by key, then value
  filteredEntries.sort(([aKey, aVal], [bKey, bVal]) => {
    const keyCmp = aKey.localeCompare(bKey);
    if (keyCmp !== 0) return keyCmp;
    return aVal.localeCompare(bVal);
  });

  parsed.search = '';
  for (const [key, value] of filteredEntries) {
    parsed.searchParams.append(key, value);
  }

  // Remove hash/fragment
  parsed.hash = '';

  return parsed.toString();
}

/**
 * Tokenizes text for fingerprint generation (NFKD normalize, lowercase, word tokenization).
 */
export function tokenizeTextForFingerprint(text: string): string[] {
  if (!text || typeof text !== 'string') return [];

  const normalized = text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();

  if (normalized.length === 0) return [];

  const words = normalized.split(/\s+/gu).filter((w) => w.length > 0);

  // Generate 2-gram shingles in addition to single words for richer fingerprinting
  const tokens: string[] = [...words];
  for (let i = 0; i < words.length - 1; i++) {
    const w1 = words[i];
    const w2 = words[i + 1];
    if (w1 && w2) {
      tokens.push(`${w1}_${w2}`);
    }
  }

  return tokens;
}

/**
 * Computes a 64-bit SimHash fingerprint as a 16-character lowercase hex string.
 */
export function computeSimHash(tokens: readonly string[]): string {
  if (tokens.length === 0) {
    return '0000000000000000';
  }

  const v = new Int32Array(64);

  for (const token of tokens) {
    const hashHex = createHash('sha256').update(token, 'utf8').digest('hex');
    // Use first 16 hex chars (64 bits) as BigInt
    const tokenHashBig = BigInt(`0x${hashHex.slice(0, 16)}`);

    for (let bit = 0; bit < 64; bit++) {
      const isBitSet = (tokenHashBig & (1n << BigInt(bit))) !== 0n;
      const current = v[bit] ?? 0;
      v[bit] = isBitSet ? current + 1 : current - 1;
    }
  }

  let fingerprintBig = 0n;
  for (let bit = 0; bit < 64; bit++) {
    const current = v[bit] ?? 0;
    if (current > 0) {
      fingerprintBig |= 1n << BigInt(bit);
    }
  }

  return fingerprintBig.toString(16).padStart(16, '0');
}

/**
 * Computes a deterministic 64-bit fingerprint for a document title.
 */
export function computeTitleFingerprint(title: string): string {
  const tokens = tokenizeTextForFingerprint(title);
  return computeSimHash(tokens);
}

/**
 * Computes a deterministic 64-bit fingerprint for document body text.
 */
export function computeBodyFingerprint(bodyText: string): string {
  const tokens = tokenizeTextForFingerprint(bodyText);
  return computeSimHash(tokens);
}

/**
 * Computes Hamming distance between two 16-character hex 64-bit SimHash fingerprints.
 */
export function computeHammingDistance(fpA: string, fpB: string): number {
  if (fpA.length !== 16 || fpB.length !== 16) {
    return 64;
  }

  try {
    const bigA = BigInt(`0x${fpA}`);
    const bigB = BigInt(`0x${fpB}`);
    let xor = bigA ^ bigB;
    let dist = 0;
    while (xor > 0n) {
      dist += Number(xor & 1n);
      xor >>= 1n;
    }
    return dist;
  } catch {
    return 64;
  }
}

/**
 * Computes fingerprint similarity in range [0.0, 1.0] from SimHash Hamming distance.
 */
export function computeFingerprintSimilarity(fpA: string, fpB: string): number {
  const dist = computeHammingDistance(fpA, fpB);
  return Math.max(0, Math.min(1, (64 - dist) / 64));
}

/**
 * Computes SHA-256 hex digest of normalized body text for exact matching.
 */
export function computeExactBodyHash(bodyText: string): string {
  const normalized = (bodyText ?? '').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export type DeduplicationMatchReason = 'natural_key' | 'canonical_url' | 'exact_body_hash';

export interface DeduplicationMatch {
  readonly matchReason: DeduplicationMatchReason;
  readonly matchedDocumentId: string;
  readonly matchedRevisionId?: string | null;
  readonly matchedClusterId?: string | null;
  readonly matchedSourceKey?: string | null;
  readonly matchedExternalId?: string | null;
  readonly confidence: number;
}

export interface NearDuplicateCandidate {
  readonly candidateDocumentId: string;
  readonly candidateRevisionId?: string | null;
  readonly candidateSourceKey?: string | null;
  readonly candidateTitle?: string | null;
  readonly titleSimilarity: number;
  readonly bodySimilarity: number;
  readonly similarity: number;
  readonly reason: string;
}

export interface DeduplicationTargetDoc {
  readonly documentId: string;
  readonly revisionId?: string | null;
  readonly rawItemId?: string | null;
  readonly sourceKey?: SourceKey | string | null;
  readonly sourceId?: string | null;
  readonly externalId?: string | null;
  readonly canonicalUrl?: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly normalizedHash: string;
  readonly publishedAt?: Date | null;
  readonly duplicateClusterId?: string | null;
  readonly createdAt?: Date | null;
}

export interface ExistingDedupDocument {
  readonly documentId: string;
  readonly revisionId?: string | null;
  readonly rawItemId?: string | null;
  readonly sourceKey?: SourceKey | string | null;
  readonly sourceId?: string | null;
  readonly externalId?: string | null;
  readonly canonicalUrl?: string | null;
  readonly normalizedCanonicalUrl?: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly bodyExactHash?: string | null;
  readonly normalizedHash: string;
  readonly duplicateClusterId?: string | null;
  readonly createdAt?: Date | null;
}

export interface DeduplicationResult {
  readonly documentId: string;
  readonly isExactDuplicate: boolean;
  readonly exactMatch: DeduplicationMatch | null;
  readonly clusterAction: 'create_cluster' | 'join_cluster' | 'none';
  readonly targetClusterId: string | null;
  readonly representativeDocumentId: string | null;
  readonly nearDuplicateCandidates: readonly NearDuplicateCandidate[];
  readonly normalizedCanonicalUrl: string | null;
  readonly bodyFingerprint: string;
  readonly titleFingerprint: string;
  readonly deduplicationVersion: string;
}

export interface DeduplicationServiceOptions {
  readonly algorithmVersion?: string;
  /** Minimum similarity threshold to report as a near-duplicate candidate (default: 0.70) */
  readonly nearDuplicateThreshold?: number;
}

export interface DeduplicationServicePort {
  readonly deduplicationVersion: string;
  normalizeCanonicalUrl(url: string | null | undefined): string | null;
  computeTitleFingerprint(title: string): string;
  computeBodyFingerprint(bodyText: string): string;
  computeSimilarity(fpA: string, fpB: string): number;
  computeExactBodyHash(bodyText: string): string;
  deduplicate(
    target: DeduplicationTargetDoc,
    existingDocs: readonly ExistingDedupDocument[],
  ): DeduplicationResult;
}

/**
 * Creates an instance of DeduplicationServicePort.
 * Enforces exact dedup 3-stage priority:
 *   1. Identical (source, external_id, revision/raw_item) natural key
 *   2. Normalized canonical URL match
 *   3. Normalized body exact hash match
 *
 * Near-duplicate candidates are suggested based on title and body SimHash fingerprints,
 * but NEVER merged automatically (pending EXP-004 threshold confirmation).
 */
export function createDeduplicationService(
  options: DeduplicationServiceOptions = {},
): DeduplicationServicePort {
  const version = options.algorithmVersion ?? DEDUPLICATION_ALGORITHM_VERSION;
  const nearDupThreshold = options.nearDuplicateThreshold ?? 0.7;

  return {
    deduplicationVersion: version,

    normalizeCanonicalUrl(url: string | null | undefined): string | null {
      return normalizeCanonicalUrl(url);
    },

    computeTitleFingerprint(title: string): string {
      return computeTitleFingerprint(title);
    },

    computeBodyFingerprint(bodyText: string): string {
      return computeBodyFingerprint(bodyText);
    },

    computeSimilarity(fpA: string, fpB: string): number {
      return computeFingerprintSimilarity(fpA, fpB);
    },

    computeExactBodyHash(bodyText: string): string {
      return computeExactBodyHash(bodyText);
    },

    deduplicate(
      target: DeduplicationTargetDoc,
      existingDocs: readonly ExistingDedupDocument[],
    ): DeduplicationResult {
      const normalizedTargetUrl = normalizeCanonicalUrl(target.canonicalUrl);
      const targetBodyHash = computeExactBodyHash(target.bodyText);
      const targetTitleFp = computeTitleFingerprint(target.title);
      const targetBodyFp = computeBodyFingerprint(target.bodyText);

      // Exclude the document itself if it's already in existingDocs
      const otherDocs = existingDocs.filter((d) => d.documentId !== target.documentId);

      // Stage 1: Check Natural Key match (source, external_id, revision/raw_item/normalized_hash)
      let matchedDoc: ExistingDedupDocument | null = null;
      let matchReason: DeduplicationMatchReason | null = null;

      if (target.sourceKey && target.externalId) {
        for (const candidate of otherDocs) {
          if (
            candidate.sourceKey === target.sourceKey &&
            candidate.externalId === target.externalId
          ) {
            // Check revision / rawItemId / normalizedHash identity
            const isSameRawItem =
              Boolean(target.rawItemId) &&
              Boolean(candidate.rawItemId) &&
              target.rawItemId === candidate.rawItemId;
            const isSameHash = target.normalizedHash === candidate.normalizedHash;
            const isSameRevision =
              Boolean(target.revisionId) &&
              Boolean(candidate.revisionId) &&
              target.revisionId === candidate.revisionId;

            if (isSameRawItem || isSameHash || isSameRevision) {
              matchedDoc = candidate;
              matchReason = 'natural_key';
              break;
            }
          }
        }
      }

      // Stage 2: Check Normalized Canonical URL match (Priority 2)
      if (!matchedDoc && normalizedTargetUrl) {
        for (const candidate of otherDocs) {
          const candidateNormalizedUrl =
            candidate.normalizedCanonicalUrl ?? normalizeCanonicalUrl(candidate.canonicalUrl);

          if (candidateNormalizedUrl && candidateNormalizedUrl === normalizedTargetUrl) {
            matchedDoc = candidate;
            matchReason = 'canonical_url';
            break;
          }
        }
      }

      // Stage 3: Check Normalized Body Exact Hash match (Priority 3)
      if (!matchedDoc) {
        for (const candidate of otherDocs) {
          const candidateBodyHash =
            candidate.bodyExactHash ?? computeExactBodyHash(candidate.bodyText);

          if (
            candidateBodyHash === targetBodyHash ||
            candidate.normalizedHash === target.normalizedHash
          ) {
            matchedDoc = candidate;
            matchReason = 'exact_body_hash';
            break;
          }
        }
      }

      // If exact duplicate found
      if (matchedDoc && matchReason) {
        const exactMatch: DeduplicationMatch = {
          matchReason,
          matchedDocumentId: matchedDoc.documentId,
          matchedRevisionId: matchedDoc.revisionId ?? null,
          matchedClusterId: matchedDoc.duplicateClusterId ?? null,
          matchedSourceKey: matchedDoc.sourceKey ? String(matchedDoc.sourceKey) : null,
          matchedExternalId: matchedDoc.externalId ?? null,
          confidence: 100,
        };

        const existingClusterId =
          matchedDoc.duplicateClusterId ?? target.duplicateClusterId ?? null;

        let clusterAction: 'create_cluster' | 'join_cluster';
        let targetClusterId: string | null = null;
        let representativeDocumentId: string;

        if (existingClusterId) {
          clusterAction = 'join_cluster';
          targetClusterId = existingClusterId;
          representativeDocumentId = matchedDoc.documentId;
        } else {
          clusterAction = 'create_cluster';
          targetClusterId = null; // To be created by caller/repository
          // Representative is the existing document (earlier arrival)
          representativeDocumentId = matchedDoc.documentId;
        }

        return {
          documentId: target.documentId,
          isExactDuplicate: true,
          exactMatch,
          clusterAction,
          targetClusterId,
          representativeDocumentId,
          nearDuplicateCandidates: [],
          normalizedCanonicalUrl: normalizedTargetUrl,
          bodyFingerprint: targetBodyFp,
          titleFingerprint: targetTitleFp,
          deduplicationVersion: version,
        };
      }

      // Stage 4: Near-duplicate candidates suggestion (Title and Body Fingerprint)
      // Note: EXP-004 threshold is pending, so we ONLY produce candidate suggestions and do NOT merge.
      const nearDuplicateCandidates: NearDuplicateCandidate[] = [];

      for (const candidate of otherDocs) {
        const candidateTitleFp = computeTitleFingerprint(candidate.title);
        const candidateBodyFp = computeBodyFingerprint(candidate.bodyText);

        const titleSim = computeFingerprintSimilarity(targetTitleFp, candidateTitleFp);
        const bodySim = computeFingerprintSimilarity(targetBodyFp, candidateBodyFp);
        // Weighted combined similarity: 0.3 * title + 0.7 * body
        const combinedSim = 0.3 * titleSim + 0.7 * bodySim;

        if (combinedSim >= nearDupThreshold || titleSim >= 0.9 || bodySim >= 0.85) {
          nearDuplicateCandidates.push({
            candidateDocumentId: candidate.documentId,
            candidateRevisionId: candidate.revisionId ?? null,
            candidateSourceKey: candidate.sourceKey ? String(candidate.sourceKey) : null,
            candidateTitle: candidate.title,
            titleSimilarity: Number(titleSim.toFixed(4)),
            bodySimilarity: Number(bodySim.toFixed(4)),
            similarity: Number(combinedSim.toFixed(4)),
            reason: 'fingerprint_near_duplicate_candidate',
          });
        }
      }

      // Sort candidates by highest similarity descending
      nearDuplicateCandidates.sort((a, b) => b.similarity - a.similarity);

      return {
        documentId: target.documentId,
        isExactDuplicate: false,
        exactMatch: null,
        clusterAction: 'none',
        targetClusterId: null,
        representativeDocumentId: null,
        nearDuplicateCandidates,
        normalizedCanonicalUrl: normalizedTargetUrl,
        bodyFingerprint: targetBodyFp,
        titleFingerprint: targetTitleFp,
        deduplicationVersion: version,
      };
    },
  };
}

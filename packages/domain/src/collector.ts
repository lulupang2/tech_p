/**
 * Authoritative set of supported source keys.
 */
export type SourceKey =
  | 'github_releases'
  | 'stack_exchange'
  | 'users_rust_lang'
  | 'arxiv'
  | 'chrome_release_notes'
  | 'react_blog'
  | 'chrome_origin_trials'
  | 'npm_registry'
  | 'npm_downloads'
  | 'github_search'
  | 'huggingface_hub';

/**
 * Common raw item output contract produced by collectors before persistence.
 * Meets invariants:
 * - Immutable raw payload preserved
 * - PII stripped before persistence (SECURITY.md §8)
 * - Source metadata attached
 */
export interface CollectedRawItem {
  readonly externalId: string;
  readonly payload: Record<string, unknown>;
  readonly rawHash: string;
  readonly publishedAt: Date | null;
  readonly cursor: string | null;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * Result of a collection run step by a collector.
 */
export interface CollectionResult {
  readonly sourceKey: SourceKey;
  readonly items: readonly CollectedRawItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly metrics?: {
    readonly itemsFetched: number;
    readonly bytesFetched: number;
    readonly durationMs: number;
  };
}

/**
 * Context and parameters passed to a collector execution.
 */
export interface CollectionContext {
  readonly sourceKey: SourceKey;
  readonly cursor: string | null;
  readonly timeWindow?: {
    readonly from: Date;
    readonly to: Date;
  };
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

/**
 * Source policy and security guard specification.
 */
export interface SourcePolicy {
  readonly sourceKey: SourceKey;
  readonly allowedHosts: readonly string[];
  readonly allowedSchemes: readonly ('http' | 'https')[];
  readonly maxSizeBytes: number;
  readonly maxRedirects: number;
  readonly verbatimOnly: boolean;
  readonly defaultLicenseId: string | null;
  readonly piiFieldsToStrip: readonly string[];
}

/**
 * Collector Port interface that every source adapter must satisfy.
 */
export interface CollectorPort {
  readonly sourceKey: SourceKey;
  readonly policy: SourcePolicy;
  collect(context: CollectionContext): Promise<CollectionResult>;
}

/**
 * Policy Guard Port for validating URLs, network boundaries, and content payloads.
 */
export interface PolicyGuardPort {
  validateUrl(url: string, policy: SourcePolicy): { valid: boolean; reason?: string };
  stripPii<T extends Record<string, unknown>>(payload: T, policy: SourcePolicy): T;
  enforceContentPolicy(
    item: CollectedRawItem,
    policy?: SourcePolicy,
  ): { valid: boolean; reason?: string };
}

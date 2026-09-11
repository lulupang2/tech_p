import type { CollectionTargetRevision, CollectionWindow } from './collection-state.js';
import type { CoverageReport } from './coverage.js';

export interface AcquisitionLimits {
  readonly maxSearches: number;
  readonly maxFetches: number;
  readonly maxHttpAttempts: number;
  readonly maxTotalBytes: number;
  readonly deadline: Date;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}
export interface SourceSearchRequest {
  readonly query: string;
  readonly target: CollectionTargetRevision;
  readonly window: CollectionWindow;
  readonly limit: number;
  readonly signal: AbortSignal;
}
export interface SourceCandidate {
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly targetRevisionId: string;
  readonly title: string;
  readonly publishedAt: Date | null;
}
export interface DiscoveredTarget {
  readonly canonicalIdentity: string;
  readonly sourceKey: CollectionTargetRevision['sourceKey'];
  readonly selector: CollectionTargetRevision['selector'];
  readonly evidenceUrl: string;
}
export interface SourceSearchPort {
  searchCandidates(request: SourceSearchRequest): Promise<readonly SourceCandidate[]>;
  discoverTargets(request: SourceSearchRequest): Promise<readonly DiscoveredTarget[]>;
}
export interface DiscoveryCandidateRecord extends DiscoveredTarget {
  readonly id: string;
  readonly state: 'pending' | 'accepted' | 'rejected';
  readonly targetId: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
}
export interface DiscoveryStatePort {
  recordCandidate(candidate: DiscoveredTarget, now: Date): Promise<DiscoveryCandidateRecord>;
  listCandidates(limit: number, after?: string): Promise<readonly DiscoveryCandidateRecord[]>;
  reviewCandidate(
    id: string,
    decision: 'accepted' | 'rejected',
    targetId: string | null,
    actor: string,
    now: Date,
  ): Promise<void>;
}
export interface AcquisitionRequest {
  readonly queryRunId: string;
  readonly query: string;
  readonly topicIds: readonly string[];
  readonly window: CollectionWindow;
  readonly coverage: CoverageReport;
  readonly limits: AcquisitionLimits;
  readonly signal: AbortSignal;
}
export interface AcquisitionResult {
  readonly acquired: number;
  readonly searches: number;
  readonly fetches: number;
  readonly httpAttempts: number;
  readonly bytes: number;
  readonly reason: string | null;
}
export interface BoundedAcquisitionPort {
  acquire(request: AcquisitionRequest): Promise<AcquisitionResult>;
}

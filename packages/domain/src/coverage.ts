import type { CollectionWindow } from './collection-state.js';
import type { ModelProfile } from './model-work.js';

export type CoverageReason = 'raw_shortage' | 'processing_pending' | 'period_gap' | 'retrieval_miss' | 'unknown';
export interface CoverageReport {
  readonly generatedAt: string;
  readonly from: string;
  readonly to: string;
  readonly rawDocuments: number;
  readonly lexicalDocuments: number;
  readonly vectorDocuments: number;
  readonly partitionsChecked: number;
  readonly partitionsCompleted: number;
  readonly partitionsPartial: number;
  readonly reasons: readonly CoverageReason[];
}
export interface CoveragePort {
  getCoverage(window: CollectionWindow, topicIds: readonly string[], now: Date): Promise<CoverageReport>;
}
export interface SearchReadinessPort {
  markLexicalReady(revisionId: string, now: Date): Promise<void>;
  getVectorReadiness(revisionId: string, profile: ModelProfile): Promise<boolean>;
}
export interface CohortMember {
  readonly targetRevisionId: string;
  readonly metric: string;
  readonly unit: string;
  readonly querySignature: string;
  readonly cadenceMs: number;
}
export interface ObservationCohort {
  readonly id: string;
  readonly version: string;
  readonly effectiveAt: Date;
  readonly members: readonly CohortMember[];
}
export interface CohortComparison {
  readonly cohortId: string;
  readonly metric: string;
  readonly unit: string;
  readonly denominator: number;
  readonly excludedTargets: number;
  readonly baseline: number | null;
  readonly current: number | null;
  readonly partial: boolean;
}
export interface CohortPersistencePort {
  createCohortVersion(cohort: ObservationCohort): Promise<void>;
  getCohortVersion(id: string): Promise<ObservationCohort | null>;
}
export interface CohortPort extends CohortPersistencePort {
  compareWindows(cohortId: string, metric: string, unit: string, baseline: CollectionWindow, current: CollectionWindow): Promise<CohortComparison>;
}

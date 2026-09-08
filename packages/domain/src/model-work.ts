export interface ModelProfile {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  readonly priceVersion: string;
  readonly tokenizerVersion: string;
  readonly approvalReference: string;
}
export interface EmbeddingWorkKey {
  readonly chunkId: string;
  readonly inputHash: string;
  readonly profile: ModelProfile;
}
export type EmbeddingWorkState = 'pending' | 'claimed' | 'calling' | 'completed' | 'outcome_unknown' | 'failed';
export interface EmbeddingWork {
  readonly id: string;
  readonly key: EmbeddingWorkKey;
  readonly state: EmbeddingWorkState;
  readonly epoch: number;
  readonly leaseUntil: Date | null;
  readonly vector: readonly number[] | null;
  readonly reservationId: string | null;
}
export interface BudgetScope {
  readonly id: string;
  readonly approved: boolean;
  readonly currency: string;
  readonly maxDailyUnits: number;
  readonly maxOutstandingUnits: number;
  readonly maxDailyTokens: number;
  readonly laneLimits: Readonly<Record<string, { readonly maxDailyUnits: number; readonly maxDailyTokens: number }>>;
  readonly approvedModelProfiles: readonly string[];
}
export interface BudgetReservation {
  readonly id: string;
  readonly scopeId: string;
  readonly attemptId: string;
  readonly state: 'reserved' | 'settled' | 'outcome_unknown' | 'released';
  readonly units: number;
  readonly tokens: number;
}
export interface ProviderBudgetPort {
  configureScope(scope: BudgetScope): Promise<void>;
  reserve(scopeId: string, attemptId: string, lane: string, units: number, tokens: number, now: Date): Promise<BudgetReservation>;
  settle(id: string, units: number, tokens: number, now: Date): Promise<void>;
  holdUnknown(id: string, now: Date): Promise<void>;
  releaseUnsent(id: string, now: Date): Promise<void>;
}
export interface EmbeddingWorkPort {
  claimOrReadCompleted(key: EmbeddingWorkKey, now: Date, leaseMs: number): Promise<EmbeddingWork | null>;
  beginCall(id: string, epoch: number, reservationId: string, now: Date): Promise<void>;
  completeWork(id: string, epoch: number, vector: readonly number[], now: Date): Promise<void>;
  markOutcomeUnknown(id: string, epoch: number, now: Date): Promise<void>;
}
export class ProviderBudgetError extends Error {
  constructor(readonly code: 'budget_exhausted' | 'approval_required' | 'invalid_usage' | 'reservation_conflict' | 'stale_work' | 'outcome_unknown') {
    super(code);
    this.name = 'ProviderBudgetError';
  }
}

import { createHash } from 'node:crypto';
import type { CollectedRawItem, SourceKey } from './collector.js';
import type { ModelProfile } from './model-work.js';

export type CollectionMode = 'backfill' | 'incremental' | 'on_demand';
export type HistoryMode = 'historical_range' | 'paginated_history' | 'feed_only' | 'snapshot_only';
export type CollectionTimeBasis = 'published_at' | 'updated_at' | 'observed_at';
export type PartitionState =
  'pending' | 'running' | 'deferred' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type PageDisposition = 'continue' | 'complete' | 'deferred' | 'partial';
export type TargetSelector =
  | { kind: 'repository'; owner: string; repository: string }
  | { kind: 'tag'; site: string; tag: string }
  | { kind: 'package'; name: string }
  | { kind: 'query'; query: string }
  | { kind: 'feed'; url: string }
  | { kind: 'category'; category: string }
  | { kind: 'source' };
export interface TargetPolicy {
  readonly version: string;
  readonly approved: boolean;
  readonly fetch: boolean;
  readonly store: boolean;
  readonly embed: boolean;
  readonly modelInput: boolean;
  readonly displayExcerpt: boolean;
  readonly licenseId: string | null;
  readonly verbatimOnly: boolean;
}
export interface TargetCapability {
  readonly historyMode: HistoryMode;
  readonly timeBasis: CollectionTimeBasis;
  readonly cursorVersion: number;
  readonly stablePagination: boolean;
  readonly canCollect: boolean;
  readonly reviewedAt: string | null;
  readonly earliestAvailableAt: string | null;
  readonly canSearch: boolean;
  readonly canDiscover: boolean;
}
export interface CollectionTargetRevision {
  readonly id: string;
  readonly targetId: string;
  readonly sourceId: string;
  readonly sourceKey: SourceKey;
  readonly canonicalIdentity: string;
  readonly configHash: string;
  readonly selector: TargetSelector;
  readonly capability: TargetCapability;
  readonly policy: TargetPolicy;
  readonly topicIds: readonly string[];
  readonly taxonomyVersion: string;
  readonly enabled: boolean;
  readonly cadenceMs: number | null;
  readonly overlapMs: number;
  readonly createdAt: Date;
}
export interface CollectionWindow {
  readonly from: Date;
  readonly to: Date;
}
export interface PartitionPlan {
  readonly targetRevisionId: string;
  readonly mode: CollectionMode;
  readonly scopeKey: string;
  readonly window: CollectionWindow;
  readonly timeBasis: CollectionTimeBasis;
  readonly workflowVersion: string;
}
export interface CollectionPartition extends PartitionPlan {
  readonly id: string;
  readonly state: PartitionState;
  readonly pageSequence: number;
  readonly cursor: string | null;
  readonly leaseEpoch: number;
  readonly leaseUntil: Date | null;
  readonly nextDueAt: Date;
  readonly reason: string | null;
}
export interface CollectionPageRequest {
  readonly target: CollectionTargetRevision;
  readonly partition: CollectionPartition;
  readonly limit: number;
  readonly maxRequests: number;
  readonly maxBytes: number;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}
export interface CollectionPageResult {
  readonly items: readonly CollectedRawItem[];
  readonly nextCursor: string | null;
  readonly disposition: PageDisposition;
  readonly reason: string | null;
  readonly retryAt: Date | null;
  readonly requests: number;
  readonly bytes: number;
}
export interface CollectorPagePort {
  collectPage(request: CollectionPageRequest): Promise<CollectionPageResult>;
}
export type DeliveryKind = 'collection' | 'normalization' | 'embedding';
export interface CollectionDelivery {
  readonly id: string;
  readonly kind: DeliveryKind;
  readonly partitionId: string;
  readonly pageSequence: number;
  readonly rawItemId: string | null;
  readonly revisionId: string | null;
  readonly completedAt: Date | null;
  readonly leaseEpoch: number;
  readonly leaseUntil: Date | null;
}
export interface ClaimedCollectionPage {
  readonly partition: CollectionPartition;
  readonly target: CollectionTargetRevision;
  readonly runId: string;
}
export interface PageCommit {
  readonly claim: ClaimedCollectionPage;
  readonly result: CollectionPageResult;
  readonly now: Date;
}
export interface CollectionStatePort {
  registerTarget(
    input: Omit<CollectionTargetRevision, 'id' | 'targetId' | 'configHash' | 'createdAt'>,
  ): Promise<CollectionTargetRevision>;
  getTargetRevision(id: string): Promise<CollectionTargetRevision | null>;
  setTargetEnabled(targetId: string, enabled: boolean, now: Date): Promise<void>;
  listTargets(limit: number, after?: string): Promise<readonly CollectionTargetRevision[]>;
  planPartition(plan: PartitionPlan, now: Date): Promise<CollectionPartition>;
  getPartition(id: string): Promise<CollectionPartition | null>;
  listPartitions(limit: number, after?: string): Promise<readonly CollectionPartition[]>;
  claimPage(
    partitionId: string,
    pageSequence: number,
    now: Date,
    leaseMs: number,
  ): Promise<ClaimedCollectionPage | null>;
  renewPage(claim: ClaimedCollectionPage, now: Date, leaseMs: number): Promise<boolean>;
  commitPage(input: PageCommit): Promise<void>;
  failPage(
    claim: ClaimedCollectionPage,
    reason: string,
    retryAt: Date | null,
    now: Date,
  ): Promise<void>;
  resumePartition(id: string, now: Date): Promise<CollectionPartition>;
  claimDeliveries(
    now: Date,
    limit: number,
    leaseMs: number,
    mode?: CollectionMode,
  ): Promise<readonly CollectionDelivery[]>;
  getDelivery(id: string): Promise<CollectionDelivery | null>;
  markSent(id: string, leaseEpoch: number, now: Date): Promise<void>;
  completeDelivery(id: string, now: Date, profile?: ModelProfile): Promise<void>;
  attachRevision(rawItemId: string, revisionId: string, now: Date): Promise<void>;
}

export class CollectionStateError extends Error {
  constructor(
    readonly code:
      | 'invalid_window'
      | 'invalid_cursor'
      | 'stale_lease'
      | 'policy_blocked'
      | 'invalid_page'
      | 'not_found'
      | 'invalid_state',
  ) {
    super(code);
    this.name = 'CollectionStateError';
  }
}

export function canonicalCollectionJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (item instanceof Date && Number.isFinite(item.getTime())) return item.toISOString();
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === 'object' && item && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, normalize((item as Record<string, unknown>)[key])]),
      );
    }
    throw new CollectionStateError('invalid_state');
  };
  return JSON.stringify(normalize(value));
}
export function collectionHash(value: unknown): string {
  return createHash('sha256').update(canonicalCollectionJson(value)).digest('hex');
}
export function validateCollectionWindow(window: CollectionWindow): void {
  if (
    !Number.isFinite(window.from.getTime()) ||
    !Number.isFinite(window.to.getTime()) ||
    window.from >= window.to
  ) {
    throw new CollectionStateError('invalid_window');
  }
}
export function partitionNaturalKey(plan: PartitionPlan): string {
  validateCollectionWindow(plan.window);
  return collectionHash(partitionPlan(plan));
}
export function assertCollectableTarget(target: CollectionTargetRevision): void {
  if (
    !target.enabled ||
    !target.policy.approved ||
    !target.policy.fetch ||
    !target.policy.store ||
    target.capability.canCollect !== true ||
    !target.capability.reviewedAt ||
    !Number.isFinite(Date.parse(target.capability.reviewedAt))
  ) {
    throw new CollectionStateError('policy_blocked');
  }
}
export function encodePageCursor(
  partition: CollectionPartition,
  cursorVersion: number,
  value: string,
): string {
  return Buffer.from(
    JSON.stringify({ key: partitionNaturalKey(partitionPlan(partition)), cursorVersion, value }),
    'utf8',
  ).toString('base64url');
}
export function partitionPlan(partition: PartitionPlan): PartitionPlan {
  return {
    targetRevisionId: partition.targetRevisionId,
    mode: partition.mode,
    scopeKey: partition.scopeKey,
    window: partition.window,
    timeBasis: partition.timeBasis,
    workflowVersion: partition.workflowVersion,
  };
}
export function decodePageCursor(
  partition: CollectionPartition,
  cursorVersion: number,
): string | null {
  if (partition.cursor === null) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(partition.cursor, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object') throw new Error();
    const cursor = data as Record<string, unknown>;
    if (
      Object.keys(cursor).length !== 3 ||
      cursor['key'] !== partitionNaturalKey(partitionPlan(partition)) ||
      cursor['cursorVersion'] !== cursorVersion ||
      typeof cursor['value'] !== 'string'
    )
      throw new Error();
    return cursor['value'];
  } catch {
    throw new CollectionStateError('invalid_cursor');
  }
}
export function validatePageResult(
  partition: CollectionPartition,
  result: CollectionPageResult,
): void {
  if (!['continue', 'complete', 'deferred', 'partial'].includes(result.disposition))
    throw new CollectionStateError('invalid_page');
  if (
    result.nextCursor !== null &&
    (typeof result.nextCursor !== 'string' || result.nextCursor.length > 16384)
  )
    throw new CollectionStateError('invalid_cursor');
  if (
    result.retryAt !== null &&
    (!(result.retryAt instanceof Date) || !Number.isFinite(result.retryAt.getTime()))
  )
    throw new CollectionStateError('invalid_page');
  if (result.reason !== null && !/^[a-z][a-z0-9_]{0,127}$/u.test(result.reason))
    throw new CollectionStateError('invalid_page');
  if (
    result.disposition === 'continue' &&
    (!result.nextCursor || result.nextCursor === partition.cursor)
  )
    throw new CollectionStateError('invalid_page');
  if (result.disposition === 'deferred' && !result.retryAt)
    throw new CollectionStateError('invalid_page');
  if (result.disposition === 'partial' && !result.reason)
    throw new CollectionStateError('invalid_page');
  if (
    !Number.isSafeInteger(result.requests) ||
    result.requests < 0 ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 0
  )
    throw new CollectionStateError('invalid_page');
}

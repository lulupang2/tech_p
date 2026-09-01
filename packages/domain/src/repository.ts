export interface SourceRecord {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly kind: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly scheduleConfig: Record<string, unknown>;
  readonly policyReviewedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CollectionRunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface CollectionRunRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly scheduledAt: Date;
  readonly startedAt: Date | null;
  readonly endedAt: Date | null;
  readonly status: CollectionRunStatus;
  readonly cursorBefore: string | null;
  readonly cursorAfter: string | null;
  readonly counts: Record<string, number>;
  readonly errorSummary: string | null;
  readonly createdAt: Date;
}

export interface CreateCollectionRunInput {
  readonly id?: string;
  readonly sourceId: string;
  readonly scheduledAt: Date;
  readonly startedAt?: Date | null;
  readonly status?: CollectionRunStatus;
  readonly cursorBefore?: string | null;
  readonly counts?: Record<string, number>;
}

export interface UpdateCollectionRunInput {
  readonly status?: CollectionRunStatus;
  readonly startedAt?: Date | null;
  readonly endedAt?: Date | null;
  readonly cursorBefore?: string | null;
  readonly cursorAfter?: string | null;
  readonly counts?: Record<string, number>;
  readonly errorSummary?: string | null;
}

export interface CollectionRunRepositoryPort {
  readonly findById: (id: string) => Promise<CollectionRunRecord | null>;
  readonly create: (input: CreateCollectionRunInput) => Promise<CollectionRunRecord>;
  readonly update: (id: string, input: UpdateCollectionRunInput) => Promise<CollectionRunRecord>;
  readonly findBySourceAndScheduledAt?: (
    sourceId: string,
    scheduledAt: Date,
  ) => Promise<CollectionRunRecord | null>;
}

export interface RawItemRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly publishedAt: Date | null;
  readonly collectedAt: Date;
  readonly httpMetadata: Record<string, unknown>;
  readonly rightsMetadata: Record<string, unknown>;
}

export interface UpsertRawItemInput {
  readonly id?: string;
  readonly sourceId: string;
  readonly runId: string;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly publishedAt?: Date | null;
  readonly collectedAt?: Date;
  readonly httpMetadata?: Record<string, unknown>;
  readonly rightsMetadata?: Record<string, unknown>;
}

export interface UpsertRawItemResult {
  readonly item: RawItemRecord;
  readonly isNew: boolean;
}

export interface RawItemRepositoryPort {
  readonly findById: (id: string) => Promise<RawItemRecord | null>;
  readonly upsert: (input: UpsertRawItemInput) => Promise<UpsertRawItemResult>;
  readonly findByRevision: (
    sourceId: string,
    externalId: string,
    payloadHash: string,
  ) => Promise<RawItemRecord | null>;
  readonly listByRunId: (runId: string) => Promise<readonly RawItemRecord[]>;
}

export type PipelineEventStatus = 'started' | 'succeeded' | 'failed' | 'skipped' | 'quarantined';

export interface PipelineEventRecord {
  readonly id: string;
  readonly rawItemId: string;
  readonly stage: string;
  readonly processorVersion: string;
  readonly status: PipelineEventStatus;
  readonly attempt: number;
  readonly errorCode: string | null;
  readonly occurredAt: Date;
}

export interface CreatePipelineEventInput {
  readonly rawItemId: string;
  readonly stage: string;
  readonly processorVersion: string;
  readonly status: PipelineEventStatus;
  readonly attempt?: number;
  readonly errorCode?: string | null;
  readonly occurredAt?: Date;
}

export interface PipelineEventRepositoryPort {
  readonly create: (input: CreatePipelineEventInput) => Promise<PipelineEventRecord>;
  readonly listByRawItemId: (rawItemId: string) => Promise<readonly PipelineEventRecord[]>;
}

export interface DocumentRecord {
  readonly id: string;
  readonly artifactType: string;
  readonly canonicalUrl: string | null;
  readonly duplicateClusterId: string | null;
  readonly currentRevisionId: string | null;
  readonly createdAt: Date;
}

export interface DocumentRevisionRecord {
  readonly id: string;
  readonly documentId: string;
  readonly rawItemId: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly author: string | null;
  readonly language: string;
  readonly publishedAt: Date | null;
  readonly licenseId: string | null;
  readonly normalizedHash: string;
  readonly normalizerVersion: string;
  readonly status: string;
  readonly searchableAt: Date | null;
  readonly createdAt: Date;
}

export interface ChunkRecord {
  readonly id: string;
  readonly documentRevisionId: string;
  readonly ordinal: number;
  readonly headingPath: string[];
  readonly content: string;
  readonly tokenCount: number;
  readonly contentHash: string;
  readonly chunkerVersion: string;
  readonly createdAt: Date;
}

export interface PaginationParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface PaginatedResult<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface DocumentFilter {
  readonly status?: string;
  readonly artifactType?: string;
  readonly publishedAfter?: Date;
  readonly publishedBefore?: Date;
}
export interface SaveNormalizedDocumentInput {
  readonly artifactType: string;
  readonly canonicalUrl?: string | null;
  readonly title: string;
  readonly bodyText: string;
  readonly author?: string | null;
  readonly language?: string;
  readonly publishedAt?: Date | null;
  readonly licenseId?: string | null;
  readonly normalizedHash: string;
  readonly normalizerVersion: string;
  readonly rawItemId?: string | null;
  readonly status?: string;
}

export interface SaveNormalizedDocumentResult {
  readonly document: DocumentRecord;
  readonly revision: DocumentRevisionRecord;
  readonly isNewRevision: boolean;
}

export interface DuplicateClusterRecord {
  readonly id: string;
  readonly representativeDocumentId: string | null;
  readonly algorithmVersion: string;
  readonly confidence: number;
  readonly createdAt: Date;
}

/** Append-only membership evidence for a specific immutable revision and algorithm version. */
export type DuplicateClusterMembershipStatus = 'suggested' | 'accepted' | 'superseded';

export interface DuplicateClusterMembershipRecord {
  readonly id: string;
  readonly clusterId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly rawItemId: string | null;
  readonly algorithmVersion: string;
  readonly confidence: number;
  readonly status: DuplicateClusterMembershipStatus;
  readonly createdAt: Date;
}

export interface CreateDuplicateClusterMembershipInput {
  readonly id?: string;
  readonly clusterId: string;
  readonly documentId: string;
  readonly revisionId: string;
  readonly rawItemId?: string | null;
  readonly algorithmVersion: string;
  readonly confidence: number;
  readonly status?: DuplicateClusterMembershipStatus;
}

export interface CreateDuplicateClusterInput {
  readonly id?: string;
  readonly representativeDocumentId?: string | null;
  readonly algorithmVersion?: string;
  readonly confidence?: number;
}

export interface UpdateDuplicateClusterInput {
  readonly representativeDocumentId?: string | null;
  readonly confidence?: number;
}

export interface DuplicateClusterRepositoryPort {
  readonly findById: (id: string) => Promise<DuplicateClusterRecord | null>;
  readonly create: (input: CreateDuplicateClusterInput) => Promise<DuplicateClusterRecord>;
  readonly update: (
    id: string,
    input: UpdateDuplicateClusterInput,
  ) => Promise<DuplicateClusterRecord>;
  readonly listByRepresentativeDocumentId: (
    docId: string,
  ) => Promise<readonly DuplicateClusterRecord[]>;
  /** Optional for backwards-compatible adapters; implementations must be append-only. */
  readonly createMembership?: (
    input: CreateDuplicateClusterMembershipInput,
  ) => Promise<DuplicateClusterMembershipRecord>;
  readonly listMemberships?: (
    clusterId: string,
  ) => Promise<readonly DuplicateClusterMembershipRecord[]>;
}

export interface DocumentRepositoryPort {
  readonly findById: (id: string) => Promise<DocumentRecord | null>;
  readonly findRevisionById: (revisionId: string) => Promise<DocumentRevisionRecord | null>;
  readonly findRevisionByHash: (
    documentId: string,
    normalizedHash: string,
  ) => Promise<DocumentRevisionRecord | null>;
  readonly findByCanonicalUrl?: (canonicalUrl: string) => Promise<DocumentRecord | null>;
  readonly findRevisionByNormalizedHash?: (
    normalizedHash: string,
  ) => Promise<DocumentRevisionRecord | null>;
  readonly assignDuplicateCluster: (
    documentId: string,
    duplicateClusterId: string | null,
  ) => Promise<DocumentRecord>;
  readonly listDocumentsByClusterId: (clusterId: string) => Promise<readonly DocumentRecord[]>;
  readonly saveNormalizedDocument: (
    input: SaveNormalizedDocumentInput,
  ) => Promise<SaveNormalizedDocumentResult>;
  readonly listDocuments: (
    filter: DocumentFilter,
    pagination?: PaginationParams,
  ) => Promise<PaginatedResult<DocumentRecord>>;
  readonly listChunksByRevision: (revisionId: string) => Promise<readonly ChunkRecord[]>;
  readonly publishRevision: (
    documentId: string,
    revisionId: string,
    searchableAt?: Date,
  ) => Promise<DocumentRevisionRecord>;
  readonly listAllDocuments?: () => Promise<readonly DocumentRecord[]>;
  readonly listAllRevisions?: () => Promise<readonly DocumentRevisionRecord[]>;
}

export interface MetricObservationRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly topicId: string | null;
  readonly subjectKey: string;
  readonly metricType: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly value: number;
  readonly unit: string;
  readonly collectedAt: Date;
  readonly rawItemId: string | null;
  readonly querySignature: string | null;
  readonly isIncomplete: boolean;
}

export interface InsertMetricObservationInput {
  readonly id?: string;
  readonly sourceId: string;
  readonly topicId?: string | null;
  readonly subjectKey: string;
  readonly metricType: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly value: number;
  readonly unit: string;
  readonly collectedAt?: Date;
  readonly rawItemId?: string | null;
  readonly querySignature?: string | null;
  readonly isIncomplete?: boolean;
}

export interface MetricObservationFilter {
  readonly sourceId?: string;
  readonly topicId?: string;
  readonly subjectKey?: string;
  readonly metricType?: string;
  readonly windowStartAfter?: Date;
  readonly windowEndBefore?: Date;
}

export interface MetricObservationRepositoryPort {
  readonly upsert: (input: InsertMetricObservationInput) => Promise<MetricObservationRecord>;
  readonly upsertBatch: (
    inputs: readonly InsertMetricObservationInput[],
  ) => Promise<readonly MetricObservationRecord[]>;
  readonly listBySubject: (
    subjectKey: string,
    filter?: MetricObservationFilter,
    pagination?: PaginationParams,
  ) => Promise<PaginatedResult<MetricObservationRecord>>;
}
export interface SourceRepositoryPort {
  readonly findByKey: (key: string) => Promise<SourceRecord | null>;
  readonly listEnabled: () => Promise<readonly SourceRecord[]>;
}

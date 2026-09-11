export * from './acquisition.js';
export * from './collection-state.js';
export * from './coverage.js';
export * from './model-work.js';
export {
  AiPortError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  UnsupportedAiInputError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
  createOpenAiCompatibleChatPort,
  createOpenAiCompatibleEmbeddingPort,
} from './ai.js';

export type {
  AiErrorKind,
  AiRequestOptions,
  ChatCompletionMetadata,
  ChatCompletionRequest,
  AiErrorMetadata,
  ChatCompletionResult,
  ChatMessage,
  ChatPort,
  ChatRole,
  ChatProvider,
  ChatRequest,
  ChatResponse,
  DeterministicChatOptions,
  DeterministicChatPort,
  DeterministicEmbeddingOptions,
  DeterministicEmbeddingPort,
  EmbeddingMetadata,
  EmbeddingPort,
  EmbeddingProvider,
  EmbeddingRequest,
  EmbeddingResult,
  TokenUsage,
  OpenAiCompatibleChatOptions,
  OpenAiCompatibleEmbeddingOptions,
} from './ai.js';
export type {
  SourceRecord,
  CollectionRunStatus,
  CollectionRunRecord,
  CreateCollectionRunInput,
  UpdateCollectionRunInput,
  CollectionRunFilter,
  CollectionRunRepositoryPort,
  RawItemRecord,
  UpsertRawItemInput,
  UpsertRawItemResult,
  RawItemRepositoryPort,
  PipelineEventStatus,
  PipelineEventRecord,
  CreatePipelineEventInput,
  PipelineEventRepositoryPort,
  DuplicateClusterRecord,
  DuplicateClusterMembershipStatus,
  DuplicateClusterMembershipRecord,
  CreateDuplicateClusterInput,
  CreateDuplicateClusterMembershipInput,
  UpdateDuplicateClusterInput,
  DuplicateClusterRepositoryPort,
  DocumentRecord,
  DocumentRevisionRecord,
  ChunkRecord,
  TopicRecord,
  DocumentTopicRecord,
  UpsertTopicInput,
  SaveDocumentTopicInput,
  TopicRepositoryPort,
  SaveChunkInput,
  ChunkRepositoryPort,
  PaginationParams,
  PaginatedResult,
  DocumentFilter,
  SaveNormalizedDocumentInput,
  SaveNormalizedDocumentResult,
  DocumentRepositoryPort,
  MetricObservationRecord,
  InsertMetricObservationInput,
  MetricObservationFilter,
  MetricObservationRepositoryPort,
  SourceRepositoryPort,
} from './repository.js';
export type {
  SearchHit,
  SearchFilter,
  FtsQueryParams,
  ExactVectorQueryParams,
  SearchServicePort,
} from './search.js';
export { extractSearchKeywords, prioritizeSearchKeywords } from './search.js';
export type {
  SourceKey,
  CollectedRawItem,
  CollectionResult,
  CollectionContext,
  SourcePolicy,
  CollectorPort,
  PolicyGuardPort,
} from './collector.js';
export {
  IngestionError,
  PolicyViolationError,
  TransientIngestionError,
  PermanentIngestionError,
  SourceNotFoundError,
  SourceDisabledError,
  createRawIngestionService,
} from './ingestion.js';

export type {
  StageJobPayload,
  StageJobPublisherPort,
  RawIngestionRequest,
  RawIngestionCounts,
  RawIngestionResult,
  CollectorResolver,
  StructuredEventLoggerLike,
  RawIngestionServiceOptions,
  RawIngestionServicePort,
} from './ingestion.js';

export {
  SANITIZER_VERSION,
  decodeHtmlEntities,
  stripInvisibleCharacters,
  sanitizeHtml,
  sanitizeText,
} from './sanitizer.js';

export {
  NORMALIZER_VERSION,
  computeNormalizedHash,
  normalizeLicenseSlug,
  parseDateOrNull,
  createNormalizationService,
} from './normalization.js';

export type {
  ArtifactType,
  NormalizedMetricType,
  DocumentRevisionStatus,
  NormalizedDocument,
  NormalizedMetricObservation,
  NormalizationResult,
  RawItemInput,
  NormalizationServicePort,
  NormalizationServiceOptions,
} from './normalization.js';

export {
  DEDUPLICATION_ALGORITHM_VERSION,
  DEDUPLICATION_THRESHOLD,
  DEDUPLICATION_BOILERPLATE_RULE_VERSION,
  DEDUPLICATION_STAGE,
  normalizeCanonicalUrl,
  tokenizeTextForFingerprint,
  computeSimHash,
  computeTitleFingerprint,
  computeBodyFingerprint,
  computeHammingDistance,
  computeFingerprintSimilarity,
  computeExactBodyHash,
  createDeduplicationService,
} from './deduplication.js';

export {
  TOPIC_TAXONOMY_VERSION,
  TOPIC_CLASSIFIER_VERSION,
  TOPIC_TAXONOMY,
  classifyTopics,
  createTopicClassifier,
} from './topic-classification.js';
export type {
  TopicTaxonomyEntry,
  TopicClassificationInput,
  TopicClassification,
} from './topic-classification.js';

export {
  CHUNKER_VERSION,
  DEFAULT_CHUNK_MAX_TOKENS,
  chunkDocument,
  createChunker,
} from './chunking.js';
export type { ChunkingInput, ChunkDraft, ChunkingResult } from './chunking.js';

export {
  classifyFailure,
  createReplayService,
  redactErrorSummary,
  InvalidReplayRequestError,
  ReplayTargetNotFoundError,
} from './replay.js';
export type {
  ReplayScope,
  ReplayStage,
  ReplayStatus,
  FailureDisposition,
  ReplayRequest,
  ReplayResult,
  ReplayPublisherPort,
  ReplayAuditEvent,
  ReplayAuditPort,
  ReplayTargetPort,
} from './replay.js';

export { createEnrichmentService } from './enrichment.js';
export type {
  EnrichmentInput,
  EnrichmentResult,
  EnrichmentServiceOptions,
  EnrichmentServicePort,
} from './enrichment.js';

export {
  METRIC_TYPES,
  METRIC_UNITS,
  MetricAggregationError,
  validateMetricObservation,
  validateCohortMetricType,
  aggregateMetricObservations,
  createMetricAggregationService,
} from './metrics.js';
export type {
  DuplicateMembershipStatus,
  MetricAggregationObservation,
  AggregatedMetricObservation,
  MetricAggregationServicePort,
} from './metrics.js';
export {
  diagnoseCoverageReasons,
  validateCoverageWindow,
  evaluateCohortComparison,
} from './coverage-service.js';
export { createEmbeddingService } from './embedding-service.js';
export type {
  EmbeddingChunkInput,
  EmbeddingServiceCaps,
  EmbeddingServiceOptions,
  ChunkEmbeddingStatus,
  ChunkEmbeddingResult,
  EmbeddingService,
} from './embedding-service.js';
export {
  createProviderBudgetService,
  calculateTokenUnits,
  estimateTokenCount,
  assertValidModelProfile,
  assertValidBudgetCaps,
  assertValidPriceRate,
} from './provider-budget.js';
export type {
  BudgetLane,
  PriceRate,
  ModelPricingTable,
  ExecutionCaps,
  BudgetedChatOptions,
  BudgetedEmbeddingOptions,
  ProviderBudgetService,
} from './provider-budget.js';
export type { CoverageDiagnosisInput, MemberCoverageEvaluation } from './coverage-service.js';

export type {
  DeduplicationMatchReason,
  NearDuplicateReviewReason,
  DeduplicationMatch,
  NearDuplicateCandidate,
  DeduplicationTargetDoc,
  ExistingDedupDocument,
  DeduplicationResult,
  DeduplicationServiceOptions,
  DeduplicationServicePort,
} from './deduplication.js';

export {
  DEFAULT_RAW_RETENTION_DAYS,
  PIPELINE_EVENTS_RETENTION_DAYS,
  QUERY_RUNS_RETENTION_DAYS,
  SOURCE_RAW_RETENTION_DAYS,
  CONFIRM_IRREVERSIBLE_PURGE_TOKEN,
  IrreversibleActionRefusalError,
  InvalidRetentionRequestError,
  computeRetentionCutoff,
  isRetentionCandidate,
  createRetentionService,
} from './retention.js';

export type {
  RetentionCountSummary,
  RetentionTargetPort,
  RetentionAuditEvent,
  RetentionAuditPort,
  RetentionPlanOptions,
  RetentionPlanResult,
  RetentionServicePort,
} from './retention.js';

export {
  TombstoneTargetNotFoundError,
  InvalidTombstoneRequestError,
  createTombstoneService,
} from './tombstone.js';

export type {
  TombstoneScope,
  TombstoneRecord,
  CreateTombstoneInput,
  TombstoneResult,
  ReindexResult,
  TombstoneTargetPort,
  TombstoneAuditEvent,
  TombstoneAuditPort,
  TombstoneServicePort,
} from './tombstone.js';

export {
  CONFIRM_RESTORE_OVERWRITE_TOKEN,
  UnsafeRestoreRefusalError,
  InvalidBackupManifestError,
  validateBackupManifest,
  createBackupRestoreService,
} from './backup-restore.js';

export type {
  BackupTableManifest,
  BackupManifest,
  BackupValidationResult,
  RestoreEnvironmentPort,
  RestoreAuditEvent,
  RestoreAuditPort,
  RestoreDrillOptions,
  RestoreDrillResult,
  BackupRestoreServicePort,
} from './backup-restore.js';

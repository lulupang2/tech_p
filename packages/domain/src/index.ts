export {
  AiPortError,
  AiProviderError,
  AiTimeoutError,
  UnsupportedAiInputError,
  createDeterministicChatPort,
  createDeterministicEmbeddingPort,
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
} from './ai.js';
export type {
  SourceRecord,
  CollectionRunStatus,
  CollectionRunRecord,
  CreateCollectionRunInput,
  UpdateCollectionRunInput,
  CollectionRunRepositoryPort,
  RawItemRecord,
  UpsertRawItemInput,
  UpsertRawItemResult,
  RawItemRepositoryPort,
  PipelineEventStatus,
  PipelineEventRecord,
  CreatePipelineEventInput,
  PipelineEventRepositoryPort,
  DocumentRecord,
  DocumentRevisionRecord,
  ChunkRecord,
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

export {
  AnswerRequestSchema,
  AnswerResponseSchema,
  CitationSchema,
  CollectionJobPayloadSchema,
  ReplayJobPayloadSchema,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
  CoverageSchema,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  ErrorSchema,
  HealthLiveResponseSchema,
  HealthReadyDependenciesSchema,
  HealthReadyResponseSchema,
  HealthStatusSchema,
  LicenseSchema,
  MetricTypeSchema,
  ObservationSchema,
  ResolvedTimeRangeSchema,
  SourceKeySchema,
  TimeRangeSchema,
  ValidationIssueSchema,
} from './schemas.js';

export type {
  AnswerRequest,
  AnswerResponse,
  Citation,
  CollectionJobPayload,
  ReplayJobPayload,
  ContractError,
  Coverage,
  ErrorCode,
  ErrorEnvelope,
  HealthLiveResponse,
  HealthReadyDependencies,
  HealthReadyResponse,
  HealthStatus,
  License,
  MetricType,
  Observation,
  ResolvedTimeRange,
  SourceKey,
  TimeRange,
  ValidationIssue,
} from './schemas.js';

export {
  ContractValidationError,
  mapValidationFailureTo400,
  parseAnswerRequest,
  parseAnswerResponse,
  parseCollectionJobPayload,
  parseErrorEnvelope,
  parseHealthLiveResponse,
  parseHealthReadyResponse,
  parseReplayJobPayload,
  safeParseAnswerRequest,
  safeParseAnswerResponse,
  safeParseCollectionJobPayload,
  safeParseErrorEnvelope,
  safeParseHealthLiveResponse,
  safeParseHealthReadyResponse,
  safeParseReplayJobPayload,
  sanitizeAnswerResponse,
} from './validation.js';

export type {
  BadRequestValidationResponse,
  SafeParseResult,
  ValidationFailure,
  ValidationSuccess,
} from './validation.js';

/** Marker retained for the initial workspace package boundary. */
export interface WorkspaceMarker {
  readonly package: '@techpulse/contracts';
}

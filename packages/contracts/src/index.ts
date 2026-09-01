export {
  AnswerRequestSchema,
  AnswerResponseSchema,
  CitationSchema,
  CollectionJobPayloadSchema,
  CONTRACT_SCHEMA_VERSION,
  CONTRACT_VERSION,
  CoverageSchema,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  ErrorSchema,
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
  ContractError,
  Coverage,
  ErrorCode,
  ErrorEnvelope,
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
  safeParseAnswerRequest,
  safeParseAnswerResponse,
  safeParseCollectionJobPayload,
  sanitizeAnswerResponse,
  safeParseErrorEnvelope,
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

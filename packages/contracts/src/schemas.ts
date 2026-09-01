import { t, type Static } from 'elysia';

export const CONTRACT_VERSION = 'v1' as const;
export const CONTRACT_SCHEMA_VERSION = 1 as const;

const sourceKeys = [
  'github_releases',
  'stack_exchange',
  'users_rust_lang',
  'arxiv',
  'chrome_release_notes',
  'react_blog',
  'chrome_origin_trials',
  'npm_registry',
  'npm_downloads',
  'github_search',
  'huggingface_hub',
] as const;

const metricTypes = [
  'community_mentions',
  'issue_discussion',
  'repo_attention',
  'source_diversity',
  'release_activity',
  'paper_activity',
  'model_activity',
  'package_downloads',
] as const;

const dateTime = t.String({ format: 'date-time' });
const nonEmptyString = t.String({ minLength: 1 });
const identifier = t.String({ minLength: 1, maxLength: 256 });

export const SourceKeySchema = t.Union(sourceKeys.map((key) => t.Literal(key)));
export type SourceKey = Static<typeof SourceKeySchema>;

export const MetricTypeSchema = t.Union(metricTypes.map((metric) => t.Literal(metric)));
export type MetricType = Static<typeof MetricTypeSchema>;

export const TimeRangeSchema = t.Object(
  {
    from: dateTime,
    to: dateTime,
  },
  { additionalProperties: false },
);
export type TimeRange = Static<typeof TimeRangeSchema>;

export const AnswerRequestSchema = t.Object(
  {
    question: t.String({ minLength: 1, maxLength: 2_000 }),
    timeRange: t.Optional(TimeRangeSchema),
    timezone: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
    language: t.Optional(t.Union([t.Literal('ko'), t.Literal('en')])),
  },
  { additionalProperties: false },
);
export type AnswerRequest = Static<typeof AnswerRequestSchema>;

export const LicenseSchema = t.Object(
  {
    id: nonEmptyString,
    name: nonEmptyString,
    url: t.String({ format: 'uri' }),
    attribution: nonEmptyString,
  },
  { additionalProperties: false },
);
export type License = Static<typeof LicenseSchema>;

export const CitationSchema = t.Object(
  {
    id: identifier,
    documentRevisionId: identifier,
    title: nonEmptyString,
    source: SourceKeySchema,
    url: t.String({ format: 'uri' }),
    publishedAt: t.Union([dateTime, t.Null()]),
    excerpt: t.Optional(t.String()),
    excerptIsVerbatim: t.Boolean(),
    license: t.Optional(LicenseSchema),
  },
  { additionalProperties: false },
);
export type Citation = Static<typeof CitationSchema>;

export const ObservationSchema = t.Object(
  {
    subject: nonEmptyString,
    metric: MetricTypeSchema,
    value: t.Number(),
    unit: nonEmptyString,
    change: t.Union([t.Number(), t.Null()]),
  },
  { additionalProperties: false },
);
export type Observation = Static<typeof ObservationSchema>;

export const ResolvedTimeRangeSchema = t.Object(
  {
    from: dateTime,
    to: dateTime,
    timezone: nonEmptyString,
  },
  { additionalProperties: false },
);
export type ResolvedTimeRange = Static<typeof ResolvedTimeRangeSchema>;

export const CoverageSchema = t.Object(
  {
    dataFreshThrough: dateTime,
    sourcesUsed: t.Integer({ minimum: 0 }),
    documentsConsidered: t.Integer({ minimum: 0 }),
    limitations: t.Array(t.String()),
  },
  { additionalProperties: false },
);
export type Coverage = Static<typeof CoverageSchema>;

export const AnswerResponseSchema = t.Object(
  {
    requestId: identifier,
    answerId: identifier,
    status: t.Union([
      t.Literal('answered'),
      t.Literal('insufficient_evidence'),
      t.Literal('unsupported_intent'),
    ]),
    intent: nonEmptyString,
    resolvedTimeRange: ResolvedTimeRangeSchema,
    answer: t.Union([t.String(), t.Null()]),
    observations: t.Array(ObservationSchema),
    citations: t.Array(CitationSchema),
    coverage: CoverageSchema,
  },
  { additionalProperties: false },
);
export type AnswerResponse = Static<typeof AnswerResponseSchema>;

export const ErrorCodeSchema = t.Union([
  t.Literal('INVALID_REQUEST'),
  t.Literal('INVALID_TIME_RANGE'),
  t.Literal('UNAUTHENTICATED'),
  t.Literal('FORBIDDEN'),
  t.Literal('NOT_FOUND'),
  t.Literal('RUN_ALREADY_ACTIVE'),
  t.Literal('IDEMPOTENCY_CONFLICT'),
  t.Literal('REQUEST_TOO_LARGE'),
  t.Literal('RATE_LIMITED'),
  t.Literal('MODEL_PROVIDER_ERROR'),
  t.Literal('DEPENDENCY_UNAVAILABLE'),
  t.Literal('ANSWER_TIMEOUT'),
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const ValidationIssueSchema = t.Object(
  {
    path: t.String(),
    reason: nonEmptyString,
  },
  { additionalProperties: false },
);
export type ValidationIssue = Static<typeof ValidationIssueSchema>;

export const ErrorSchema = t.Object(
  {
    code: ErrorCodeSchema,
    message: nonEmptyString,
    details: t.Array(ValidationIssueSchema),
    retryable: t.Boolean(),
  },
  { additionalProperties: false },
);
export type ContractError = Static<typeof ErrorSchema>;

export const ErrorEnvelopeSchema = t.Object(
  {
    requestId: identifier,
    error: ErrorSchema,
  },
  { additionalProperties: false },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const CollectionJobPayloadSchema = t.Object(
  {
    schemaVersion: t.Literal(CONTRACT_SCHEMA_VERSION),
    collectionRunId: identifier,
    sourceKey: SourceKeySchema,
    cursor: t.Union([t.String({ maxLength: 4_096 }), t.Null()]),
  },
  { additionalProperties: false },
);
export type CollectionJobPayload = Static<typeof CollectionJobPayloadSchema>;

/** Elysia must disable normalization to preserve strict request rejection. */
export const ElysiaContractOptions = {
  normalize: false,
} as const;

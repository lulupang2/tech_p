import { Type, type Static } from '@sinclair/typebox';
import { FormatRegistry } from '@sinclair/typebox/type';

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

if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set(
    'date-time',
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  );
}

if (!FormatRegistry.Has('uri')) {
  FormatRegistry.Set('uri', (value) => {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  });
}

const dateTime = Type.String({ format: 'date-time' });
const nonEmptyString = Type.String({ minLength: 1 });
const identifier = Type.String({ minLength: 1, maxLength: 256 });

export const SourceKeySchema = Type.Union(sourceKeys.map((key) => Type.Literal(key)));
export type SourceKey = Static<typeof SourceKeySchema>;

export const MetricTypeSchema = Type.Union(metricTypes.map((metric) => Type.Literal(metric)));
export type MetricType = Static<typeof MetricTypeSchema>;

export const ReplayJobPayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    replayId: identifier,
    naturalKey: identifier,
    scope: Type.Union([Type.Literal('run'), Type.Literal('raw'), Type.Literal('stage')]),
    targetId: identifier,
    stage: Type.Union([Type.Literal('normalization'), Type.Literal('deduplication')]),
    requestedAt: dateTime,
  },
  { additionalProperties: false },
);
export type ReplayJobPayload = Static<typeof ReplayJobPayloadSchema>;

export const TimeRangeSchema = Type.Object(
  {
    from: dateTime,
    to: dateTime,
  },
  { additionalProperties: false },
);
export type TimeRange = Static<typeof TimeRangeSchema>;

export const AnswerRequestSchema = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    timeRange: Type.Optional(TimeRangeSchema),
    timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    language: Type.Optional(Type.Union([Type.Literal('ko'), Type.Literal('en')])),
  },
  { additionalProperties: false },
);
export type AnswerRequest = Static<typeof AnswerRequestSchema>;

export const LicenseSchema = Type.Object(
  {
    id: nonEmptyString,
    name: nonEmptyString,
    url: Type.String({ format: 'uri' }),
    attribution: nonEmptyString,
  },
  { additionalProperties: false },
);
export type License = Static<typeof LicenseSchema>;

export const CitationSchema = Type.Object(
  {
    id: identifier,
    documentRevisionId: identifier,
    title: nonEmptyString,
    source: SourceKeySchema,
    url: Type.String({ format: 'uri' }),
    publishedAt: Type.Union([dateTime, Type.Null()]),
    excerpt: Type.Optional(Type.String()),
    excerptIsVerbatim: Type.Boolean(),
    license: Type.Optional(LicenseSchema),
  },
  { additionalProperties: false },
);
export type Citation = Static<typeof CitationSchema>;

export const ObservationSchema = Type.Object(
  {
    subject: nonEmptyString,
    metric: MetricTypeSchema,
    value: Type.Number(),
    unit: nonEmptyString,
    change: Type.Union([Type.Number(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type Observation = Static<typeof ObservationSchema>;

export const ResolvedTimeRangeSchema = Type.Object(
  {
    from: dateTime,
    to: dateTime,
    timezone: nonEmptyString,
  },
  { additionalProperties: false },
);
export type ResolvedTimeRange = Static<typeof ResolvedTimeRangeSchema>;

export const CoverageSchema = Type.Object(
  {
    dataFreshThrough: dateTime,
    sourcesUsed: Type.Integer({ minimum: 0 }),
    documentsConsidered: Type.Integer({ minimum: 0 }),
    limitations: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export type Coverage = Static<typeof CoverageSchema>;

export const AnswerResponseSchema = Type.Object(
  {
    requestId: identifier,
    answerId: identifier,
    status: Type.Union([
      Type.Literal('answered'),
      Type.Literal('insufficient_evidence'),
      Type.Literal('unsupported_intent'),
    ]),
    intent: nonEmptyString,
    resolvedTimeRange: ResolvedTimeRangeSchema,
    answer: Type.Union([Type.String(), Type.Null()]),
    observations: Type.Array(ObservationSchema),
    citations: Type.Array(CitationSchema),
    coverage: CoverageSchema,
  },
  { additionalProperties: false },
);
export type AnswerResponse = Static<typeof AnswerResponseSchema>;

export const ErrorCodeSchema = Type.Union([
  Type.Literal('INVALID_REQUEST'),
  Type.Literal('INVALID_TIME_RANGE'),
  Type.Literal('UNAUTHENTICATED'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('RUN_ALREADY_ACTIVE'),
  Type.Literal('IDEMPOTENCY_CONFLICT'),
  Type.Literal('REQUEST_TOO_LARGE'),
  Type.Literal('RATE_LIMITED'),
  Type.Literal('MODEL_PROVIDER_ERROR'),
  Type.Literal('DEPENDENCY_UNAVAILABLE'),
  Type.Literal('ANSWER_TIMEOUT'),
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const ValidationIssueSchema = Type.Object(
  {
    path: Type.String(),
    reason: nonEmptyString,
  },
  { additionalProperties: false },
);
export type ValidationIssue = Static<typeof ValidationIssueSchema>;

export const ErrorSchema = Type.Object(
  {
    code: ErrorCodeSchema,
    message: nonEmptyString,
    details: Type.Array(ValidationIssueSchema),
    retryable: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ContractError = Static<typeof ErrorSchema>;

export const ErrorEnvelopeSchema = Type.Object(
  {
    requestId: identifier,
    error: ErrorSchema,
  },
  { additionalProperties: false },
);
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const CollectionJobPayloadSchema = Type.Object(
  {
    schemaVersion: Type.Literal(CONTRACT_SCHEMA_VERSION),
    collectionRunId: identifier,
    sourceKey: SourceKeySchema,
    cursor: Type.Union([Type.String({ maxLength: 4_096 }), Type.Null()]),
  },
  { additionalProperties: false },
);
export type CollectionJobPayload = Static<typeof CollectionJobPayloadSchema>;

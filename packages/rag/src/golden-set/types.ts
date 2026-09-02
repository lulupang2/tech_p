import { Type, type Static } from '@sinclair/typebox';
import { MetricTypeSchema } from '@techpulse/contracts';

export const GoldenSetStatusSchema = Type.Union([
  Type.Literal('answered'),
  Type.Literal('insufficient_evidence'),
  Type.Literal('unsupported_intent'),
]);
export type GoldenSetStatus = Static<typeof GoldenSetStatusSchema>;

export const GoldenSetIntentSchema = Type.Union([
  Type.Literal('trend_summary'),
  Type.Literal('recent_updates'),
  Type.Literal('compare_interest'),
  Type.Literal('emerging_topics'),
  Type.Literal('unsupported_intent'),
]);
export type GoldenSetIntent = Static<typeof GoldenSetIntentSchema>;

export const GoldenSetCategorySchema = Type.Union([
  Type.Literal('user_example'),
  Type.Literal('language_alias'),
  Type.Literal('time_boundary'),
  Type.Literal('evidence_and_conflict'),
  Type.Literal('metric_calculation'),
  Type.Literal('license_and_citation'),
  Type.Literal('security_injection'),
  Type.Literal('deduplication'),
  Type.Literal('additional_english'),
]);
export type GoldenSetCategory = Static<typeof GoldenSetCategorySchema>;

export const ExpectedMetricSchema = Type.Object(
  {
    metric: MetricTypeSchema,
    unit: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ExpectedMetric = Static<typeof ExpectedMetricSchema>;

export const ExpectedTimeRangeSchema = Type.Object(
  {
    from: Type.Union([Type.String(), Type.Null()]),
    to: Type.Union([Type.String(), Type.Null()]),
    description: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ExpectedTimeRange = Static<typeof ExpectedTimeRangeSchema>;

export const GoldenSetItemSchema = Type.Object(
  {
    id: Type.String({ pattern: '^G-\\d{3}$' }),
    question: Type.String({ minLength: 1 }),
    category: GoldenSetCategorySchema,
    intent: GoldenSetIntentSchema,
    isSecurityInjection: Type.Boolean(),
    injectionContent: Type.Optional(Type.String()),
    relevanceCriteria: Type.Array(Type.String()),
    allowedClaims: Type.Array(Type.String({ minLength: 1 })),
    forbiddenClaims: Type.Array(Type.String({ minLength: 1 })),
    expectedStatus: GoldenSetStatusSchema,
    expectedTimeRange: ExpectedTimeRangeSchema,
    expectedMetrics: Type.Array(ExpectedMetricSchema),
    expectedLimitations: Type.Array(Type.String()),
    notes: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type GoldenSetItem = {
  readonly id: string;
  readonly question: string;
  readonly category: GoldenSetCategory;
  readonly intent: GoldenSetIntent;
  readonly isSecurityInjection: boolean;
  readonly injectionContent?: string;
  readonly relevanceCriteria: readonly string[];
  readonly allowedClaims: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly expectedStatus: GoldenSetStatus;
  readonly expectedTimeRange: ExpectedTimeRange;
  readonly expectedMetrics: readonly ExpectedMetric[];
  readonly expectedLimitations: readonly string[];
  readonly notes: string;
};

export const GoldenSetMetadataSchema = Type.Object(
  {
    version: Type.String({ minLength: 1 }),
    reviewer: Type.Literal('Signal Archive Evaluation Team'),
    reviewedAt: Type.String({ minLength: 1 }),
    totalItems: Type.Integer({ minimum: 1 }),
    questionCount: Type.Integer({ minimum: 1 }),
    securityInjectionCount: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);
export type GoldenSetMetadata = Static<typeof GoldenSetMetadataSchema>;

export const GoldenSetCollectionSchema = Type.Object(
  {
    metadata: GoldenSetMetadataSchema,
    items: Type.Array(GoldenSetItemSchema),
  },
  { additionalProperties: false },
);

export type GoldenSetCollection = {
  readonly metadata: GoldenSetMetadata;
  readonly items: readonly GoldenSetItem[];
};

export type GoldenSetDataset = GoldenSetCollection;

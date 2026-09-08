import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { SourceKeySchema } from './schemas.js';
import { ContractValidationError } from './validation.js';

const text = Type.String({ minLength: 1, maxLength: 512 });
const id = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const utc = Type.String({ format: 'date-time', maxLength: 32 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const options = { additionalProperties: false } as const;
export const CollectionDeliverySchema = Type.Object({ schemaVersion: Type.Literal(2), deliveryId: id }, options);
export type CollectionDeliveryPayload = Static<typeof CollectionDeliverySchema>;
export const TargetSelectorSchema = Type.Union([
  Type.Object({ kind: Type.Literal('repository'), owner: text, repository: text }, options),
  Type.Object({ kind: Type.Literal('tag'), site: text, tag: text }, options),
  Type.Object({ kind: Type.Literal('package'), name: text }, options),
  Type.Object({ kind: Type.Literal('query'), query: text }, options),
  Type.Object({ kind: Type.Literal('feed'), url: Type.String({ format: 'uri', maxLength: 2048 }) }, options),
  Type.Object({ kind: Type.Literal('category'), category: text }, options),
  Type.Object({ kind: Type.Literal('source') }, options),
]);
export const TargetPolicySchema = Type.Object({
  version: text, approved: Type.Boolean(), fetch: Type.Boolean(), store: Type.Boolean(), embed: Type.Boolean(),
  modelInput: Type.Boolean(), displayExcerpt: Type.Boolean(), licenseId: Type.Union([text, Type.Null()]), verbatimOnly: Type.Boolean(),
}, options);
export const TargetCapabilitySchema = Type.Object({
  historyMode: Type.Union((['historical_range','paginated_history','feed_only','snapshot_only'] as const).map((item) => Type.Literal(item))),
  timeBasis: Type.Union((['published_at','updated_at','observed_at'] as const).map((item) => Type.Literal(item))),
  cursorVersion: Type.Integer({ minimum: 1 }), canSearch: Type.Boolean(), canDiscover: Type.Boolean(),
  stablePagination: Type.Boolean(), canCollect: Type.Boolean(),
  reviewedAt: Type.Union([utc, Type.Null()]), earliestAvailableAt: Type.Union([utc, Type.Null()]),
}, options);
export const RegisterTargetSchema = Type.Object({
  sourceId: id, sourceKey: SourceKeySchema, canonicalIdentity: text, selector: TargetSelectorSchema,
  capability: TargetCapabilitySchema, policyVersion: text, topicIds: Type.Array(id, { maxItems: 32, uniqueItems: true }),
  taxonomyVersion: text,
  enabled: Type.Literal(false), cadenceMs: Type.Union([Type.Integer({ minimum: 60000 }), Type.Null()]), overlapMs: Type.Integer({ minimum: 0, maximum: 86400000 }),
}, options);
export const PartitionPlanSchema = Type.Object({
  targetRevisionId: id, mode: Type.Union((['backfill','incremental','on_demand'] as const).map((item) => Type.Literal(item))),
  scopeKey: text, from: utc, to: utc,
  timeBasis: Type.Union((['published_at','updated_at','observed_at'] as const).map((item) => Type.Literal(item))),
  workflowVersion: text, dryRun: Type.Boolean(),
}, options);
export const CoverageQuerySchema = Type.Object({
  from: utc, to: utc, topicId: Type.Optional(id),
}, options);
export const CoverageReportSchema = Type.Object({
  generatedAt: utc, from: utc, to: utc, rawDocuments: count, lexicalDocuments: count, vectorDocuments: count,
  partitionsChecked: count, partitionsCompleted: count, partitionsPartial: count,
  reasons: Type.Array(Type.Union((['raw_shortage','processing_pending','period_gap','retrieval_miss','unknown'] as const).map((item) => Type.Literal(item))), { uniqueItems: true, maxItems: 5 }),
}, options);
export type CoverageReportResponse = Static<typeof CoverageReportSchema>;
export type CoverageQuery = Static<typeof CoverageQuerySchema>;
export type RegisterTarget = Static<typeof RegisterTargetSchema>;
export type PartitionPlanRequest = Static<typeof PartitionPlanSchema>;
export const OpsCommandSchema = Type.Object({
  actor: Type.String({ minLength: 1, maxLength: 128 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 128 }),
}, options);
export const OpsEntityParamsSchema = Type.Object({ id }, options);
export const OpsListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  after: Type.Optional(id),
}, options);
export const ReviewCandidateSchema = Type.Object({
  ...OpsCommandSchema.properties,
  decision: Type.Union([Type.Literal('accepted'), Type.Literal('rejected')]),
  targetId: Type.Union([id, Type.Null()]),
}, options);
export const ReconcileModelWorkSchema = Type.Object({
  ...OpsCommandSchema.properties,
  expectedEpoch: Type.Integer({ minimum: 1 }),
  evidenceReference: Type.String({ minLength: 1, maxLength: 256 }),
  actualUnits: count,
  actualTokens: count,
  outcome: Type.Union([Type.Literal('completed'), Type.Literal('not_executed')]),
}, options);
export type OpsCommand = Static<typeof OpsCommandSchema>;
export type ReviewCandidateRequest = Static<typeof ReviewCandidateSchema>;
export type ReconcileModelWorkRequest = Static<typeof ReconcileModelWorkSchema>;

export function parsePartitionPlan(value: unknown): PartitionPlanRequest {
  if (!Value.Check(PartitionPlanSchema, value)) throw new ContractValidationError([{ path: '', reason: 'invalid_partition_plan' }]);
  if (Date.parse(value.from) >= Date.parse(value.to)) throw new ContractValidationError([{ path: 'to', reason: 'invalid_window' }]);
  return value;
}
export const COVERAGE_ROUTES = {
  coverage: '/api/v1/coverage', targets: '/api/v1/ops/targets', partitions: '/api/v1/ops/partitions',
  candidates: '/api/v1/ops/candidates', work: '/api/v1/ops/model-work',
} as const;

export function parseCollectionDelivery(value: unknown): CollectionDeliveryPayload {
  if (!Value.Check(CollectionDeliverySchema, value)) throw new ContractValidationError([{ path: '', reason: 'invalid_delivery' }]);
  return value;
}
export function parseCoverageQuery(value: unknown): CoverageQuery {
  if (!Value.Check(CoverageQuerySchema, value)) throw new ContractValidationError([{ path: '', reason: 'invalid_coverage_query' }]);
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (from >= to || to - from > 366 * 86400000) throw new ContractValidationError([{ path: 'to', reason: 'invalid_window' }]);
  return value;
}

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  customType,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';

const utcTimestamp = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    baseUrl: text('base_url').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    scheduleConfig: jsonb('schedule_config').$type<Record<string, unknown>>().notNull().default({}),
    policyReviewedAt: timestamp('policy_reviewed_at', { withTimezone: true, mode: 'date' }),
    createdAt: utcTimestamp('created_at'),
    updatedAt: utcTimestamp('updated_at'),
  },
  (table) => [
    unique('sources_key_unique').on(table.key),
    check('sources_key_nonempty', sql`length(trim(${table.key})) > 0`),
    check('sources_base_url_http', sql`${table.baseUrl} ~ '^https?://'`),
  ],
);

export const collectionRuns = pgTable(
  'collection_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull().default('pending'),
    cursorBefore: text('cursor_before'),
    cursorAfter: text('cursor_after'),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    errorSummary: text('error_summary'),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('collection_runs_source_id_unique').on(table.sourceId, table.id),
    index('collection_runs_source_scheduled_idx').on(table.sourceId, table.scheduledAt),
    check(
      'collection_runs_status_valid',
      sql`${table.status} IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'collection_runs_times_ordered',
      sql`${table.endedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`,
    ),
  ],
);

export const rawItems = pgTable(
  'raw_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    runId: uuid('run_id').notNull(),
    externalId: text('external_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    payload: jsonb('payload').$type<unknown>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    collectedAt: utcTimestamp('collected_at'),
    httpMetadata: jsonb('http_metadata').$type<Record<string, unknown>>().notNull().default({}),
    rightsMetadata: jsonb('rights_metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    foreignKey({
      columns: [table.sourceId, table.runId],
      foreignColumns: [collectionRuns.sourceId, collectionRuns.id],
      name: 'raw_items_source_run_consistency_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    unique('raw_items_revision_identity_unique').on(
      table.sourceId,
      table.externalId,
      table.payloadHash,
    ),
    index('raw_items_source_external_idx').on(table.sourceId, table.externalId),
    index('raw_items_payload_hash_idx').on(table.payloadHash),
    check('raw_items_external_id_nonempty', sql`length(trim(${table.externalId})) > 0`),
    check('raw_items_canonical_url_http', sql`${table.canonicalUrl} ~ '^https?://'`),
    check('raw_items_payload_hash_sha256', sql`${table.payloadHash} ~ '^[0-9a-fA-F]{64}$'`),
  ],
);

export const pipelineEvents = pgTable(
  'pipeline_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    rawItemId: uuid('raw_item_id')
      .notNull()
      .references(() => rawItems.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    stage: text('stage').notNull(),
    processorVersion: text('processor_version').notNull(),
    status: text('status').notNull(),
    attempt: integer('attempt').notNull().default(1),
    errorCode: text('error_code'),
    occurredAt: utcTimestamp('occurred_at'),
  },
  (table) => [
    index('pipeline_events_raw_item_occurred_idx').on(table.rawItemId, table.occurredAt),
    check('pipeline_events_stage_nonempty', sql`length(trim(${table.stage})) > 0`),
    check('pipeline_events_attempt_positive', sql`${table.attempt} > 0`),
    check(
      'pipeline_events_status_valid',
      sql`${table.status} IN ('started', 'succeeded', 'failed', 'skipped', 'quarantined')`,
    ),
  ],
);

export const customVector = customType<{
  data: number[];
  config: { dimensions?: number };
  driverData: string;
}>({
  dataType(config) {
    return config?.dimensions ? `vector(${config.dimensions})` : 'vector';
  },
  toDriver(value: number[]): string {
    return JSON.stringify(value);
  },
  fromDriver(value: string): number[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      return value
        .replace(/^\[|\]$/gu, '')
        .split(',')
        .map((x) => Number(x.trim()));
    }
    return [];
  },
});

export const licenses = pgTable(
  'licenses',
  {
    id: text('id').primaryKey(),
    spdxId: text('spdx_id'),
    name: text('name').notNull(),
    url: text('url'),
    requiresAttribution: boolean('requires_attribution').notNull().default(true),
    isShareAlike: boolean('is_share_alike').notNull().default(false),
    allowsCommercial: boolean('allows_commercial').notNull().default(true),
    notes: text('notes'),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [check('licenses_id_slug', sql`${table.id} ~ '^[a-z0-9.-]+$'`)],
);

export const duplicateClusters = pgTable(
  'duplicate_clusters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    representativeDocumentId: uuid('representative_document_id'),
    algorithmVersion: text('algorithm_version').notNull(),
    confidence: integer('confidence').notNull().default(100),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    check('duplicate_clusters_confidence_range', sql`${table.confidence} BETWEEN 0 AND 100`),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    artifactType: text('artifact_type').notNull().default('article'),
    canonicalUrl: text('canonical_url'),
    duplicateClusterId: uuid('duplicate_cluster_id').references(() => duplicateClusters.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    currentRevisionId: uuid('current_revision_id'),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    index('documents_duplicate_cluster_idx').on(table.duplicateClusterId),
    check(
      'documents_artifact_type_valid',
      sql`${table.artifactType} IN ('article', 'release_note', 'forum_post', 'qa_post', 'paper')`,
    ),
    check(
      'documents_canonical_url_http',
      sql`${table.canonicalUrl} IS NULL OR ${table.canonicalUrl} ~ '^https?://'`,
    ),
  ],
);

export const documentRevisions = pgTable(
  'document_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    rawItemId: uuid('raw_item_id').references(() => rawItems.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    title: text('title').notNull(),
    bodyText: text('body_text').notNull(),
    author: text('author'),
    language: text('language').notNull().default('ko'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    licenseId: text('license_id').references(() => licenses.id, {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    }),
    normalizedHash: text('normalized_hash').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    status: text('status').notNull().default('pending'),
    searchableAt: timestamp('searchable_at', { withTimezone: true, mode: 'date' }),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('document_revisions_doc_hash_unique').on(table.documentId, table.normalizedHash),
    index('document_revisions_status_published_idx').on(table.status, table.publishedAt),
    check('document_revisions_title_nonempty', sql`length(trim(${table.title})) > 0`),
    check(
      'document_revisions_normalized_hash_sha256',
      sql`${table.normalizedHash} ~ '^[0-9a-fA-F]{64}$'`,
    ),
    check(
      'document_revisions_status_valid',
      sql`${table.status} IN ('pending', 'processing', 'searchable', 'quarantined', 'tombstoned')`,
    ),
  ],
);

/**
 * Versioned, append-only cluster membership evidence.  The legacy document pointer remains a
 * read convenience for the active exact-dedup cluster; this table prevents a recluster from
 * rewriting the historical revision/provenance relationship.
 */
export const duplicateClusterMemberships = pgTable(
  'duplicate_cluster_memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => duplicateClusters.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    revisionId: uuid('revision_id')
      .notNull()
      .references(() => documentRevisions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    rawItemId: uuid('raw_item_id').references(() => rawItems.id, {
      onDelete: 'restrict',
      onUpdate: 'cascade',
    }),
    algorithmVersion: text('algorithm_version').notNull(),
    confidence: integer('confidence').notNull(),
    status: text('status').notNull().default('suggested'),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('duplicate_cluster_memberships_identity_unique').on(
      table.clusterId,
      table.documentId,
      table.revisionId,
      table.algorithmVersion,
    ),
    index('duplicate_cluster_memberships_document_idx').on(table.documentId, table.createdAt),
    check(
      'duplicate_cluster_memberships_confidence_range',
      sql`${table.confidence} BETWEEN 0 AND 100`,
    ),
    check(
      'duplicate_cluster_memberships_status_valid',
      sql`${table.status} IN ('suggested', 'accepted', 'superseded')`,
    ),
  ],
);

export const topics = pgTable(
  'topics',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    slug: text('slug').notNull(),
    displayName: text('display_name').notNull(),
    parentId: uuid('parent_id'),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    taxonomyVersion: text('taxonomy_version').notNull().default('v1'),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('topics_slug_taxonomy_unique').on(table.slug, table.taxonomyVersion),
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: 'topics_parent_id_fk',
    })
      .onDelete('set null')
      .onUpdate('cascade'),
    check('topics_slug_format', sql`${table.slug} ~ '^[a-z0-9-]+$'`),
  ],
);

export const documentTopics = pgTable(
  'document_topics',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    method: text('method').notNull().default('deterministic'),
    confidence: integer('confidence').notNull().default(100),
    classifierVersion: text('classifier_version').notNull().default('v1'),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('document_topics_unique').on(table.documentId, table.topicId, table.classifierVersion),
    index('document_topics_topic_doc_idx').on(table.topicId, table.documentId),
    check('document_topics_confidence_range', sql`${table.confidence} BETWEEN 0 AND 100`),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentRevisionId: uuid('document_revision_id')
      .notNull()
      .references(() => documentRevisions.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    headingPath: jsonb('heading_path').$type<string[]>().notNull().default([]),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull(),
    contentHash: text('content_hash').notNull(),
    chunkerVersion: text('chunker_version').notNull(),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('chunks_revision_ordinal_version_unique').on(
      table.documentRevisionId,
      table.ordinal,
      table.chunkerVersion,
    ),
    check('chunks_ordinal_non_negative', sql`${table.ordinal} >= 0`),
    check('chunks_token_count_positive', sql`${table.tokenCount} > 0`),
    check('chunks_content_hash_sha256', sql`${table.contentHash} ~ '^[0-9a-fA-F]{64}$'`),
  ],
);

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: customVector('embedding'),
    inputHash: text('input_hash').notNull(),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('embeddings_chunk_provider_model_hash_unique').on(
      table.chunkId,
      table.provider,
      table.model,
      table.inputHash,
    ),
    check('embeddings_dimensions_positive', sql`${table.dimensions} > 0`),
    check('embeddings_input_hash_sha256', sql`${table.inputHash} ~ '^[0-9a-fA-F]{64}$'`),
  ],
);

export const metricObservations = pgTable(
  'metric_observations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    topicId: uuid('topic_id').references(() => topics.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    subjectKey: text('subject_key').notNull(),
    metricType: text('metric_type').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true, mode: 'date' }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true, mode: 'date' }).notNull(),
    value: integer('value').notNull(),
    unit: text('unit').notNull(),
    collectedAt: utcTimestamp('collected_at'),
    rawItemId: uuid('raw_item_id').references(() => rawItems.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    querySignature: text('query_signature'),
    isIncomplete: boolean('is_incomplete').notNull().default(false),
  },
  (table) => [
    unique('metric_obs_natural_key_unique').on(
      table.sourceId,
      table.subjectKey,
      table.metricType,
      table.windowStart,
      table.windowEnd,
      table.rawItemId,
    ),
    index('metric_obs_subject_metric_window_idx').on(
      table.subjectKey,
      table.metricType,
      table.windowStart,
    ),
    check(
      'metric_obs_metric_type_valid',
      sql`${table.metricType} IN (
        'community_mentions',
        'issue_discussion',
        'repo_attention',
        'source_diversity',
        'release_activity',
        'paper_activity',
        'model_activity',
        'package_downloads'
      )`,
    ),
    check('metric_obs_window_ordered', sql`${table.windowEnd} >= ${table.windowStart}`),
  ],
);

export const queryRuns = pgTable(
  'query_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    requestId: text('request_id').notNull(),
    questionHash: text('question_hash').notNull(),
    parsedQuery: jsonb('parsed_query').$type<Record<string, unknown>>().notNull(),
    retrievalConfig: jsonb('retrieval_config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    workflowVersion: text('workflow_version').notNull(),
    modelMetadata: jsonb('model_metadata').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('completed'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    coverage: jsonb('coverage').$type<Record<string, unknown>>().notNull().default({}),
    usage: jsonb('usage').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    index('query_runs_request_id_idx').on(table.requestId),
    check('query_runs_question_hash_sha256', sql`${table.questionHash} ~ '^[0-9a-fA-F]{64}$'`),
    check(
      'query_runs_status_valid',
      sql`${table.status} IN ('pending', 'running', 'completed', 'failed', 'insufficient_evidence')`,
    ),
  ],
);

export const answerCitations = pgTable(
  'answer_citations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queryRunId: uuid('query_run_id')
      .notNull()
      .references(() => queryRuns.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    citationKey: text('citation_key').notNull(),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    documentRevisionId: uuid('document_revision_id')
      .notNull()
      .references(() => documentRevisions.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    claimIndex: integer('claim_index').notNull().default(0),
    excerpt: text('excerpt').notNull(),
    createdAt: utcTimestamp('created_at'),
  },
  (table) => [
    unique('answer_citations_query_citation_key_unique').on(table.queryRunId, table.citationKey),
    index('answer_citations_chunk_id_idx').on(table.chunkId),
    index('answer_citations_doc_revision_id_idx').on(table.documentRevisionId),
    check('answer_citations_claim_index_non_negative', sql`${table.claimIndex} >= 0`),
    check('answer_citations_excerpt_nonempty', sql`length(trim(${table.excerpt})) > 0`),
  ],
);

export const schema = {
  sources,
  collectionRuns,
  rawItems,
  pipelineEvents,
  licenses,
  duplicateClusters,
  duplicateClusterMemberships,
  documents,
  documentRevisions,
  topics,
  documentTopics,
  chunks,
  embeddings,
  metricObservations,
  queryRuns,
  answerCitations,
};
export type DatabaseSchema = typeof schema;
export type RawItemInsert = typeof rawItems.$inferInsert;
export type DocumentInsert = typeof documents.$inferInsert;
export type DocumentRevisionInsert = typeof documentRevisions.$inferInsert;
export type TopicInsert = typeof topics.$inferInsert;
export type DocumentTopicInsert = typeof documentTopics.$inferInsert;
export type ChunkInsert = typeof chunks.$inferInsert;
export type EmbeddingInsert = typeof embeddings.$inferInsert;
export type MetricObservationInsert = typeof metricObservations.$inferInsert;
export type QueryRunInsert = typeof queryRuns.$inferInsert;
export type AnswerCitationInsert = typeof answerCitations.$inferInsert;
/**
 * Inserts a raw revision once. A replay of the same source/external-id/hash
 * returns the original row without mutating its immutable payload or provenance.
 */
export async function upsertRawItem(
  db: NeonDatabase<typeof schema>,
  values: RawItemInsert,
): Promise<typeof rawItems.$inferSelect> {
  const inserted = await db
    .insert(rawItems)
    .values(values)
    .onConflictDoNothing({
      target: [rawItems.sourceId, rawItems.externalId, rawItems.payloadHash],
    })
    .returning();

  if (inserted[0]) return inserted[0];

  const existing = await db.query.rawItems.findFirst({
    where: (item, { and, eq }) =>
      and(
        eq(item.sourceId, values.sourceId),
        eq(item.externalId, values.externalId),
        eq(item.payloadHash, values.payloadHash),
      ),
  });
  if (!existing) throw new Error('Raw revision disappeared during replay');
  return existing;
}

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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

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
    scheduleConfig: jsonb('schedule_config').$type<Record<string, unknown>>().notNull(),
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
    }).onDelete('restrict').onUpdate('cascade'),
    unique('raw_items_revision_identity_unique').on(table.sourceId, table.externalId, table.payloadHash),
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

export const schema = { sources, collectionRuns, rawItems, pipelineEvents };
export type DatabaseSchema = typeof schema;
export type RawItemInsert = typeof rawItems.$inferInsert;

/**
 * Inserts a raw revision once. A replay of the same source/external-id/hash
 * returns the original row without mutating its immutable payload or provenance.
 */
export async function upsertRawItem(
  db: NodePgDatabase<typeof schema>,
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

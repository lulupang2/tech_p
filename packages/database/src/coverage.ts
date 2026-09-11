import { and, eq, gt, lt, ne, sql } from 'drizzle-orm';
import {
  collectionHash,
  CollectionStateError,
  type CollectionWindow,
  type CohortComparison,
  type CohortPort,
  type CoveragePort,
  type CoverageReport,
  type ModelProfile,
  type SearchReadinessPort,
  diagnoseCoverageReasons,
  validateCoverageWindow,
  evaluateCohortComparison,
  type MemberCoverageEvaluation,
  assertValidModelProfile,
} from '@techpulse/domain';
import type { DatabaseClient } from './client.js';
import { createCohortPersistenceRepository } from './cohort-state.js';
import {
  collectionPartitions,
  chunks,
  documentRevisions,
  embeddings,
  rawItems,
  sources,
} from './schema/index.js';

type Database = DatabaseClient['db'];

export function createSearchReadinessRepository(db: Database): SearchReadinessPort {
  return {
    async markLexicalReady(revisionId: string, now: Date): Promise<void> {
      await db.transaction(async (tx) => {
        const [rev] = await tx
          .select()
          .from(documentRevisions)
          .where(eq(documentRevisions.id, revisionId))
          .for('update');
        if (!rev) throw new CollectionStateError('not_found');
        if (rev.status === 'tombstoned' || rev.status === 'quarantined') {
          throw new CollectionStateError('invalid_state');
        }

        const chunkRows = await tx
          .select({ id: chunks.id })
          .from(chunks)
          .where(eq(chunks.documentRevisionId, revisionId));
        if (chunkRows.length === 0) {
          throw new CollectionStateError('invalid_state');
        }

        if (rev.rawItemId) {
          const [raw] = await tx
            .select({ id: rawItems.id, sourceId: rawItems.sourceId })
            .from(rawItems)
            .where(eq(rawItems.id, rev.rawItemId));
          if (raw) {
            const [src] = await tx
              .select({ id: sources.id, enabled: sources.enabled })
              .from(sources)
              .where(eq(sources.id, raw.sourceId));
            if (src && !src.enabled) {
              throw new CollectionStateError('invalid_state');
            }
          }
        }

        await tx
          .update(documentRevisions)
          .set({
            lexicalReadyAt: now,
            searchableAt: rev.searchableAt ?? now,
            status:
              rev.status === 'pending' || rev.status === 'processing' ? 'searchable' : rev.status,
          })
          .where(eq(documentRevisions.id, revisionId));
      });
    },

    async getVectorReadiness(revisionId: string, profile: ModelProfile): Promise<boolean> {
      const [rev] = await db
        .select({ id: documentRevisions.id, status: documentRevisions.status })
        .from(documentRevisions)
        .where(eq(documentRevisions.id, revisionId));
      if (!rev || rev.status === 'tombstoned' || rev.status === 'quarantined') {
        return false;
      }

      const chunkRows = await db
        .select({ id: chunks.id, contentHash: chunks.contentHash })
        .from(chunks)
        .where(eq(chunks.documentRevisionId, revisionId));
      if (chunkRows.length === 0) return false;

      const profileHash = collectionHash(profile);

      for (const chunk of chunkRows) {
        const [emb] = await db
          .select({ id: embeddings.id })
          .from(embeddings)
          .where(
            and(
              eq(embeddings.chunkId, chunk.id),
              eq(embeddings.provider, profile.provider),
              eq(embeddings.model, profile.model),
              eq(embeddings.dimensions, profile.dimensions),
              eq(embeddings.profileHash, profileHash),
              eq(embeddings.inputHash, chunk.contentHash),
            ),
          );
        if (!emb) return false;
      }

      return true;
    },
  };
}

export interface CoverageRepositoryOptions {
  /** Vector counts are zero, rather than "any embedding", when no approved profile is supplied. */
  readonly embeddingProfile?: ModelProfile;
  /** Trusted fixed-run composition; absent means all eligible non-on-demand partitions. */
  readonly scopeKeys?: readonly string[];
  /** Canonical target IDs are independent of optional taxonomy topic assignments. */
  readonly targetIdentities?: readonly string[];
  /** Explicit labeled misses only, matched to the exact query window and topic set. */
  readonly knownMisses?: readonly {
    readonly from: string;
    readonly to: string;
    readonly topicIds: readonly string[];
    readonly labelReference: string;
    readonly missingRevisionIds: readonly string[];
  }[];
}

export function createCoverageRepository(
  db: Database,
  options: CoverageRepositoryOptions = {},
): CoveragePort {
  const profile = options.embeddingProfile;
  if (profile) assertValidModelProfile(profile);
  const profileHash = profile ? collectionHash(profile) : null;
  return {
    async getCoverage(
      window: CollectionWindow,
      topicIds: readonly string[],
      now: Date,
    ): Promise<CoverageReport> {
      validateCoverageWindow(window);

      const topicClause =
        topicIds.length === 0
          ? sql``
          : sql` AND tr.topic_ids ?| ARRAY[${sql.join(
              topicIds.map((id) => sql`${id}`),
              sql`, `,
            )}]::text[]`;
      const scopeClause =
        options.scopeKeys === undefined
          ? sql``
          : options.scopeKeys.length === 0
            ? sql` AND false`
            : sql` AND cp.scope_key IN (${sql.join(
                options.scopeKeys.map((key) => sql`${key}`),
                sql`, `,
              )})`;
      const targetClause =
        options.targetIdentities === undefined
          ? sql``
          : options.targetIdentities.length === 0
            ? sql` AND false`
            : sql` AND ct.canonical_identity IN (${sql.join(
                options.targetIdentities.map((key) => sql`${key}`),
                sql`, `,
              )})`;
      const vectorClause = profile
        ? sql`
        er.rights_metadata ->> 'embed' = 'true' AND er.target_policy ->> 'embed' = 'true'
        AND NOT EXISTS (
          SELECT 1 FROM chunks c WHERE c.document_revision_id = er.id AND NOT EXISTS (
            SELECT 1 FROM embeddings e WHERE e.chunk_id = c.id
              AND e.provider = ${profile.provider} AND e.model = ${profile.model}
              AND e.dimensions = ${profile.dimensions} AND e.profile_hash = ${profileHash}
              AND e.input_hash = c.content_hash
          )
        )`
        : sql`false`;
      const topicKey = JSON.stringify([...new Set(topicIds)].sort());
      const knownMissIds = [
        ...new Set(
          (options.knownMisses ?? [])
            .filter(
              (miss) =>
                miss.from === window.from.toISOString() &&
                miss.to === window.to.toISOString() &&
                JSON.stringify([...new Set(miss.topicIds)].sort()) === topicKey &&
                miss.labelReference.trim().length > 0,
            )
            .flatMap((miss) => miss.missingRevisionIds),
        ),
      ];
      const knownMissClause =
        knownMissIds.length === 0
          ? sql`false`
          : sql`er.id::text IN (${sql.join(
              knownMissIds.map((id) => sql`${id}`),
              sql`, `,
            )})`;

      // All stages use the SAME target/partition membership in one statement/snapshot.
      // Publication-based requests never silently substitute collection time for a null publication.
      const result = await db.execute(sql`
        WITH eligible_targets AS (
          SELECT tr.id, ct.source_id, tr.policy
          FROM collection_target_revisions tr
          JOIN collection_targets ct ON ct.id = tr.target_id
          JOIN sources src ON src.id = ct.source_id
          WHERE ct.enabled = true AND src.enabled = true AND src.policy_reviewed_at IS NOT NULL
            AND tr.policy ->> 'approved' = 'true' AND tr.policy ->> 'store' = 'true'
            AND tr.policy ->> 'modelInput' = 'true' AND tr.policy ->> 'displayExcerpt' = 'true'
            ${topicClause} ${targetClause}
        ), eligible_partitions AS (
          SELECT cp.id, cp.state, et.source_id, et.policy
          FROM collection_partitions cp JOIN eligible_targets et ON et.id = cp.target_revision_id
          WHERE cp.window_from < ${window.to} AND cp.window_to > ${window.from}
            AND cp.mode <> 'on_demand' ${scopeClause}
        ), eligible_raw AS (
          SELECT DISTINCT raw.id, am.revision_id, raw.rights_metadata, ep.policy AS target_policy
          FROM eligible_partitions ep
          JOIN acquisition_memberships am ON am.partition_id = ep.id
          JOIN raw_items raw ON raw.id = am.raw_item_id AND raw.source_id = ep.source_id
          WHERE raw.published_at >= ${window.from} AND raw.published_at < ${window.to}
            AND raw.rights_metadata ->> 'approved' = 'true' AND raw.rights_metadata ->> 'store' = 'true'
            AND raw.rights_metadata ->> 'modelInput' = 'true' AND raw.rights_metadata ->> 'displayExcerpt' = 'true'
        ), eligible_lexical AS (
          SELECT DISTINCT dr.id, er.rights_metadata, er.target_policy
          FROM eligible_raw er JOIN document_revisions dr ON dr.id = er.revision_id AND dr.raw_item_id = er.id
          WHERE dr.status = 'searchable' AND dr.lexical_ready_at IS NOT NULL
            AND dr.published_at >= ${window.from} AND dr.published_at < ${window.to}
            AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_revision_id = dr.id)
        )
        SELECT
          (SELECT count(DISTINCT id)::int FROM eligible_targets) AS target_count,
          (SELECT count(DISTINCT id)::int FROM eligible_partitions) AS partitions_checked,
          (SELECT count(DISTINCT id)::int FROM eligible_partitions WHERE state = 'completed') AS partitions_completed,
          (SELECT count(DISTINCT id)::int FROM eligible_partitions WHERE state IN ('partial','failed','deferred','cancelled')) AS partitions_partial,
          (SELECT count(DISTINCT id)::int FROM eligible_raw) AS raw_documents,
          (SELECT count(DISTINCT id)::int FROM eligible_lexical) AS lexical_documents,
          (SELECT count(DISTINCT er.id)::int FROM eligible_lexical er WHERE ${vectorClause}) AS vector_documents,
          (SELECT count(DISTINCT er.id)::int FROM eligible_lexical er WHERE ${knownMissClause}) AS known_miss_count
      `);
      const row = result.rows[0];
      const count = (key: string): number => {
        const value = Number(row?.[key]);
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error('coverage_counts_unavailable');
        return value;
      };
      const rawDocuments = count('raw_documents');
      const lexicalDocuments = count('lexical_documents');
      const vectorDocuments = count('vector_documents');
      const partitionsChecked = count('partitions_checked');
      const partitionsCompleted = count('partitions_completed');
      const partitionsPartial = count('partitions_partial');
      const hasKnownMiss = count('known_miss_count') > 0;

      const reasons = diagnoseCoverageReasons({
        rawDocuments,
        lexicalDocuments,
        vectorDocuments,
        partitionsChecked,
        partitionsCompleted,
        partitionsPartial,
        targetCount: count('target_count'),
        hasKnownMiss,
      });

      return {
        generatedAt: now.toISOString(),
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        rawDocuments,
        lexicalDocuments,
        vectorDocuments,
        partitionsChecked,
        partitionsCompleted,
        partitionsPartial,
        reasons,
      };
    },
  };
}

export function createCohortRepository(db: Database): CohortPort {
  const persistence = createCohortPersistenceRepository(db);

  return {
    createCohortVersion: persistence.createCohortVersion,
    getCohortVersion: persistence.getCohortVersion,

    async compareWindows(
      cohortId: string,
      metric: string,
      unit: string,
      baseline: CollectionWindow,
      current: CollectionWindow,
    ): Promise<CohortComparison> {
      validateCoverageWindow(baseline);
      validateCoverageWindow(current);

      const cohort = await persistence.getCohortVersion(cohortId);
      if (!cohort) throw new CollectionStateError('not_found');

      const matchingMembers = cohort.members.filter((m) => m.metric === metric && m.unit === unit);

      if (matchingMembers.length === 0) {
        return {
          cohortId,
          metric,
          unit,
          denominator: 0,
          excludedTargets: cohort.members.length,
          baseline: null,
          current: null,
          partial: true,
        };
      }

      const memberEvaluations: MemberCoverageEvaluation[] = [];

      for (const member of matchingMembers) {
        const baselinePartitions = await db
          .select({ state: collectionPartitions.state })
          .from(collectionPartitions)
          .where(
            and(
              eq(collectionPartitions.targetRevisionId, member.targetRevisionId),
              ne(collectionPartitions.mode, 'on_demand'),
              lt(collectionPartitions.windowFrom, baseline.to),
              gt(collectionPartitions.windowTo, baseline.from),
            ),
          );
        const baselineCovered =
          baselinePartitions.length > 0 && baselinePartitions.every((p) => p.state === 'completed');

        const currentPartitions = await db
          .select({ state: collectionPartitions.state })
          .from(collectionPartitions)
          .where(
            and(
              eq(collectionPartitions.targetRevisionId, member.targetRevisionId),
              ne(collectionPartitions.mode, 'on_demand'),
              lt(collectionPartitions.windowFrom, current.to),
              gt(collectionPartitions.windowTo, current.from),
            ),
          );
        const currentCovered =
          currentPartitions.length > 0 && currentPartitions.every((p) => p.state === 'completed');

        let baselineValue: number | null = null;
        let currentValue: number | null = null;

        if (baselineCovered && currentCovered) {
          const baselineObs = await db.execute(sql`
            SELECT COALESCE(SUM(mo.value), 0)::int AS total
            FROM metric_observations mo
            WHERE mo.metric_type = ${metric}
              AND mo.unit = ${unit}
              AND mo.window_start >= ${baseline.from}
              AND mo.window_end <= ${baseline.to}
              AND (
                mo.query_signature = ${member.querySignature}
                OR mo.raw_item_id IN (
                  SELECT am.raw_item_id
                  FROM acquisition_memberships am
                  JOIN collection_partitions cp ON am.partition_id = cp.id
                  WHERE cp.target_revision_id = ${member.targetRevisionId}
                    AND cp.mode != 'on_demand'
                )
              )
              AND (
                mo.raw_item_id IS NULL
                OR mo.raw_item_id NOT IN (
                  SELECT am.raw_item_id
                  FROM acquisition_memberships am
                  JOIN collection_partitions cp ON am.partition_id = cp.id
                  WHERE cp.mode = 'on_demand'
                )
              )
          `);
          baselineValue = Number(baselineObs.rows[0]?.['total'] ?? 0);

          const currentObs = await db.execute(sql`
            SELECT COALESCE(SUM(mo.value), 0)::int AS total
            FROM metric_observations mo
            WHERE mo.metric_type = ${metric}
              AND mo.unit = ${unit}
              AND mo.window_start >= ${current.from}
              AND mo.window_end <= ${current.to}
              AND (
                mo.query_signature = ${member.querySignature}
                OR mo.raw_item_id IN (
                  SELECT am.raw_item_id
                  FROM acquisition_memberships am
                  JOIN collection_partitions cp ON am.partition_id = cp.id
                  WHERE cp.target_revision_id = ${member.targetRevisionId}
                    AND cp.mode != 'on_demand'
                )
              )
              AND (
                mo.raw_item_id IS NULL
                OR mo.raw_item_id NOT IN (
                  SELECT am.raw_item_id
                  FROM acquisition_memberships am
                  JOIN collection_partitions cp ON am.partition_id = cp.id
                  WHERE cp.mode = 'on_demand'
                )
              )
          `);
          currentValue = Number(currentObs.rows[0]?.['total'] ?? 0);
        }

        memberEvaluations.push({
          targetRevisionId: member.targetRevisionId,
          baselineCovered,
          currentCovered,
          baselineValue,
          currentValue,
        });
      }

      return evaluateCohortComparison(cohort, metric, unit, memberEvaluations);
    },
  };
}

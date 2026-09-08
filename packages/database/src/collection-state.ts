import { and, eq, lte, or, isNull, sql, asc } from 'drizzle-orm';
import {
  assertCollectableTarget, collectionHash, partitionNaturalKey, validatePageResult, decodePageCursor, CollectionStateError,
  type CollectionStatePort, type CollectionTargetRevision, type CollectionPartition, type CollectionDelivery,
  type ClaimedCollectionPage, type SourceKey, type PartitionState, type CollectionMode, type CollectionTimeBasis,
} from '@techpulse/domain';
import type { DatabaseClient } from './client.js';
import { sources, collectionTargets, collectionTargetRevisions, collectionPartitions, collectionCheckpoints, collectionPageAttempts,
  collectionRuns, rawItems, acquisitionMemberships, deliveryOutbox, documentRevisions } from './schema/index.js';

type Database = DatabaseClient['db'];
type Executor = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;
type PartitionRow = typeof collectionPartitions.$inferSelect;

function partitionRecord(row: PartitionRow): CollectionPartition {
  return { id: row.id, targetRevisionId: row.targetRevisionId, mode: row.mode as CollectionMode,
    scopeKey: row.scopeKey, window: { from: row.windowFrom, to: row.windowTo }, timeBasis: row.timeBasis as CollectionTimeBasis,
    workflowVersion: row.workflowVersion, state: row.state as PartitionState, pageSequence: row.pageSequence,
    cursor: row.cursor, leaseEpoch: row.leaseEpoch, leaseUntil: row.leaseUntil, nextDueAt: row.nextDueAt, reason: row.reason };
}
async function readTarget(db: Executor, id: string, lock = false): Promise<CollectionTargetRevision | null> {
  const query = db.select({ target: collectionTargets, revision: collectionTargetRevisions, source: sources })
    .from(collectionTargetRevisions).innerJoin(collectionTargets, eq(collectionTargets.id, collectionTargetRevisions.targetId))
    .innerJoin(sources, eq(sources.id, collectionTargets.sourceId)).where(eq(collectionTargetRevisions.id, id));
  const [row] = await (lock ? query.for('update') : query);
  if (!row) return null;
  return { id: row.revision.id, targetId: row.target.id, sourceId: row.source.id, sourceKey: row.source.key as SourceKey,
    canonicalIdentity: row.target.canonicalIdentity, configHash: row.revision.configHash,
    selector: row.revision.selector, capability: row.revision.capability, policy: row.revision.policy,
    topicIds: row.revision.topicIds, cadenceMs: row.revision.cadenceMs, overlapMs: row.revision.overlapMs,
    taxonomyVersion: row.revision.taxonomyVersion,
    createdAt: row.revision.createdAt,
    enabled: row.source.enabled && row.target.enabled && row.target.currentRevisionId === row.revision.id };
}
async function fencePage(db: Executor, claim: ClaimedCollectionPage, now: Date): Promise<PartitionRow> {
  const [row] = await db.select().from(collectionPartitions).where(eq(collectionPartitions.id, claim.partition.id)).for('update');
  if (!row || row.targetRevisionId !== claim.target.id || row.targetRevisionId !== claim.partition.targetRevisionId ||
      row.state !== 'running' || row.pageSequence !== claim.partition.pageSequence || row.leaseEpoch !== claim.partition.leaseEpoch ||
      !row.leaseUntil || row.leaseUntil <= now || row.runId !== claim.runId) throw new CollectionStateError('stale_lease');
  return row;
}
async function collectionDelivery(db: Executor, partitionId: string, pageSequence: number, notBefore: Date): Promise<void> {
  await db.insert(deliveryOutbox).values({ naturalKey: collectionHash({ kind: 'collection', partitionId, pageSequence }),
    kind: 'collection', partitionId, pageSequence, notBefore }).onConflictDoNothing();
}

export function createCollectionStateRepository(db: Database): CollectionStatePort {
  return {
    async registerTarget(input) {
      if (!input.taxonomyVersion?.trim() || !input.canonicalIdentity.trim() || !Number.isSafeInteger(input.capability.cursorVersion) ||
          input.capability.cursorVersion < 1 || input.topicIds.length > 32) throw new CollectionStateError('invalid_state');
      const configHash = collectionHash({ selector: input.selector, capability: input.capability, policy: input.policy,
        topicIds: [...input.topicIds].sort(), taxonomyVersion: input.taxonomyVersion, cadenceMs: input.cadenceMs, overlapMs: input.overlapMs });
      return db.transaction(async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.id, input.sourceId)).for('update');
        if (!source || source.key !== input.sourceKey) throw new CollectionStateError('not_found');
        if (input.policy.approved && !source.policyReviewedAt) throw new CollectionStateError('policy_blocked');
        await tx.insert(collectionTargets).values({ sourceId: input.sourceId, canonicalIdentity: input.canonicalIdentity }).onConflictDoNothing();
        const [target] = await tx.select().from(collectionTargets).where(and(eq(collectionTargets.sourceId, input.sourceId), eq(collectionTargets.canonicalIdentity, input.canonicalIdentity))).for('update');
        if (!target) throw new CollectionStateError('not_found');
        await tx.insert(collectionTargetRevisions).values({ targetId: target.id, configHash, selector: input.selector,
          capability: input.capability, policy: input.policy, topicIds: [...input.topicIds], taxonomyVersion: input.taxonomyVersion,
          cadenceMs: input.cadenceMs, overlapMs: input.overlapMs }).onConflictDoNothing();
        const [revision] = await tx.select().from(collectionTargetRevisions).where(and(eq(collectionTargetRevisions.targetId, target.id), eq(collectionTargetRevisions.configHash, configHash)));
        if (!revision) throw new CollectionStateError('not_found');
        // Every new revision needs a separate enable action, including a policy/config change.
        await tx.update(collectionTargets).set({ currentRevisionId: revision.id, ...(target.currentRevisionId !== revision.id ? { enabled: false } : {}) }).where(eq(collectionTargets.id, target.id));
        const result = await readTarget(tx, revision.id);
        if (!result) throw new CollectionStateError('not_found');
        return result;
      });
    },
    getTargetRevision(id) { return readTarget(db, id); },
    async setTargetEnabled(targetId, enabled, now) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(collectionTargets).where(eq(collectionTargets.id, targetId));
        if (!row?.currentRevisionId) throw new CollectionStateError('not_found');
        const revision = await readTarget(tx, row.currentRevisionId, true);
        if (!revision) throw new CollectionStateError('not_found');
        if (enabled) assertCollectableTarget({ ...revision, enabled: true });
        await tx.update(collectionTargets).set({ enabled, updatedAt: now }).where(eq(collectionTargets.id, targetId));
      });
    },
    async listTargets(limit, after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CollectionStateError('invalid_state');
      const rows = await db.select({ id: collectionTargets.currentRevisionId }).from(collectionTargets)
        .where(after ? sql`${collectionTargets.id} > ${after}::uuid` : undefined).orderBy(asc(collectionTargets.id)).limit(limit);
      const revisions = await Promise.all(rows.map((row) => row.id ? readTarget(db, row.id) : null));
      return revisions.filter((row): row is CollectionTargetRevision => row !== null);
    },
    async planPartition(plan, now) {
      const naturalKey = partitionNaturalKey(plan);
      return db.transaction(async (tx) => {
        const target = await readTarget(tx, plan.targetRevisionId, true);
        if (!target) throw new CollectionStateError('not_found');
        assertCollectableTarget(target);
        if (target.capability.timeBasis !== plan.timeBasis) throw new CollectionStateError('invalid_window');
        await tx.insert(collectionPartitions).values({ targetRevisionId: plan.targetRevisionId, naturalKey, mode: plan.mode,
          scopeKey: plan.scopeKey, windowFrom: plan.window.from, windowTo: plan.window.to, timeBasis: plan.timeBasis,
          workflowVersion: plan.workflowVersion, nextDueAt: now, createdAt: now, updatedAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(collectionPartitions).where(eq(collectionPartitions.naturalKey, naturalKey));
        if (!row) throw new CollectionStateError('not_found');
        if (!['completed','partial','cancelled','failed'].includes(row.state)) await collectionDelivery(tx, row.id, row.pageSequence, row.nextDueAt);
        return partitionRecord(row);
      });
    },
    async getPartition(id) {
      const [row] = await db.select().from(collectionPartitions).where(eq(collectionPartitions.id, id));
      return row ? partitionRecord(row) : null;
    },
    async listPartitions(limit, after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CollectionStateError('invalid_state');
      const rows = await db.select().from(collectionPartitions).where(after ? sql`${collectionPartitions.id} > ${after}::uuid` : undefined)
        .orderBy(asc(collectionPartitions.id)).limit(limit);
      return rows.map(partitionRecord);
    },
    async claimPage(partitionId, pageSequence, now, leaseMs) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new CollectionStateError('invalid_state');
      return db.transaction(async (tx) => {
        // Lock source/target before partition everywhere to avoid disable/commit deadlocks.
        const [candidate] = await tx.select().from(collectionPartitions).where(eq(collectionPartitions.id, partitionId));
        if (!candidate) return null;
        const target = await readTarget(tx, candidate.targetRevisionId, true);
        if (!target) return null;
        assertCollectableTarget(target);
        const [row] = await tx.select().from(collectionPartitions).where(eq(collectionPartitions.id, partitionId)).for('update');
        if (!row || row.pageSequence !== pageSequence || !['pending','running','deferred'].includes(row.state) || row.nextDueAt > now || (row.leaseUntil && row.leaseUntil > now)) return null;
        decodePageCursor(partitionRecord(row), target.capability.cursorVersion);
        const [run] = await tx.insert(collectionRuns).values({ sourceId: target.sourceId, scheduledAt: row.nextDueAt, startedAt: now, status: 'running', cursorBefore: row.cursor }).returning();
        if (!run) throw new CollectionStateError('invalid_state');
        if (row.runId) await tx.update(collectionRuns).set({ status: 'failed', endedAt: now, errorSummary: 'lease_expired' })
          .where(and(eq(collectionRuns.id, row.runId), eq(collectionRuns.status, 'running')));
        await tx.insert(collectionPageAttempts).values({ runId: run.id, partitionId: row.id, pageSequence: row.pageSequence, leaseEpoch: row.leaseEpoch + 1 });
        const [claimed] = await tx.update(collectionPartitions).set({ state: 'running', leaseEpoch: row.leaseEpoch + 1,
          leaseUntil: new Date(now.getTime() + leaseMs), runId: run.id, attempts: row.attempts + 1, updatedAt: now }).where(eq(collectionPartitions.id, row.id)).returning();
        if (!claimed) throw new CollectionStateError('invalid_state');
        return { partition: partitionRecord(claimed), target, runId: run.id };
      });
    },
    async renewPage(claim, now, leaseMs) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new CollectionStateError('invalid_state');
      return db.transaction(async (tx) => {
        const target = await readTarget(tx, claim.target.id, true);
        if (!target) return false;
        assertCollectableTarget(target);
        await fencePage(tx, claim, now);
        await tx.update(collectionPartitions).set({ leaseUntil: new Date(now.getTime() + leaseMs), updatedAt: now })
          .where(eq(collectionPartitions.id, claim.partition.id));
        return true;
      });
    },
    async commitPage({ claim, result, now }) {
      validatePageResult(claim.partition, result);
      if (result.retryAt && result.retryAt <= now) throw new CollectionStateError('invalid_page');
      if (result.disposition === 'complete' && claim.partition.mode === 'backfill' &&
          ['feed_only', 'snapshot_only'].includes(claim.target.capability.historyMode)) throw new CollectionStateError('invalid_page');
      await db.transaction(async (tx) => {
        const target = await readTarget(tx, claim.target.id, true);
        if (!target) throw new CollectionStateError('not_found');
        assertCollectableTarget(target);
        const row = await fencePage(tx, claim, now);
        decodePageCursor({ ...partitionRecord(row), cursor: result.nextCursor }, target.capability.cursorVersion);
        for (const item of result.items) {
          const canonicalUrl = item.metadata?.['canonicalUrl'];
          if (typeof canonicalUrl !== 'string') throw new CollectionStateError('invalid_page');
          try {
            const url = new URL(canonicalUrl);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid_url');
          } catch { throw new CollectionStateError('invalid_page'); }
          const declaredRights = item.metadata?.['rightsMetadata'];
          if (declaredRights !== undefined && (!declaredRights || typeof declaredRights !== 'object' || Array.isArray(declaredRights))) throw new CollectionStateError('invalid_page');
          const itemRights = (declaredRights ?? {}) as Record<string, unknown>;
          const rights = { ...target.policy };
          for (const permission of ['approved', 'fetch', 'store', 'embed', 'modelInput', 'displayExcerpt'] as const) {
            if (itemRights[permission] !== undefined) {
              if (typeof itemRights[permission] !== 'boolean') throw new CollectionStateError('invalid_page');
              rights[permission] = rights[permission] && itemRights[permission] === true;
            }
          }
          if (itemRights['verbatimOnly'] === true) rights.verbatimOnly = true;
          if (itemRights['licenseId'] !== undefined && itemRights['licenseId'] !== rights.licenseId) {
            if (itemRights['licenseId'] !== null && typeof itemRights['licenseId'] !== 'string') throw new CollectionStateError('invalid_page');
            rights.licenseId = itemRights['licenseId'] as string | null;
            rights.embed = false;
            rights.modelInput = false;
            rights.displayExcerpt = false;
          }
          if (!rights.approved || !rights.fetch || !rights.store) throw new CollectionStateError('policy_blocked');
          await tx.insert(rawItems).values({ sourceId: target.sourceId, runId: claim.runId, externalId: item.externalId,
            canonicalUrl, payload: item.payload, payloadHash: item.rawHash, publishedAt: item.publishedAt,
            collectedAt: now, rightsMetadata: rights, httpMetadata: {} }).onConflictDoNothing();
          const [raw] = await tx.select({ id: rawItems.id }).from(rawItems).where(and(eq(rawItems.sourceId, target.sourceId), eq(rawItems.externalId, item.externalId), eq(rawItems.payloadHash, item.rawHash)));
          if (!raw) throw new CollectionStateError('invalid_page');
          const [revision] = await tx.select({ id: documentRevisions.id }).from(documentRevisions).where(eq(documentRevisions.rawItemId, raw.id)).orderBy(asc(documentRevisions.createdAt)).limit(1);
          await tx.insert(acquisitionMemberships).values({ partitionId: row.id, rawItemId: raw.id, runId: claim.runId,
            revisionId: revision?.id ?? null, acquiredAt: now }).onConflictDoNothing();
          // Repeated acquisition repairs absent downstream delivery even for pre-existing raw rows.
          await tx.insert(deliveryOutbox).values({ naturalKey: collectionHash({ kind: 'normalization', rawItemId: raw.id, workflowVersion: row.workflowVersion }),
            kind: 'normalization', partitionId: row.id, pageSequence: row.pageSequence, rawItemId: raw.id, notBefore: now }).onConflictDoNothing();
        }
        await tx.insert(collectionCheckpoints).values({ partitionId: row.id, pageSequence: row.pageSequence, leaseEpoch: row.leaseEpoch,
          cursorBefore: row.cursor, cursorAfter: result.nextCursor, disposition: result.disposition, retainedItems: result.items.length,
          requests: result.requests, bytes: result.bytes, committedAt: now });
        const nextState = { continue: 'pending', complete: 'completed', deferred: 'deferred', partial: 'partial' }[result.disposition];
        const nextDueAt = result.retryAt ?? now;
        await tx.update(collectionPartitions).set({ pageSequence: row.pageSequence + 1, cursor: result.nextCursor, state: nextState,
          reason: result.reason, leaseUntil: null, nextDueAt, updatedAt: now }).where(eq(collectionPartitions.id, row.id));
        await tx.update(collectionRuns).set({ status: 'succeeded', endedAt: now, cursorAfter: result.nextCursor,
          counts: { retained: result.items.length, requests: result.requests, bytes: result.bytes } }).where(eq(collectionRuns.id, claim.runId));
        await tx.update(deliveryOutbox).set({ completedAt: now }).where(and(eq(deliveryOutbox.partitionId, row.id), eq(deliveryOutbox.kind, 'collection'), eq(deliveryOutbox.pageSequence, row.pageSequence)));
        if (result.disposition === 'continue' || result.disposition === 'deferred') await collectionDelivery(tx, row.id, row.pageSequence + 1, nextDueAt);
      });
    },
    async failPage(claim, reason, retryAt, now) {
      await db.transaction(async (tx) => {
        const row = await fencePage(tx, claim, now);
        await tx.update(collectionPartitions).set({ state: retryAt ? 'deferred' : 'failed', reason: reason.slice(0, 128),
          nextDueAt: retryAt ?? now, leaseUntil: null, updatedAt: now }).where(eq(collectionPartitions.id, row.id));
        await tx.update(collectionRuns).set({ status: 'failed', endedAt: now, errorSummary: reason.slice(0,128) }).where(eq(collectionRuns.id, claim.runId));
        await tx.update(deliveryOutbox).set({ notBefore: retryAt ?? now, sentAt: null, completedAt: retryAt ? null : now })
          .where(and(eq(deliveryOutbox.partitionId, row.id), eq(deliveryOutbox.kind, 'collection'), eq(deliveryOutbox.pageSequence, row.pageSequence)));
      });
    },
    async resumePartition(id, now) {
      return db.transaction(async (tx) => {
        const [candidate] = await tx.select().from(collectionPartitions).where(eq(collectionPartitions.id, id));
        if (!candidate) throw new CollectionStateError('not_found');
        const target = await readTarget(tx, candidate.targetRevisionId, true);
        if (!target) throw new CollectionStateError('not_found');
        assertCollectableTarget(target);
        const [row] = await tx.select().from(collectionPartitions).where(eq(collectionPartitions.id, id)).for('update');
        if (!row || row.state === 'completed' || row.state === 'partial' || (row.leaseUntil && row.leaseUntil > now)) throw new CollectionStateError('invalid_state');
        const [resumed] = await tx.update(collectionPartitions).set({ state: 'pending', nextDueAt: now, leaseUntil: null, reason: null, updatedAt: now }).where(eq(collectionPartitions.id, id)).returning();
        await collectionDelivery(tx, id, row.pageSequence, now);
        await tx.update(deliveryOutbox).set({ completedAt: null, sentAt: null, notBefore: now }).where(and(eq(deliveryOutbox.partitionId, id), eq(deliveryOutbox.kind, 'collection'), eq(deliveryOutbox.pageSequence, row.pageSequence)));
        if (!resumed) throw new CollectionStateError('not_found');
        return partitionRecord(resumed);
      });
    },
    async claimDeliveries(now, limit, leaseMs, mode) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new CollectionStateError('invalid_state');
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(deliveryOutbox).where(and(isNull(deliveryOutbox.completedAt), lte(deliveryOutbox.notBefore, now),
          or(isNull(deliveryOutbox.leaseUntil), lte(deliveryOutbox.leaseUntil, now)),
          sql`EXISTS (
            SELECT 1 FROM collection_partitions p
            JOIN collection_target_revisions tr ON tr.id = p.target_revision_id
            JOIN collection_targets t ON t.id = tr.target_id
            JOIN collection_target_revisions current_tr ON current_tr.id = t.current_revision_id
            JOIN sources s ON s.id = t.source_id
            WHERE p.id = ${deliveryOutbox.partitionId} AND s.enabled AND t.enabled
              AND (${mode ?? null}::text IS NULL OR p.mode = ${mode ?? null})
              AND current_tr.policy->>'approved' = 'true'
              AND current_tr.policy->>'fetch' = 'true' AND current_tr.policy->>'store' = 'true'
          )`,
          or(isNull(deliveryOutbox.sentAt), lte(deliveryOutbox.sentAt, new Date(now.getTime() - 30000)))))
          .orderBy(asc(deliveryOutbox.notBefore), asc(deliveryOutbox.id)).limit(limit).for('update', { skipLocked: true });
        const claimed: CollectionDelivery[] = [];
        for (const row of rows) {
          const [updated] = await tx.update(deliveryOutbox).set({ leaseEpoch: row.leaseEpoch + 1, leaseUntil: new Date(now.getTime() + leaseMs) })
            .where(eq(deliveryOutbox.id, row.id)).returning();
          if (updated) claimed.push({ ...updated, kind: updated.kind as CollectionDelivery['kind'] });
        }
        return claimed;
      });
    },
    async getDelivery(id) {
      const [row] = await db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, id));
      return row ? { ...row, kind: row.kind as CollectionDelivery['kind'] } : null;
    },
    async markSent(id, leaseEpoch, now) {
      const updated = await db.update(deliveryOutbox).set({ sentAt: now, leaseUntil: null }).where(and(eq(deliveryOutbox.id, id),
        eq(deliveryOutbox.leaseEpoch, leaseEpoch), sql`${deliveryOutbox.leaseUntil} > ${now}`, isNull(deliveryOutbox.completedAt))).returning({ id: deliveryOutbox.id });
      if (updated.length !== 1) throw new CollectionStateError('stale_lease');
    },
    async completeDelivery(id, now, profile) {
      await db.transaction(async (tx) => {
        const [delivery] = await tx.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, id)).for('update');
        if (!delivery) throw new CollectionStateError('not_found');
        if (delivery.completedAt) return;
        let complete = false;
        if (delivery.kind === 'collection') {
          const checkpoints = await tx.select({ id: collectionCheckpoints.id }).from(collectionCheckpoints).where(and(
            eq(collectionCheckpoints.partitionId, delivery.partitionId), eq(collectionCheckpoints.pageSequence, delivery.pageSequence))).limit(1);
          complete = checkpoints.length === 1;
        } else if (delivery.kind === 'normalization') {
          const result = await tx.execute(sql`SELECT r.id FROM document_revisions r
            JOIN acquisition_memberships a ON a.revision_id = r.id AND a.raw_item_id = r.raw_item_id
            WHERE r.raw_item_id = ${delivery.rawItemId} AND r.status IN ('processing','searchable')
              AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_revision_id = r.id) LIMIT 1`);
          complete = result.rows.length === 1;
        } else if (delivery.kind === 'embedding' && profile) {
          const result = await tx.execute(sql`SELECT r.id FROM document_revisions r WHERE r.id = ${delivery.revisionId}
            AND r.status NOT IN ('quarantined','tombstoned')
            AND EXISTS (SELECT 1 FROM chunks c WHERE c.document_revision_id = r.id)
            AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.document_revision_id = r.id
              AND NOT EXISTS (SELECT 1 FROM embedding_work_items w WHERE w.chunk_id = c.id
                AND w.input_hash = c.content_hash AND w.profile = ${JSON.stringify(profile)}::jsonb AND w.state = 'completed'))`);
          complete = result.rows.length === 1;
        }
        if (!complete) throw new CollectionStateError('invalid_state');
        await tx.update(deliveryOutbox).set({ completedAt: now, leaseUntil: null }).where(eq(deliveryOutbox.id, id));
      });
    },
    async attachRevision(rawItemId, revisionId, now) {
      await db.transaction(async (tx) => {
        const [revision] = await tx.select().from(documentRevisions).where(and(eq(documentRevisions.id, revisionId), eq(documentRevisions.rawItemId, rawItemId)));
        if (!revision) throw new CollectionStateError('not_found');
        await tx.update(acquisitionMemberships).set({ revisionId }).where(eq(acquisitionMemberships.rawItemId, rawItemId));
        const memberships = await tx.select().from(acquisitionMemberships).where(eq(acquisitionMemberships.rawItemId, rawItemId));
        for (const membership of memberships) {
          await tx.insert(deliveryOutbox).values({ naturalKey: collectionHash({ kind: 'embedding', revisionId }), kind: 'embedding',
            partitionId: membership.partitionId, pageSequence: 0, revisionId, notBefore: now }).onConflictDoNothing();
        }
      });
    },
  };
}

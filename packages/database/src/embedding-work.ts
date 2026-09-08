import { and, eq, sql } from 'drizzle-orm';
import { collectionHash, ProviderBudgetError, type EmbeddingWorkPort, type EmbeddingWork, type EmbeddingWorkState } from '@techpulse/domain';
import type { DatabaseClient } from './client.js';
import { embeddingWorkItems, embeddings, providerBudgetReservations, providerBudgetScopes, chunks } from './schema/index.js';

type Database = DatabaseClient['db'];
type Executor = Pick<Database, 'select' | 'execute'>;
type WorkRow = typeof embeddingWorkItems.$inferSelect;
function workRecord(row: WorkRow, vector: readonly number[] | null = null): EmbeddingWork {
  return { id: row.id, key: { chunkId: row.chunkId, inputHash: row.inputHash, profile: row.profile },
    state: row.state as EmbeddingWorkState, epoch: row.leaseEpoch, leaseUntil: row.leaseUntil, vector, reservationId: row.reservationId };
}
async function checkWorkRights(tx: Executor, row: WorkRow): Promise<void> {
  const result = await tx.execute(sql`SELECT c.id FROM chunks c
    JOIN document_revisions r ON r.id = c.document_revision_id
    JOIN acquisition_memberships a ON a.revision_id = r.id
    JOIN collection_partitions p ON p.id = a.partition_id
    JOIN collection_target_revisions tr ON tr.id = p.target_revision_id
    JOIN collection_targets t ON t.id = tr.target_id
    JOIN collection_target_revisions current_tr ON current_tr.id = t.current_revision_id
    JOIN sources s ON s.id = t.source_id
    JOIN raw_items raw ON raw.id = r.raw_item_id AND raw.source_id = s.id
    WHERE c.id = ${row.chunkId} AND c.content_hash = ${row.inputHash}
      AND r.status NOT IN ('quarantined','tombstoned') AND t.enabled AND s.enabled
      AND current_tr.policy->>'approved' = 'true' AND current_tr.policy->>'embed' = 'true'
      AND current_tr.policy->>'modelInput' = 'true' AND current_tr.policy->>'store' = 'true'
      AND raw.rights_metadata->>'approved' = 'true' AND raw.rights_metadata->>'embed' = 'true'
      AND raw.rights_metadata->>'modelInput' = 'true' AND raw.rights_metadata->>'store' = 'true'
    LIMIT 1 FOR SHARE OF r, t, s, current_tr`);
  if (result.rows.length !== 1) throw new ProviderBudgetError('approval_required');
}
export function createEmbeddingWorkRepository(db: Database): EmbeddingWorkPort {
  return {
    async claimOrReadCompleted(key, now, leaseMs) {
      const profile = key.profile;
      if (!profile.provider || !profile.model || !profile.version || !profile.priceVersion || !profile.tokenizerVersion || !profile.approvalReference ||
        !Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1 || profile.dimensions > 16000 ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new ProviderBudgetError('invalid_usage');
      const workKey = collectionHash(key);
      return db.transaction(async (tx) => {
        const [chunk] = await tx.select({ hash: chunks.contentHash }).from(chunks).where(eq(chunks.id, key.chunkId));
        if (!chunk || chunk.hash !== key.inputHash) throw new ProviderBudgetError('stale_work');
        await tx.insert(embeddingWorkItems).values({ workKey, chunkId: key.chunkId, inputHash: key.inputHash, profile: key.profile, createdAt: now, updatedAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(embeddingWorkItems).where(eq(embeddingWorkItems.workKey, workKey)).for('update');
        if (!row) throw new ProviderBudgetError('stale_work');
        await checkWorkRights(tx, row);
        if (row.state === 'completed') {
          const [embedding] = await tx.select().from(embeddings).where(eq(embeddings.id, row.embeddingId ?? '00000000-0000-0000-0000-000000000000'));
          if (!embedding || embedding.dimensions !== profile.dimensions || embedding.profileHash !== collectionHash(profile)) throw new ProviderBudgetError('stale_work');
          return workRecord(row, embedding.embedding);
        }
        if (row.state === 'outcome_unknown') return workRecord(row);
        if (row.leaseUntil && row.leaseUntil > now) return null;
        if (row.state === 'calling') {
          const [unknown] = await tx.update(embeddingWorkItems).set({ state: 'outcome_unknown', updatedAt: now }).where(eq(embeddingWorkItems.id, row.id)).returning();
          if (row.reservationId) await tx.update(providerBudgetReservations).set({ state: 'outcome_unknown', updatedAt: now })
            .where(and(eq(providerBudgetReservations.id, row.reservationId), eq(providerBudgetReservations.state, 'reserved')));
          if (!unknown) throw new ProviderBudgetError('stale_work');
          return workRecord(unknown);
        }
        const [claimed] = await tx.update(embeddingWorkItems).set({ state: 'claimed', leaseEpoch: row.leaseEpoch + 1,
          leaseUntil: new Date(now.getTime() + leaseMs), reservationId: null, updatedAt: now }).where(eq(embeddingWorkItems.id, row.id)).returning();
        if (!claimed) throw new ProviderBudgetError('stale_work');
        return workRecord(claimed);
      });
    },
    async beginCall(id, epoch, reservationId, now) {
      await db.transaction(async (tx) => {
        const [work] = await tx.select().from(embeddingWorkItems).where(eq(embeddingWorkItems.id, id)).for('update');
        if (!work || work.state !== 'claimed' || work.leaseEpoch !== epoch || !work.leaseUntil || work.leaseUntil <= now) throw new ProviderBudgetError('stale_work');
        const [candidate] = await tx.select({ scopeId: providerBudgetReservations.scopeId }).from(providerBudgetReservations).where(eq(providerBudgetReservations.id, reservationId));
        if (!candidate) throw new ProviderBudgetError('reservation_conflict');
        const [scope] = await tx.select().from(providerBudgetScopes).where(eq(providerBudgetScopes.id, candidate.scopeId)).for('update');
        const [reservation] = await tx.select().from(providerBudgetReservations).where(eq(providerBudgetReservations.id, reservationId)).for('update');
        if (!reservation || reservation.state !== 'reserved' || reservation.lane !== 'ingestion_embedding' ||
            reservation.attemptId !== `${id}:${epoch}`) throw new ProviderBudgetError('reservation_conflict');
        if (!scope?.approved || scope.blocked || !scope.approvedModelProfiles.includes(collectionHash(work.profile))) throw new ProviderBudgetError('approval_required');
        await checkWorkRights(tx, work);
        await tx.update(embeddingWorkItems).set({ state: 'calling', reservationId, updatedAt: now }).where(eq(embeddingWorkItems.id, id));
      });
    },
    async completeWork(id, epoch, vector, now) {
      await db.transaction(async (tx) => {
        const [work] = await tx.select().from(embeddingWorkItems).where(eq(embeddingWorkItems.id, id)).for('update');
        if (!work || work.leaseEpoch !== epoch || work.state !== 'calling' || !work.leaseUntil || work.leaseUntil <= now) throw new ProviderBudgetError('stale_work');
        if (vector.length !== work.profile.dimensions || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new ProviderBudgetError('invalid_usage');
        await checkWorkRights(tx, work);
        const profileHash = collectionHash(work.profile);
        await tx.insert(embeddings).values({ chunkId: work.chunkId, provider: work.profile.provider, model: work.profile.model,
          profileHash, dimensions: work.profile.dimensions, embedding: [...vector], inputHash: work.inputHash }).onConflictDoNothing();
        const [embedding] = await tx.select({ id: embeddings.id }).from(embeddings).where(and(eq(embeddings.chunkId, work.chunkId),
          eq(embeddings.provider, work.profile.provider), eq(embeddings.model, work.profile.model), eq(embeddings.profileHash, profileHash), eq(embeddings.inputHash, work.inputHash)));
        if (!embedding) throw new ProviderBudgetError('stale_work');
        await tx.update(embeddingWorkItems).set({ state: 'completed', embeddingId: embedding.id, leaseUntil: null, updatedAt: now }).where(eq(embeddingWorkItems.id, id));
      });
    },
    async markOutcomeUnknown(id, epoch, now) {
      await db.transaction(async (tx) => {
        const [work] = await tx.select().from(embeddingWorkItems).where(eq(embeddingWorkItems.id, id)).for('update');
        if (!work || work.leaseEpoch !== epoch || work.state !== 'calling') return;
        await tx.update(embeddingWorkItems).set({ state: 'outcome_unknown', updatedAt: now }).where(eq(embeddingWorkItems.id, id));
        if (work.reservationId) await tx.update(providerBudgetReservations).set({ state: 'outcome_unknown', updatedAt: now })
          .where(and(eq(providerBudgetReservations.id, work.reservationId), eq(providerBudgetReservations.state, 'reserved')));
      });
    },
  };
}

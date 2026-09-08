import { and, asc, eq, sql } from 'drizzle-orm';
import { CollectionStateError, type DiscoveryStatePort, type DiscoveryCandidateRecord, type SourceKey } from '@techpulse/domain';
import type { DatabaseClient } from './client.js';
import { sources, discoveryCandidates, collectionTargets } from './schema/index.js';

export function createDiscoveryStateRepository(db: DatabaseClient['db']): DiscoveryStatePort {
  return {
    async recordCandidate(candidate, now) {
      if (!candidate.canonicalIdentity.trim() || candidate.canonicalIdentity.length > 512 || !Number.isFinite(now.getTime())) throw new CollectionStateError('invalid_state');
      try {
        const url = new URL(candidate.evidenceUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || candidate.evidenceUrl.length > 2048) throw new Error();
      } catch { throw new CollectionStateError('invalid_state'); }
      return db.transaction(async (tx) => {
        const [source] = await tx.select().from(sources).where(eq(sources.key, candidate.sourceKey)).for('share');
        if (!source) throw new CollectionStateError('not_found');
        if (!source.enabled || !source.policyReviewedAt) throw new CollectionStateError('policy_blocked');
        await tx.insert(discoveryCandidates).values({ sourceId: source.id, canonicalIdentity: candidate.canonicalIdentity,
          selector: candidate.selector, evidenceUrl: candidate.evidenceUrl, createdAt: now }).onConflictDoNothing();
        const [row] = await tx.select().from(discoveryCandidates).where(and(eq(discoveryCandidates.sourceId, source.id), eq(discoveryCandidates.canonicalIdentity, candidate.canonicalIdentity)));
        if (!row) throw new CollectionStateError('not_found');
        return { id: row.id, sourceKey: candidate.sourceKey, canonicalIdentity: row.canonicalIdentity, selector: row.selector,
          evidenceUrl: row.evidenceUrl, state: row.state as DiscoveryCandidateRecord['state'], targetId: row.targetId, reviewedBy: row.reviewedBy, reviewedAt: row.reviewedAt };
      });
    },
    async listCandidates(limit, after) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CollectionStateError('invalid_state');
      const rows = await db.select({ candidate: discoveryCandidates, sourceKey: sources.key }).from(discoveryCandidates)
        .innerJoin(sources, eq(sources.id, discoveryCandidates.sourceId)).where(after ? sql`${discoveryCandidates.id} > ${after}::uuid` : undefined)
        .orderBy(asc(discoveryCandidates.id)).limit(limit);
      return rows.map(({ candidate, sourceKey }) => ({ id: candidate.id, sourceKey: sourceKey as SourceKey, canonicalIdentity: candidate.canonicalIdentity,
        selector: candidate.selector, evidenceUrl: candidate.evidenceUrl, state: candidate.state as DiscoveryCandidateRecord['state'],
        targetId: candidate.targetId, reviewedBy: candidate.reviewedBy, reviewedAt: candidate.reviewedAt }));
    },
    async reviewCandidate(id, decision, targetId, actor, now) {
      if (!['accepted','rejected'].includes(decision) || !actor.trim() || actor.length > 128 || !Number.isFinite(now.getTime()) ||
          (decision === 'accepted' ? targetId === null : targetId !== null)) throw new CollectionStateError('invalid_state');
      await db.transaction(async (tx) => {
        const [candidate] = await tx.select().from(discoveryCandidates).where(eq(discoveryCandidates.id, id)).for('update');
        if (!candidate) throw new CollectionStateError('not_found');
        if (candidate.state !== 'pending') {
          if (candidate.state === decision && candidate.targetId === targetId && candidate.reviewedBy === actor) return;
          throw new CollectionStateError('invalid_state');
        }
        if (targetId) {
          const [target] = await tx.select().from(collectionTargets).where(eq(collectionTargets.id, targetId));
          if (!target || target.sourceId !== candidate.sourceId || target.canonicalIdentity !== candidate.canonicalIdentity) throw new CollectionStateError('invalid_state');
        }
        // Review links existing records only; it grants no rights and never enables a target.
        await tx.update(discoveryCandidates).set({ state: decision, targetId, reviewedBy: actor, reviewedAt: now }).where(eq(discoveryCandidates.id, id));
      });
    },
  };
}

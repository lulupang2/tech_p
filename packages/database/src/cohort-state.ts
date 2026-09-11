import { asc, eq } from 'drizzle-orm';
import {
  collectionHash,
  CollectionStateError,
  type CohortPersistencePort,
  type ObservationCohort,
} from '@techpulse/domain';
import type { DatabaseClient } from './client.js';
import {
  observationCohorts,
  observationCohortMembers,
  collectionTargetRevisions,
} from './schema/index.js';

function cohortIdentity(cohort: ObservationCohort): string {
  return collectionHash({
    ...cohort,
    members: [...cohort.members].sort((a, b) =>
      `${a.targetRevisionId}:${a.metric}:${a.unit}`.localeCompare(
        `${b.targetRevisionId}:${b.metric}:${b.unit}`,
      ),
    ),
  });
}
export function createCohortPersistenceRepository(db: DatabaseClient['db']): CohortPersistencePort {
  return {
    async createCohortVersion(cohort) {
      if (
        !cohort.version.trim() ||
        !Number.isFinite(cohort.effectiveAt.getTime()) ||
        cohort.members.length === 0 ||
        cohort.members.length > 100
      )
        throw new CollectionStateError('invalid_state');
      const identities = new Set<string>();
      for (const member of cohort.members) {
        const key = `${member.targetRevisionId}:${member.metric}:${member.unit}`;
        if (
          identities.has(key) ||
          !member.metric.trim() ||
          !member.unit.trim() ||
          !member.querySignature.trim() ||
          !Number.isSafeInteger(member.cadenceMs) ||
          member.cadenceMs < 60000
        )
          throw new CollectionStateError('invalid_state');
        identities.add(key);
      }
      await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(observationCohorts)
          .values({ id: cohort.id, version: cohort.version, effectiveAt: cohort.effectiveAt })
          .onConflictDoNothing()
          .returning();
        const [existing] = await tx
          .select()
          .from(observationCohorts)
          .where(eq(observationCohorts.id, cohort.id))
          .for('update');
        if (!existing) throw new CollectionStateError('invalid_state');
        if (inserted.length === 0) {
          const members = await tx
            .select()
            .from(observationCohortMembers)
            .where(eq(observationCohortMembers.cohortId, cohort.id));
          const previous: ObservationCohort = {
            id: existing.id,
            version: existing.version,
            effectiveAt: existing.effectiveAt,
            members: members.map(
              ({ targetRevisionId, metric, unit, querySignature, cadenceMs }) => ({
                targetRevisionId,
                metric,
                unit,
                querySignature,
                cadenceMs,
              }),
            ),
          };
          if (cohortIdentity(previous) !== cohortIdentity(cohort))
            throw new CollectionStateError('invalid_state');
          return;
        }
        for (const member of cohort.members) {
          const [revision] = await tx
            .select()
            .from(collectionTargetRevisions)
            .where(eq(collectionTargetRevisions.id, member.targetRevisionId));
          if (!revision) throw new CollectionStateError('not_found');
          await tx.insert(observationCohortMembers).values({ cohortId: cohort.id, ...member });
        }
      });
    },
    async getCohortVersion(id) {
      const [cohort] = await db
        .select()
        .from(observationCohorts)
        .where(eq(observationCohorts.id, id));
      if (!cohort) return null;
      const members = await db
        .select()
        .from(observationCohortMembers)
        .where(eq(observationCohortMembers.cohortId, id))
        .orderBy(
          asc(observationCohortMembers.targetRevisionId),
          asc(observationCohortMembers.metric),
          asc(observationCohortMembers.unit),
        );
      return {
        id: cohort.id,
        version: cohort.version,
        effectiveAt: cohort.effectiveAt,
        members: members.map(({ targetRevisionId, metric, unit, querySignature, cadenceMs }) => ({
          targetRevisionId,
          metric,
          unit,
          querySignature,
          cadenceMs,
        })),
      };
    },
  };
}

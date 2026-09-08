import { and, eq, sql } from 'drizzle-orm';
import { ProviderBudgetError, type ProviderBudgetPort, type BudgetReservation } from '@techpulse/domain';
import type { DatabaseClient } from './client.js';
import { providerBudgetScopes, providerBudgetReservations, embeddingWorkItems } from './schema/index.js';

function assertUsage(units: number, tokens: number): void {
  if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(tokens) || tokens < 0) throw new ProviderBudgetError('invalid_usage');
}
export function createProviderBudgetRepository(db: DatabaseClient['db']): ProviderBudgetPort {
  return {
    async configureScope(scope) {
      assertUsage(scope.maxDailyUnits, scope.maxDailyTokens);
      assertUsage(scope.maxOutstandingUnits, 0);
      if (!/^[A-Z]{3}$/u.test(scope.currency) || !scope.id) throw new ProviderBudgetError('invalid_usage');
      for (const limit of Object.values(scope.laneLimits)) assertUsage(limit.maxDailyUnits, limit.maxDailyTokens);
      if (!Array.isArray(scope.approvedModelProfiles) || scope.approvedModelProfiles.some((hash) => !/^[a-f0-9]{64}$/u.test(hash))) throw new ProviderBudgetError('invalid_usage');
      await db.transaction(async (tx) => {
        await tx.insert(providerBudgetScopes).values(scope).onConflictDoNothing();
        const [existing] = await tx.select().from(providerBudgetScopes).where(eq(providerBudgetScopes.id, scope.id)).for('update');
        if (!existing || existing.currency !== scope.currency) throw new ProviderBudgetError('reservation_conflict');
        await tx.update(providerBudgetScopes).set(scope).where(eq(providerBudgetScopes.id, scope.id));
      });
    },
    async reserve(scopeId, attemptId, lane, units, tokens, now) {
      assertUsage(units, tokens);
      if (!attemptId || attemptId.length > 256 || !Number.isFinite(now.getTime())) throw new ProviderBudgetError('invalid_usage');
      const utcDay = now.toISOString().slice(0, 10);
      return db.transaction(async (tx) => {
        const [scope] = await tx.select().from(providerBudgetScopes).where(eq(providerBudgetScopes.id, scopeId)).for('update');
        if (!scope?.approved || !scope.laneLimits[lane]) throw new ProviderBudgetError('approval_required');
        const [existing] = await tx.select().from(providerBudgetReservations).where(eq(providerBudgetReservations.attemptId, attemptId));
        if (existing) {
          if (existing.scopeId !== scopeId || existing.lane !== lane || existing.units !== units || existing.tokens !== tokens) throw new ProviderBudgetError('reservation_conflict');
          return { ...existing, state: existing.state as BudgetReservation['state'] };
        }
        if (scope.blocked) throw new ProviderBudgetError('budget_exhausted');
        const total = await tx.execute<{ daily_units: string; daily_tokens: string; outstanding: string; lane_units: string; lane_tokens: string }>(sql`
          SELECT
            COALESCE(SUM(CASE WHEN utc_day = ${utcDay} THEN COALESCE(actual_units, units) ELSE 0 END), 0)::text AS daily_units,
            COALESCE(SUM(CASE WHEN utc_day = ${utcDay} THEN COALESCE(actual_tokens, tokens) ELSE 0 END), 0)::text AS daily_tokens,
            COALESCE(SUM(CASE WHEN state IN ('reserved','outcome_unknown') THEN units ELSE 0 END), 0)::text AS outstanding,
            COALESCE(SUM(CASE WHEN utc_day = ${utcDay} AND lane = ${lane} THEN COALESCE(actual_units, units) ELSE 0 END), 0)::text AS lane_units,
            COALESCE(SUM(CASE WHEN utc_day = ${utcDay} AND lane = ${lane} THEN COALESCE(actual_tokens, tokens) ELSE 0 END), 0)::text AS lane_tokens
          FROM provider_budget_reservations WHERE scope_id = ${scopeId} AND state != 'released'`);
        const row = total.rows[0];
        const laneLimit = scope.laneLimits[lane];
        if (!row || !laneLimit || BigInt(row.daily_units) + BigInt(units) > BigInt(scope.maxDailyUnits) ||
          BigInt(row.daily_tokens) + BigInt(tokens) > BigInt(scope.maxDailyTokens) ||
          BigInt(row.outstanding) + BigInt(units) > BigInt(scope.maxOutstandingUnits) ||
          BigInt(row.lane_units) + BigInt(units) > BigInt(laneLimit.maxDailyUnits) ||
          BigInt(row.lane_tokens) + BigInt(tokens) > BigInt(laneLimit.maxDailyTokens)) throw new ProviderBudgetError('budget_exhausted');
        const [reservation] = await tx.insert(providerBudgetReservations).values({ scopeId, attemptId, lane, utcDay, units, tokens, createdAt: now, updatedAt: now }).returning();
        if (!reservation) throw new ProviderBudgetError('reservation_conflict');
        return { ...reservation, state: reservation.state as BudgetReservation['state'] };
      });
    },
    async settle(id, units, tokens, now) {
      assertUsage(units, tokens);
      await db.transaction(async (tx) => {
        const [candidate] = await tx.select().from(providerBudgetReservations).where(eq(providerBudgetReservations.id, id));
        if (!candidate) throw new ProviderBudgetError('reservation_conflict');
        await tx.select().from(providerBudgetScopes).where(eq(providerBudgetScopes.id, candidate.scopeId)).for('update');
        const [row] = await tx.select().from(providerBudgetReservations).where(eq(providerBudgetReservations.id, id)).for('update');
        if (!row || row.state === 'released') throw new ProviderBudgetError('reservation_conflict');
        if (row.state === 'settled') {
          if (row.actualUnits !== units || row.actualTokens !== tokens) throw new ProviderBudgetError('reservation_conflict');
          return;
        }
        await tx.update(providerBudgetReservations).set({ state: 'settled', actualUnits: units, actualTokens: tokens, updatedAt: now }).where(eq(providerBudgetReservations.id, id));
        if (units > row.units || tokens > row.tokens) {
          await tx.update(providerBudgetScopes).set({ blocked: true }).where(eq(providerBudgetScopes.id, row.scopeId));
        }
      });
    },
    async holdUnknown(id, now) {
      await db.update(providerBudgetReservations).set({ state: 'outcome_unknown', updatedAt: now })
        .where(and(eq(providerBudgetReservations.id, id), eq(providerBudgetReservations.state, 'reserved')));
    },
    async releaseUnsent(id, now) {
      await db.transaction(async (tx) => {
        const [row] = await tx.select().from(providerBudgetReservations).where(eq(providerBudgetReservations.id, id)).for('update');
        if (!row) throw new ProviderBudgetError('reservation_conflict');
        if (row.state === 'released') return;
        if (row.state !== 'reserved') throw new ProviderBudgetError('outcome_unknown');
        const [work] = await tx.select().from(embeddingWorkItems).where(eq(embeddingWorkItems.reservationId, id));
        if (work && ['calling','completed','outcome_unknown'].includes(work.state)) throw new ProviderBudgetError('outcome_unknown');
        await tx.update(providerBudgetReservations).set({ state: 'released', updatedAt: now }).where(eq(providerBudgetReservations.id, id));
      });
    },
  };
}

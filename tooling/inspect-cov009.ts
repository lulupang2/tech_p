import { eq, like, sql } from 'drizzle-orm';
import {
  collectionCheckpoints,
  collectionPartitions,
  createDatabaseClient,
  embeddingWorkItems,
  providerBudgetReservations,
} from '@techpulse/database';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = createDatabaseClient(databaseUrl);
  await client.connect();
  try {
    const partitions = await client.db
      .select({ state: collectionPartitions.state, count: sql<number>`count(*)::int` })
      .from(collectionPartitions)
      .where(like(collectionPartitions.scopeKey, 'cov009-20260910-live-v1%'))
      .groupBy(collectionPartitions.state);
    const checkpoints = await client.db
      .select({
        count: sql<number>`count(*)::int`,
        requests: sql<number>`coalesce(sum(${collectionCheckpoints.requests}), 0)::int`,
        bytes: sql<number>`coalesce(sum(${collectionCheckpoints.bytes}), 0)::bigint`,
        retainedItems: sql<number>`coalesce(sum(${collectionCheckpoints.retainedItems}), 0)::int`,
      })
      .from(collectionCheckpoints)
      .innerJoin(
        collectionPartitions,
        eq(collectionPartitions.id, collectionCheckpoints.partitionId),
      )
      .where(like(collectionPartitions.scopeKey, 'cov009-20260910-live-v1%'));
    const work = await client.db
      .select({ state: embeddingWorkItems.state, count: sql<number>`count(*)::int` })
      .from(embeddingWorkItems)
      .groupBy(embeddingWorkItems.state);
    const budget = await client.db
      .select({
        state: providerBudgetReservations.state,
        count: sql<number>`count(*)::int`,
        actualUnits: sql<number>`coalesce(sum(${providerBudgetReservations.actualUnits}), 0)::bigint`,
        actualTokens: sql<number>`coalesce(sum(${providerBudgetReservations.actualTokens}), 0)::bigint`,
        reservedUnits: sql<number>`coalesce(sum(${providerBudgetReservations.units}), 0)::bigint`,
      })
      .from(providerBudgetReservations)
      .where(eq(providerBudgetReservations.scopeId, 'dec-012-cov009'))
      .groupBy(providerBudgetReservations.state);
    const outbox = await client.db.execute<{ kind: string; pending: number }>(sql`
      SELECT d.kind, count(*)::int AS pending
      FROM delivery_outbox d
      JOIN collection_partitions p ON p.id = d.partition_id
      WHERE p.scope_key LIKE 'cov009-20260910-live-v1%' AND d.completed_at IS NULL
      GROUP BY d.kind ORDER BY d.kind`);
    process.stdout.write(
      `${JSON.stringify({ partitions, checkpoints: checkpoints[0], work, budget, pendingOutbox: outbox.rows })}\n`,
    );
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

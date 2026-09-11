import { createDatabaseClient } from '@techpulse/database';
import { sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_DIRECT?.trim() || process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const client = createDatabaseClient(databaseUrl);
  await client.connect();
  try {
    const recovered = await client.db.transaction(async (tx) => {
      const candidates = await tx.execute<{ work_id: string; reservation_id: string }>(sql`
        SELECT w.id AS work_id, r.id AS reservation_id
        FROM embedding_work_items w
        JOIN provider_budget_reservations r ON r.id = w.reservation_id
        WHERE w.state = 'outcome_unknown'
          AND r.scope_id = 'dec-012-cov009'
          AND r.state = 'outcome_unknown'
          AND r.actual_units IS NULL
          AND r.actual_tokens IS NULL
          AND EXISTS (
            SELECT 1
            FROM chunks c
            JOIN document_revisions dr ON dr.id = c.document_revision_id
            JOIN acquisition_memberships a ON a.revision_id = dr.id
            JOIN collection_partitions p ON p.id = a.partition_id
            WHERE c.id = w.chunk_id
              AND p.scope_key LIKE 'cov009-20260910-live-v1%'
          )
        FOR UPDATE OF w, r`);
      if (candidates.rows.length !== 28) {
        throw new Error(
          `Expected exactly 28 confirmed auth failures, found ${candidates.rows.length}`,
        );
      }
      const workIds = candidates.rows.map((row) => sql`${row.work_id}::uuid`);
      const reservationIds = candidates.rows.map((row) => sql`${row.reservation_id}::uuid`);
      await tx.execute(sql`
        UPDATE embedding_work_items
        SET state = 'pending', reservation_id = NULL, lease_until = NULL, updated_at = now()
        WHERE id IN (${sql.join(workIds, sql`, `)})`);
      await tx.execute(sql`
        UPDATE provider_budget_reservations
        SET state = 'released', updated_at = now()
        WHERE id IN (${sql.join(reservationIds, sql`, `)})`);
      return candidates.rows.length;
    });
    process.stdout.write(`${JSON.stringify({ recoveredKnownHttp401Failures: recovered })}\n`);
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

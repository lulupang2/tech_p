import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  collectionRuns,
  createDatabaseClient,
  rawItems,
  sources,
  upsertRawItem,
} from '../src/index.js';

describe('DB-002 PostgreSQL integration', () => {
  const databaseUrl = process.env['DATABASE_URL'];
  const describeIntegration = databaseUrl ? describe : describe.skip;

  describeIntegration('source, run, raw item persistence', () => {
    test('replaying a raw revision preserves one immutable logical row', async () => {
      const client = createDatabaseClient(databaseUrl as string);
      const sourceKey = `db002-${crypto.randomUUID()}`;
      try {
        await client.migrate();
        const [source] = await client.db
          .insert(sources)
          .values({
            key: sourceKey,
            name: 'DB-002 fixture',
            kind: 'text',
            baseUrl: 'https://example.com',
            scheduleConfig: { interval: 'daily' },
          })
          .returning();
        assert.ok(source);
        const [run] = await client.db
          .insert(collectionRuns)
          .values({ sourceId: source.id, scheduledAt: new Date('2026-01-01T00:00:00Z') })
          .returning();
        assert.ok(run);

        const values = {
          sourceId: source.id,
          runId: run.id,
          externalId: 'fixture-1',
          canonicalUrl: 'https://example.com/fixture-1',
          payload: { title: 'raw', body: 'immutable' },
          payloadHash: 'a'.repeat(64),
          rightsMetadata: { license: 'cc0-1.0' },
        };
        const first = await upsertRawItem(client.db, values);
        const replay = await upsertRawItem(client.db, {
          ...values,
          payload: { title: 'tampered' },
          runId: run.id,
        });
        assert.equal(replay.id, first.id);
        assert.deepEqual(replay.payload, first.payload);
        assert.deepEqual(replay.rightsMetadata, first.rightsMetadata);
        const count = await client.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM raw_items WHERE source_id = $1',
          [source.id],
        );
        assert.equal(Number(count.rows[0]?.count), 1);

        await assert.rejects(
          client.db.insert(rawItems).values({ ...values, payloadHash: 'not-a-sha256' }),
          (error: unknown) =>
            error instanceof Error &&
            error.cause instanceof Error &&
            error.cause.message.includes('raw_items_payload_hash_sha256'),
        );
      } finally {
        await client.close();
      }
    });
  });
});

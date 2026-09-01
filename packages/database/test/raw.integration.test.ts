import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  collectionRuns,
  createDatabaseClient,
  pipelineEvents,
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
        const [secondSource] = await client.db
          .insert(sources)
          .values({
            key: `${sourceKey}-other`,
            name: 'DB-002 second fixture',
            kind: 'text',
            baseUrl: 'https://other.example.com',
            scheduleConfig: {},
          })
          .returning();
        assert.ok(secondSource);
        await assert.rejects(
          client.db.insert(rawItems).values({ ...values, sourceId: secondSource.id }),
          (error: unknown) =>
            error instanceof Error &&
            error.cause instanceof Error &&
            error.cause.message.includes('raw_items_source_run_consistency_fk'),
        );

        const [event] = await client.db
          .insert(pipelineEvents)
          .values({
            rawItemId: first.id,
            stage: 'normalize',
            processorVersion: 'test-1',
            status: 'succeeded',
          })
          .returning();
        assert.ok(event);
        await assert.rejects(
          client.pool.query('UPDATE raw_items SET payload = $1 WHERE id = $2', [
            { changed: true },
            first.id,
          ]),
          /immutable/u,
        );
        await assert.rejects(
          client.pool.query('DELETE FROM raw_items WHERE id = $1', [first.id]),
          /immutable/u,
        );
        await assert.rejects(
          client.pool.query('UPDATE pipeline_events SET status = $1 WHERE id = $2', [
            'failed',
            event.id,
          ]),
          /immutable/u,
        );
        await assert.rejects(
          client.pool.query('DELETE FROM pipeline_events WHERE id = $1', [event.id]),
          /immutable/u,
        );
      } finally {
        await client.close();
      }
    });
  });
});

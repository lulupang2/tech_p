import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createDatabaseClient } from '../src/index.js';
import {
  sources,
  collectionRuns,
  rawItems,
  documents,
  documentRevisions,
  topics,
  documentTopics,
  chunks,
  embeddings,
} from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('DB-003 PostgreSQL integration', () => {
  test('applies all migrations including DB-003 and validates constraints', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    try {
      const migResult = await client.migrate();
      assert(migResult.applied);

      const sourceKey = `test-src-db003-${Date.now()}`;
      const [src] = await db
        .insert(sources)
        .values({
          key: sourceKey,
          name: 'DB003 Test Source',
          kind: 'rss',
          baseUrl: 'https://example.com/feed.xml',
          scheduleConfig: { interval: '1h' },
        })
        .returning();
      assert(src);

      const [run] = await db
        .insert(collectionRuns)
        .values({
          sourceId: src.id,
          scheduledAt: new Date(),
          status: 'succeeded',
        })
        .returning();
      assert(run);

      const sha256 = 'a'.repeat(64);
      const [raw] = await db
        .insert(rawItems)
        .values({
          sourceId: src.id,
          runId: run.id,
          externalId: 'ext-1',
          canonicalUrl: 'https://example.com/article-1',
          payload: { hello: 'world' },
          payloadHash: sha256,
        })
        .returning();
      assert(raw);

      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: 'https://example.com/article-1',
        })
        .returning();
      assert(doc);

      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          rawItemId: raw.id,
          title: 'Test Article Title',
          bodyText: 'This is the body content of test article.',
          normalizedHash: sha256,
          normalizerVersion: 'v1.0.0',
          status: 'searchable',
        })
        .returning();
      assert(rev);

      const [topic] = await db
        .insert(topics)
        .values({
          slug: `typescript-${Date.now()}`,
          displayName: 'TypeScript',
          aliases: ['ts'],
        })
        .returning();
      assert(topic);

      await db.insert(documentTopics).values({
        documentId: doc.id,
        topicId: topic.id,
        method: 'deterministic',
        confidence: 100,
      });

      const [chunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: rev.id,
          ordinal: 0,
          headingPath: ['Introduction'],
          content: 'This is the chunk text.',
          tokenCount: 15,
          contentHash: sha256,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(chunk);

      const [emb] = await db
        .insert(embeddings)
        .values({
          chunkId: chunk.id,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: 3,
          embedding: [0.1, 0.2, 0.3],
          inputHash: sha256,
        })
        .returning();
      assert(emb);

      // Verify revision unique constraint (documentId + normalizedHash)
      await assert.rejects(async () => {
        await db.insert(documentRevisions).values({
          documentId: doc.id,
          title: 'Duplicate revision attempt',
          bodyText: 'Different body text',
          normalizedHash: sha256, // same hash
          normalizerVersion: 'v1.0.0',
        });
      });

      // Verify chunk unique constraint (documentRevisionId + ordinal + chunkerVersion)
      await assert.rejects(async () => {
        await db.insert(chunks).values({
          documentRevisionId: rev.id,
          ordinal: 0, // same ordinal
          content: 'Another chunk content',
          tokenCount: 20,
          contentHash: 'b'.repeat(64),
          chunkerVersion: 'v1.0.0', // same version
        });
      });
    } finally {
      await client.close();
    }
  });
});

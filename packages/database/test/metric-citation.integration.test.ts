import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createDatabaseClient } from '../src/index.js';
import {
  sources,
  collectionRuns,
  rawItems,
  documents,
  documentRevisions,
  chunks,
  topics,
  metricObservations,
  queryRuns,
  answerCitations,
} from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('DB-004 PostgreSQL integration', () => {
  test('applies all migrations including DB-004 and validates metric & citation constraints', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    try {
      const migResult = await client.migrate();
      assert(migResult.applied);

      const sourceKey = `test-src-db004-${Date.now()}`;
      const [src] = await db
        .insert(sources)
        .values({
          key: sourceKey,
          name: 'DB004 Test Source',
          kind: 'metric_api',
          baseUrl: 'https://example.com/api',
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

      const sha256 = 'c'.repeat(64);
      const [raw] = await db
        .insert(rawItems)
        .values({
          sourceId: src.id,
          runId: run.id,
          externalId: 'ext-m1',
          canonicalUrl: 'https://example.com/metric-1',
          payload: { count: 123 },
          payloadHash: sha256,
        })
        .returning();
      assert(raw);

      const [topic] = await db
        .insert(topics)
        .values({
          slug: `react-${Date.now()}`,
          displayName: 'React',
          aliases: ['reactjs'],
        })
        .returning();
      assert(topic);

      const now = new Date();
      const past = new Date(now.getTime() - 3600000);

      // 1. Insert metric observation
      const [metric] = await db
        .insert(metricObservations)
        .values({
          sourceId: src.id,
          topicId: topic.id,
          subjectKey: 'facebook/react',
          metricType: 'repo_attention',
          windowStart: past,
          windowEnd: now,
          value: 205000,
          unit: 'stars',
          rawItemId: raw.id,
          querySignature: 'stars:>1000',
          isIncomplete: false,
        })
        .returning();
      assert(metric);

      // Verify metric natural key uniqueness: (sourceId, subjectKey, metricType, windowStart, windowEnd, rawItemId)
      await assert.rejects(async () => {
        await db.insert(metricObservations).values({
          sourceId: src.id,
          topicId: topic.id,
          subjectKey: 'facebook/react',
          metricType: 'repo_attention',
          windowStart: past,
          windowEnd: now,
          value: 999999, // different value
          unit: 'stars',
          rawItemId: raw.id, // same raw revision
        });
      });

      // 2. Insert document, revision, and chunk for citation testing
      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: 'https://example.com/article-db004',
        })
        .returning();
      assert(doc);

      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          rawItemId: raw.id,
          title: 'Article for DB-004 Citation',
          bodyText: 'Citation verification body text content.',
          normalizedHash: sha256,
          normalizerVersion: 'v1.0.0',
          status: 'searchable',
        })
        .returning();
      assert(rev);

      const [chunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: rev.id,
          ordinal: 0,
          headingPath: [],
          content: 'Citation snippet chunk text.',
          tokenCount: 8,
          contentHash: sha256,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(chunk);

      // 3. Insert query run
      const reqId = `req-test-${Date.now()}`;
      const [qRun] = await db
        .insert(queryRuns)
        .values({
          requestId: reqId,
          questionHash: 'd'.repeat(64),
          parsedQuery: { topic: 'react', intent: 'summary' },
          retrievalConfig: { limit: 5 },
          workflowVersion: 'wf-v1',
          status: 'completed',
        })
        .returning();
      assert(qRun);

      // 4. Insert answer citation
      const [cit] = await db
        .insert(answerCitations)
        .values({
          queryRunId: qRun.id,
          citationKey: 'cite-1',
          chunkId: chunk.id,
          documentRevisionId: rev.id,
          claimIndex: 0,
          excerpt: 'Citation snippet chunk text.',
        })
        .returning();
      assert(cit);

      // Verify citation key uniqueness within query run
      await assert.rejects(async () => {
        await db.insert(answerCitations).values({
          queryRunId: qRun.id,
          citationKey: 'cite-1', // duplicate in same query run
          chunkId: chunk.id,
          documentRevisionId: rev.id,
          claimIndex: 1,
          excerpt: 'Different excerpt',
        });
      });
    } finally {
      await client.close();
    }
  });
});

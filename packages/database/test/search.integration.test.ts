import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { createDatabaseClient, createSearchService } from '../src/index.js';
import { documents, documentRevisions, chunks, embeddings } from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('DB-006 Search Integration (FTS & Exact Vector)', () => {
  test('performs deterministic full-text search and exact cosine vector search', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const searchService = createSearchService(db);

    try {
      await client.migrate();

      const uniqueKeyword = `UniqueFtsTarget${Date.now()}`;
      const uniqueVectorKeyword = `UniqueVecTarget${Date.now()}`;

      // Seed corpus document
      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: `https://example.com/fts-vector-test-${Date.now()}`,
        })
        .returning();
      assert(doc);

      const sha256 = '8'.repeat(64);
      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          title: `PostgreSQL pgvector Architecture ${uniqueKeyword}`,
          bodyText: 'Comprehensive guide to building full-text search and vector retrieval.',
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
          headingPath: ['Architecture', 'Retrieval'],
          content: `We combine lexical search with exact nearest-neighbor cosine distance ${uniqueVectorKeyword}.`,
          tokenCount: 12,
          contentHash: sha256,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(chunk);

      // Seed embedding: [1.0, 0.0, 0.0]
      await db.insert(embeddings).values({
        chunkId: chunk.id,
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 3,
        embedding: [1.0, 0.0, 0.0],
        inputHash: sha256,
      });

      // 1. FTS Search Test with unique keyword
      const ftsHits = await searchService.searchFts({
        query: uniqueKeyword,
        limit: 5,
      });
      assert.equal(ftsHits.length, 1);
      assert.equal(ftsHits[0]?.chunkId, chunk.id);
      assert.equal(ftsHits[0]?.title, `PostgreSQL pgvector Architecture ${uniqueKeyword}`);
      assert(ftsHits[0]!.score > 0);

      // 2. Exact Vector Search Test
      // Query vector: [0.99, 0.01, 0.0] should match [1.0, 0.0, 0.0] with very high cosine similarity
      const vectorHits = await searchService.searchExactVector({
        vector: [0.99, 0.01, 0.0],
        dimensions: 3,
        provider: 'openai',
        model: 'text-embedding-3-small',
        limit: 1,
      });
      assert(vectorHits.length >= 1);
      assert(vectorHits[0]!.score > 0.95);
    } finally {
      await client.close();
    }
  });
});

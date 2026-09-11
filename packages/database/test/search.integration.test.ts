import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  collectionHash,
  type ModelProfile,
  type SearchServicePort,
  type SearchReadinessPort,
} from '@techpulse/domain';
import {
  createDatabaseClient,
  createSearchService,
  createSearchReadinessRepository,
  type DatabaseClient,
} from '../src/index.js';
import {
  sources,
  collectionRuns,
  rawItems,
  documents,
  documentRevisions,
  chunks,
  embeddings,
} from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

const approvedProfile: ModelProfile = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  version: '1',
  dimensions: 3,
  priceVersion: 'zero-1',
  tokenizerVersion: 'fixture-1',
  approvalReference: 'approved-fixture',
};
const approvedProfileHash = collectionHash(approvedProfile);

const wrongProfile: ModelProfile = {
  provider: 'cohere',
  model: 'embed-english-v3.0',
  version: '1',
  dimensions: 3,
  priceVersion: 'zero-1',
  tokenizerVersion: 'fixture-1',
  approvalReference: 'wrong-fixture',
};

describeIntegration(
  'DB-006 Search Integration (FTS & Exact Vector with Readiness & Isolation)',
  () => {
    let admin: DatabaseClient;
    let client: DatabaseClient;
    let db: DatabaseClient['db'];
    let searchService: SearchServicePort;
    let readinessRepo: SearchReadinessPort;
    let databaseName: string;
    let dbCreated = false;

    const now = new Date('2026-09-08T12:00:00Z');

    beforeAll(async () => {
      const rootUrl = new URL(databaseUrl as string);
      const isLocal =
        ['127.0.0.1', 'localhost', '::1', 'postgres', 'postgres-persistent'].includes(
          rootUrl.hostname,
        ) || rootUrl.hostname.startsWith('postgres-');
      const allowRemoteIsolation = process.env['ALLOW_REMOTE_INTEGRATION_DATABASE'] === '1';
      if (!isLocal && !allowRemoteIsolation) {
        throw new Error(
          'Search integration test requires an isolated PostgreSQL server or explicit remote isolation opt-in',
        );
      }

      admin = createDatabaseClient(rootUrl.toString());
      databaseName = `search_isolated_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(rootUrl);
      url.pathname = `/${databaseName}`;

      await admin.db.execute(sql.raw(`CREATE DATABASE "${databaseName}"`));
      dbCreated = true;

      client = createDatabaseClient(url.toString());
      db = client.db;
      searchService = createSearchService(db);
      readinessRepo = createSearchReadinessRepository(db);

      await client.connect();
      const healthy = await client.checkHealth();
      assert.equal(healthy, true, 'Database is unreachable for search integration test');

      const migrationResult = await client.migrate();
      assert.equal(migrationResult.applied, true);

      const vectorInfo = await client.checkVector();
      assert.equal(vectorInfo.installed, true, 'pgvector extension is required');
    }, 30000);

    afterAll(async () => {
      if (client) {
        await client.close();
      }
      if (admin) {
        if (dbCreated) {
          await admin.db.execute(sql.raw(`DROP DATABASE "${databaseName}" WITH (FORCE)`));
        }
        await admin.close();
      }
    });

    test('performs deterministic full-text search and exact cosine vector search with valid readiness and provenance', async () => {
      const uniqueKeyword = `UniqueFtsTarget${randomUUID().replaceAll('-', '')}`;
      const uniqueVectorKeyword = `UniqueVecTarget${randomUUID().replaceAll('-', '')}`;
      const sha256 = '8'.repeat(64);

      // 1. Seed provenance: source, run, raw item with valid rights
      const [source] = await db
        .insert(sources)
        .values({
          key: `source_${randomUUID().replaceAll('-', '')}`,
          name: 'Search Fixture Source',
          kind: 'api',
          baseUrl: 'https://example.com/api',
          enabled: true,
          policyReviewedAt: now,
        })
        .returning();
      assert(source);

      const [run] = await db
        .insert(collectionRuns)
        .values({
          sourceId: source.id,
          scheduledAt: now,
          startedAt: now,
          endedAt: now,
          status: 'succeeded',
        })
        .returning();
      assert(run);

      const [raw] = await db
        .insert(rawItems)
        .values({
          sourceId: source.id,
          runId: run.id,
          externalId: `ext-${randomUUID()}`,
          canonicalUrl: `https://example.com/search-raw-${Date.now()}`,
          payload: { title: 'Raw Search Document', content: 'Raw content' },
          payloadHash: sha256,
          publishedAt: now,
          collectedAt: now,
          httpMetadata: { status: 200 },
          rightsMetadata: {
            approved: true,
            fetch: true,
            store: true,
            embed: true,
            modelInput: true,
            displayExcerpt: true,
            verbatimOnly: false,
            licenseId: null,
          },
        })
        .returning();
      assert(raw);

      // 2. Seed corpus document and revision satisfying lexical readiness
      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: `https://example.com/fts-vector-test-${Date.now()}`,
        })
        .returning();
      assert(doc);

      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          rawItemId: raw.id,
          title: `PostgreSQL pgvector Architecture ${uniqueKeyword}`,
          bodyText: 'Comprehensive guide to building full-text search and vector retrieval.',
          normalizedHash: sha256,
          normalizerVersion: 'v1.0.0',
          status: 'searchable',
          lexicalReadyAt: now,
          searchableAt: now,
          publishedAt: now,
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

      // 3. Seed embedding matching approvedProfile and profileHash
      await db.insert(embeddings).values({
        chunkId: chunk.id,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        dimensions: approvedProfile.dimensions,
        embedding: [1.0, 0.0, 0.0],
        inputHash: sha256,
      });

      // 4. Verify vector readiness repository confirms profile vector readiness
      const isVecReady = await readinessRepo.getVectorReadiness(rev.id, approvedProfile);
      assert.equal(isVecReady, true);

      // 5. FTS Search Test with unique keyword: validates exact returned chunk metadata
      const ftsHits = await searchService.searchFts({
        query: uniqueKeyword,
        limit: 5,
        filter: { requireApprovedRights: true },
      });
      assert.equal(ftsHits.length, 1);
      assert.equal(ftsHits[0]?.chunkId, chunk.id);
      assert.equal(ftsHits[0]?.documentId, doc.id);
      assert.equal(ftsHits[0]?.documentRevisionId, rev.id);
      assert.equal(ftsHits[0]?.title, `PostgreSQL pgvector Architecture ${uniqueKeyword}`);
      assert.equal(
        ftsHits[0]?.content,
        `We combine lexical search with exact nearest-neighbor cosine distance ${uniqueVectorKeyword}.`,
      );
      assert.deepEqual(ftsHits[0]?.headingPath, ['Architecture', 'Retrieval']);
      assert(ftsHits[0]!.score > 0);
      assert.equal(ftsHits[0]?.publishedAt?.toISOString(), now.toISOString());

      // 6. Exact Vector Search Test: cosine similarity nearest neighbor match
      const vectorHits = await searchService.searchExactVector({
        vector: [0.99, 0.01, 0.0],
        dimensions: 3,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        limit: 1,
        filter: { requireApprovedRights: true },
      });
      assert.equal(vectorHits.length, 1);
      assert.equal(vectorHits[0]?.chunkId, chunk.id);
      assert.equal(vectorHits[0]?.documentId, doc.id);
      assert.equal(vectorHits[0]?.documentRevisionId, rev.id);
      assert(vectorHits[0]!.score > 0.95);

      const selected = createSearchService(db, { revisionIds: [rev.id] });
      assert.equal(
        (await selected.searchFts({ query: uniqueKeyword, limit: 1 }))[0]?.chunkId,
        chunk.id,
      );
      const excluded = createSearchService(db, { revisionIds: [randomUUID()] });
      assert.deepEqual(await excluded.searchFts({ query: uniqueKeyword, limit: 1 }), []);
      assert.deepEqual(
        await excluded.searchExactVector({
          vector: [1, 0, 0],
          dimensions: 3,
          provider: approvedProfile.provider,
          model: approvedProfile.model,
          profileHash: approvedProfileHash,
          limit: 1,
        }),
        [],
      );
      assert.deepEqual(
        await createSearchService(db, { revisionIds: [] }).searchFts({ query: uniqueKeyword }),
        [],
      );

      // A revision is vector-ready only when every current chunk has a matching profile/input hash.
      const secondHash = '7'.repeat(64);
      const [secondChunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: rev.id,
          ordinal: 1,
          headingPath: ['Architecture', 'Readiness'],
          content: 'A second chunk must be embedded before this revision is vector-ready.',
          tokenCount: 11,
          contentHash: secondHash,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(secondChunk);
      const incompleteHits = await searchService.searchExactVector({
        vector: [0.99, 0.01, 0.0],
        dimensions: 3,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        filter: { requireApprovedRights: true },
      });
      assert.equal(
        incompleteHits.some((hit) => hit.documentRevisionId === rev.id),
        false,
      );

      await db.insert(embeddings).values({
        chunkId: secondChunk.id,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        dimensions: approvedProfile.dimensions,
        embedding: [0.8, 0.2, 0.0],
        inputHash: secondHash,
      });
      const completeHits = await searchService.searchExactVector({
        vector: [0.99, 0.01, 0.0],
        dimensions: 3,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        filter: { requireApprovedRights: true },
      });
      assert.equal(
        completeHits.some((hit) => hit.documentRevisionId === rev.id),
        true,
      );

      // Raw rows are immutable. Insert a separate denied provenance chain and prove both paths
      // exclude it instead of mutating the approved fixture.
      const deniedKeyword = `RightsDenied${randomUUID().replaceAll('-', '')}`;
      const deniedHash = '6'.repeat(64);
      const [deniedRaw] = await db
        .insert(rawItems)
        .values({
          sourceId: source.id,
          runId: run.id,
          externalId: `denied-${randomUUID()}`,
          canonicalUrl: `https://example.com/rights-denied-${Date.now()}`,
          payload: { title: deniedKeyword },
          payloadHash: deniedHash,
          publishedAt: now,
          collectedAt: now,
          httpMetadata: { status: 200 },
          rightsMetadata: {
            approved: false,
            fetch: true,
            store: true,
            embed: true,
            modelInput: true,
            displayExcerpt: true,
          },
        })
        .returning();
      assert(deniedRaw);
      const [deniedDoc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: deniedRaw.canonicalUrl,
        })
        .returning();
      assert(deniedDoc);
      const [deniedRevision] = await db
        .insert(documentRevisions)
        .values({
          documentId: deniedDoc.id,
          rawItemId: deniedRaw.id,
          title: deniedKeyword,
          bodyText: 'This denied-rights document must never enter RAG retrieval.',
          normalizedHash: deniedHash,
          normalizerVersion: 'v1.0.0',
          status: 'searchable',
          lexicalReadyAt: now,
          searchableAt: now,
          publishedAt: now,
        })
        .returning();
      assert(deniedRevision);
      const [deniedChunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: deniedRevision.id,
          ordinal: 0,
          headingPath: ['Denied'],
          content: `Denied retrieval content ${deniedKeyword}.`,
          tokenCount: 6,
          contentHash: deniedHash,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(deniedChunk);
      await db.insert(embeddings).values({
        chunkId: deniedChunk.id,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        dimensions: approvedProfile.dimensions,
        embedding: [0.99, 0.01, 0.0],
        inputHash: deniedHash,
      });
      const rightsBlockedFts = await searchService.searchFts({
        query: deniedKeyword,
        filter: { requireApprovedRights: true },
      });
      const rightsBlockedVector = await searchService.searchExactVector({
        vector: [0.99, 0.01, 0.0],
        dimensions: 3,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        filter: { requireApprovedRights: true },
      });
      assert.equal(
        rightsBlockedFts.some((hit) => hit.documentRevisionId === deniedRevision.id),
        false,
      );
      assert.equal(
        rightsBlockedVector.some((hit) => hit.documentRevisionId === deniedRevision.id),
        false,
      );
    });

    test('enforces search readiness contract: excludes unready revisions and marks ready via search readiness repository', async () => {
      const uniqueKeyword = `UnreadyTarget_${randomUUID().replaceAll('-', '')}`;
      const sha256 = '9'.repeat(64);

      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: `https://example.com/unready-test-${Date.now()}`,
        })
        .returning();
      assert(doc);

      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          title: `Pending Document Title ${uniqueKeyword}`,
          bodyText: 'This document starts in pending status without lexical readiness.',
          normalizedHash: sha256,
          normalizerVersion: 'v1.0.0',
          status: 'pending',
          publishedAt: now,
        })
        .returning();
      assert(rev);

      const [chunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: rev.id,
          ordinal: 0,
          headingPath: ['Unready'],
          content: `Search content for ${uniqueKeyword} before markLexicalReady.`,
          tokenCount: 10,
          contentHash: sha256,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(chunk);

      // 1. Before markLexicalReady: lexicalReadyAt is null, FTS returns 0 hits
      const beforeHits = await searchService.searchFts({ query: uniqueKeyword });
      assert.equal(beforeHits.length, 0);

      // 2. Mark lexically ready via readiness repository
      await readinessRepo.markLexicalReady(rev.id, now);

      // 3. After markLexicalReady: revision status is searchable and FTS returns exactly 1 hit
      const [updatedRev] = await db
        .select()
        .from(documentRevisions)
        .where(eq(documentRevisions.id, rev.id));
      assert.equal(updatedRev?.status, 'searchable');
      assert(updatedRev?.lexicalReadyAt !== null);

      const afterHits = await searchService.searchFts({ query: uniqueKeyword });
      assert.equal(afterHits.length, 1);
      assert.equal(afterHits[0]?.documentRevisionId, rev.id);
    });

    test('excludes tombstoned revisions and mismatching model profile embeddings', async () => {
      const uniqueKeyword = `TombstoneTarget_${randomUUID().replaceAll('-', '')}`;
      const sha256 = 'a'.repeat(64);

      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: `https://example.com/tombstone-test-${Date.now()}`,
        })
        .returning();
      assert(doc);

      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          title: `Tombstone Target Title ${uniqueKeyword}`,
          bodyText: 'Document to be tombstoned after verification.',
          normalizedHash: sha256,
          normalizerVersion: 'v1.0.0',
          status: 'searchable',
          lexicalReadyAt: now,
          searchableAt: now,
          publishedAt: now,
        })
        .returning();
      assert(rev);

      const [chunk] = await db
        .insert(chunks)
        .values({
          documentRevisionId: rev.id,
          ordinal: 0,
          headingPath: ['Exclusions'],
          content: `Searchable content before tombstoning ${uniqueKeyword}.`,
          tokenCount: 8,
          contentHash: sha256,
          chunkerVersion: 'v1.0.0',
        })
        .returning();
      assert(chunk);

      await db.insert(embeddings).values({
        chunkId: chunk.id,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
        profileHash: approvedProfileHash,
        dimensions: approvedProfile.dimensions,
        embedding: [0.0, 1.0, 0.0],
        inputHash: sha256,
      });

      // Searchable prior to tombstone
      const ftsBefore = await searchService.searchFts({ query: uniqueKeyword });
      assert.equal(ftsBefore.length, 1);

      // 1. Exclude wrong model profile from vector search
      const wrongHits = await searchService.searchExactVector({
        vector: [0.0, 0.99, 0.01],
        dimensions: 3,
        provider: wrongProfile.provider,
        model: wrongProfile.model,
      });
      assert.equal(
        wrongHits.some((h) => h.documentRevisionId === rev.id),
        false,
      );

      // 2. Apply tombstone and verify exclusion from both FTS and vector search
      await db
        .update(documentRevisions)
        .set({ status: 'tombstoned' })
        .where(eq(documentRevisions.id, rev.id));

      const ftsAfter = await searchService.searchFts({ query: uniqueKeyword });
      assert.equal(ftsAfter.length, 0);

      const vecAfter = await searchService.searchExactVector({
        vector: [0.0, 0.99, 0.01],
        dimensions: 3,
        provider: approvedProfile.provider,
        model: approvedProfile.model,
      });
      assert.equal(
        vecAfter.some((h) => h.documentRevisionId === rev.id),
        false,
      );
    });
  },
);

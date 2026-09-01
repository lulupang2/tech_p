import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createDatabaseClient,
  createDocumentRepository,
  createSourceRepository,
} from '../src/index.js';
import { sources, documents, documentRevisions, chunks } from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('DB-005 Repository Ports & Adapters Integration', () => {
  test('document repository provides pagination, lookup, chunk listing and atomic publish', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const docRepo = createDocumentRepository(db);

    try {
      await client.migrate();

      // Create a document
      const [doc] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: 'https://example.com/repo-test-1',
        })
        .returning();
      assert(doc);

      // Verify findById
      const foundDoc = await docRepo.findById(doc.id);
      assert(foundDoc);
      assert.equal(foundDoc.id, doc.id);
      assert.equal(foundDoc.artifactType, 'article');

      // Create a revision
      const sha256 = 'e'.repeat(64);
      const [rev] = await db
        .insert(documentRevisions)
        .values({
          documentId: doc.id,
          title: 'Repository Test Article',
          bodyText: 'Testing repository adapter operations.',
          normalizedHash: sha256,
          normalizerVersion: 'v1.0.0',
          status: 'pending',
        })
        .returning();
      assert(rev);

      // Create chunks
      await db.insert(chunks).values([
        {
          documentRevisionId: rev.id,
          ordinal: 0,
          headingPath: ['Part 1'],
          content: 'First chunk content.',
          tokenCount: 4,
          contentHash: 'f'.repeat(64),
          chunkerVersion: 'v1.0.0',
        },
        {
          documentRevisionId: rev.id,
          ordinal: 1,
          headingPath: ['Part 2'],
          content: 'Second chunk content.',
          tokenCount: 4,
          contentHash: '1'.repeat(64),
          chunkerVersion: 'v1.0.0',
        },
      ]);

      // Verify listChunksByRevision
      const chunksList = await docRepo.listChunksByRevision(rev.id);
      assert.equal(chunksList.length, 2);
      assert.equal(chunksList[0]?.ordinal, 0);
      assert.equal(chunksList[1]?.ordinal, 1);

      // Verify atomic publishRevision
      const publishedRev = await docRepo.publishRevision(doc.id, rev.id);
      assert.equal(publishedRev.status, 'searchable');
      assert.ok(publishedRev.searchableAt);

      const updatedDoc = await docRepo.findById(doc.id);
      assert.equal(updatedDoc?.currentRevisionId, rev.id);

      // Verify listDocuments pagination
      const listRes = await docRepo.listDocuments(
        { artifactType: 'article' },
        { limit: 10, offset: 0 },
      );
      assert(listRes.total >= 1);
      assert(listRes.items.length >= 1);
    } finally {
      await client.close();
    }
  });

  test('source repository provides key lookup and enabled filtering', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const sourceRepo = createSourceRepository(db);

    try {
      await client.migrate();

      const key = `test-repo-src-${Date.now()}`;
      await db.insert(sources).values({
        key,
        name: 'Repo Test Source',
        kind: 'rss',
        baseUrl: 'https://example.com/repo-feed',
        enabled: true,
        scheduleConfig: {},
      });

      const found = await sourceRepo.findByKey(key);
      assert(found);
      assert.equal(found.key, key);
      assert.equal(found.enabled, true);

      const enabledList = await sourceRepo.listEnabled();
      assert(enabledList.some((s) => s.key === key));
    } finally {
      await client.close();
    }
  });
});

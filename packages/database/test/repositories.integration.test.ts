import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createDatabaseClient,
  createDocumentRepository,
  createSourceRepository,
  createCollectionRunRepository,
  createRawItemRepository,
  createPipelineEventRepository,
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

  test('collection run, raw item, and pipeline event repositories operate correctly with constraints', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const runRepo = createCollectionRunRepository(db);
    const rawRepo = createRawItemRepository(db);
    const eventRepo = createPipelineEventRepository(db);

    try {
      await client.migrate();

      // 1. Create source
      const sourceKey = `test-run-src-${Date.now()}`;
      const [source] = await db
        .insert(sources)
        .values({
          key: sourceKey,
          name: 'Run Test Source',
          kind: 'api',
          baseUrl: 'https://api.example.com',
          enabled: true,
          scheduleConfig: {},
        })
        .returning();
      assert(source);

      // 2. Test CollectionRunRepository
      const scheduledAt = new Date();
      const createdRun = await runRepo.create({
        sourceId: source.id,
        scheduledAt,
        cursorBefore: 'cursor-init',
      });
      assert(createdRun);
      assert.equal(createdRun.sourceId, source.id);
      assert.equal(createdRun.status, 'pending');

      const updatedRun = await runRepo.update(createdRun.id, {
        status: 'running',
        startedAt: new Date(),
      });
      assert.equal(updatedRun.status, 'running');

      const foundRun = await runRepo.findById(createdRun.id);
      assert(foundRun);
      assert.equal(foundRun.id, createdRun.id);

      // 3. Test RawItemRepository upsert and deduplication
      const externalId = 'ext-item-1';
      const payloadHash = 'a'.repeat(64);
      const firstUpsert = await rawRepo.upsert({
        sourceId: source.id,
        runId: createdRun.id,
        externalId,
        canonicalUrl: 'https://api.example.com/items/1',
        payload: { title: 'First Item' },
        payloadHash,
      });
      assert.equal(firstUpsert.isNew, true);
      assert.equal(firstUpsert.item.externalId, externalId);

      // Replay same item -> isNew should be false
      const replayUpsert = await rawRepo.upsert({
        sourceId: source.id,
        runId: createdRun.id,
        externalId,
        canonicalUrl: 'https://api.example.com/items/1',
        payload: { title: 'First Item' },
        payloadHash,
      });
      assert.equal(replayUpsert.isNew, false);
      assert.equal(replayUpsert.item.id, firstUpsert.item.id);

      // 4. Test PipelineEventRepository
      const createdEvent = await eventRepo.create({
        rawItemId: firstUpsert.item.id,
        stage: 'raw_saved',
        processorVersion: '1.0.0',
        status: 'succeeded',
      });
      assert(createdEvent);
      assert.equal(createdEvent.rawItemId, firstUpsert.item.id);

      const events = await eventRepo.listByRawItemId(firstUpsert.item.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.stage, 'raw_saved');
    } finally {
      await client.close();
    }
  });
});

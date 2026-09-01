import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createChunkRepository,
  createDatabaseClient,
  createDocumentRepository,
  createTopicRepository,
} from '../src/index.js';
import { chunkDocument } from '@techpulse/domain';
import { documents, documentRevisions } from '../src/schema/index.js';

const databaseUrl = process.env['DATABASE_URL_DIRECT'] || process.env['DATABASE_URL'];
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration('PIPE-005 topic and chunk adapters', () => {
  test('persists versioned topics/chunks idempotently and blocks invalid publication', async () => {
    const client = createDatabaseClient({ databaseUrl: databaseUrl as string });
    const db = client.db;
    const documentRepository = createDocumentRepository(db);
    const topicRepository = createTopicRepository(db);
    const chunkRepository = createChunkRepository(db);

    try {
      await client.migrate();
      const [document] = await db
        .insert(documents)
        .values({
          artifactType: 'article',
          canonicalUrl: `https://example.com/pipe005-${Date.now()}`,
        })
        .returning();
      assert(document);
      const hash = 'a'.repeat(64);
      const [revision] = await db
        .insert(documentRevisions)
        .values({
          documentId: document.id,
          title: 'TypeScript article',
          bodyText: 'TypeScript makes deterministic systems possible.',
          normalizedHash: hash,
          normalizerVersion: 'v1.0.0',
          status: 'pending',
        })
        .returning();
      assert(revision);

      await assert.rejects(
        () => documentRepository.publishRevision(document.id, revision.id),
        /valid chunks/u,
      );

      const topicV1 = await topicRepository.upsert({
        slug: 'typescript',
        displayName: 'TypeScript',
        aliases: ['ts'],
        taxonomyVersion: '2026-09-01.1',
      });
      const topicV2 = await topicRepository.upsert({
        slug: 'typescript',
        displayName: 'TypeScript',
        aliases: ['ts'],
        taxonomyVersion: '2026-09-02.1',
      });
      const topicInput = {
        documentId: document.id,
        topicId: topicV1.id,
        method: 'deterministic',
        confidence: 100,
        classifierVersion: 'deterministic-alias-2026-09-01.1',
      } as const;
      await topicRepository.saveDocumentTopics([topicInput]);
      await topicRepository.saveDocumentTopics([topicInput]);
      await topicRepository.saveDocumentTopics([
        {
          ...topicInput,
          topicId: topicV2.id,
          classifierVersion: 'deterministic-alias-2026-09-02.1',
        },
      ]);
      assert.equal((await topicRepository.listByDocument(document.id)).length, 2);

      const chunkInputs = chunkDocument({ bodyText: revision.bodyText }).chunks.map((chunk) => ({
        documentRevisionId: revision.id,
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        contentHash: chunk.contentHash,
        chunkerVersion: chunk.chunkerVersion,
      }));
      await chunkRepository.saveChunks(chunkInputs);
      await chunkRepository.saveChunks(chunkInputs);
      assert.equal((await chunkRepository.listByRevision(revision.id)).length, chunkInputs.length);
      const published = await documentRepository.publishRevision(document.id, revision.id);
      assert.equal(published.status, 'searchable');
    } finally {
      await client.close();
    }
  });
});

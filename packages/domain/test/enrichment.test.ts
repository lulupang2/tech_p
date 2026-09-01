import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createEnrichmentService,
  type ChunkRepositoryPort,
  type DocumentTopicRecord,
  type SaveChunkInput,
  type SaveDocumentTopicInput,
  type TopicRecord,
  type TopicRepositoryPort,
} from '../src/index.js';

describe('PIPE-005 enrichment persistence orchestration', () => {
  test('saves deterministic topics and chunks idempotently without deleting evidence', async () => {
    const topics = new Map<string, TopicRecord>();
    const documentTopics: DocumentTopicRecord[] = [];
    const chunks: SaveChunkInput[] = [];
    const now = new Date('2026-09-02T00:00:00.000Z');
    const topicRepository: TopicRepositoryPort = {
      async upsert(input) {
        const key = `${input.slug}|${input.taxonomyVersion}`;
        const existing = topics.get(key);
        if (existing) return existing;
        const record: TopicRecord = {
          id: `topic-${topics.size + 1}`,
          slug: input.slug,
          displayName: input.displayName,
          parentId: input.parentId ?? null,
          aliases: input.aliases ?? [],
          taxonomyVersion: input.taxonomyVersion,
          createdAt: now,
        };
        topics.set(key, record);
        return record;
      },
      async findBySlug(slug, taxonomyVersion) {
        return topics.get(`${slug}|${taxonomyVersion}`) ?? null;
      },
      async listByDocument(documentId) {
        return documentTopics.filter((topic) => topic.documentId === documentId);
      },
      async saveDocumentTopics(inputs: readonly SaveDocumentTopicInput[]) {
        for (const input of inputs) {
          if (
            !documentTopics.some(
              (topic) =>
                topic.documentId === input.documentId &&
                topic.topicId === input.topicId &&
                topic.classifierVersion === input.classifierVersion,
            )
          ) {
            documentTopics.push({ ...input, createdAt: now });
          }
        }
        return documentTopics;
      },
    };
    const chunkRepository: ChunkRepositoryPort = {
      async listByRevision(revisionId) {
        return chunks
          .filter((chunk) => chunk.documentRevisionId === revisionId)
          .map((chunk) => ({
            ...chunk,
            headingPath: chunk.headingPath ?? [],
            createdAt: now,
            id: chunk.id ?? `chunk-${chunk.ordinal}`,
          }));
      },
      async saveChunks(inputs) {
        for (const input of inputs) {
          if (
            !chunks.some(
              (chunk) =>
                chunk.documentRevisionId === input.documentRevisionId &&
                chunk.ordinal === input.ordinal &&
                chunk.chunkerVersion === input.chunkerVersion,
            )
          ) {
            chunks.push(input);
          }
        }
        return this.listByRevision(inputs[0]?.documentRevisionId ?? '');
      },
    };
    const service = createEnrichmentService({ topicRepository, chunkRepository });
    const input = {
      documentId: 'document-1',
      revisionId: 'revision-1',
      title: 'TypeScript and React',
      bodyText: '# Intro\n\nTypeScript and React are useful.',
    };
    const first = await service.enrich(input);
    const second = await service.enrich(input);
    assert.equal(first.topicsSaved, 2);
    assert.equal(second.topicsSaved, 2);
    assert.equal(documentTopics.length, 2);
    assert.equal(first.chunksSaved, 1);
    assert.equal(second.chunksSaved, 1);
    assert.equal(chunks.length, 1);
  });
});

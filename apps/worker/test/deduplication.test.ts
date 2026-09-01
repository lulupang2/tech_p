import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createDeduplicationJobData,
  parseDeduplicationJobData,
  createDeduplicationJobHandler,
  WorkerJobValidationError,
} from '../src/index.js';
import {
  createDeduplicationService,
  type CreateDuplicateClusterInput,
  type DocumentFilter,
  type DocumentRecord,
  type DocumentRepositoryPort,
  type DocumentRevisionRecord,
  type DuplicateClusterRecord,
  type DuplicateClusterRepositoryPort,
  type PaginationParams,
  type PipelineEventRecord,
  type PipelineEventRepositoryPort,
  type RawItemRecord,
  type RawItemRepositoryPort,
  type SaveNormalizedDocumentInput,
  type SaveNormalizedDocumentResult,
  type UpdateDuplicateClusterInput,
} from '@techpulse/domain';

function createFakeRepositories() {
  const rawItems = new Map<string, RawItemRecord>();
  const documents = new Map<string, DocumentRecord>();
  const revisions = new Map<string, DocumentRevisionRecord>();
  const clusters = new Map<string, DuplicateClusterRecord>();
  const pipelineEvents: PipelineEventRecord[] = [];

  const rawItemRepo: RawItemRepositoryPort = {
    async findById(id: string): Promise<RawItemRecord | null> {
      return rawItems.get(id) ?? null;
    },
    async upsert(input) {
      const id = input.id ?? `raw-${rawItems.size + 1}`;
      const record: RawItemRecord = {
        id,
        sourceId: input.sourceId,
        runId: input.runId,
        externalId: input.externalId,
        canonicalUrl: input.canonicalUrl,
        payload: input.payload as Record<string, unknown>,
        payloadHash: input.payloadHash,
        publishedAt: input.publishedAt ?? null,
        collectedAt: input.collectedAt ?? new Date(),
        httpMetadata: input.httpMetadata ?? {},
        rightsMetadata: input.rightsMetadata ?? {},
      };
      rawItems.set(id, record);
      return { item: record, isNew: true };
    },
    async findByRevision(sourceId, externalId, payloadHash) {
      for (const item of rawItems.values()) {
        if (
          item.sourceId === sourceId &&
          item.externalId === externalId &&
          item.payloadHash === payloadHash
        ) {
          return item;
        }
      }
      return null;
    },
    async listByRunId(runId) {
      return Array.from(rawItems.values()).filter((r) => r.runId === runId);
    },
  };

  const docRepo: DocumentRepositoryPort = {
    async findById(id) {
      return documents.get(id) ?? null;
    },
    async findRevisionById(id) {
      return revisions.get(id) ?? null;
    },
    async findRevisionByHash(documentId, hash) {
      for (const rev of revisions.values()) {
        if (rev.documentId === documentId && rev.normalizedHash === hash) return rev;
      }
      return null;
    },
    async findByCanonicalUrl(canonicalUrl) {
      for (const doc of documents.values()) {
        if (doc.canonicalUrl === canonicalUrl) return doc;
      }
      return null;
    },
    async findRevisionByNormalizedHash(normalizedHash) {
      for (const rev of revisions.values()) {
        if (rev.normalizedHash === normalizedHash) return rev;
      }
      return null;
    },
    async assignDuplicateCluster(documentId, duplicateClusterId) {
      const doc = documents.get(documentId);
      if (!doc) throw new Error(`Document ${documentId} not found`);
      const updated: DocumentRecord = {
        ...doc,
        duplicateClusterId,
      };
      documents.set(documentId, updated);
      return updated;
    },
    async listDocumentsByClusterId(clusterId) {
      return Array.from(documents.values()).filter((d) => d.duplicateClusterId === clusterId);
    },
    async listAllDocuments() {
      return Array.from(documents.values());
    },
    async listAllRevisions() {
      return Array.from(revisions.values());
    },
    async saveNormalizedDocument(
      input: SaveNormalizedDocumentInput,
    ): Promise<SaveNormalizedDocumentResult> {
      let docId = `doc-${documents.size + 1}`;
      for (const doc of documents.values()) {
        if (input.canonicalUrl && doc.canonicalUrl === input.canonicalUrl) {
          docId = doc.id;
          break;
        }
      }

      if (!documents.has(docId)) {
        documents.set(docId, {
          id: docId,
          artifactType: input.artifactType,
          canonicalUrl: input.canonicalUrl ?? null,
          duplicateClusterId: null,
          currentRevisionId: null,
          createdAt: new Date(),
        });
      }

      const revId = `rev-${revisions.size + 1}`;
      const revRecord: DocumentRevisionRecord = {
        id: revId,
        documentId: docId,
        rawItemId: input.rawItemId ?? null,
        title: input.title,
        bodyText: input.bodyText,
        author: input.author ?? null,
        language: input.language ?? 'en',
        publishedAt: input.publishedAt ?? null,
        licenseId: input.licenseId ?? null,
        normalizedHash: input.normalizedHash,
        normalizerVersion: input.normalizerVersion,
        status: input.status ?? 'pending',
        searchableAt: null,
        createdAt: new Date(),
      };
      revisions.set(revId, revRecord);

      const doc = documents.get(docId)!;
      const updatedDoc: DocumentRecord = {
        ...doc,
        currentRevisionId: doc.currentRevisionId ?? revId,
      };
      documents.set(docId, updatedDoc);

      return {
        document: updatedDoc,
        revision: revRecord,
        isNewRevision: true,
      };
    },
    async listDocuments(filter: DocumentFilter, pagination: PaginationParams = {}) {
      const items = Array.from(documents.values());
      const limit = pagination.limit ?? 20;
      const offset = pagination.offset ?? 0;
      return {
        items: items.slice(offset, offset + limit),
        total: items.length,
        limit,
        offset,
      };
    },
    async listChunksByRevision() {
      return [];
    },
    async publishRevision(documentId, revisionId, searchableAt = new Date()) {
      const rev = revisions.get(revisionId);
      if (!rev) throw new Error('not found');
      const updatedRev = { ...rev, status: 'searchable', searchableAt };
      revisions.set(revisionId, updatedRev);
      return updatedRev;
    },
  };

  const clusterRepo: DuplicateClusterRepositoryPort = {
    async findById(id) {
      return clusters.get(id) ?? null;
    },
    async create(input: CreateDuplicateClusterInput) {
      const id = input.id ?? `cluster-${clusters.size + 1}`;
      const record: DuplicateClusterRecord = {
        id,
        representativeDocumentId: input.representativeDocumentId ?? null,
        algorithmVersion: input.algorithmVersion ?? 'v1.0.0',
        confidence: input.confidence ?? 100,
        createdAt: new Date(),
      };
      clusters.set(id, record);
      return record;
    },
    async update(id: string, input: UpdateDuplicateClusterInput) {
      const existing = clusters.get(id);
      if (!existing) throw new Error(`Cluster ${id} not found`);
      const updated: DuplicateClusterRecord = {
        ...existing,
        representativeDocumentId:
          input.representativeDocumentId !== undefined
            ? input.representativeDocumentId
            : existing.representativeDocumentId,
        confidence: input.confidence !== undefined ? input.confidence : existing.confidence,
      };
      clusters.set(id, updated);
      return updated;
    },
    async listByRepresentativeDocumentId(docId) {
      return Array.from(clusters.values()).filter((c) => c.representativeDocumentId === docId);
    },
  };

  const eventRepo: PipelineEventRepositoryPort = {
    async create(input) {
      const record: PipelineEventRecord = {
        id: `event-${pipelineEvents.length + 1}`,
        rawItemId: input.rawItemId,
        stage: input.stage,
        processorVersion: input.processorVersion,
        status: input.status,
        attempt: input.attempt ?? 1,
        errorCode: input.errorCode ?? null,
        occurredAt: input.occurredAt ?? new Date(),
      };
      pipelineEvents.push(record);
      return record;
    },
    async listByRawItemId(rawItemId) {
      return pipelineEvents.filter((e) => e.rawItemId === rawItemId);
    },
  };

  return {
    rawItems,
    documents,
    revisions,
    clusters,
    pipelineEvents,
    rawItemRepo,
    docRepo,
    clusterRepo,
    eventRepo,
  };
}

describe('PIPE-004 Worker Deduplication Job Handler', () => {
  describe('1. Deduplication Job Data Contract Validation', () => {
    test('creates and parses valid deduplication job data', () => {
      const jobData = createDeduplicationJobData({
        documentId: 'doc-123',
        revisionId: 'rev-456',
        rawItemId: 'raw-789',
        sourceKey: 'github_releases',
        externalId: 'ext-100',
      });

      assert.equal(jobData.stage, 'deduplication');
      assert.equal(jobData.documentId, 'doc-123');

      const parsed = parseDeduplicationJobData(jobData);
      assert.deepEqual(parsed, jobData);
    });

    test('rejects invalid schemaVersion, stage, or empty documentId', () => {
      assert.throws(
        () =>
          parseDeduplicationJobData({ schemaVersion: 2, stage: 'deduplication', documentId: 'd1' }),
        WorkerJobValidationError,
      );
      assert.throws(
        () =>
          parseDeduplicationJobData({ schemaVersion: 1, stage: 'wrong_stage', documentId: 'd1' }),
        WorkerJobValidationError,
      );
      assert.throws(
        () =>
          parseDeduplicationJobData({ schemaVersion: 1, stage: 'deduplication', documentId: '' }),
        WorkerJobValidationError,
      );
    });
  });

  describe('2. Deduplication Worker Execution with Repositories', () => {
    test('creates duplicate_cluster on exact canonical URL match and links both documents without deleting originals', async () => {
      const fakes = createFakeRepositories();
      const dedupService = createDeduplicationService();
      const handler = createDeduplicationJobHandler({
        deduplicationService: dedupService,
        documentRepository: fakes.docRepo,
        duplicateClusterRepository: fakes.clusterRepo,
        rawItemRepository: fakes.rawItemRepo,
        pipelineEventRepository: fakes.eventRepo,
      });

      // Seed first document (GitHub release)
      const saveRes1 = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'release_note',
        canonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        title: 'React 19.0.0 Release',
        bodyText: 'React 19 release notes.',
        normalizedHash: '1111111111111111111111111111111111111111111111111111111111111111',
        normalizerVersion: 'v1.0.0',
        rawItemId: 'raw-1',
      });

      // Seed second document (React blog referencing same canonical URL with tracking query)
      const saveRes2 = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'article',
        canonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0/?utm_source=twitter',
        title: 'React 19 Available Now',
        bodyText: 'React 19 announcement on blog.',
        normalizedHash: '2222222222222222222222222222222222222222222222222222222222222222',
        normalizerVersion: 'v1.0.0',
        rawItemId: 'raw-2',
      });

      const doc1 = saveRes1.document;
      const doc2 = saveRes2.document;

      // Execute deduplication for doc2
      const jobData = createDeduplicationJobData({
        documentId: doc2.id,
        revisionId: saveRes2.revision.id,
        rawItemId: 'raw-2',
        sourceKey: 'react_blog',
      });

      const execResult = await handler(jobData);

      assert.equal(execResult.status, 'succeeded');
      assert.equal(execResult.isExactDuplicate, true);
      assert.equal(execResult.matchReason, 'canonical_url');
      assert.ok(execResult.clusterId);
      assert.equal(execResult.representativeDocumentId, doc1.id);

      // Verify both documents are linked to the same duplicate_cluster in repository
      const updatedDoc1 = await fakes.docRepo.findById(doc1.id);
      const updatedDoc2 = await fakes.docRepo.findById(doc2.id);

      assert.equal(updatedDoc1?.duplicateClusterId, execResult.clusterId);
      assert.equal(updatedDoc2?.duplicateClusterId, execResult.clusterId);

      // Verify original documents, revisions, and raw item IDs are preserved
      assert.equal(updatedDoc1?.id, doc1.id);
      assert.equal(updatedDoc2?.id, doc2.id);
      assert.equal(fakes.revisions.size, 2);

      // Verify duplicate_cluster record in repository
      const clusterRecord = await fakes.clusterRepo.findById(execResult.clusterId!);
      assert.ok(clusterRecord);
      assert.equal(clusterRecord.representativeDocumentId, doc1.id);
      assert.equal(clusterRecord.confidence, 100);

      // Verify pipeline event recorded
      const events = await fakes.eventRepo.listByRawItemId('raw-2');
      assert.equal(events.length, 1);
      assert.equal(events[0]?.stage, 'deduplication');
      assert.equal(events[0]?.status, 'succeeded');
    });

    test('joins existing cluster when a third cross-source document with exact body hash arrives', async () => {
      const fakes = createFakeRepositories();
      const dedupService = createDeduplicationService();
      const handler = createDeduplicationJobHandler({
        deduplicationService: dedupService,
        documentRepository: fakes.docRepo,
        duplicateClusterRepository: fakes.clusterRepo,
        rawItemRepository: fakes.rawItemRepo,
        pipelineEventRepository: fakes.eventRepo,
      });

      // Existing cluster with doc1
      const cluster = await fakes.clusterRepo.create({
        representativeDocumentId: 'doc-seed',
        algorithmVersion: 'v1.0.0',
        confidence: 100,
      });

      const saveResSeed = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'release_note',
        canonicalUrl: 'https://seed.org/v1',
        title: 'Seed Release Note',
        bodyText: 'Shared exact announcement body text.',
        normalizedHash: 'seed-hash',
        normalizerVersion: 'v1.0.0',
        rawItemId: 'raw-seed',
      });
      await fakes.docRepo.assignDuplicateCluster(saveResSeed.document.id, cluster.id);

      // New target doc with different URL but exact body text
      const saveResNew = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'article',
        canonicalUrl: 'https://mirror.net/news',
        title: 'Mirror News',
        bodyText: 'Shared exact announcement body text.',
        normalizedHash: 'mirror-hash',
        normalizerVersion: 'v1.0.0',
        rawItemId: 'raw-mirror',
      });

      const jobData = createDeduplicationJobData({
        documentId: saveResNew.document.id,
        rawItemId: 'raw-mirror',
        sourceKey: 'react_blog',
      });

      const execResult = await handler(jobData);

      assert.equal(execResult.status, 'succeeded');
      assert.equal(execResult.isExactDuplicate, true);
      assert.equal(execResult.matchReason, 'exact_body_hash');
      assert.equal(execResult.clusterId, cluster.id);

      const updatedNew = await fakes.docRepo.findById(saveResNew.document.id);
      assert.equal(updatedNew?.duplicateClusterId, cluster.id);
      assert.equal(fakes.clusters.size, 1); // No new cluster created, joined existing
    });

    test('reprocessing the same document is idempotent and preserves cluster assignment', async () => {
      const fakes = createFakeRepositories();
      const dedupService = createDeduplicationService();
      const handler = createDeduplicationJobHandler({
        deduplicationService: dedupService,
        documentRepository: fakes.docRepo,
        duplicateClusterRepository: fakes.clusterRepo,
        rawItemRepository: fakes.rawItemRepo,
        pipelineEventRepository: fakes.eventRepo,
      });

      await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'release_note',
        canonicalUrl: 'https://source-a.com/release-1',
        title: 'Release 1',
        bodyText: 'Release 1 body',
        normalizedHash: 'hash-1',
        normalizerVersion: 'v1.0.0',
        rawItemId: 'raw-1',
      });

      const saveRes2 = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'release_note',
        canonicalUrl: 'https://source-a.com/release-1?utm_medium=feed',
        title: 'Release 1 Feed',
        bodyText: 'Release 1 body',
        normalizedHash: 'hash-2',
        normalizerVersion: 'v1.0.0',
        rawItemId: 'raw-2',
      });

      const jobData = createDeduplicationJobData({
        documentId: saveRes2.document.id,
        rawItemId: 'raw-2',
      });

      const firstRun = await handler(jobData);
      const secondRun = await handler(jobData);

      assert.equal(firstRun.status, 'succeeded');
      assert.equal(secondRun.status, 'succeeded');
      assert.equal(firstRun.clusterId, secondRun.clusterId);
      assert.equal(firstRun.isExactDuplicate, secondRun.isExactDuplicate);
    });

    test('returns versioned near-duplicate suggestions without linking or overwriting provenance', async () => {
      const fakes = createFakeRepositories();
      const dedupService = createDeduplicationService();
      const handler = createDeduplicationJobHandler({
        deduplicationService: dedupService,
        documentRepository: fakes.docRepo,
        duplicateClusterRepository: fakes.clusterRepo,
      });

      const existing = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'article',
        canonicalUrl: 'https://source.example/existing',
        title: 'Deterministic lexical announcement',
        bodyText: 'shared lexical content with stable release details',
        normalizedHash: 'a'.repeat(64),
        normalizerVersion: 'pipe-002-v1.0.0',
        rawItemId: 'raw-existing',
      });
      const target = await fakes.docRepo.saveNormalizedDocument({
        artifactType: 'article',
        canonicalUrl: 'https://other.example/target',
        title: 'Deterministic lexical announcement updated',
        bodyText: 'shared lexical content with stable release details updated',
        normalizedHash: 'b'.repeat(64),
        normalizerVersion: 'pipe-002-v1.0.0',
        rawItemId: 'raw-target',
      });

      const result = await handler(
        createDeduplicationJobData({
          documentId: target.document.id,
          revisionId: target.revision.id,
          rawItemId: 'raw-target',
        }),
      );

      assert.equal(result.status, 'succeeded');
      assert.equal(result.isExactDuplicate, false);
      assert.equal(result.clusterId, null);
      assert.equal(result.nearDuplicateCandidates.length, 1);
      assert.equal(result.nearDuplicateCandidates[0]?.candidateDocumentId, existing.document.id);
      assert.equal(result.deduplicationVersion, 'exp004-dedup-v1.0.0');
      assert.equal(result.nearDuplicateThreshold, 0.8);
      assert.equal(result.manualReviewRequired, true);
      assert.equal((await fakes.docRepo.findById(target.document.id))?.duplicateClusterId, null);
      assert.equal(fakes.revisions.size, 2);
    });
  });
});

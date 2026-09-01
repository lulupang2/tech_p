import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  createNormalizationJobData,
  parseNormalizationJobData,
  createNormalizationJobHandler,
  WorkerJobValidationError,
} from '../src/index.js';
import {
  createNormalizationService,
  type DocumentRecord,
  type DocumentRepositoryPort,
  type DocumentRevisionRecord,
  type InsertMetricObservationInput,
  type MetricObservationRecord,
  type MetricObservationRepositoryPort,
  type PipelineEventRecord,
  type PipelineEventRepositoryPort,
  type RawItemRecord,
  type RawItemRepositoryPort,
  type SaveNormalizedDocumentInput,
  type SaveNormalizedDocumentResult,
  type SourceRecord,
  type SourceRepositoryPort,
} from '@techpulse/domain';

// In-memory fake repositories for worker execution test
function createFakeRepositories() {
  const rawItems = new Map<string, RawItemRecord>();
  const documents = new Map<string, DocumentRecord>();
  const revisions = new Map<string, DocumentRevisionRecord>();
  const metrics: MetricObservationRecord[] = [];
  const pipelineEvents: PipelineEventRecord[] = [];
  const sources = new Map<string, SourceRecord>();

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
        rawItemId: input.rawItemId,
        title: input.title,
        bodyText: input.bodyText,
        author: input.author,
        language: input.language ?? 'en',
        publishedAt: input.publishedAt,
        licenseId: input.licenseId,
        normalizedHash: input.normalizedHash,
        normalizerVersion: input.normalizerVersion,
        status: input.status ?? 'pending',
        searchableAt: null,
        createdAt: new Date(),
      };
      revisions.set(revId, revRecord);

      const doc = documents.get(docId)!;
      return {
        document: doc,
        revision: revRecord,
        isNewRevision: true,
      };
    },
    async listDocuments() {
      return { items: Array.from(documents.values()), total: documents.size, limit: 20, offset: 0 };
    },
    async listChunksByRevision() {
      return [];
    },
    async publishRevision(documentId, revisionId, searchableAt = new Date()) {
      const rev = revisions.get(revisionId)!;
      const updated = { ...rev, status: 'searchable', searchableAt };
      revisions.set(revisionId, updated);
      return updated;
    },
  };

  const metricRepo: MetricObservationRepositoryPort = {
    async upsert(input: InsertMetricObservationInput): Promise<MetricObservationRecord> {
      const record: MetricObservationRecord = {
        id: input.id ?? `metric-${metrics.length + 1}`,
        sourceId: input.sourceId,
        topicId: input.topicId ?? null,
        subjectKey: input.subjectKey,
        metricType: input.metricType,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        value: input.value,
        unit: input.unit,
        collectedAt: input.collectedAt ?? new Date(),
        rawItemId: input.rawItemId,
        querySignature: input.querySignature,
        isIncomplete: input.isIncomplete,
      };
      metrics.push(record);
      return record;
    },
    async upsertBatch(inputs) {
      const res: MetricObservationRecord[] = [];
      for (const i of inputs) res.push(await this.upsert(i));
      return res;
    },
    async listBySubject() {
      return { items: metrics, total: metrics.length, limit: 20, offset: 0 };
    },
  };

  const pipelineEventRepo: PipelineEventRepositoryPort = {
    async create(input) {
      const record: PipelineEventRecord = {
        id: input.id ?? `event-${pipelineEvents.length + 1}`,
        rawItemId: input.rawItemId,
        stage: input.stage,
        processorVersion: input.processorVersion,
        status: input.status,
        attempt: input.attempt ?? 1,
        errorCode: input.errorCode ?? null,
        occurredAt: new Date(),
      };
      pipelineEvents.push(record);
      return record;
    },
    async listByRawItemId(rawItemId) {
      return pipelineEvents.filter((e) => e.rawItemId === rawItemId);
    },
  };

  const sourceRepo: SourceRepositoryPort = {
    async findByKey(key) {
      return sources.get(key) ?? null;
    },
    async listEnabled() {
      return Array.from(sources.values()).filter((s) => s.enabled);
    },
  };

  return {
    rawItems,
    documents,
    revisions,
    metrics,
    pipelineEvents,
    sources,
    rawItemRepo,
    docRepo,
    metricRepo,
    pipelineEventRepo,
    sourceRepo,
  };
}

describe('PIPE-002 Worker Normalization Job Handler', () => {
  test('creates and parses valid NormalizationJobData', () => {
    const validData = createNormalizationJobData({
      rawItemId: 'raw-123',
      sourceKey: 'github_releases',
      runId: 'run-456',
      externalId: 'ext-789',
      payloadHash: 'a'.repeat(64),
    });

    const parsed = parseNormalizationJobData(validData);
    assert.equal(parsed.stage, 'normalization');
    assert.equal(parsed.rawItemId, 'raw-123');
    assert.equal(parsed.sourceKey, 'github_releases');
  });

  test('parseNormalizationJobData rejects invalid schema or invalid payloadHash', () => {
    assert.throws(
      () =>
        parseNormalizationJobData({
          schemaVersion: 1,
          stage: 'collection',
          rawItemId: 'raw-1',
          sourceKey: 'github_releases',
          runId: 'run-1',
          externalId: 'ext-1',
          payloadHash: 'short-hash',
        }),
      WorkerJobValidationError,
    );
  });

  test('executes normalization job successfully: updates pipeline events, saves documents and metrics', async () => {
    const fakes = createFakeRepositories();
    const normalizationService = createNormalizationService();

    const handler = createNormalizationJobHandler({
      normalizationService,
      rawItemRepository: fakes.rawItemRepo,
      documentRepository: fakes.docRepo,
      metricObservationRepository: fakes.metricRepo,
      pipelineEventRepository: fakes.pipelineEventRepo,
      sourceRepository: fakes.sourceRepo,
    });

    // Seed raw item
    const rawItem: RawItemRecord = {
      id: 'raw-react-1',
      sourceId: 'source-gh',
      runId: 'run-1',
      externalId: 'react-v19',
      canonicalUrl: 'https://github.com/facebook/react/releases/tag/v19.0.0',
      payload: {
        tag_name: 'v19.0.0',
        name: 'React 19.0.0',
        body: 'Release notes content for React 19',
        published_at: '2026-08-31T12:00:00.000Z',
        html_url: 'https://github.com/facebook/react/releases/tag/v19.0.0',
        repo: 'facebook/react',
      },
      payloadHash: 'b'.repeat(64),
      publishedAt: new Date('2026-08-31T12:00:00.000Z'),
      collectedAt: new Date('2026-09-01T00:00:00.000Z'),
      httpMetadata: {},
      rightsMetadata: { license_id: 'MIT' },
    };
    fakes.rawItems.set(rawItem.id, rawItem);

    const jobData = createNormalizationJobData({
      rawItemId: rawItem.id,
      sourceKey: 'github_releases',
      runId: 'run-1',
      externalId: rawItem.externalId,
      payloadHash: rawItem.payloadHash,
    });

    const result = await handler(jobData);

    assert.equal(result.status, 'succeeded');
    assert.equal(result.documentsSaved, 1);
    assert.equal(result.metricsSaved, 1);

    // Verify pipeline events: started and succeeded
    const events = await fakes.pipelineEventRepo.listByRawItemId(rawItem.id);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.status, 'started');
    assert.equal(events[0]?.stage, 'normalization');
    assert.equal(events[1]?.status, 'succeeded');
    assert.equal(events[1]?.stage, 'normalization');

    // Verify saved document and revision
    assert.equal(fakes.documents.size, 1);
    assert.equal(fakes.revisions.size, 1);
    const savedRev = Array.from(fakes.revisions.values())[0]!;
    assert.equal(savedRev.title, 'React 19.0.0');
    assert.equal(savedRev.normalizerVersion, 'v1.0.0');

    // Verify saved metric
    assert.equal(fakes.metrics.length, 1);
    assert.equal(fakes.metrics[0]?.metricType, 'release_activity');
  });

  test('records quarantined pipeline event if raw item does not exist', async () => {
    const fakes = createFakeRepositories();
    const normalizationService = createNormalizationService();

    const handler = createNormalizationJobHandler({
      normalizationService,
      rawItemRepository: fakes.rawItemRepo,
      documentRepository: fakes.docRepo,
      metricObservationRepository: fakes.metricRepo,
      pipelineEventRepository: fakes.pipelineEventRepo,
    });

    const jobData = createNormalizationJobData({
      rawItemId: 'non-existent-raw-id',
      sourceKey: 'github_releases',
      runId: 'run-1',
      externalId: 'ext-1',
      payloadHash: 'c'.repeat(64),
    });

    const result = await handler(jobData);
    assert.equal(result.status, 'quarantined');
    assert.equal(result.documentsSaved, 0);

    const events = await fakes.pipelineEventRepo.listByRawItemId('non-existent-raw-id');
    assert.equal(events.length, 2);
    assert.equal(events[0]?.status, 'started');
    assert.equal(events[1]?.status, 'quarantined');
    assert.equal(events[1]?.errorCode, 'RAW_ITEM_NOT_FOUND');
  });
});

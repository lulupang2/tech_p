import { eq, and, desc, count, sql } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type {
  DocumentRepositoryPort,
  SourceRepositoryPort,
  CollectionRunRepositoryPort,
  RawItemRepositoryPort,
  PipelineEventRepositoryPort,
  MetricObservationRepositoryPort,
  DuplicateClusterRepositoryPort,
  DuplicateClusterRecord,
  DuplicateClusterMembershipRecord,
  DuplicateClusterMembershipStatus,
  CreateDuplicateClusterInput,
  CreateDuplicateClusterMembershipInput,
  UpdateDuplicateClusterInput,
  DocumentRecord,
  DocumentRevisionRecord,
  ChunkRecord,
  SourceRecord,
  CollectionRunRecord,
  CollectionRunStatus,
  CreateCollectionRunInput,
  UpdateCollectionRunInput,
  RawItemRecord,
  UpsertRawItemInput,
  UpsertRawItemResult,
  PipelineEventRecord,
  PipelineEventStatus,
  CreatePipelineEventInput,
  DocumentFilter,
  SaveNormalizedDocumentInput,
  SaveNormalizedDocumentResult,
  MetricObservationRecord,
  InsertMetricObservationInput,
  MetricObservationFilter,
  PaginationParams,
  PaginatedResult,
} from '@techpulse/domain';
import { DEDUPLICATION_ALGORITHM_VERSION } from '@techpulse/domain';
import {
  documents,
  documentRevisions,
  chunks,
  duplicateClusters,
  duplicateClusterMemberships,
  sources,
  collectionRuns,
  rawItems,
  pipelineEvents,
  metricObservations,
  type schema,
} from './schema/index.js';

export function createDocumentRepository(db: NeonDatabase<typeof schema>): DocumentRepositoryPort {
  return {
    async findById(id: string): Promise<DocumentRecord | null> {
      const row = await db.query.documents.findFirst({
        where: eq(documents.id, id),
      });
      if (!row) return null;
      return {
        id: row.id,
        artifactType: row.artifactType,
        canonicalUrl: row.canonicalUrl,
        duplicateClusterId: row.duplicateClusterId,
        currentRevisionId: row.currentRevisionId,
        createdAt: row.createdAt,
      };
    },
    async findRevisionById(revisionId: string): Promise<DocumentRevisionRecord | null> {
      const row = await db.query.documentRevisions.findFirst({
        where: eq(documentRevisions.id, revisionId),
      });
      if (!row) return null;
      return {
        id: row.id,
        documentId: row.documentId,
        rawItemId: row.rawItemId,
        title: row.title,
        bodyText: row.bodyText,
        author: row.author,
        language: row.language,
        publishedAt: row.publishedAt,
        licenseId: row.licenseId,
        normalizedHash: row.normalizedHash,
        normalizerVersion: row.normalizerVersion,
        status: row.status,
        searchableAt: row.searchableAt,
        createdAt: row.createdAt,
      };
    },

    async findRevisionByHash(
      documentId: string,
      normalizedHash: string,
    ): Promise<DocumentRevisionRecord | null> {
      const row = await db.query.documentRevisions.findFirst({
        where: and(
          eq(documentRevisions.documentId, documentId),
          eq(documentRevisions.normalizedHash, normalizedHash),
        ),
      });
      if (!row) return null;
      return {
        id: row.id,
        documentId: row.documentId,
        rawItemId: row.rawItemId,
        title: row.title,
        bodyText: row.bodyText,
        author: row.author,
        language: row.language,
        publishedAt: row.publishedAt,
        licenseId: row.licenseId,
        normalizedHash: row.normalizedHash,
        normalizerVersion: row.normalizerVersion,
        status: row.status,
        searchableAt: row.searchableAt,
        createdAt: row.createdAt,
      };
    },

    async findByCanonicalUrl(canonicalUrl: string): Promise<DocumentRecord | null> {
      const row = await db.query.documents.findFirst({
        where: eq(documents.canonicalUrl, canonicalUrl),
      });
      if (!row) return null;
      return {
        id: row.id,
        artifactType: row.artifactType,
        canonicalUrl: row.canonicalUrl,
        duplicateClusterId: row.duplicateClusterId,
        currentRevisionId: row.currentRevisionId,
        createdAt: row.createdAt,
      };
    },

    async findRevisionByNormalizedHash(
      normalizedHash: string,
    ): Promise<DocumentRevisionRecord | null> {
      const row = await db.query.documentRevisions.findFirst({
        where: eq(documentRevisions.normalizedHash, normalizedHash),
      });
      if (!row) return null;
      return {
        id: row.id,
        documentId: row.documentId,
        rawItemId: row.rawItemId,
        title: row.title,
        bodyText: row.bodyText,
        author: row.author,
        language: row.language,
        publishedAt: row.publishedAt,
        licenseId: row.licenseId,
        normalizedHash: row.normalizedHash,
        normalizerVersion: row.normalizerVersion,
        status: row.status,
        searchableAt: row.searchableAt,
        createdAt: row.createdAt,
      };
    },

    async assignDuplicateCluster(
      documentId: string,
      duplicateClusterId: string | null,
    ): Promise<DocumentRecord> {
      const [updated] = await db
        .update(documents)
        .set({ duplicateClusterId })
        .where(eq(documents.id, documentId))
        .returning();

      if (!updated) {
        throw new Error(`Document ${documentId} not found`);
      }

      return {
        id: updated.id,
        artifactType: updated.artifactType,
        canonicalUrl: updated.canonicalUrl,
        duplicateClusterId: updated.duplicateClusterId,
        currentRevisionId: updated.currentRevisionId,
        createdAt: updated.createdAt,
      };
    },

    async listDocumentsByClusterId(clusterId: string): Promise<readonly DocumentRecord[]> {
      const rows = await db.query.documents.findMany({
        where: eq(documents.duplicateClusterId, clusterId),
      });

      return rows.map((r) => ({
        id: r.id,
        artifactType: r.artifactType,
        canonicalUrl: r.canonicalUrl,
        duplicateClusterId: r.duplicateClusterId,
        currentRevisionId: r.currentRevisionId,
        createdAt: r.createdAt,
      }));
    },

    async listAllDocuments(): Promise<readonly DocumentRecord[]> {
      const rows = await db.select().from(documents);
      return rows.map((r) => ({
        id: r.id,
        artifactType: r.artifactType,
        canonicalUrl: r.canonicalUrl,
        duplicateClusterId: r.duplicateClusterId,
        currentRevisionId: r.currentRevisionId,
        createdAt: r.createdAt,
      }));
    },

    async listAllRevisions(): Promise<readonly DocumentRevisionRecord[]> {
      const rows = await db.select().from(documentRevisions);
      return rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        rawItemId: r.rawItemId,
        title: r.title,
        bodyText: r.bodyText,
        author: r.author,
        language: r.language,
        publishedAt: r.publishedAt,
        licenseId: r.licenseId,
        normalizedHash: r.normalizedHash,
        normalizerVersion: r.normalizerVersion,
        status: r.status,
        searchableAt: r.searchableAt,
        createdAt: r.createdAt,
      }));
    },

    async saveNormalizedDocument(
      input: SaveNormalizedDocumentInput,
    ): Promise<SaveNormalizedDocumentResult> {
      return await db.transaction(async (tx) => {
        let docRow: typeof documents.$inferSelect | undefined;

        if (input.canonicalUrl) {
          docRow = await tx.query.documents.findFirst({
            where: eq(documents.canonicalUrl, input.canonicalUrl),
          });
        }

        if (!docRow) {
          const [createdDoc] = await tx
            .insert(documents)
            .values({
              artifactType: input.artifactType,
              canonicalUrl: input.canonicalUrl ?? null,
            })
            .returning();
          docRow = createdDoc;
        }

        if (!docRow) {
          throw new Error('Failed to create or find document');
        }

        const existingRev = await tx.query.documentRevisions.findFirst({
          where: and(
            eq(documentRevisions.documentId, docRow.id),
            eq(documentRevisions.normalizedHash, input.normalizedHash),
          ),
        });

        if (existingRev) {
          return {
            document: {
              id: docRow.id,
              artifactType: docRow.artifactType,
              canonicalUrl: docRow.canonicalUrl,
              duplicateClusterId: docRow.duplicateClusterId,
              currentRevisionId: docRow.currentRevisionId,
              createdAt: docRow.createdAt,
            },
            revision: {
              id: existingRev.id,
              documentId: existingRev.documentId,
              rawItemId: existingRev.rawItemId,
              title: existingRev.title,
              bodyText: existingRev.bodyText,
              author: existingRev.author,
              language: existingRev.language,
              publishedAt: existingRev.publishedAt,
              licenseId: existingRev.licenseId,
              normalizedHash: existingRev.normalizedHash,
              normalizerVersion: existingRev.normalizerVersion,
              status: existingRev.status,
              searchableAt: existingRev.searchableAt,
              createdAt: existingRev.createdAt,
            },
            isNewRevision: false,
          };
        }

        const [newRev] = await tx
          .insert(documentRevisions)
          .values({
            documentId: docRow.id,
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
          })
          .returning();

        if (!newRev) {
          throw new Error('Failed to insert document revision');
        }

        if (!docRow.currentRevisionId) {
          await tx
            .update(documents)
            .set({ currentRevisionId: newRev.id })
            .where(eq(documents.id, docRow.id));
          docRow.currentRevisionId = newRev.id;
        }

        return {
          document: {
            id: docRow.id,
            artifactType: docRow.artifactType,
            canonicalUrl: docRow.canonicalUrl,
            duplicateClusterId: docRow.duplicateClusterId,
            currentRevisionId: docRow.currentRevisionId,
            createdAt: docRow.createdAt,
          },
          revision: {
            id: newRev.id,
            documentId: newRev.documentId,
            rawItemId: newRev.rawItemId,
            title: newRev.title,
            bodyText: newRev.bodyText,
            author: newRev.author,
            language: newRev.language,
            publishedAt: newRev.publishedAt,
            licenseId: newRev.licenseId,
            normalizedHash: newRev.normalizedHash,
            normalizerVersion: newRev.normalizerVersion,
            status: newRev.status,
            searchableAt: newRev.searchableAt,
            createdAt: newRev.createdAt,
          },
          isNewRevision: true,
        };
      });
    },

    async listDocuments(
      filter: DocumentFilter,
      pagination: PaginationParams = {},
    ): Promise<PaginatedResult<DocumentRecord>> {
      const limit = Math.max(1, Math.min(pagination.limit ?? 20, 100));
      const offset = Math.max(0, pagination.offset ?? 0);

      const conditions = [];
      if (filter.artifactType) {
        conditions.push(eq(documents.artifactType, filter.artifactType));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [totalRow] = await db.select({ total: count() }).from(documents).where(whereClause);

      const rows = await db
        .select()
        .from(documents)
        .where(whereClause)
        .orderBy(desc(documents.createdAt))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          artifactType: r.artifactType,
          canonicalUrl: r.canonicalUrl,
          duplicateClusterId: r.duplicateClusterId,
          currentRevisionId: r.currentRevisionId,
          createdAt: r.createdAt,
        })),
        total: Number(totalRow?.total ?? 0),
        limit,
        offset,
      };
    },

    async listChunksByRevision(revisionId: string): Promise<readonly ChunkRecord[]> {
      const rows = await db
        .select()
        .from(chunks)
        .where(eq(chunks.documentRevisionId, revisionId))
        .orderBy(chunks.ordinal);

      return rows.map((c) => ({
        id: c.id,
        documentRevisionId: c.documentRevisionId,
        ordinal: c.ordinal,
        headingPath: c.headingPath,
        content: c.content,
        tokenCount: c.tokenCount,
        contentHash: c.contentHash,
        chunkerVersion: c.chunkerVersion,
        createdAt: c.createdAt,
      }));
    },

    async publishRevision(
      documentId: string,
      revisionId: string,
      searchableAt = new Date(),
    ): Promise<DocumentRevisionRecord> {
      return await db.transaction(async (tx) => {
        const [updatedRevision] = await tx
          .update(documentRevisions)
          .set({
            status: 'searchable',
            searchableAt,
          })
          .where(
            and(eq(documentRevisions.id, revisionId), eq(documentRevisions.documentId, documentId)),
          )
          .returning();

        if (!updatedRevision) {
          throw new Error(`Revision ${revisionId} not found for document ${documentId}`);
        }

        await tx
          .update(documents)
          .set({
            currentRevisionId: revisionId,
          })
          .where(eq(documents.id, documentId));

        return {
          id: updatedRevision.id,
          documentId: updatedRevision.documentId,
          rawItemId: updatedRevision.rawItemId,
          title: updatedRevision.title,
          bodyText: updatedRevision.bodyText,
          author: updatedRevision.author,
          language: updatedRevision.language,
          publishedAt: updatedRevision.publishedAt,
          licenseId: updatedRevision.licenseId,
          normalizedHash: updatedRevision.normalizedHash,
          normalizerVersion: updatedRevision.normalizerVersion,
          status: updatedRevision.status,
          searchableAt: updatedRevision.searchableAt,
          createdAt: updatedRevision.createdAt,
        };
      });
    },
  };
}

export function createSourceRepository(db: NeonDatabase<typeof schema>): SourceRepositoryPort {
  return {
    async findByKey(key: string): Promise<SourceRecord | null> {
      const row = await db.query.sources.findFirst({
        where: eq(sources.key, key),
      });
      if (!row) return null;
      return {
        id: row.id,
        key: row.key,
        name: row.name,
        kind: row.kind,
        baseUrl: row.baseUrl,
        enabled: row.enabled,
        scheduleConfig: row.scheduleConfig,
        policyReviewedAt: row.policyReviewedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },

    async listEnabled(): Promise<readonly SourceRecord[]> {
      const rows = await db
        .select()
        .from(sources)
        .where(eq(sources.enabled, true))
        .orderBy(sources.key);

      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        kind: r.kind,
        baseUrl: r.baseUrl,
        enabled: r.enabled,
        scheduleConfig: r.scheduleConfig,
        policyReviewedAt: r.policyReviewedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    },
  };
}

export function createCollectionRunRepository(
  db: NeonDatabase<typeof schema>,
): CollectionRunRepositoryPort {
  return {
    async findById(id: string): Promise<CollectionRunRecord | null> {
      const row = await db.query.collectionRuns.findFirst({
        where: eq(collectionRuns.id, id),
      });
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.sourceId,
        scheduledAt: row.scheduledAt,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        status: row.status as CollectionRunStatus,
        cursorBefore: row.cursorBefore,
        cursorAfter: row.cursorAfter,
        counts: row.counts ?? {},
        errorSummary: row.errorSummary,
        createdAt: row.createdAt,
      };
    },

    async create(input: CreateCollectionRunInput): Promise<CollectionRunRecord> {
      const [inserted] = await db
        .insert(collectionRuns)
        .values({
          ...(input.id ? { id: input.id } : {}),
          sourceId: input.sourceId,
          scheduledAt: input.scheduledAt,
          startedAt: input.startedAt ?? null,
          status: input.status ?? 'pending',
          cursorBefore: input.cursorBefore ?? null,
          counts: input.counts ?? {},
        })
        .returning();
      if (!inserted) throw new Error('Failed to create collection run');
      return {
        id: inserted.id,
        sourceId: inserted.sourceId,
        scheduledAt: inserted.scheduledAt,
        startedAt: inserted.startedAt,
        endedAt: inserted.endedAt,
        status: inserted.status as CollectionRunStatus,
        cursorBefore: inserted.cursorBefore,
        cursorAfter: inserted.cursorAfter,
        counts: inserted.counts ?? {},
        errorSummary: inserted.errorSummary,
        createdAt: inserted.createdAt,
      };
    },

    async update(id: string, input: UpdateCollectionRunInput): Promise<CollectionRunRecord> {
      const setValues: Record<string, unknown> = {};
      if (input.status !== undefined) setValues['status'] = input.status;
      if (input.startedAt !== undefined) setValues['startedAt'] = input.startedAt;
      if (input.endedAt !== undefined) setValues['endedAt'] = input.endedAt;
      if (input.cursorBefore !== undefined) setValues['cursorBefore'] = input.cursorBefore;
      if (input.cursorAfter !== undefined) setValues['cursorAfter'] = input.cursorAfter;
      if (input.counts !== undefined) setValues['counts'] = input.counts;
      if (input.errorSummary !== undefined) setValues['errorSummary'] = input.errorSummary;

      const [updated] = await db
        .update(collectionRuns)
        .set(setValues)
        .where(eq(collectionRuns.id, id))
        .returning();
      if (!updated) throw new Error(`Collection run not found: ${id}`);
      return {
        id: updated.id,
        sourceId: updated.sourceId,
        scheduledAt: updated.scheduledAt,
        startedAt: updated.startedAt,
        endedAt: updated.endedAt,
        status: updated.status as CollectionRunStatus,
        cursorBefore: updated.cursorBefore,
        cursorAfter: updated.cursorAfter,
        counts: updated.counts ?? {},
        errorSummary: updated.errorSummary,
        createdAt: updated.createdAt,
      };
    },

    async findBySourceAndScheduledAt(
      sourceId: string,
      scheduledAt: Date,
    ): Promise<CollectionRunRecord | null> {
      const row = await db.query.collectionRuns.findFirst({
        where: and(
          eq(collectionRuns.sourceId, sourceId),
          eq(collectionRuns.scheduledAt, scheduledAt),
        ),
      });
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.sourceId,
        scheduledAt: row.scheduledAt,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        status: row.status as CollectionRunStatus,
        cursorBefore: row.cursorBefore,
        cursorAfter: row.cursorAfter,
        counts: row.counts ?? {},
        errorSummary: row.errorSummary,
        createdAt: row.createdAt,
      };
    },
  };
}

export function createRawItemRepository(db: NeonDatabase<typeof schema>): RawItemRepositoryPort {
  return {
    async findById(id: string): Promise<RawItemRecord | null> {
      const row = await db.query.rawItems.findFirst({
        where: eq(rawItems.id, id),
      });
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.sourceId,
        runId: row.runId,
        externalId: row.externalId,
        canonicalUrl: row.canonicalUrl,
        payload: row.payload as Record<string, unknown>,
        payloadHash: row.payloadHash,
        publishedAt: row.publishedAt,
        collectedAt: row.collectedAt,
        httpMetadata: row.httpMetadata as Record<string, unknown>,
        rightsMetadata: row.rightsMetadata as Record<string, unknown>,
      };
    },

    async upsert(input: UpsertRawItemInput): Promise<UpsertRawItemResult> {
      const inserted = await db
        .insert(rawItems)
        .values({
          ...(input.id ? { id: input.id } : {}),
          sourceId: input.sourceId,
          runId: input.runId,
          externalId: input.externalId,
          canonicalUrl: input.canonicalUrl,
          payload: input.payload,
          payloadHash: input.payloadHash,
          publishedAt: input.publishedAt ?? null,
          collectedAt: input.collectedAt ?? new Date(),
          httpMetadata: input.httpMetadata ?? {},
          rightsMetadata: input.rightsMetadata ?? {},
        })
        .onConflictDoNothing({
          target: [rawItems.sourceId, rawItems.externalId, rawItems.payloadHash],
        })
        .returning();

      if (inserted[0]) {
        const row = inserted[0];
        return {
          item: {
            id: row.id,
            sourceId: row.sourceId,
            runId: row.runId,
            externalId: row.externalId,
            canonicalUrl: row.canonicalUrl,
            payload: row.payload as Record<string, unknown>,
            payloadHash: row.payloadHash,
            publishedAt: row.publishedAt,
            collectedAt: row.collectedAt,
            httpMetadata: row.httpMetadata as Record<string, unknown>,
            rightsMetadata: row.rightsMetadata as Record<string, unknown>,
          },
          isNew: true,
        };
      }

      const existing = await db.query.rawItems.findFirst({
        where: and(
          eq(rawItems.sourceId, input.sourceId),
          eq(rawItems.externalId, input.externalId),
          eq(rawItems.payloadHash, input.payloadHash),
        ),
      });
      if (!existing) throw new Error('Raw revision disappeared during replay');

      return {
        item: {
          id: existing.id,
          sourceId: existing.sourceId,
          runId: existing.runId,
          externalId: existing.externalId,
          canonicalUrl: existing.canonicalUrl,
          payload: existing.payload as Record<string, unknown>,
          payloadHash: existing.payloadHash,
          publishedAt: existing.publishedAt,
          collectedAt: existing.collectedAt,
          httpMetadata: existing.httpMetadata as Record<string, unknown>,
          rightsMetadata: existing.rightsMetadata as Record<string, unknown>,
        },
        isNew: false,
      };
    },

    async findByRevision(
      sourceId: string,
      externalId: string,
      payloadHash: string,
    ): Promise<RawItemRecord | null> {
      const row = await db.query.rawItems.findFirst({
        where: and(
          eq(rawItems.sourceId, sourceId),
          eq(rawItems.externalId, externalId),
          eq(rawItems.payloadHash, payloadHash),
        ),
      });
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.sourceId,
        runId: row.runId,
        externalId: row.externalId,
        canonicalUrl: row.canonicalUrl,
        payload: row.payload as Record<string, unknown>,
        payloadHash: row.payloadHash,
        publishedAt: row.publishedAt,
        collectedAt: row.collectedAt,
        httpMetadata: row.httpMetadata as Record<string, unknown>,
        rightsMetadata: row.rightsMetadata as Record<string, unknown>,
      };
    },

    async listByRunId(runId: string): Promise<readonly RawItemRecord[]> {
      const rows = await db.query.rawItems.findMany({
        where: eq(rawItems.runId, runId),
      });
      return rows.map((row) => ({
        id: row.id,
        sourceId: row.sourceId,
        runId: row.runId,
        externalId: row.externalId,
        canonicalUrl: row.canonicalUrl,
        payload: row.payload as Record<string, unknown>,
        payloadHash: row.payloadHash,
        publishedAt: row.publishedAt,
        collectedAt: row.collectedAt,
        httpMetadata: row.httpMetadata as Record<string, unknown>,
        rightsMetadata: row.rightsMetadata as Record<string, unknown>,
      }));
    },
  };
}

export function createPipelineEventRepository(
  db: NeonDatabase<typeof schema>,
): PipelineEventRepositoryPort {
  return {
    async create(input: CreatePipelineEventInput): Promise<PipelineEventRecord> {
      const [inserted] = await db
        .insert(pipelineEvents)
        .values({
          rawItemId: input.rawItemId,
          stage: input.stage,
          processorVersion: input.processorVersion,
          status: input.status,
          attempt: input.attempt ?? 1,
          errorCode: input.errorCode ?? null,
          occurredAt: input.occurredAt ?? new Date(),
        })
        .returning();
      if (!inserted) throw new Error('Failed to create pipeline event');
      return {
        id: inserted.id,
        rawItemId: inserted.rawItemId,
        stage: inserted.stage,
        processorVersion: inserted.processorVersion,
        status: inserted.status as PipelineEventStatus,
        attempt: inserted.attempt,
        errorCode: inserted.errorCode,
        occurredAt: inserted.occurredAt,
      };
    },

    async listByRawItemId(rawItemId: string): Promise<readonly PipelineEventRecord[]> {
      const rows = await db.query.pipelineEvents.findMany({
        where: eq(pipelineEvents.rawItemId, rawItemId),
      });
      return rows.map((row) => ({
        id: row.id,
        rawItemId: row.rawItemId,
        stage: row.stage,
        processorVersion: row.processorVersion,
        status: row.status as PipelineEventStatus,
        attempt: row.attempt,
        errorCode: row.errorCode,
        occurredAt: row.occurredAt,
      }));
    },
  };
}

export function createMetricObservationRepository(
  db: NeonDatabase<typeof schema>,
): MetricObservationRepositoryPort {
  return {
    async upsert(input: InsertMetricObservationInput): Promise<MetricObservationRecord> {
      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(metricObservations)
          .values({
            ...(input.id ? { id: input.id } : {}),
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
          })
          .onConflictDoNothing({
            target: [
              metricObservations.sourceId,
              metricObservations.subjectKey,
              metricObservations.metricType,
              metricObservations.windowStart,
              metricObservations.windowEnd,
              metricObservations.rawItemId,
            ],
          })
          .returning();

        if (inserted) return inserted;

        const existing = await tx.query.metricObservations.findFirst({
          where: and(
            eq(metricObservations.sourceId, input.sourceId),
            eq(metricObservations.subjectKey, input.subjectKey),
            eq(metricObservations.metricType, input.metricType),
            eq(metricObservations.windowStart, input.windowStart),
            eq(metricObservations.windowEnd, input.windowEnd),
            input.rawItemId
              ? eq(metricObservations.rawItemId, input.rawItemId)
              : sql`${metricObservations.rawItemId} IS NULL`,
          ),
        });

        if (!existing) {
          throw new Error('Metric observation conflict resolution failed');
        }
        return existing;
      });

      return {
        id: row.id,
        sourceId: row.sourceId,
        topicId: row.topicId,
        subjectKey: row.subjectKey,
        metricType: row.metricType,
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        value: row.value,
        unit: row.unit,
        collectedAt: row.collectedAt,
        rawItemId: row.rawItemId,
        querySignature: row.querySignature,
        isIncomplete: row.isIncomplete,
      };
    },

    async upsertBatch(
      inputs: readonly InsertMetricObservationInput[],
    ): Promise<readonly MetricObservationRecord[]> {
      const results: MetricObservationRecord[] = [];
      for (const input of inputs) {
        results.push(await this.upsert(input));
      }
      return results;
    },

    async listBySubject(
      subjectKey: string,
      filter: MetricObservationFilter = {},
      pagination: PaginationParams = {},
    ): Promise<PaginatedResult<MetricObservationRecord>> {
      const limit = Math.max(1, Math.min(pagination.limit ?? 20, 100));
      const offset = Math.max(0, pagination.offset ?? 0);

      const conditions = [eq(metricObservations.subjectKey, subjectKey)];
      if (filter.sourceId) conditions.push(eq(metricObservations.sourceId, filter.sourceId));
      if (filter.topicId) conditions.push(eq(metricObservations.topicId, filter.topicId));
      if (filter.metricType) conditions.push(eq(metricObservations.metricType, filter.metricType));
      if (filter.windowStartAfter)
        conditions.push(sql`${metricObservations.windowStart} >= ${filter.windowStartAfter}`);
      if (filter.windowEndBefore)
        conditions.push(sql`${metricObservations.windowEnd} <= ${filter.windowEndBefore}`);

      const whereClause = and(...conditions);

      const [totalRow] = await db
        .select({ total: count() })
        .from(metricObservations)
        .where(whereClause);

      const rows = await db
        .select()
        .from(metricObservations)
        .where(whereClause)
        .orderBy(desc(metricObservations.windowStart))
        .limit(limit)
        .offset(offset);

      return {
        items: rows.map((r) => ({
          id: r.id,
          sourceId: r.sourceId,
          topicId: r.topicId,
          subjectKey: r.subjectKey,
          metricType: r.metricType,
          windowStart: r.windowStart,
          windowEnd: r.windowEnd,
          value: r.value,
          unit: r.unit,
          collectedAt: r.collectedAt,
          rawItemId: r.rawItemId,
          querySignature: r.querySignature,
          isIncomplete: r.isIncomplete,
        })),
        total: Number(totalRow?.total ?? 0),
        limit,
        offset,
      };
    },
  };
}

export function createDuplicateClusterRepository(
  db: NeonDatabase<typeof schema>,
): DuplicateClusterRepositoryPort {
  return {
    async findById(id: string): Promise<DuplicateClusterRecord | null> {
      const row = await db.query.duplicateClusters.findFirst({
        where: eq(duplicateClusters.id, id),
      });
      if (!row) return null;
      return {
        id: row.id,
        representativeDocumentId: row.representativeDocumentId,
        algorithmVersion: row.algorithmVersion,
        confidence: row.confidence,
        createdAt: row.createdAt,
      };
    },

    async create(input: CreateDuplicateClusterInput): Promise<DuplicateClusterRecord> {
      const values: typeof duplicateClusters.$inferInsert = {
        id: input.id,
        representativeDocumentId: input.representativeDocumentId ?? null,
        algorithmVersion: input.algorithmVersion ?? DEDUPLICATION_ALGORITHM_VERSION,
        confidence: input.confidence ?? 100,
      };

      const [row] = await db.insert(duplicateClusters).values(values).returning();
      if (!row) {
        throw new Error('Failed to create duplicate cluster');
      }

      return {
        id: row.id,
        representativeDocumentId: row.representativeDocumentId,
        algorithmVersion: row.algorithmVersion,
        confidence: row.confidence,
        createdAt: row.createdAt,
      };
    },

    async update(id: string, input: UpdateDuplicateClusterInput): Promise<DuplicateClusterRecord> {
      const updateSet: Partial<typeof duplicateClusters.$inferInsert> = {};
      if (input.representativeDocumentId !== undefined) {
        updateSet.representativeDocumentId = input.representativeDocumentId;
      }
      if (input.confidence !== undefined) {
        updateSet.confidence = input.confidence;
      }

      const [row] = await db
        .update(duplicateClusters)
        .set(updateSet)
        .where(eq(duplicateClusters.id, id))
        .returning();

      if (!row) {
        throw new Error(`Duplicate cluster ${id} not found for update`);
      }

      return {
        id: row.id,
        representativeDocumentId: row.representativeDocumentId,
        algorithmVersion: row.algorithmVersion,
        confidence: row.confidence,
        createdAt: row.createdAt,
      };
    },

    async listByRepresentativeDocumentId(
      docId: string,
    ): Promise<readonly DuplicateClusterRecord[]> {
      const rows = await db.query.duplicateClusters.findMany({
        where: eq(duplicateClusters.representativeDocumentId, docId),
      });

      return rows.map((r) => ({
        id: r.id,
        representativeDocumentId: r.representativeDocumentId,
        algorithmVersion: r.algorithmVersion,
        confidence: r.confidence,
        createdAt: r.createdAt,
      }));
    },

    async createMembership(
      input: CreateDuplicateClusterMembershipInput,
    ): Promise<DuplicateClusterMembershipRecord> {
      const inserted = await db
        .insert(duplicateClusterMemberships)
        .values({
          ...(input.id ? { id: input.id } : {}),
          clusterId: input.clusterId,
          documentId: input.documentId,
          revisionId: input.revisionId,
          rawItemId: input.rawItemId ?? null,
          algorithmVersion: input.algorithmVersion,
          confidence: input.confidence,
          status: input.status ?? 'suggested',
        })
        .onConflictDoNothing({
          target: [
            duplicateClusterMemberships.clusterId,
            duplicateClusterMemberships.documentId,
            duplicateClusterMemberships.revisionId,
            duplicateClusterMemberships.algorithmVersion,
          ],
        })
        .returning();
      const row =
        inserted[0] ??
        (await db.query.duplicateClusterMemberships.findFirst({
          where: and(
            eq(duplicateClusterMemberships.clusterId, input.clusterId),
            eq(duplicateClusterMemberships.documentId, input.documentId),
            eq(duplicateClusterMemberships.revisionId, input.revisionId),
            eq(duplicateClusterMemberships.algorithmVersion, input.algorithmVersion),
          ),
        }));

      if (!row) throw new Error('Failed to create duplicate cluster membership');
      return {
        id: row.id,
        clusterId: row.clusterId,
        documentId: row.documentId,
        revisionId: row.revisionId,
        rawItemId: row.rawItemId,
        algorithmVersion: row.algorithmVersion,
        confidence: row.confidence,
        status: row.status as DuplicateClusterMembershipStatus,
        createdAt: row.createdAt,
      };
    },

    async listMemberships(clusterId: string): Promise<readonly DuplicateClusterMembershipRecord[]> {
      const rows = await db.query.duplicateClusterMemberships.findMany({
        where: eq(duplicateClusterMemberships.clusterId, clusterId),
      });
      return rows.map((row) => ({
        id: row.id,
        clusterId: row.clusterId,
        documentId: row.documentId,
        revisionId: row.revisionId,
        rawItemId: row.rawItemId,
        algorithmVersion: row.algorithmVersion,
        confidence: row.confidence,
        status: row.status as DuplicateClusterMembershipStatus,
        createdAt: row.createdAt,
      }));
    },
  };
}

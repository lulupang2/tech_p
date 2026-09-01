import { eq, and, desc, count } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type {
  DocumentRepositoryPort,
  SourceRepositoryPort,
  DocumentRecord,
  DocumentRevisionRecord,
  ChunkRecord,
  SourceRecord,
  DocumentFilter,
  PaginationParams,
  PaginatedResult,
} from '@techpulse/domain';
import { documents, documentRevisions, chunks, sources, type schema } from './schema/index.js';

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

import { sql } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import type {
  SearchServicePort,
  SearchHit,
  FtsQueryParams,
  ExactVectorQueryParams,
} from '@techpulse/domain';
import type { schema } from './schema/index.js';

export function createSearchService(db: NeonDatabase<typeof schema>): SearchServicePort {
  return {
    async searchFts(params: FtsQueryParams): Promise<readonly SearchHit[]> {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const status = params.filter?.status ?? 'searchable';
      const cleanQuery = params.query.trim();
      if (!cleanQuery) return [];

      const querySql = sql`
        SELECT
          c.id AS chunk_id,
          dr.document_id AS document_id,
          dr.id AS document_revision_id,
          dr.title AS title,
          c.content AS content,
          c.heading_path AS heading_path,
          ts_rank(
            to_tsvector('simple', COALESCE(dr.title, '') || ' ' || COALESCE(c.content, '')),
            plainto_tsquery('simple', ${cleanQuery})
          ) AS score,
          dr.published_at AS published_at
        FROM chunks c
        JOIN document_revisions dr ON c.document_revision_id = dr.id
        WHERE dr.status = ${status}
          AND to_tsvector('simple', COALESCE(dr.title, '') || ' ' || COALESCE(c.content, '')) @@ plainto_tsquery('simple', ${cleanQuery})
        ORDER BY score DESC, dr.published_at DESC NULLS LAST
        LIMIT ${limit};
      `;

      const result = await db.execute(querySql);
      return result.rows.map((row) => ({
        chunkId: String(row['chunk_id']),
        documentId: String(row['document_id']),
        documentRevisionId: String(row['document_revision_id']),
        title: String(row['title']),
        content: String(row['content']),
        headingPath: Array.isArray(row['heading_path']) ? (row['heading_path'] as string[]) : [],
        score: Number(row['score']),
        publishedAt: row['published_at'] ? new Date(String(row['published_at'])) : null,
      }));
    },

    async searchExactVector(params: ExactVectorQueryParams): Promise<readonly SearchHit[]> {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const status = params.filter?.status ?? 'searchable';
      const vectorLiteral = `[${params.vector.join(',')}]`;

      const querySql = sql`
        SELECT
          c.id AS chunk_id,
          dr.document_id AS document_id,
          dr.id AS document_revision_id,
          dr.title AS title,
          c.content AS content,
          c.heading_path AS heading_path,
          1 - (e.embedding <=> ${vectorLiteral}::vector) AS score,
          dr.published_at AS published_at
        FROM embeddings e
        JOIN chunks c ON e.chunk_id = c.id
        JOIN document_revisions dr ON c.document_revision_id = dr.id
        WHERE dr.status = ${status}
          AND e.provider = ${params.provider}
          AND e.model = ${params.model}
          AND e.dimensions = ${params.dimensions}
        ORDER BY e.embedding <=> ${vectorLiteral}::vector ASC
        LIMIT ${limit};
      `;

      const result = await db.execute(querySql);
      return result.rows.map((row) => ({
        chunkId: String(row['chunk_id']),
        documentId: String(row['document_id']),
        documentRevisionId: String(row['document_revision_id']),
        title: String(row['title']),
        content: String(row['content']),
        headingPath: Array.isArray(row['heading_path']) ? (row['heading_path'] as string[]) : [],
        score: Number(row['score']),
        publishedAt: row['published_at'] ? new Date(String(row['published_at'])) : null,
      }));
    },
  };
}

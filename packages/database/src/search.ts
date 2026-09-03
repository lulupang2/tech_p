import { sql } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  type SearchServicePort,
  type SearchHit,
  type FtsQueryParams,
  type ExactVectorQueryParams,
  extractSearchKeywords,
} from '@techpulse/domain';
import type { schema } from './schema/index.js';

export function createSearchService(db: NeonDatabase<typeof schema>): SearchServicePort {
  return {
    async searchFts(params: FtsQueryParams): Promise<readonly SearchHit[]> {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const status = params.filter?.status ?? 'searchable';
      const cleanQuery = params.query.trim();
      if (!cleanQuery) return [];

      const publishedAfter = params.filter?.publishedAfter;
      const publishedBefore = params.filter?.publishedBefore;

      const executeFts = async (queryText: string): Promise<readonly SearchHit[]> => {
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
              plainto_tsquery('simple', ${queryText})
            ) AS score,
            dr.published_at AS published_at
          FROM chunks c
          JOIN document_revisions dr ON c.document_revision_id = dr.id
          WHERE dr.status = ${status}
            ${publishedAfter ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at >= ${publishedAfter})` : sql``}
            ${publishedBefore ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at < ${publishedBefore})` : sql``}
            AND to_tsvector('simple', COALESCE(dr.title, '') || ' ' || COALESCE(c.content, '')) @@ plainto_tsquery('simple', ${queryText})
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
      };

      // 1. Exact query first
      const exactHits = await executeFts(cleanQuery);
      if (exactHits.length > 0) {
        return exactHits;
      }

      // 2. Conservative fallback for natural-language questions
      const normalizedKeywords = extractSearchKeywords(cleanQuery);
      if (normalizedKeywords.length === 0) {
        return [];
      }

      // Candidate 2a: Combined normalized keywords
      const combinedQuery = normalizedKeywords.join(' ');
      if (combinedQuery !== cleanQuery) {
        const combinedHits = await executeFts(combinedQuery);
        if (combinedHits.length > 0) {
          return combinedHits;
        }
      }

      // Candidate 2b: Technical entity keywords (e.g. "Playwright", "v1.62.1", "Bun")
      const techKeywords = normalizedKeywords.filter((k) => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(k));
      if (techKeywords.length > 0) {
        const techQuery = techKeywords.join(' ');
        if (techQuery !== combinedQuery && techQuery !== cleanQuery) {
          const techHits = await executeFts(techQuery);
          if (techHits.length > 0) {
            return techHits;
          }
        }

        // If multiple tech keywords, try individual tech keywords
        if (techKeywords.length > 1) {
          for (const tk of techKeywords) {
            const singleHits = await executeFts(tk);
            if (singleHits.length > 0) {
              return singleHits;
            }
          }
        }
      }

      // Candidate 2c: If only Korean/non-tech keywords and multiple keywords, try individual primary keywords
      if (normalizedKeywords.length > 1) {
        for (const kw of normalizedKeywords) {
          if (kw.length >= 2) {
            const singleHits = await executeFts(kw);
            if (singleHits.length > 0) {
              return singleHits;
            }
          }
        }
      }

      return [];
    },

    async searchExactVector(params: ExactVectorQueryParams): Promise<readonly SearchHit[]> {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const status = params.filter?.status ?? 'searchable';
      const vectorLiteral = `[${params.vector.join(',')}]`;
      const publishedAfter = params.filter?.publishedAfter;
      const publishedBefore = params.filter?.publishedBefore;
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
          ${publishedAfter ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at >= ${publishedAfter})` : sql``}
          ${publishedBefore ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at < ${publishedBefore})` : sql``}
          AND (e.provider = ${params.provider} OR e.provider IN ('openai', 'openrouter'))
          AND (e.model = ${params.model} OR e.dimensions = ${params.dimensions})
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

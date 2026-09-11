import { sql } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  type SearchServicePort,
  type SearchHit,
  type FtsQueryParams,
  type ExactVectorQueryParams,
  extractSearchKeywords,
  prioritizeSearchKeywords,
} from '@techpulse/domain';
import type { schema } from './schema/index.js';

export interface SearchServiceScope {
  /** Trusted composition only; a fixed corpus is filtered before ranking/LIMIT, never afterward. */
  readonly revisionIds?: readonly string[];
}

export function createSearchService(
  db: NeonDatabase<typeof schema>,
  scope: SearchServiceScope = {},
): SearchServicePort {
  if (
    scope.revisionIds?.some(
      (id) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id),
    )
  ) {
    throw new Error('invalid_search_revision_scope');
  }
  const scopeClause =
    scope.revisionIds === undefined
      ? sql``
      : scope.revisionIds.length === 0
        ? sql` AND false`
        : sql` AND dr.id IN (${sql.join(
            scope.revisionIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`;
  return {
    async searchFts(params: FtsQueryParams): Promise<readonly SearchHit[]> {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const status = params.filter?.status ?? 'searchable';
      const cleanQuery = params.query.trim();
      if (!cleanQuery) return [];

      const publishedAfter = params.filter?.publishedAfter;
      const publishedBefore = params.filter?.publishedBefore;
      const topicSlugs = params.filter?.topicSlugs;
      const requireApprovedRights = params.filter?.requireApprovedRights === true;

      const normalizedKeywords = extractSearchKeywords(cleanQuery);
      const prioritizedKeywords = prioritizeSearchKeywords(normalizedKeywords);
      const exactIdentifiers = prioritizedKeywords.filter(
        (value) =>
          /^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?$/iu.test(value) ||
          /^\d{4}-\d{2}-\d{2}$/u.test(value),
      );
      const combinedQuery = normalizedKeywords.join(' ');
      const techKeywords = prioritizedKeywords.filter((k) =>
        /^[A-Za-z0-9][A-Za-z0-9@._/-]*$/u.test(k),
      );
      const techQuery = techKeywords.join(' ');
      const candidates = [
        ...exactIdentifiers,
        cleanQuery,
        combinedQuery,
        techQuery,
        ...prioritizedKeywords,
      ]
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .filter(
          (value, index, values) =>
            values.findIndex(
              (candidate) =>
                candidate.toLocaleLowerCase('en-US') === value.toLocaleLowerCase('en-US'),
            ) === index,
        )
        .slice(0, 12);
      if (candidates.length === 0) return [];

      const candidateTsQuery = sql`(${sql.join(
        candidates.map((candidate) => sql`plainto_tsquery('simple', ${candidate})`),
        sql` || `,
      )})`;
      const identifierTsQuery =
        exactIdentifiers.length > 0
          ? sql`(${sql.join(
              exactIdentifiers.map((candidate) => sql`plainto_tsquery('simple', ${candidate})`),
              sql` || `,
            )})`
          : null;

      const executeFts = async (): Promise<readonly SearchHit[]> => {
        const topicClause =
          topicSlugs && topicSlugs.length > 0
            ? sql` AND EXISTS (
                SELECT 1 FROM document_topics dt
                JOIN topics t ON dt.topic_id = t.id
                WHERE dt.document_id = dr.document_id
                  AND t.slug IN (${sql.join(
                    topicSlugs.map((s) => sql`${s}`),
                    sql`, `,
                  )})
              )`
            : sql``;

        const filterClause = sql`
            dr.status = ${status}
            AND dr.status NOT IN ('tombstoned', 'quarantined')
            AND dr.lexical_ready_at IS NOT NULL
            ${scopeClause}
            ${
              requireApprovedRights
                ? sql` AND raw.id IS NOT NULL
                    AND src.enabled = true
                    AND src.policy_reviewed_at IS NOT NULL
                    AND raw.rights_metadata ->> 'approved' = 'true'
                    AND raw.rights_metadata ->> 'store' = 'true'
                    AND raw.rights_metadata ->> 'modelInput' = 'true'
                    AND raw.rights_metadata ->> 'displayExcerpt' = 'true'`
                : sql``
            }
            ${publishedAfter ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at >= ${publishedAfter})` : sql``}
            ${publishedBefore ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at < ${publishedBefore})` : sql``}
            ${topicClause}`;

        const querySql = sql`
          WITH matched AS (
          SELECT
            c.id AS chunk_id,
            dr.document_id AS document_id,
            d.duplicate_cluster_id AS duplicate_cluster_id,
            dr.id AS document_revision_id,
            dr.title AS title,
            COALESCE(raw.canonical_url, d.canonical_url) AS canonical_url,
            src.key AS source_key,
            lic.id AS license_id, lic.name AS license_name, lic.url AS license_url,
            c.content AS content,
            c.heading_path AS heading_path,
            c.ordinal AS ordinal,
            c.token_count AS token_count,
            (ts_rank(to_tsvector('simple', c.content), ${candidateTsQuery})
              ${identifierTsQuery ? sql` + 2 * ts_rank(to_tsvector('simple', c.content), ${identifierTsQuery})` : sql``}) AS score,
            dr.published_at AS published_at
          FROM chunks c
          JOIN document_revisions dr ON c.document_revision_id = dr.id
          JOIN documents d ON d.id = dr.document_id
          LEFT JOIN raw_items raw ON raw.id = dr.raw_item_id
          LEFT JOIN sources src ON src.id = raw.source_id
          LEFT JOIN licenses lic ON lic.id = dr.license_id
          WHERE ${filterClause}
            AND to_tsvector('simple', c.content) @@ ${candidateTsQuery}

          UNION ALL

          SELECT
            c.id AS chunk_id,
            dr.document_id AS document_id,
            d.duplicate_cluster_id AS duplicate_cluster_id,
            dr.id AS document_revision_id,
            dr.title AS title,
            COALESCE(raw.canonical_url, d.canonical_url) AS canonical_url,
            src.key AS source_key,
            lic.id AS license_id, lic.name AS license_name, lic.url AS license_url,
            c.content AS content,
            c.heading_path AS heading_path,
            c.ordinal AS ordinal,
            c.token_count AS token_count,
            ((ts_rank(to_tsvector('simple', dr.title), ${candidateTsQuery})
              ${identifierTsQuery ? sql` + 2 * ts_rank(to_tsvector('simple', dr.title), ${identifierTsQuery})` : sql``}) * 1.15) AS score,
            dr.published_at AS published_at
          FROM chunks c
          JOIN document_revisions dr ON c.document_revision_id = dr.id
          JOIN documents d ON d.id = dr.document_id
          LEFT JOIN raw_items raw ON raw.id = dr.raw_item_id
          LEFT JOIN sources src ON src.id = raw.source_id
          LEFT JOIN licenses lic ON lic.id = dr.license_id
          WHERE ${filterClause}
            AND to_tsvector('simple', dr.title) @@ ${candidateTsQuery}
          ), deduplicated AS (
            SELECT DISTINCT ON (chunk_id) *
            FROM matched
            ORDER BY chunk_id, score DESC
          )
          SELECT * FROM deduplicated
          ORDER BY score DESC, published_at DESC NULLS LAST, ordinal ASC
          LIMIT ${limit};
        `;

        const result = await db.execute(querySql);
        return result.rows.map((row) => ({
          chunkId: String(row['chunk_id']),
          documentId: String(row['document_id']),
          duplicateClusterId: row['duplicate_cluster_id']
            ? String(row['duplicate_cluster_id'])
            : null,
          documentRevisionId: String(row['document_revision_id']),
          title: String(row['title']),
          canonicalUrl: String(row['canonical_url']),
          sourceKey: String(row['source_key']),
          ...(row['license_id'] && row['license_url']
            ? {
                license: {
                  id: String(row['license_id']),
                  name: String(row['license_name']),
                  url: String(row['license_url']),
                  attribution: `${String(row['title'])} — ${String(row['canonical_url'])}`,
                },
              }
            : {}),
          content: String(row['content']),
          headingPath: Array.isArray(row['heading_path']) ? (row['heading_path'] as string[]) : [],
          ordinal: Number(row['ordinal']),
          tokenCount: Number(row['token_count']),
          score: Number(row['score']),
          publishedAt: row['published_at'] ? new Date(String(row['published_at'])) : null,
        }));
      };

      return executeFts();
    },

    async searchExactVector(params: ExactVectorQueryParams): Promise<readonly SearchHit[]> {
      const limit = Math.max(1, Math.min(params.limit ?? 10, 50));
      const status = params.filter?.status ?? 'searchable';
      const vectorLiteral = `[${params.vector.join(',')}]`;
      const publishedAfter = params.filter?.publishedAfter;
      const publishedBefore = params.filter?.publishedBefore;
      const topicSlugs = params.filter?.topicSlugs;
      const requireApprovedRights = params.filter?.requireApprovedRights === true;
      const profileHash = params.profileHash;

      const topicClause =
        topicSlugs && topicSlugs.length > 0
          ? sql` AND EXISTS (
              SELECT 1 FROM document_topics dt
              JOIN topics t ON dt.topic_id = t.id
              WHERE dt.document_id = dr.document_id
                AND t.slug IN (${sql.join(
                  topicSlugs.map((s) => sql`${s}`),
                  sql`, `,
                )})
            )`
          : sql``;

      const querySql = sql`
        SELECT
          c.id AS chunk_id,
          dr.document_id AS document_id,
          d.duplicate_cluster_id AS duplicate_cluster_id,
          dr.id AS document_revision_id,
          dr.title AS title,
            COALESCE(raw.canonical_url, d.canonical_url) AS canonical_url,
            src.key AS source_key,
            lic.id AS license_id, lic.name AS license_name, lic.url AS license_url,
          c.content AS content,
          c.heading_path AS heading_path,
          c.ordinal AS ordinal,
          c.token_count AS token_count,
          1 - (e.embedding <=> ${vectorLiteral}::vector) AS score,
          dr.published_at AS published_at
        FROM embeddings e
        JOIN chunks c ON e.chunk_id = c.id
        JOIN document_revisions dr ON c.document_revision_id = dr.id
          JOIN documents d ON d.id = dr.document_id
          LEFT JOIN raw_items raw ON raw.id = dr.raw_item_id
          LEFT JOIN sources src ON src.id = raw.source_id
          LEFT JOIN licenses lic ON lic.id = dr.license_id
        WHERE dr.status = ${status}
          AND dr.status NOT IN ('tombstoned', 'quarantined')
          ${scopeClause}
          ${
            requireApprovedRights
              ? sql` AND raw.id IS NOT NULL
                  AND src.enabled = true
                  AND src.policy_reviewed_at IS NOT NULL
                  AND raw.rights_metadata ->> 'approved' = 'true'
                  AND raw.rights_metadata ->> 'store' = 'true'
                  AND raw.rights_metadata ->> 'modelInput' = 'true'
                  AND raw.rights_metadata ->> 'embed' = 'true'
                  AND raw.rights_metadata ->> 'displayExcerpt' = 'true'`
              : sql``
          }
          ${publishedAfter ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at >= ${publishedAfter})` : sql``}
          ${publishedBefore ? sql` AND (dr.published_at IS NOT NULL AND dr.published_at < ${publishedBefore})` : sql``}
          ${topicClause}
          AND e.provider = ${params.provider}
          AND e.model = ${params.model}
          AND e.dimensions = ${params.dimensions}
          ${profileHash ? sql` AND e.profile_hash = ${profileHash}` : sql``}
          AND e.input_hash = c.content_hash
          AND NOT EXISTS (
            SELECT 1
            FROM chunks required_chunk
            WHERE required_chunk.document_revision_id = dr.id
              AND NOT EXISTS (
                SELECT 1
                FROM embeddings required_embedding
                WHERE required_embedding.chunk_id = required_chunk.id
                  AND required_embedding.provider = ${params.provider}
                  AND required_embedding.model = ${params.model}
                  AND required_embedding.dimensions = ${params.dimensions}
                  ${
                    profileHash ? sql` AND required_embedding.profile_hash = ${profileHash}` : sql``
                  }
                  AND required_embedding.input_hash = required_chunk.content_hash
              )
          )
        ORDER BY e.embedding <=> ${vectorLiteral}::vector ASC
        LIMIT ${limit};
      `;

      const result = await db.execute(querySql);
      return result.rows.map((row) => ({
        chunkId: String(row['chunk_id']),
        documentId: String(row['document_id']),
        duplicateClusterId: row['duplicate_cluster_id']
          ? String(row['duplicate_cluster_id'])
          : null,
        documentRevisionId: String(row['document_revision_id']),
        title: String(row['title']),
        canonicalUrl: String(row['canonical_url']),
        sourceKey: String(row['source_key']),
        ...(row['license_id'] && row['license_url']
          ? {
              license: {
                id: String(row['license_id']),
                name: String(row['license_name']),
                url: String(row['license_url']),
                attribution: `${String(row['title'])} — ${String(row['canonical_url'])}`,
              },
            }
          : {}),
        content: String(row['content']),
        headingPath: Array.isArray(row['heading_path']) ? (row['heading_path'] as string[]) : [],
        ordinal: Number(row['ordinal']),
        tokenCount: Number(row['token_count']),
        score: Number(row['score']),
        publishedAt: row['published_at'] ? new Date(String(row['published_at'])) : null,
      }));
    },
  };
}

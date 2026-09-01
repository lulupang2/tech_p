import {
  type SourceDetailResponse,
  type SourceKey,
  type SourceListResponse,
  type SourceSummary,
} from '@techpulse/contracts';
import { type SourceRecord, type SourceRepositoryPort } from '@techpulse/domain';
import { Elysia, t } from 'elysia';

import { ApiHttpError } from '../errors.js';

export interface SourceCatalogEntry {
  readonly key: SourceKey;
  readonly displayName: string;
  readonly kind: string;
  readonly coverageNotes: readonly string[];
}

export const KNOWN_SOURCES: readonly SourceCatalogEntry[] = [
  {
    key: 'github_releases',
    displayName: 'GitHub Releases',
    kind: 'releases',
    coverageNotes: ['Approved repository releases and changelogs'],
  },
  {
    key: 'stack_exchange',
    displayName: 'Stack Exchange',
    kind: 'qa',
    coverageNotes: ['Stack Overflow questions with approved tags; verbatim only'],
  },
  {
    key: 'users_rust_lang',
    displayName: 'Users Rust-Lang',
    kind: 'forum',
    coverageNotes: ['Rust users forum posts after 2020-07-17'],
  },
  {
    key: 'arxiv',
    displayName: 'arXiv',
    kind: 'papers',
    coverageNotes: ['Computer science paper abstracts'],
  },
  {
    key: 'chrome_release_notes',
    displayName: 'Chrome Release Notes',
    kind: 'article',
    coverageNotes: ['Chrome developer blog and release notes'],
  },
  {
    key: 'react_blog',
    displayName: 'React Blog',
    kind: 'article',
    coverageNotes: ['React official blog articles'],
  },
  {
    key: 'chrome_origin_trials',
    displayName: 'Chrome Origin Trials',
    kind: 'documentation',
    coverageNotes: ['Chrome platform status origin trials'],
  },
  {
    key: 'npm_registry',
    displayName: 'npm Registry',
    kind: 'package_registry',
    coverageNotes: ['npm package metadata and versions'],
  },
  {
    key: 'npm_downloads',
    displayName: 'npm Downloads',
    kind: 'metrics',
    coverageNotes: ['Daily and weekly package download point metrics'],
  },
  {
    key: 'github_search',
    displayName: 'GitHub Search',
    kind: 'metrics',
    coverageNotes: ['Search signal snapshots'],
  },
  {
    key: 'huggingface_hub',
    displayName: 'Hugging Face Hub',
    kind: 'metrics',
    coverageNotes: ['Hugging Face model and dataset metrics'],
  },
];

export interface SourceRouteOptions {
  readonly sourceRepository?: SourceRepositoryPort | undefined;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { offset?: unknown };
    if (
      typeof parsed.offset !== 'number' ||
      parsed.offset < 0 ||
      !Number.isInteger(parsed.offset)
    ) {
      throw new Error('invalid offset');
    }
    return parsed.offset;
  } catch {
    throw new ApiHttpError({
      code: 'INVALID_REQUEST',
      status: 400,
      message: 'Invalid pagination cursor',
    });
  }
}

function buildSourceSummary(
  entry: SourceCatalogEntry,
  record?: SourceRecord | null,
): SourceSummary {
  const isEnabled = record ? record.enabled : true;
  return {
    key: entry.key,
    displayName: entry.displayName,
    kind: entry.kind,
    lastSuccessfulCollectionAt: record?.updatedAt ? record.updatedAt.toISOString() : null,
    freshThrough: record?.updatedAt ? record.updatedAt.toISOString() : null,
    status: isEnabled ? 'healthy' : 'disabled',
    coverageNotes: [...entry.coverageNotes],
  };
}

export function createSourceRoutes(options: SourceRouteOptions = {}) {
  const repository = options.sourceRepository;

  return new Elysia()
    .get(
      '/sources',
      async ({ query, store }): Promise<SourceListResponse> => {
        const requestId = (store as Record<string, unknown>)['requestId'] as string;
        const limit = Math.min(Math.max(1, query.limit ?? 20), 100);
        const offset = decodeCursor(query.cursor);

        let enabledMap: Map<string, SourceRecord> | null = null;
        if (repository) {
          try {
            const records = await repository.listEnabled();
            enabledMap = new Map(records.map((r) => [r.key, r]));
          } catch {
            // Safe fallback when repo query encounters issues
            enabledMap = null;
          }
        }

        const allSummaries: SourceSummary[] = KNOWN_SOURCES.map((entry) => {
          const record = enabledMap ? enabledMap.get(entry.key) : undefined;
          return buildSourceSummary(entry, record);
        });

        const items = allSummaries.slice(offset, offset + limit);
        const hasNext = offset + limit < allSummaries.length;
        const nextCursor = hasNext ? encodeCursor(offset + limit) : null;

        return {
          requestId: requestId || 'req_sources',
          items,
          page: {
            nextCursor,
            limit,
          },
        };
      },
      {
        query: t.Object(
          {
            cursor: t.Optional(t.String({ maxLength: 512 })),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
          },
          { additionalProperties: false },
        ),
      },
    )
    .get(
      '/sources/:key',
      async ({ params, store }): Promise<SourceDetailResponse> => {
        const requestId = (store as Record<string, unknown>)['requestId'] as string;
        const key = params.key;

        const entry = KNOWN_SOURCES.find((s) => s.key === key);
        if (!entry) {
          throw new ApiHttpError({
            code: 'NOT_FOUND',
            status: 404,
            message: `Source '${key}' was not found`,
          });
        }

        let record: SourceRecord | null = null;
        if (repository) {
          try {
            record = await repository.findByKey(key);
          } catch {
            record = null;
          }
        }

        return {
          requestId: requestId || 'req_source_detail',
          source: buildSourceSummary(entry, record),
        };
      },
      {
        params: t.Object(
          {
            key: t.String({ minLength: 1, maxLength: 64 }),
          },
          { additionalProperties: false },
        ),
      },
    );
}

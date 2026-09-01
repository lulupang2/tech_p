import { type TopicListResponse, type TopicSummary } from '@techpulse/contracts';
import {
  TOPIC_TAXONOMY,
  TOPIC_TAXONOMY_VERSION,
  type TopicRepositoryPort,
} from '@techpulse/domain';
import { Elysia, t } from 'elysia';

import { ApiHttpError } from '../errors.js';

export interface TopicRouteOptions {
  readonly topicRepository?: TopicRepositoryPort | undefined;
}

function encodeCursor(offset: number, query?: string): string {
  return Buffer.from(JSON.stringify({ offset, q: query ?? '' })).toString('base64url');
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

export function createTopicRoutes(options: TopicRouteOptions = {}) {
  void options.topicRepository;
  const allTopicSummaries: readonly TopicSummary[] = TOPIC_TAXONOMY.map((entry) => ({
    slug: entry.slug,
    displayName: entry.displayName,
    parent: entry.parent ?? null,
    aliases: [...entry.aliases],
    taxonomyVersion: TOPIC_TAXONOMY_VERSION,
  }));
  return new Elysia().get(
    '/topics',
    async ({ query, store }): Promise<TopicListResponse> => {
      const requestId = (store as Record<string, unknown>)['requestId'] as string;
      const limit = Math.min(Math.max(1, query.limit ?? 20), 100);
      const offset = decodeCursor(query.cursor);

      let filtered = allTopicSummaries;
      const searchTerm = query.q?.trim().toLowerCase();
      if (searchTerm && searchTerm.length > 0) {
        filtered = allTopicSummaries.filter(
          (topic) =>
            topic.slug.toLowerCase().includes(searchTerm) ||
            topic.displayName.toLowerCase().includes(searchTerm) ||
            topic.aliases.some((alias) => alias.toLowerCase().includes(searchTerm)),
        );
      }

      const items = filtered.slice(offset, offset + limit);
      const hasNext = offset + limit < filtered.length;
      const nextCursor = hasNext ? encodeCursor(offset + limit, query.q) : null;

      return {
        requestId: requestId || 'req_topics',
        items: [...items],
        page: {
          nextCursor,
          limit,
        },
      };
    },
    {
      query: t.Object(
        {
          q: t.Optional(t.String({ maxLength: 256 })),
          cursor: t.Optional(t.String({ maxLength: 512 })),
          limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100 })),
        },
        { additionalProperties: false },
      ),
    },
  );
}

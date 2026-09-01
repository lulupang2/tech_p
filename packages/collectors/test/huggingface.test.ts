import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  HuggingFaceCollector,
  HuggingFaceCollectorError,
  HuggingFaceRateLimitError,
  HuggingFaceHttpError,
  HuggingFaceItemNotFoundError,
  buildHuggingFaceExternalId,
  extractHuggingFaceMetricPayload,
  parseRetryAfter,
  readHuggingFaceRateLimit,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
} from '../src/index.js';
import type { CollectionContext } from '@techpulse/domain';

// Fixture 1: Model item containing rich metadata, metrics, and text/card/PII fields
const SAMPLE_MODEL_FIXTURE = {
  _id: '64b1234567890abcdef12345',
  id: 'meta-llama/Llama-2-7b-hf',
  modelId: 'meta-llama/Llama-2-7b-hf',
  author: 'meta-llama',
  sha: '83e5843a41926615b3b0ef9b7367332c96c561b3',
  lastModified: '2026-08-20T14:30:00.000Z',
  createdAt: '2026-07-18T10:00:00.000Z',
  private: false,
  disabled: false,
  gated: 'auto',
  downloads: 4829103,
  downloadsAllTime: 12500000,
  likes: 18204,
  tags: ['pytorch', 'llama', 'text-generation', 'en', 'license:other'],
  pipeline_tag: 'text-generation',
  library_name: 'transformers',
  // Fields that MUST NOT be retained in raw metric payload
  cardData: {
    language: ['en'],
    license: 'other',
    tags: ['llama', 'facebook'],
    model_name: 'Llama 2 7B',
    authors: ['Personal Author <author@meta.com>'],
  },
  description: 'Llama 2 is a collection of pretrained and fine-tuned generative text models.',
  readme: '# Llama 2 Model Card\n\nFull model card text and benchmark details...',
  siblings: [{ rfilename: '.gitattributes' }, { rfilename: 'config.json' }],
  widgetData: [{ text: 'How are you today?' }],
  user: 'individual_uploader_username',
};

// Fixture 2: Dataset item with metrics and README
const SAMPLE_DATASET_FIXTURE = {
  _id: '64d9876543210fedcba54321',
  id: 'tatsu-lab/alpaca',
  author: 'tatsu-lab',
  sha: '35ce53e118b87190011b6264ccb6ef6101c56b46',
  lastModified: '2026-05-10T12:00:00.000Z',
  createdAt: '2026-03-15T09:00:00.000Z',
  private: false,
  downloads: 948201,
  downloadsAllTime: 3200000,
  likes: 5412,
  tags: ['instruction-tuning', 'synthetic'],
  cardData: {
    dataset_info: { dataset_size: 24000000 },
  },
  description: 'Alpaca instruction tuning dataset.',
  readme: '# Stanford Alpaca Dataset\n\nFull dataset documentation...',
};

// Fixture 3: Model item with lastModified but no createdAt
const SAMPLE_MODEL_NO_CREATED_AT = {
  id: 'mistralai/Mistral-7B-v0.1',
  sha: '26bca36bde8333b5d7f72e9ed20cc4824d81b41e',
  lastModified: '2026-08-01T16:45:00.000Z',
  downloads: 2100345,
  likes: 9340,
  tags: ['transformers', 'mistral'],
};

function createJsonResponse(
  data: unknown,
  options: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
  } = {},
): Response {
  return new Response(JSON.stringify(data), {
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers: {
      'content-type': 'application/json',
      ...options.headers,
    },
  });
}

describe('COL-010 Hugging Face Hub Collector', () => {
  describe('Helper Unit Tests', () => {
    test('buildHuggingFaceExternalId creates stable {namespace}/{repo}:{sha} identifiers', () => {
      const id1 = buildHuggingFaceExternalId(
        'meta-llama/Llama-2-7b-hf',
        '83e5843a41926615b3b0ef9b7367332c96c561b3',
      );
      assert.equal(id1, 'meta-llama/Llama-2-7b-hf:83e5843a41926615b3b0ef9b7367332c96c561b3');

      // Defaults to head if sha is null or empty
      const id2 = buildHuggingFaceExternalId('gpt2', null);
      assert.equal(id2, 'gpt2:head');

      const id3 = buildHuggingFaceExternalId('tatsu-lab/alpaca', '   ');
      assert.equal(id3, 'tatsu-lab/alpaca:head');
    });

    test('parseRetryAfter parses integer seconds and HTTP-date strings correctly', () => {
      const now = 1788285600000; // Fixed timestamp

      // Numeric seconds
      const numRes = parseRetryAfter('120', now);
      assert.equal(numRes.seconds, 120);
      assert.equal(numRes.resetAt?.getTime(), now + 120000);

      // HTTP-Date header format
      const dateHeader = new Date(now + 60000).toUTCString();
      const dateRes = parseRetryAfter(dateHeader, now);
      assert.equal(dateRes.seconds, 60);
      assert.equal(dateRes.resetAt?.getTime(), now + 60000);

      // Empty / invalid cases
      assert.deepEqual(parseRetryAfter(null), { seconds: null, resetAt: null });
      assert.deepEqual(parseRetryAfter(''), { seconds: null, resetAt: null });
      assert.deepEqual(parseRetryAfter('invalid-date-string'), { seconds: null, resetAt: null });
    });

    test('readHuggingFaceRateLimit parses standard and rate limit headers', () => {
      const headers = new Headers({
        'x-ratelimit-limit': '1000',
        'x-ratelimit-remaining': '950',
        'x-ratelimit-reset': '1788289200',
      });
      const limit = readHuggingFaceRateLimit(headers);
      assert.deepEqual(limit, {
        limit: 1000,
        remaining: 950,
        reset: 1788289200,
      });

      const emptyHeaders = new Headers();
      assert.equal(readHuggingFaceRateLimit(emptyHeaders), null);
    });

    test('extractHuggingFaceMetricPayload extracts only metric data and excludes text/PII', () => {
      const payload = extractHuggingFaceMetricPayload(SAMPLE_MODEL_FIXTURE, 'model');

      assert.equal(payload['id'], 'meta-llama/Llama-2-7b-hf');
      assert.equal(payload['entityType'], 'model');
      assert.equal(payload['sha'], '83e5843a41926615b3b0ef9b7367332c96c561b3');
      assert.equal(payload['downloads'], 4829103);
      assert.equal(payload['downloadsAllTime'], 12500000);
      assert.equal(payload['likes'], 18204);
      assert.equal(payload['createdAt'], '2026-07-18T10:00:00.000Z');
      assert.equal(payload['lastModified'], '2026-08-20T14:30:00.000Z');
      assert.equal(payload['metricType'], 'model_activity');

      // Verify complete absence of prose, docs, and PII
      assert.equal(payload['cardData'], undefined);
      assert.equal(payload['readme'], undefined);
      assert.equal(payload['description'], undefined);
      assert.equal(payload['siblings'], undefined);
      assert.equal(payload['widgetData'], undefined);
      assert.equal(payload['author'], undefined);
      assert.equal(payload['user'], undefined);
    });
  });

  describe('Metric-Only & Privacy Invariants', () => {
    test('strictly collects metrics without README, model card, description or namespace PII', async () => {
      const collector = new HuggingFaceCollector({
        fetchFn: async () => createJsonResponse([SAMPLE_MODEL_FIXTURE]),
      });

      const context: CollectionContext = {
        sourceKey: 'huggingface_hub',
        cursor: null,
      };

      const result = await collector.collect(context);
      assert.equal(result.items.length, 1);

      const item = result.items[0]!;
      assert.equal(
        item.externalId,
        'meta-llama/Llama-2-7b-hf:83e5843a41926615b3b0ef9b7367332c96c561b3',
      );
      assert.equal(item.publishedAt?.toISOString(), '2026-07-18T10:00:00.000Z');

      const payload = item.payload;
      assert.equal(payload['downloads'], 4829103);
      assert.equal(payload['likes'], 18204);
      assert.equal(payload['metricType'], 'model_activity');

      // Strict privacy & content check: no README, model card, or author PII
      assert.equal(payload['readme'], undefined);
      assert.equal(payload['cardData'], undefined);
      assert.equal(payload['description'], undefined);
      assert.equal(payload['author'], undefined);
      assert.equal(payload['user'], undefined);
      assert.equal(payload['siblings'], undefined);
      assert.equal(payload['widgetData'], undefined);

      // Raw hash must be valid sha256 hex string (64 chars)
      assert.match(item.rawHash, /^[a-f0-9]{64}$/);

      // Metadata contains source and timestamps
      assert.equal(item.metadata?.['source'], 'huggingface_hub');
      assert.equal(item.metadata?.['entityType'], 'model');
      assert.equal(item.metadata?.['createdAt'], '2026-07-18T10:00:00.000Z');
      assert.equal(item.metadata?.['lastModified'], '2026-08-20T14:30:00.000Z');
      assert.equal(
        item.metadata?.['canonicalUrl'],
        'https://huggingface.co/meta-llama/Llama-2-7b-hf',
      );
    });

    test('collects dataset metrics and sets dataset canonicalUrl and entityType', async () => {
      const collector = new HuggingFaceCollector({
        defaultEntityType: 'datasets',
        fetchFn: async () => createJsonResponse([SAMPLE_DATASET_FIXTURE]),
      });

      const result = await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
      assert.equal(result.items.length, 1);

      const item = result.items[0]!;
      assert.equal(item.externalId, 'tatsu-lab/alpaca:35ce53e118b87190011b6264ccb6ef6101c56b46');
      assert.equal(item.payload['downloads'], 948201);
      assert.equal(item.payload['likes'], 5412);
      assert.equal(item.payload['readme'], undefined);
      assert.equal(
        item.metadata?.['canonicalUrl'],
        'https://huggingface.co/datasets/tatsu-lab/alpaca',
      );
    });
  });

  describe('Conditional Token Authentication', () => {
    test('sends Authorization: Bearer <token> when token option is provided', async () => {
      let capturedRequest: RequestInit | undefined;
      let capturedUrl = '';

      const collector = new HuggingFaceCollector({
        token: 'hf_test_secret_token_12345',
        fetchFn: async (url, init) => {
          capturedUrl = String(url);
          capturedRequest = init;
          return createJsonResponse([SAMPLE_MODEL_FIXTURE]);
        },
      });

      await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });

      assert(capturedUrl.includes('https://huggingface.co/api/models'));
      const headers = capturedRequest?.headers as Record<string, string>;
      assert.equal(headers['Authorization'], 'Bearer hf_test_secret_token_12345');
      assert.equal(headers['Accept'], 'application/json');
    });

    test('omits Authorization header when token is not provided (anonymous access)', async () => {
      let capturedRequest: RequestInit | undefined;

      const collector = new HuggingFaceCollector({
        token: undefined,
        fetchFn: async (_url, init) => {
          capturedRequest = init;
          return createJsonResponse([SAMPLE_MODEL_FIXTURE]);
        },
      });

      await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });

      const headers = capturedRequest?.headers as Record<string, string>;
      assert.equal(headers['Authorization'], undefined);
      assert.equal(headers['Accept'], 'application/json');
    });
  });

  describe('HTTP 429 Rate Limit & Retry-After Handling', () => {
    test('throws HuggingFaceRateLimitError on HTTP 429 with parsed seconds delay', async () => {
      const collector = new HuggingFaceCollector({
        fetchFn: async () => {
          return new Response(JSON.stringify({ error: 'Too many requests' }), {
            status: 429,
            statusText: 'Too Many Requests',
            headers: {
              'content-type': 'application/json',
              'retry-after': '300',
              'x-ratelimit-limit': '500',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': '1788289500',
            },
          });
        },
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
        },
        (err: unknown) => {
          assert(err instanceof HuggingFaceRateLimitError);
          assert.equal(err.status, 429);
          assert.equal(err.retryAfterHeader, '300');
          assert.equal(err.retryAfterSeconds, 300);
          assert.notEqual(err.resetAt, null);
          assert.equal(err.rateLimit?.remaining, 0);
          return true;
        },
      );
    });

    test('parses HTTP Date Retry-After header on HTTP 429', async () => {
      const resetTime = new Date(Date.now() + 45000).toUTCString();

      const collector = new HuggingFaceCollector({
        fetchFn: async () => {
          return new Response(JSON.stringify({ error: 'Rate limited' }), {
            status: 429,
            headers: {
              'retry-after': resetTime,
            },
          });
        },
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
        },
        (err: unknown) => {
          assert(err instanceof HuggingFaceRateLimitError);
          assert.equal(err.retryAfterHeader, resetTime);
          assert(typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds > 0);
          return true;
        },
      );
    });

    test('throws HuggingFaceHttpError on 500 server error and HuggingFaceItemNotFoundError on 404', async () => {
      const serverErrCollector = new HuggingFaceCollector({
        fetchFn: async () =>
          createJsonResponse(
            { error: 'Internal error' },
            { status: 500, statusText: 'Internal Error' },
          ),
      });

      await assert.rejects(
        async () => serverErrCollector.collect({ sourceKey: 'huggingface_hub', cursor: null }),
        (err: unknown) => {
          assert(err instanceof HuggingFaceHttpError);
          assert.equal(err.status, 500);
          return true;
        },
      );

      const notFoundCollector = new HuggingFaceCollector({
        targetModels: ['non-existent-org/non-existent-model'],
        fetchFn: async () =>
          createJsonResponse(
            { error: 'Model not found' },
            { status: 404, statusText: 'Not Found' },
          ),
      });

      await assert.rejects(
        async () => notFoundCollector.collect({ sourceKey: 'huggingface_hub', cursor: null }),
        (err: unknown) => {
          assert(err instanceof HuggingFaceItemNotFoundError);
          assert.equal(err.status, 404);
          assert.equal(err.itemId, 'non-existent-org/non-existent-model');
          return true;
        },
      );
    });
  });

  describe('Timestamp Mapping (createdAt / lastModified)', () => {
    test('maps publishedAt to createdAt, preserving lastModified in metadata', async () => {
      const collector = new HuggingFaceCollector({
        fetchFn: async () => createJsonResponse([SAMPLE_MODEL_FIXTURE]),
      });

      const result = await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
      const item = result.items[0]!;

      assert.equal(item.publishedAt?.toISOString(), '2026-07-18T10:00:00.000Z');
      assert.equal(item.metadata?.['createdAt'], '2026-07-18T10:00:00.000Z');
      assert.equal(item.metadata?.['lastModified'], '2026-08-20T14:30:00.000Z');
    });

    test('falls back to lastModified when createdAt is missing', async () => {
      const collector = new HuggingFaceCollector({
        fetchFn: async () => createJsonResponse([SAMPLE_MODEL_NO_CREATED_AT]),
      });

      const result = await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
      const item = result.items[0]!;

      assert.equal(item.publishedAt?.toISOString(), '2026-08-01T16:45:00.000Z');
      assert.equal(item.metadata?.['createdAt'], null);
      assert.equal(item.metadata?.['lastModified'], '2026-08-01T16:45:00.000Z');
    });
  });

  describe('Pagination, Cursors & CollectionResult Metrics', () => {
    test('emits opaque cursor with next page and offset when hasMore is true', async () => {
      const items = Array.from({ length: 2 }, (_, i) => ({
        id: `org/model-${i}`,
        sha: `sha-${i}`,
        downloads: 100 * (i + 1),
        likes: 10 * (i + 1),
        createdAt: '2026-01-01T00:00:00.000Z',
      }));

      const collector = new HuggingFaceCollector({
        defaultLimit: 2,
        fetchFn: async () =>
          createJsonResponse(items, {
            headers: {
              'x-ratelimit-remaining': '900',
              'x-ratelimit-limit': '1000',
            },
          }),
      });

      const result = await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });

      assert.equal(result.items.length, 2);
      assert.equal(result.hasMore, true);
      assert(result.nextCursor !== null);

      const decoded = decodeOpaqueCursor<{
        entityType: string;
        page: number;
        offset: number;
        rateLimit?: { limit: number; remaining: number };
      }>(result.nextCursor!);

      assert.equal(decoded.page, 2);
      assert.equal(decoded.offset, 2);
      assert.equal(decoded.rateLimit?.remaining, 900);

      // Verify CollectionResult metrics shape: itemsFetched, bytesFetched, durationMs
      assert.equal(result.metrics?.itemsFetched, 2);
      assert(typeof result.metrics?.bytesFetched === 'number' && result.metrics.bytesFetched > 0);
      assert(typeof result.metrics?.durationMs === 'number');
    });

    test('uses cursor offset in subsequent request', async () => {
      let requestedUrl = '';
      const inputCursor = encodeOpaqueCursor({
        entityType: 'models',
        page: 2,
        offset: 20,
      });

      const collector = new HuggingFaceCollector({
        fetchFn: async (url) => {
          requestedUrl = String(url);
          return createJsonResponse([]);
        },
      });

      const result = await collector.collect({
        sourceKey: 'huggingface_hub',
        cursor: inputCursor,
      });

      assert(requestedUrl.includes('offset=20'));
      assert.equal(result.items.length, 0);
      assert.equal(result.hasMore, false);
    });

    test('collects specific target models sequentially', async () => {
      const requestedUrls: string[] = [];
      const collector = new HuggingFaceCollector({
        targetModels: ['meta-llama/Llama-2-7b-hf', 'mistralai/Mistral-7B-v0.1'],
        fetchFn: async (url) => {
          requestedUrls.push(String(url));
          if (String(url).includes('meta-llama')) {
            return createJsonResponse(SAMPLE_MODEL_FIXTURE);
          }
          return createJsonResponse(SAMPLE_MODEL_NO_CREATED_AT);
        },
      });

      const result = await collector.collect({
        sourceKey: 'huggingface_hub',
        cursor: null,
        limit: 2,
      });

      assert.equal(result.items.length, 2);
      assert.equal(requestedUrls.length, 2);
      assert(requestedUrls[0]?.includes('/api/models/meta-llama%2FLlama-2-7b-hf'));
      assert(requestedUrls[1]?.includes('/api/models/mistralai%2FMistral-7B-v0.1'));
      assert.equal(result.metrics?.itemsFetched, 2);
    });
  });

  describe('Security & SSRF Guard Policy', () => {
    test('rejects SSRF attempts and forbidden hosts', async () => {
      const collector = new HuggingFaceCollector({
        baseUrl: 'https://169.254.169.254', // AWS metadata SSRF attempt
        fetchFn: async () => createJsonResponse([]),
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
        },
        (err: unknown) => {
          assert(err instanceof HuggingFaceCollectorError);
          assert(
            err.message.includes('rejected by policy guard') ||
              err.message.includes('Security violation'),
          );
          return true;
        },
      );
    });

    test('rejects unlisted external host', async () => {
      const collector = new HuggingFaceCollector({
        baseUrl: 'https://malicious-site.com',
        fetchFn: async () => createJsonResponse([]),
      });

      await assert.rejects(
        async () => {
          await collector.collect({ sourceKey: 'huggingface_hub', cursor: null });
        },
        (err: unknown) => {
          assert(err instanceof HuggingFaceCollectorError);
          assert(err.message.includes('rejected by policy guard'));
          return true;
        },
      );
    });
  });
});

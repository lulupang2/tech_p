export {
  COLLECTION_JOB_NAME,
  NORMALIZATION_JOB_NAME,
  DEDUPLICATION_JOB_NAME,
  MAX_JOB_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_MAX_MS,
  WORKER_JOB_SCHEMA_VERSION,
  collectionJobNaturalKey,
  createCollectionJobData,
  createNormalizationJobData,
  createDeduplicationJobData,
  normalizeScheduleWindow,
  parseCollectionJobData,
  parseNormalizationJobData,
  parseDeduplicationJobData,
  retryBackoffMs,
  WorkerJobValidationError,
  type CollectionJobData,
  type NormalizationJobData,
  type DeduplicationJobData,
  type ScheduleWindow,
} from './jobs.js';
export {
  InMemorySourceConcurrencyLimiter,
  LeaseOwnershipLostError,
  LeaseReleaseError,
  LeaseRenewalError,
  RedisSourceConcurrencyLimiter,
  leaseRenewalIntervalMs,
  type RedisSourceConcurrencyLimiterOptions,
  type SourceConcurrency,
  type SourceConcurrencyLimiter,
} from './concurrency.js';
export {
  createCollectionScheduler,
  createCollectionWorker,
  directDeliveryBoundary,
  enqueueCollectionJob,
  InMemoryIdempotentDeliveryBoundary,
  InMemoryJobClaimStore,
  type JobClaimStore,
  RedisJobClaimStore,
  processCollectionJob,
  type CollectionOperation,
  type CollectionScheduler,
  type CreateSchedulerOptions,
  type DeliveryBoundary,
  type DeliveryResult,
  type EnqueueOptions,
  type EnqueueResult,
} from './scheduler.js';
export { createIngestionJobHandler, type IngestionJobHandlerOptions } from './ingestion.js';
export {
  createNormalizationJobHandler,
  type NormalizationJobHandlerOptions,
  type NormalizationExecutionResult,
  type NormalizationOperation,
} from './normalization.js';
export {
  createDeduplicationJobHandler,
  type DeduplicationJobHandlerOptions,
  type DeduplicationExecutionResult,
  type DeduplicationOperation,
} from './deduplication.js';
export {
  RedditCollector,
  createRedditCollector,
  REDDIT_COLLECTION_SCHEDULE,
  createRedditScheduleWindow,
  enqueueRedditScheduleJob,
  type EnqueueRedditJobOptions,
  type EnqueueRedditJobResult,
  type RedditCollectorOptions,
  type RedditCollectorConfig,
} from './collectors/reddit.js';
import {
  createChunkRepository,
  createCollectionRunRepository,
  createDatabaseClient,
  createDocumentRepository,
  createMetricObservationRepository,
  createPipelineEventRepository,
  createRawItemRepository,
  createSourceRepository,
  createTopicRepository,
  embeddings,
  documentRevisions,
} from '@techpulse/database';
import {
  ArticleCollector,
  ArxivCollector,
  ChromeOriginTrialsCollector,
  DiscourseCollector,
  GitHubReleasesCollector,
  GitHubSearchCollector,
  HuggingFaceCollector,
  NpmDownloadsCollector,
  NpmRegistryCollector,
  RedditCollector,
  StackExchangeCollector,
  type PlaywrightBrowser,
} from '@techpulse/collectors';
import type { CollectorPort, SourceKey } from '@techpulse/domain';
import {
  createEnrichmentService,
  createNormalizationService,
  createOpenAiCompatibleEmbeddingPort,
  createRawIngestionService,
} from '@techpulse/domain';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { createCollectionWorker } from './scheduler.js';
import { createIngestionJobHandler } from './ingestion.js';
import { createNormalizationJobHandler } from './normalization.js';
import { createNormalizationJobData, parseNormalizationJobData } from './jobs.js';
import { loadWorkerConfig, type Environment, type WorkerConfig } from './config.js';
import {
  createStructuredLogger,
  isValidCorrelationId,
  normalizeCorrelationContext,
  type CorrelationContext,
  type StructuredEvent,
} from '@techpulse/observability';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

/** Node-only Playwright factory; the collector owns browser lifecycle. */
export function createWorkerChromiumFactory(): () => Promise<PlaywrightBrowser> {
  return async () =>
    (await chromium.launch({
      headless: true,
    })) as unknown as PlaywrightBrowser;
}

export interface CreateCollectorOptions {
  readonly browserFactory?: () => Promise<PlaywrightBrowser>;
  readonly robotsFetcher?: (url: string) => Promise<string>;
}

/**
 * Dynamic collector factory resolving any supported sourceKey with scheduleConfig.
 * Supports multi-target bounded collection for Bun, Node.js, Playwright, TypeScript, React.
 */
export function createCollectorForSource(
  sourceKey: SourceKey,
  scheduleConfig?: Record<string, unknown>,
  options?: CreateCollectorOptions,
): CollectorPort | undefined {
  const browserFactory = options?.browserFactory ?? createWorkerChromiumFactory();

  switch (sourceKey) {
    case 'github_releases': {
      const repos = Array.isArray(scheduleConfig?.['repositories'])
        ? (scheduleConfig!['repositories'] as Array<{ owner: string; repo: string }>)
        : undefined;
      const owner =
        typeof scheduleConfig?.['owner'] === 'string' ? scheduleConfig['owner'] : 'microsoft';
      const repo =
        typeof scheduleConfig?.['repo'] === 'string' ? scheduleConfig['repo'] : 'playwright';
      return new GitHubReleasesCollector({
        owner,
        repo,
        ...(repos ? { repositories: repos } : {}),
      });
    }
    case 'github_search': {
      const queries = Array.isArray(scheduleConfig?.['queries'])
        ? (scheduleConfig!['queries'] as string[])
        : undefined;
      const query =
        typeof scheduleConfig?.['query'] === 'string'
          ? scheduleConfig['query']
          : 'topic:typescript stars:>500';
      return new GitHubSearchCollector({
        query,
        ...(queries ? { queries } : {}),
      });
    }
    case 'stack_exchange': {
      const tags = Array.isArray(scheduleConfig?.['tags'])
        ? (scheduleConfig!['tags'] as string[])
        : undefined;
      const tag =
        typeof scheduleConfig?.['tag'] === 'string' ? scheduleConfig['tag'] : 'typescript';
      const site =
        typeof scheduleConfig?.['site'] === 'string' ? scheduleConfig['site'] : 'stackoverflow';
      return new StackExchangeCollector({
        defaultSite: site,
        defaultTag: tag,
        ...(tags ? { defaultTags: tags } : {}),
      });
    }
    case 'npm_registry': {
      const packages = Array.isArray(scheduleConfig?.['packages'])
        ? (scheduleConfig!['packages'] as string[])
        : undefined;
      return new NpmRegistryCollector({
        ...(packages ? { defaultPackages: packages } : {}),
      });
    }
    case 'npm_downloads': {
      const packages = Array.isArray(scheduleConfig?.['packages'])
        ? (scheduleConfig!['packages'] as string[])
        : undefined;
      return new NpmDownloadsCollector({
        ...(packages ? { defaultPackages: packages } : {}),
      });
    }
    case 'react_blog': {
      return new ArticleCollector('react_blog');
    }
    case 'chrome_release_notes': {
      return new ArticleCollector('chrome_release_notes');
    }
    case 'arxiv': {
      const categories = Array.isArray(scheduleConfig?.['categories'])
        ? (scheduleConfig!['categories'] as string[])
        : undefined;
      return new ArxivCollector({
        ...(categories ? { defaultCategories: categories } : {}),
      });
    }
    case 'users_rust_lang': {
      return new DiscourseCollector();
    }
    case 'huggingface_hub': {
      return new HuggingFaceCollector();
    }
    case 'chrome_origin_trials': {
      return new ChromeOriginTrialsCollector({
        browserFactory,
      });
    }
    case 'reddit': {
      const subreddit =
        typeof scheduleConfig?.['subreddit'] === 'string'
          ? scheduleConfig['subreddit']
          : 'typescript';
      const robotsFetcher =
        options?.robotsFetcher ??
        (async (url: string) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`robots.txt request failed: ${response.status}`);
          return response.text();
        });
      return new RedditCollector({
        browserFactory,
        robotsFetcher,
        config: { subreddit },
      });
    }
    default:
      return undefined;
  }
}

export const workerLogger = createStructuredLogger({ service: 'worker' });

function firstValidCorrelationAlias(
  candidate: Record<string, unknown>,
  aliases: readonly string[],
): string | undefined {
  for (const alias of aliases) {
    const value = candidate[alias];
    if (isValidCorrelationId(value)) return value;
  }
  return undefined;
}

/** Worker boundary IDs are read without coupling this skeleton to a job package. */
export function jobCorrelationContext(job: unknown): CorrelationContext {
  if (typeof job !== 'object' || job === null || Array.isArray(job)) return {};
  const candidate = job as Record<string, unknown>;
  return normalizeCorrelationContext({
    requestId: candidate['requestId'],
    runId: firstValidCorrelationAlias(candidate, ['runId', 'queryRunId', 'collectionRunId']),
    jobId: candidate['jobId'],
    sourceId: candidate['sourceId'],
    queryId: candidate['queryId'],
  });
}

export function logJobStarted(job: unknown): StructuredEvent {
  return workerLogger.withContext(jobCorrelationContext(job)).info('worker.job.started');
}

export function logJobFinished(job: unknown): StructuredEvent {
  return workerLogger.withContext(jobCorrelationContext(job)).info('worker.job.finished');
}

/**
 * Worker process entrypoint. Job registration starts after QUE-001.
 */
export const workerEntrypoint = '@techpulse/worker';
export function start(env: Environment = process.env): WorkerConfig {
  const config = loadWorkerConfig(env);
  workerLogger.info('worker.starting');
  return config;
}

async function runWorkerProcess(env: Environment = process.env): Promise<void> {
  const config = start(env);
  const databaseClient = createDatabaseClient(config.databaseUrl);
  const sourceRepository = createSourceRepository(databaseClient.db);
  const collectionRunRepository = createCollectionRunRepository(databaseClient.db);
  const rawItemRepository = createRawItemRepository(databaseClient.db);
  const documentRepository = createDocumentRepository(databaseClient.db);
  const metricObservationRepository = createMetricObservationRepository(databaseClient.db);
  const pipelineEventRepository = createPipelineEventRepository(databaseClient.db);
  const topicRepository = createTopicRepository(databaseClient.db);
  const chunkRepository = createChunkRepository(databaseClient.db);
  const enrichmentService = createEnrichmentService({ topicRepository, chunkRepository });
  const normalizationService = createNormalizationService();
  const embeddingPort =
    env['EMBEDDING_API_KEY'] && env['EMBEDDING_API_KEY'].trim().length > 0
      ? createOpenAiCompatibleEmbeddingPort({
          apiKey: env['EMBEDDING_API_KEY'],
          ...(env['EMBEDDING_BASE_URL'] ? { baseUrl: env['EMBEDDING_BASE_URL'] } : {}),
          ...(env['EMBEDDING_MODEL'] ? { model: env['EMBEDDING_MODEL'] } : {}),
          ...(env['EMBEDDING_DIMENSIONS']
            ? { dimensions: Number(env['EMBEDDING_DIMENSIONS']) }
            : {}),
        })
      : undefined;
  const embedRevision = embeddingPort
    ? async (revisionId: string): Promise<void> => {
        const chunks = await chunkRepository.listByRevision(revisionId);
        for (const chunk of chunks) {
          const inputHash = createHash('sha256').update(chunk.content, 'utf8').digest('hex');
          const result = await embeddingPort.embed({ input: chunk.content, timeoutMs: 15_000 });
          await databaseClient.db
            .insert(embeddings)
            .values({
              chunkId: chunk.id,
              provider: 'openrouter',
              model: result.metadata.model,
              dimensions: result.metadata.dimensions,
              embedding: [...result.vector],
              inputHash,
            })
            .onConflictDoNothing();
        }
        await databaseClient.db
          .update(documentRevisions)
          .set({ status: 'searchable', searchableAt: new Date() })
          .where(eq(documentRevisions.id, revisionId));
      }
    : undefined;
  // Multi-target collector resolver for expanded public corpus
  const collectorResolver = (
    sourceKey: SourceKey,
    source?: { scheduleConfig?: Record<string, unknown> },
  ): CollectorPort | undefined => createCollectorForSource(sourceKey, source?.scheduleConfig);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const normalizationQueue = new Queue('techpulse-normalization', { connection: redis });
  const normalizationHandler = createNormalizationJobHandler({
    normalizationService,
    rawItemRepository,
    documentRepository,
    metricObservationRepository,
    pipelineEventRepository,
    sourceRepository,
    enrichmentService,
    ...(embedRevision ? { embedRevision } : {}),
  });
  const normalizationWorker = new Worker(
    'techpulse-normalization',
    async (job: Job<unknown>) => normalizationHandler(parseNormalizationJobData(job.data)),
    { connection: redis, concurrency: config.concurrency },
  );
  const ingestionService = createRawIngestionService({
    sourceRepository,
    collectionRunRepository,
    rawItemRepository,
    collectorResolver,
    stageJobPublisher: {
      publishStageJob: async (payload) => {
        const data = createNormalizationJobData({
          rawItemId: payload.rawItemId,
          sourceKey: payload.sourceKey,
          runId: payload.runId,
          externalId: payload.externalId,
          payloadHash: payload.payloadHash,
        });
        await normalizationQueue.add('normalization', data, {
          jobId: `normalization|${payload.rawItemId}`,
          removeOnComplete: true,
        });
      },
    },
    logger: workerLogger,
  });
  const worker = createCollectionWorker({
    connection: redis,
    concurrency: config.concurrency,
    handle: createIngestionJobHandler(ingestionService),
  });
  const shutdown = async () => {
    await worker.close();
    await normalizationWorker.close();
    await normalizationQueue.close();
    await redis.quit();
    await databaseClient.close();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  await new Promise<void>(() => undefined);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runWorkerProcess();
}

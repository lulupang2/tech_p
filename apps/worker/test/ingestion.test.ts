import { describe, expect, test } from 'vitest';
import type { CollectionJobPayload } from '@techpulse/contracts';
import type {
  RawIngestionRequest,
  RawIngestionResult,
  RawIngestionServicePort,
} from '@techpulse/domain';
import { createIngestionJobHandler } from '../src/index.js';

describe('worker raw ingestion job handler integration', () => {
  const samplePayload: CollectionJobPayload = {
    schemaVersion: 1,
    collectionRunId: 'run-worker-001',
    sourceKey: 'github_releases',
    cursor: 'cursor-prev',
  };

  test('successfully handles collection job when ingestion service succeeds', async () => {
    let executedRequest: RawIngestionRequest | undefined;

    const fakeIngestionService: RawIngestionServicePort = {
      async executeIngestion(request: RawIngestionRequest): Promise<RawIngestionResult> {
        executedRequest = request;
        return {
          runId: request.collectionRunId,
          sourceKey: request.sourceKey,
          status: 'succeeded',
          counts: {
            itemsFetched: 5,
            itemsPersisted: 5,
            duplicatesSkipped: 0,
            stageJobsPublished: 5,
            bytesFetched: 1024,
          },
          nextCursor: 'cursor-next',
          errorSummary: null,
        };
      },
    };

    const handler = createIngestionJobHandler(fakeIngestionService);
    await expect(handler(samplePayload)).resolves.toBeUndefined();

    expect(executedRequest).toEqual({
      collectionRunId: 'run-worker-001',
      sourceKey: 'github_releases',
      cursor: 'cursor-prev',
    });
  });

  test('re-throws transient failure to trigger scheduler retry/backoff', async () => {
    const fakeIngestionService: RawIngestionServicePort = {
      async executeIngestion(request: RawIngestionRequest): Promise<RawIngestionResult> {
        return {
          runId: request.collectionRunId,
          sourceKey: request.sourceKey,
          status: 'failed',
          counts: {
            itemsFetched: 0,
            itemsPersisted: 0,
            duplicatesSkipped: 0,
            stageJobsPublished: 0,
            bytesFetched: 0,
          },
          nextCursor: null,
          errorSummary: 'HTTP 429 Too Many Requests',
          isTransientError: true,
        };
      },
    };

    const handler = createIngestionJobHandler(fakeIngestionService);
    await expect(handler(samplePayload)).rejects.toThrow(/transiently: HTTP 429/);
  });

  test('quarantines permanent policy failure without endless retry loop', async () => {
    let permanentFailureReported: string | null | undefined;

    const fakeIngestionService: RawIngestionServicePort = {
      async executeIngestion(request: RawIngestionRequest): Promise<RawIngestionResult> {
        return {
          runId: request.collectionRunId,
          sourceKey: request.sourceKey,
          status: 'failed',
          counts: {
            itemsFetched: 0,
            itemsPersisted: 0,
            duplicatesSkipped: 0,
            stageJobsPublished: 0,
            bytesFetched: 0,
          },
          nextCursor: null,
          errorSummary: 'Policy violation: SSRF target denied',
          isTransientError: false,
        };
      },
    };

    const handler = createIngestionJobHandler({
      service: fakeIngestionService,
      onPermanentFailure: (errorSummary) => {
        permanentFailureReported = errorSummary;
      },
    });

    // Should NOT throw retryable error, instead completes and reports permanent failure
    await expect(handler(samplePayload)).resolves.toBeUndefined();
    expect(permanentFailureReported).toBe('Policy violation: SSRF target denied');
  });
});

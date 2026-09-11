import type {
  CollectionStatePort,
  DocumentRepositoryPort,
  EnrichmentServicePort,
  MetricObservationRepositoryPort,
  NormalizationResult,
  NormalizationServicePort,
  PipelineEventRepositoryPort,
  RawItemRepositoryPort,
  SourceKey,
  SourceRecord,
  SourceRepositoryPort,
  SearchReadinessPort,
} from '@techpulse/domain';
import { validateMetricObservation } from '@techpulse/domain';
import type { DeduplicationOperation } from './deduplication.js';

export interface NormalizationJobHandlerOptions {
  readonly normalizationService: NormalizationServicePort;
  readonly rawItemRepository: RawItemRepositoryPort;
  readonly documentRepository: DocumentRepositoryPort;
  readonly metricObservationRepository: MetricObservationRepositoryPort;
  readonly pipelineEventRepository: PipelineEventRepositoryPort;
  readonly sourceRepository?: SourceRepositoryPort | undefined;
  readonly collectionStateRepository?: CollectionStatePort | undefined;
  readonly readinessRepository?: SearchReadinessPort | undefined;
  readonly deduplicate?: DeduplicationOperation | undefined;
  /** Optional PIPE-005 stage; absent keeps normalization fakes/backward compatibility intact. */
  readonly enrichmentService?: EnrichmentServicePort | undefined;
  /** Optional embedding hook executed after chunks are persisted. */
  readonly embedRevision?: ((revisionId: string) => Promise<void>) | undefined;
}
export interface NormalizationExecutionResult {
  readonly rawItemId: string;
  readonly sourceKey: string;
  readonly documentsSaved: number;
  readonly metricsSaved: number;
  readonly status: 'succeeded' | 'failed' | 'quarantined';
  readonly errorSummary?: string | null;
}

export interface NormalizationDeliveryRequest {
  readonly deliveryId?: string | undefined;
  readonly rawItemId: string;
  readonly sourceKey?: SourceKey | undefined;
}

export type NormalizationDeliveryOperation = (
  request: NormalizationDeliveryRequest,
) => Promise<NormalizationExecutionResult>;

/**
 * Creates the worker execution handler for normalization jobs.
 * Integrates NormalizationService with RawItemRepository, DocumentRepository,
 * MetricObservationRepository, and PipelineEventRepository.
 */
export function createNormalizationDeliveryHandler(
  options: NormalizationJobHandlerOptions,
): NormalizationDeliveryOperation {
  const {
    normalizationService,
    rawItemRepository,
    documentRepository,
    metricObservationRepository,
    pipelineEventRepository,
    sourceRepository,
    collectionStateRepository,
    readinessRepository,
    deduplicate,
    enrichmentService,
    embedRevision,
  } = options;

  return async (request: NormalizationDeliveryRequest): Promise<NormalizationExecutionResult> => {
    const { rawItemId, deliveryId } = request;
    let sourceKey: SourceKey = request.sourceKey ?? ('github_releases' as SourceKey);
    const processorVersion = normalizationService.normalizerVersion;
    const now = new Date();

    // 1. Record started pipeline event
    await pipelineEventRepository.create({
      rawItemId,
      stage: 'normalization',
      processorVersion,
      status: 'started',
      attempt: 1,
    });

    try {
      // 2. Fetch raw item
      const rawItem = await rawItemRepository.findById(rawItemId);
      if (!rawItem) {
        const errorMsg = `Raw item '${rawItemId}' not found for normalization`;
        await pipelineEventRepository.create({
          rawItemId,
          stage: 'normalization',
          processorVersion,
          status: 'quarantined',
          errorCode: 'RAW_ITEM_NOT_FOUND',
        });
        return {
          rawItemId,
          sourceKey,
          documentsSaved: 0,
          metricsSaved: 0,
          status: 'quarantined',
          errorSummary: errorMsg,
        };
      }

      // 3. Source resolution for sourceId / sourceKey
      let sourceId = rawItem.sourceId;
      if (sourceRepository) {
        if (request.sourceKey) {
          const source = await sourceRepository.findByKey(request.sourceKey);
          if (source) sourceId = source.id;
        } else if (sourceId) {
          const allSources = await sourceRepository.listEnabled();
          const matched = allSources.find((s: SourceRecord) => s.id === sourceId);
          if (matched) sourceKey = matched.key as SourceKey;
        }
      }
      // 4. Run deterministic normalization
      const normResult: NormalizationResult = normalizationService.normalize(rawItem, sourceKey);

      // 5. Persist normalized documents
      let documentsSaved = 0;
      for (const doc of normResult.documents) {
        const savedDocument = await documentRepository.saveNormalizedDocument({
          artifactType: doc.artifactType,
          canonicalUrl: doc.canonicalUrl,
          title: doc.title,
          bodyText: doc.bodyText,
          author: doc.author,
          language: doc.language,
          publishedAt: doc.publishedAt,
          licenseId: doc.licenseId,
          normalizedHash: doc.normalizedHash,
          normalizerVersion: doc.normalizerVersion,
          rawItemId: doc.rawItemId ?? rawItemId,
          status: doc.status,
        });
        if (deduplicate) {
          const result = await deduplicate({
            documentId: savedDocument.document.id,
            revisionId: savedDocument.revision.id,
            rawItemId,
            sourceKey,
            externalId: rawItem.externalId,
          });
          if (result.status !== 'succeeded') throw new Error('Deduplication failed');
        }

        if (enrichmentService) {
          await enrichmentService.enrich({
            documentId: savedDocument.document.id,
            revisionId: savedDocument.revision.id,
            title: doc.title,
            bodyText: doc.bodyText,
            sourceKey,
          });
        }
        if (readinessRepository) {
          await readinessRepository.markLexicalReady(savedDocument.revision.id, now);
        }
        if (collectionStateRepository) {
          await collectionStateRepository.attachRevision(rawItemId, savedDocument.revision.id, now);
        }
        if (embedRevision) {
          await embedRevision(savedDocument.revision.id);
        }
        documentsSaved++;
      }

      // 6. Persist metric observations
      let metricsSaved = 0;
      for (const metric of normResult.metrics) {
        if (sourceId) {
          validateMetricObservation(metric);
          await metricObservationRepository.upsert({
            sourceId,
            subjectKey: metric.subjectKey,
            metricType: metric.metricType,
            windowStart: metric.windowStart,
            windowEnd: metric.windowEnd,
            value: metric.value,
            unit: metric.unit,
            rawItemId: metric.rawItemId ?? rawItemId,
            querySignature: metric.querySignature,
            isIncomplete: metric.isIncomplete,
          });
          metricsSaved++;
        }
      }

      // 7. Complete delivery outbox if deliveryId is provided
      if (deliveryId && collectionStateRepository) {
        await collectionStateRepository.completeDelivery(deliveryId, now);
      }

      // 8. Record succeeded pipeline event
      await pipelineEventRepository.create({
        rawItemId,
        stage: 'normalization',
        processorVersion,
        status: 'succeeded',
        attempt: 1,
      });

      return {
        rawItemId,
        sourceKey,
        documentsSaved,
        metricsSaved,
        status: 'succeeded',
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await pipelineEventRepository.create({
        rawItemId,
        stage: 'normalization',
        processorVersion,
        status: 'failed',
        errorCode: 'NORMALIZATION_FAILED',
      });

      return {
        rawItemId,
        sourceKey,
        documentsSaved: 0,
        metricsSaved: 0,
        status: 'failed',
        errorSummary: errorMessage,
      };
    }
  };
}

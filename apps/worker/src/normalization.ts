import type {
  DocumentRepositoryPort,
  EnrichmentServicePort,
  MetricObservationRepositoryPort,
  NormalizationResult,
  NormalizationServicePort,
  PipelineEventRepositoryPort,
  RawItemRepositoryPort,
  SourceRepositoryPort,
} from '@techpulse/domain';
import type { NormalizationJobData } from './jobs.js';

export interface NormalizationJobHandlerOptions {
  readonly normalizationService: NormalizationServicePort;
  readonly rawItemRepository: RawItemRepositoryPort;
  readonly documentRepository: DocumentRepositoryPort;
  readonly metricObservationRepository: MetricObservationRepositoryPort;
  readonly pipelineEventRepository: PipelineEventRepositoryPort;
  readonly sourceRepository?: SourceRepositoryPort;
  /** Optional PIPE-005 stage; absent keeps normalization fakes/backward compatibility intact. */
  readonly enrichmentService?: EnrichmentServicePort;
}

export interface NormalizationExecutionResult {
  readonly rawItemId: string;
  readonly sourceKey: string;
  readonly documentsSaved: number;
  readonly metricsSaved: number;
  readonly status: 'succeeded' | 'failed' | 'quarantined';
  readonly errorSummary?: string | null;
}

export type NormalizationOperation = (
  jobData: NormalizationJobData,
) => Promise<NormalizationExecutionResult>;

/**
 * Creates the worker execution handler for normalization jobs.
 * Integrates NormalizationService with RawItemRepository, DocumentRepository,
 * MetricObservationRepository, and PipelineEventRepository.
 */
export function createNormalizationJobHandler(
  options: NormalizationJobHandlerOptions,
): NormalizationOperation {
  const {
    normalizationService,
    rawItemRepository,
    documentRepository,
    metricObservationRepository,
    pipelineEventRepository,
    sourceRepository,
    enrichmentService,
  } = options;

  return async (jobData: NormalizationJobData): Promise<NormalizationExecutionResult> => {
    const { rawItemId, sourceKey } = jobData;
    const processorVersion = normalizationService.normalizerVersion;

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

      // 3. Optional source resolution for sourceId
      let sourceId = rawItem.sourceId;
      if (!sourceId && sourceRepository) {
        const source = await sourceRepository.findByKey(sourceKey);
        if (source) {
          sourceId = source.id;
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
        if (enrichmentService) {
          await enrichmentService.enrich({
            documentId: savedDocument.document.id,
            revisionId: savedDocument.revision.id,
            title: doc.title,
            bodyText: doc.bodyText,
            sourceKey,
          });
        }
        documentsSaved++;
      }

      // 6. Persist metric observations
      let metricsSaved = 0;
      for (const metric of normResult.metrics) {
        if (sourceId) {
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

      // 7. Record succeeded pipeline event
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

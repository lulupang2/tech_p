import {
  DEDUPLICATION_STAGE,
  type DeduplicationMatchReason,
  type DeduplicationResult,
  type DeduplicationServicePort,
  type DeduplicationTargetDoc,
  type DocumentRepositoryPort,
  type DocumentRevisionRecord,
  type DuplicateClusterRepositoryPort,
  type ExistingDedupDocument,
  type PipelineEventRepositoryPort,
  type RawItemRecord,
  type RawItemRepositoryPort,
} from '@techpulse/domain';
import type { DeduplicationJobData } from './jobs.js';

export interface DeduplicationJobHandlerOptions {
  readonly deduplicationService: DeduplicationServicePort;
  readonly documentRepository: DocumentRepositoryPort;
  readonly duplicateClusterRepository: DuplicateClusterRepositoryPort;
  readonly rawItemRepository?: RawItemRepositoryPort;
  readonly pipelineEventRepository?: PipelineEventRepositoryPort;
}

export interface DeduplicationExecutionResult {
  readonly documentId: string;
  readonly isExactDuplicate: boolean;
  readonly matchReason?: DeduplicationMatchReason | null;
  readonly clusterId?: string | null;
  readonly representativeDocumentId?: string | null;
  readonly nearDuplicateCandidatesCount: number;
  readonly status: 'succeeded' | 'failed' | 'quarantined';
  readonly errorSummary?: string | null;
}

export type DeduplicationOperation = (
  jobData: DeduplicationJobData,
) => Promise<DeduplicationExecutionResult>;

/**
 * Creates the worker execution handler for deduplication jobs.
 * Identifies exact duplicates using 3-stage priority:
 *   1. Natural key identity (source, external_id, revision)
 *   2. Normalized canonical URL match
 *   3. Normalized body exact hash match
 *
 * For exact duplicates:
 *   - Links documents via duplicate_cluster without merging or deleting originals
 *   - Preserves all provenance, raw items, and URLs
 *
 * For near-duplicates:
 *   - Generates candidate suggestions only (EXP-004 threshold pending)
 */
export function createDeduplicationJobHandler(
  options: DeduplicationJobHandlerOptions,
): DeduplicationOperation {
  const {
    deduplicationService,
    documentRepository,
    duplicateClusterRepository,
    rawItemRepository,
    pipelineEventRepository,
  } = options;

  return async (jobData: DeduplicationJobData): Promise<DeduplicationExecutionResult> => {
    try {
      const doc = await documentRepository.findById(jobData.documentId);
      if (!doc) {
        throw new Error(`Target document not found: ${jobData.documentId}`);
      }

      const revisionId = jobData.revisionId ?? doc.currentRevisionId;
      if (!revisionId) {
        throw new Error(`Document ${jobData.documentId} has no current revision`);
      }

      const revision = await documentRepository.findRevisionById(revisionId);
      if (!revision) {
        throw new Error(`Revision ${revisionId} not found for document ${jobData.documentId}`);
      }

      let rawItem: RawItemRecord | null = null;
      const rawItemId = jobData.rawItemId ?? revision.rawItemId;
      if (rawItemId && rawItemRepository) {
        rawItem = await rawItemRepository.findById(rawItemId);
      }

      const target: DeduplicationTargetDoc = {
        documentId: doc.id,
        revisionId: revision.id,
        rawItemId: rawItemId ?? null,
        sourceKey: jobData.sourceKey ?? null,
        externalId: jobData.externalId ?? rawItem?.externalId ?? null,
        canonicalUrl: doc.canonicalUrl,
        title: revision.title,
        bodyText: revision.bodyText,
        normalizedHash: revision.normalizedHash,
        publishedAt: revision.publishedAt,
        duplicateClusterId: doc.duplicateClusterId,
        createdAt: doc.createdAt,
      };

      // Gather existing documents for comparison
      const existingDocs: ExistingDedupDocument[] = [];

      if (documentRepository.listAllDocuments && documentRepository.listAllRevisions) {
        const allDocs = await documentRepository.listAllDocuments();
        const allRevs = await documentRepository.listAllRevisions();

        const revMap = new Map<string, DocumentRevisionRecord>();
        for (const r of allRevs) {
          revMap.set(r.id, r);
        }

        for (const d of allDocs) {
          if (d.id === target.documentId) continue;

          let rev: DocumentRevisionRecord | null | undefined = null;
          if (d.currentRevisionId) {
            rev = revMap.get(d.currentRevisionId);
          }
          if (!rev) {
            rev = allRevs.find((r) => r.documentId === d.id);
          }

          if (rev) {
            existingDocs.push({
              documentId: d.id,
              revisionId: rev.id,
              rawItemId: rev.rawItemId,
              canonicalUrl: d.canonicalUrl,
              title: rev.title,
              bodyText: rev.bodyText,
              normalizedHash: rev.normalizedHash,
              duplicateClusterId: d.duplicateClusterId,
              createdAt: d.createdAt,
            });
          }
        }
      } else {
        const docList = await documentRepository.listDocuments({}, { limit: 100 });
        for (const d of docList.items) {
          if (d.id === target.documentId) continue;
          if (d.currentRevisionId) {
            const rev = await documentRepository.findRevisionById(d.currentRevisionId);
            if (rev) {
              existingDocs.push({
                documentId: d.id,
                revisionId: rev.id,
                rawItemId: rev.rawItemId,
                canonicalUrl: d.canonicalUrl,
                title: rev.title,
                bodyText: rev.bodyText,
                normalizedHash: rev.normalizedHash,
                duplicateClusterId: d.duplicateClusterId,
                createdAt: d.createdAt,
              });
            }
          }
        }
      }

      // Execute deterministic deduplication logic
      const result: DeduplicationResult = deduplicationService.deduplicate(target, existingDocs);

      let finalClusterId = doc.duplicateClusterId;

      if (result.isExactDuplicate) {
        if (result.clusterAction === 'create_cluster') {
          const newCluster = await duplicateClusterRepository.create({
            representativeDocumentId: result.representativeDocumentId,
            algorithmVersion: deduplicationService.deduplicationVersion,
            confidence: 100,
          });

          finalClusterId = newCluster.id;

          // Link both the representative document and the target document to the new cluster
          if (result.representativeDocumentId) {
            await documentRepository.assignDuplicateCluster(
              result.representativeDocumentId,
              newCluster.id,
            );
          }
          await documentRepository.assignDuplicateCluster(target.documentId, newCluster.id);
        } else if (result.clusterAction === 'join_cluster' && result.targetClusterId) {
          finalClusterId = result.targetClusterId;
          await documentRepository.assignDuplicateCluster(
            target.documentId,
            result.targetClusterId,
          );
        }
      }

      // Record pipeline event if rawItemId and repository are available
      if (rawItemId && pipelineEventRepository) {
        await pipelineEventRepository.create({
          rawItemId,
          stage: DEDUPLICATION_STAGE,
          processorVersion: deduplicationService.deduplicationVersion,
          status: 'succeeded',
        });
      }

      return {
        documentId: target.documentId,
        isExactDuplicate: result.isExactDuplicate,
        matchReason: result.exactMatch?.matchReason ?? null,
        clusterId: finalClusterId,
        representativeDocumentId: result.representativeDocumentId,
        nearDuplicateCandidatesCount: result.nearDuplicateCandidates.length,
        status: 'succeeded',
      };
    } catch (err) {
      const rawItemId = jobData.rawItemId ?? null;
      if (rawItemId && pipelineEventRepository) {
        await pipelineEventRepository.create({
          rawItemId,
          stage: DEDUPLICATION_STAGE,
          processorVersion: deduplicationService.deduplicationVersion,
          status: 'failed',
          errorCode: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        documentId: jobData.documentId,
        isExactDuplicate: false,
        matchReason: null,
        clusterId: null,
        representativeDocumentId: null,
        nearDuplicateCandidatesCount: 0,
        status: 'failed',
        errorSummary: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

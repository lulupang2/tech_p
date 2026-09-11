import {
  DEDUPLICATION_STAGE,
  type DeduplicationMatchReason,
  type DeduplicationResult,
  type DeduplicationServicePort,
  type DeduplicationTargetDoc,
  type NearDuplicateCandidate,
  type DocumentRepositoryPort,
  type DocumentRevisionRecord,
  type DuplicateClusterRepositoryPort,
  type ExistingDedupDocument,
  type PipelineEventRepositoryPort,
  type RawItemRecord,
  type RawItemRepositoryPort,
} from '@techpulse/domain';
export interface DeduplicationRequest {
  readonly documentId: string;
  readonly revisionId?: string;
  readonly rawItemId?: string;
  readonly sourceKey?: string;
  readonly externalId?: string;
}

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
  readonly nearDuplicateCandidates: readonly NearDuplicateCandidate[];
  readonly deduplicationVersion: string;
  readonly nearDuplicateThreshold: number;
  readonly boilerplateRuleVersion: string;
  readonly confidence: number | null;
  readonly manualReviewRequired: boolean;
  readonly manualReviewReasons: readonly string[];
  readonly status: 'succeeded' | 'failed' | 'quarantined';
  readonly errorSummary?: string | null;
}

export type DeduplicationOperation = (
  jobData: DeduplicationRequest,
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
 *   - Generates EXP-004 candidate suggestions only; it never auto-merges them
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

  return async (jobData: DeduplicationRequest): Promise<DeduplicationExecutionResult> => {
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
      const isVerbatimOnly = (item: RawItemRecord | null): boolean =>
        item?.rightsMetadata['verbatim_only'] === true;

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
        licenseId: revision.licenseId,
        verbatimOnly: isVerbatimOnly(rawItem),
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
            const existingRawItem =
              rawItemRepository && rev.rawItemId
                ? await rawItemRepository.findById(rev.rawItemId)
                : null;
            existingDocs.push({
              documentId: d.id,
              revisionId: rev.id,
              rawItemId: rev.rawItemId,
              canonicalUrl: d.canonicalUrl,
              title: rev.title,
              bodyText: rev.bodyText,
              normalizedHash: rev.normalizedHash,
              duplicateClusterId: d.duplicateClusterId,
              licenseId: rev.licenseId,
              verbatimOnly: isVerbatimOnly(existingRawItem),
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
              const existingRawItem =
                rawItemRepository && rev.rawItemId
                  ? await rawItemRepository.findById(rev.rawItemId)
                  : null;
              existingDocs.push({
                documentId: d.id,
                revisionId: rev.id,
                rawItemId: rev.rawItemId,
                canonicalUrl: d.canonicalUrl,
                title: rev.title,
                bodyText: rev.bodyText,
                normalizedHash: rev.normalizedHash,
                duplicateClusterId: d.duplicateClusterId,
                licenseId: rev.licenseId,
                verbatimOnly: isVerbatimOnly(existingRawItem),
                createdAt: d.createdAt,
              });
            }
          }
        }
      }

      // Execute deterministic deduplication logic
      const result: DeduplicationResult = deduplicationService.deduplicate(target, existingDocs);

      let finalClusterId = doc.duplicateClusterId;

      const recordMembership = async (
        clusterId: string,
        documentId: string,
        memberRevisionId: string,
        memberRawItemId: string | null,
        confidence: number,
      ): Promise<void> => {
        if (!duplicateClusterRepository.createMembership) return;
        await duplicateClusterRepository.createMembership({
          clusterId,
          documentId,
          revisionId: memberRevisionId,
          rawItemId: memberRawItemId,
          algorithmVersion: result.deduplicationVersion,
          confidence,
          status: 'accepted',
        });
      };

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
            const representative = existingDocs.find(
              (candidate) => candidate.documentId === result.representativeDocumentId,
            );
            if (representative?.revisionId) {
              await recordMembership(
                newCluster.id,
                representative.documentId,
                representative.revisionId,
                representative.rawItemId ?? null,
                100,
              );
            }
          }
          await documentRepository.assignDuplicateCluster(target.documentId, newCluster.id);
          await recordMembership(newCluster.id, target.documentId, revision.id, rawItemId, 100);
        } else if (result.clusterAction === 'join_cluster' && result.targetClusterId) {
          finalClusterId = result.targetClusterId;
          await documentRepository.assignDuplicateCluster(
            target.documentId,
            result.targetClusterId,
          );
          await recordMembership(
            result.targetClusterId,
            target.documentId,
            revision.id,
            rawItemId,
            100,
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
        nearDuplicateCandidates: result.nearDuplicateCandidates,
        deduplicationVersion: result.deduplicationVersion,
        nearDuplicateThreshold: result.nearDuplicateThreshold,
        boilerplateRuleVersion: result.boilerplateRuleVersion,
        confidence:
          result.exactMatch?.confidence ?? result.nearDuplicateCandidates[0]?.confidence ?? null,
        manualReviewRequired: result.manualReviewRequired,
        manualReviewReasons: result.manualReviewReasons,
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
        nearDuplicateCandidates: [],
        deduplicationVersion: deduplicationService.deduplicationVersion,
        nearDuplicateThreshold: deduplicationService.nearDuplicateThreshold,
        boilerplateRuleVersion: deduplicationService.boilerplateRuleVersion,
        confidence: null,
        manualReviewRequired: false,
        manualReviewReasons: [],
        status: 'failed',
        errorSummary: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

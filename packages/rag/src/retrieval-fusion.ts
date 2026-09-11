import type { SearchHit } from '@techpulse/domain';

export interface RetrievalFusionOptions {
  readonly limit?: number;
  readonly rrfK?: number;
  readonly maxChunksPerRevision?: number;
  readonly maxPerDuplicateCluster?: number;
  readonly maxPerSource?: number;
  readonly recencyHalfLifeDays?: number;
  readonly now?: Date;
}

interface ScoredHit {
  readonly hit: SearchHit;
  readonly score: number;
}

/**
 * Reciprocal-rank fusion with bounded recency and deterministic diversity caps.
 * The score only orders evidence candidates and must never be exposed as an interest metric.
 */
export function fuseRetrievalCandidates(
  rankedLists: readonly (readonly SearchHit[])[],
  options: RetrievalFusionOptions = {},
): readonly SearchHit[] {
  const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
  const rrfK = Math.max(1, options.rrfK ?? 60);
  const maxChunksPerRevision = Math.max(1, options.maxChunksPerRevision ?? 2);
  const maxPerDuplicateCluster = Math.max(1, options.maxPerDuplicateCluster ?? 2);
  const halfLifeDays = Math.max(1, options.recencyHalfLifeDays ?? 30);
  const nowMs = (options.now ?? new Date()).getTime();
  const byChunk = new Map<string, ScoredHit>();

  for (const list of rankedLists) {
    list.forEach((hit, index) => {
      const previous = byChunk.get(hit.chunkId);
      byChunk.set(hit.chunkId, {
        hit,
        score: (previous?.score ?? 0) + 1 / (rrfK + index + 1),
      });
    });
  }

  const scored = [...byChunk.values()].map(({ hit, score }) => {
    if (!hit.publishedAt || !Number.isFinite(hit.publishedAt.getTime())) return { hit, score };
    const ageDays = Math.max(0, nowMs - hit.publishedAt.getTime()) / 86_400_000;
    const recency = Math.pow(0.5, ageDays / halfLifeDays);
    return { hit, score: score + recency / (rrfK + 1) / 10 };
  });
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      (right.hit.publishedAt?.getTime() ?? 0) - (left.hit.publishedAt?.getTime() ?? 0) ||
      left.hit.chunkId.localeCompare(right.hit.chunkId),
  );

  const sourceCount = new Set(scored.map(({ hit }) => hit.sourceKey).filter(Boolean)).size;
  const maxPerSource = Math.max(
    1,
    options.maxPerSource ?? (sourceCount > 1 ? Math.ceil(limit * 0.6) : limit),
  );
  const revisionCounts = new Map<string, number>();
  const clusterCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const selected: SearchHit[] = [];

  for (const candidate of scored) {
    const { hit } = candidate;
    const clusterKey = hit.duplicateClusterId ?? hit.documentId;
    const sourceKey = hit.sourceKey ?? 'unknown';
    if ((revisionCounts.get(hit.documentRevisionId) ?? 0) >= maxChunksPerRevision) continue;
    if ((clusterCounts.get(clusterKey) ?? 0) >= maxPerDuplicateCluster) continue;
    if ((sourceCounts.get(sourceKey) ?? 0) >= maxPerSource) continue;
    revisionCounts.set(
      hit.documentRevisionId,
      (revisionCounts.get(hit.documentRevisionId) ?? 0) + 1,
    );
    clusterCounts.set(clusterKey, (clusterCounts.get(clusterKey) ?? 0) + 1);
    sourceCounts.set(sourceKey, (sourceCounts.get(sourceKey) ?? 0) + 1);
    selected.push({ ...hit, score: candidate.score });
    if (selected.length >= limit) break;
  }
  return selected;
}

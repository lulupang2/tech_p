import type { SearchHit } from '@techpulse/domain';
import type { QueryIntent } from './query-parser.js';

export interface ContextAssemblyOptions {
  readonly intent: QueryIntent;
  readonly entityIds?: readonly string[];
  readonly latestOnly?: boolean;
  readonly repositoryTarget?: string | null;
  readonly maxContextTokens?: number;
}

export interface AssembledEvidence {
  readonly hit: SearchHit;
  readonly mergedChunkIds: readonly string[];
  readonly estimatedTokens: number;
}

export interface EvidenceSufficiency {
  readonly sufficient: boolean;
  readonly reason: string | null;
  readonly documents: number;
  readonly sources: number;
}

export interface ContextAssemblyResult {
  readonly evidence: readonly AssembledEvidence[];
  readonly totalEstimatedTokens: number;
  readonly droppedForBudget: number;
  readonly suppressedDuplicates: number;
  readonly sufficiency: EvidenceSufficiency;
}

const REPOSITORY_TARGET_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'facebook/react': ['react/react'],
};

function estimateTokens(hit: SearchHit): number {
  if (hit.tokenCount && Number.isFinite(hit.tokenCount) && hit.tokenCount > 0) {
    return Math.ceil(hit.tokenCount);
  }
  return Math.max(1, Math.ceil(`${hit.title}\n${hit.content}`.length / 3));
}

function canMergeAdjacent(left: SearchHit, right: SearchHit): boolean {
  return (
    left.documentRevisionId === right.documentRevisionId &&
    left.ordinal !== undefined &&
    right.ordinal !== undefined &&
    right.ordinal === left.ordinal + 1 &&
    left.headingPath.join('\u0000') === right.headingPath.join('\u0000')
  );
}

function mergeAdjacentHits(hits: readonly SearchHit[]): AssembledEvidence[] {
  const byRevision = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const group = byRevision.get(hit.documentRevisionId) ?? [];
    group.push(hit);
    byRevision.set(hit.documentRevisionId, group);
  }

  const mergedByChunk = new Map<string, AssembledEvidence>();
  for (const group of byRevision.values()) {
    const ordered = [...group].sort((a, b) => {
      if (a.ordinal === undefined || b.ordinal === undefined) return 0;
      return a.ordinal - b.ordinal;
    });
    for (let index = 0; index < ordered.length; index += 1) {
      const first = ordered[index]!;
      let merged = first;
      const chunkIds = [first.chunkId];
      let tokens = estimateTokens(first);
      while (index + 1 < ordered.length && canMergeAdjacent(ordered[index]!, ordered[index + 1]!)) {
        const next = ordered[index + 1]!;
        merged = {
          ...merged,
          content: `${merged.content}\n\n${next.content}`,
          tokenCount:
            (merged.tokenCount ?? estimateTokens(merged)) +
            (next.tokenCount ?? estimateTokens(next)),
        };
        chunkIds.push(next.chunkId);
        tokens += estimateTokens(next);
        index += 1;
      }
      const evidence = { hit: merged, mergedChunkIds: chunkIds, estimatedTokens: tokens };
      for (const chunkId of chunkIds) mergedByChunk.set(chunkId, evidence);
    }
  }

  const result: AssembledEvidence[] = [];
  const seen = new Set<AssembledEvidence>();
  for (const hit of hits) {
    const evidence = mergedByChunk.get(hit.chunkId);
    if (evidence && !seen.has(evidence)) {
      seen.add(evidence);
      result.push(evidence);
    }
  }
  return result;
}

function suppressDuplicateUpstream(evidence: readonly AssembledEvidence[]): {
  evidence: AssembledEvidence[];
  suppressed: number;
} {
  const selected: AssembledEvidence[] = [];
  const clusterIds = new Set<string>();
  const contentKeys = new Set<string>();
  let suppressed = 0;

  for (const item of evidence) {
    const clusterId = item.hit.duplicateClusterId ?? undefined;
    const normalizedContent = item.hit.content
      .replace(/\s+/gu, ' ')
      .trim()
      .toLocaleLowerCase('en-US');
    const contentKey = `${item.hit.title.toLocaleLowerCase('en-US')}\u0000${normalizedContent}`;
    const duplicateByContent = !clusterId && contentKeys.has(contentKey);
    if ((clusterId && clusterIds.has(clusterId)) || duplicateByContent) {
      suppressed += 1;
      continue;
    }
    if (clusterId) clusterIds.add(clusterId);
    if (!clusterId) contentKeys.add(contentKey);
    selected.push(item);
  }
  return { evidence: selected, suppressed };
}

function checkSufficiency(
  evidence: readonly AssembledEvidence[],
  intent: QueryIntent,
  entityIds: readonly string[],
): EvidenceSufficiency {
  const documents = new Set(evidence.map((item) => item.hit.documentRevisionId)).size;
  const sources = new Set(evidence.map((item) => item.hit.sourceKey).filter(Boolean)).size;

  if (evidence.length === 0) {
    return { sufficient: false, reason: 'no_evidence', documents, sources };
  }
  if (intent === 'compare_interest') {
    const minimumDocuments = Math.max(2, entityIds.length);
    return documents >= minimumDocuments
      ? { sufficient: true, reason: null, documents, sources }
      : {
          sufficient: false,
          reason: 'compare_requires_multiple_independent_documents',
          documents,
          sources,
        };
  }
  if (intent === 'emerging_topics') {
    return documents >= 2
      ? { sufficient: true, reason: null, documents, sources }
      : {
          sufficient: false,
          reason: 'emerging_topics_require_multiple_documents',
          documents,
          sources,
        };
  }
  return { sufficient: true, reason: null, documents, sources };
}

export function assembleContextEvidence(
  hits: readonly SearchHit[],
  options: ContextAssemblyOptions,
): ContextAssemblyResult {
  const maxContextTokens = Math.max(1, options.maxContextTokens ?? 4000);
  const merged = mergeAdjacentHits(hits);
  const repositoryTarget = options.repositoryTarget?.toLocaleLowerCase('en-US');
  const repositoryTargets = repositoryTarget
    ? [repositoryTarget, ...(REPOSITORY_TARGET_ALIASES[repositoryTarget] ?? [])]
    : [];
  const matchingTarget = options.repositoryTarget
    ? merged.filter((item) => {
        try {
          const url = new URL(item.hit.canonicalUrl ?? '');
          const path = url.pathname.toLocaleLowerCase('en-US');
          return (
            url.protocol === 'https:' &&
            url.hostname === 'github.com' &&
            !url.username &&
            !url.password &&
            !url.port &&
            repositoryTargets.some(
              (target) => path === `/${target}` || path.startsWith(`/${target}/`),
            )
          );
        } catch {
          return false;
        }
      })
    : [];
  const scoped = options.repositoryTarget ? matchingTarget : merged;
  const eligible = options.latestOnly
    ? (() => {
        const dated = scoped.filter((item) => item.hit.publishedAt);
        if (dated.length === 0) return scoped;
        const latest = Math.max(...dated.map((item) => item.hit.publishedAt!.getTime()));
        const revisions = new Set(
          dated
            .filter((item) => item.hit.publishedAt!.getTime() === latest)
            .map((item) => item.hit.documentRevisionId),
        );
        return scoped.filter((item) => revisions.has(item.hit.documentRevisionId));
      })()
    : scoped;
  const deduplicated = suppressDuplicateUpstream(eligible);
  const selected: AssembledEvidence[] = [];
  let totalEstimatedTokens = 0;
  let droppedForBudget = 0;

  for (const item of deduplicated.evidence) {
    if (totalEstimatedTokens + item.estimatedTokens > maxContextTokens) {
      droppedForBudget += 1;
      continue;
    }
    selected.push(item);
    totalEstimatedTokens += item.estimatedTokens;
  }

  return {
    evidence: selected,
    totalEstimatedTokens,
    droppedForBudget,
    suppressedDuplicates: deduplicated.suppressed,
    sufficiency: checkSufficiency(selected, options.intent, options.entityIds ?? []),
  };
}

import type {
  AcquisitionLimits,
  AcquisitionRequest,
  BoundedAcquisitionPort,
  CollectionWindow,
  CoveragePort,
  CoverageReport,
  SearchHit,
  SearchServicePort,
} from '@techpulse/domain';
import { classifyTopics } from '@techpulse/domain';
import { randomUUID } from 'node:crypto';

export interface LiveSearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly sourceKey: string;
  readonly publishedAt: Date | null;
}

export interface LiveSearchOptions {
  readonly timeoutMs?: number | undefined;
  readonly acquisitionPort?: BoundedAcquisitionPort | undefined;
  readonly searchService?: SearchServicePort | undefined;
  readonly coveragePort?: CoveragePort | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly now?: () => Date;
  readonly window?: CollectionWindow | undefined;
  readonly topicIds?: readonly string[] | undefined;
}

function combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
    return controller.signal;
  }
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

/**
 * Bounded on-demand technical evidence acquisition using injected BoundedAcquisitionPort
 * and SearchServicePort. Enforces provider/source limits, deadline/timeout, and returns
 * SearchHits produced from immutable persisted documents via one lexical re-search.
 */
export async function fetchLiveTechEvidence(
  question: string,
  options: LiveSearchOptions = {},
): Promise<readonly SearchHit[]> {
  if (!options.acquisitionPort) {
    return [];
  }

  const nowFn = options.now ?? (() => new Date());
  const now = nowFn();
  const timeoutMs = Math.min(10000, Math.max(100, options.timeoutMs ?? 3500));
  const deadline = new Date(now.getTime() + timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const window: CollectionWindow = options.window ?? {
    from: new Date('1970-01-01T00:00:00.000Z'),
    to: now,
  };

  const topicIds = options.topicIds ?? classifyTopics({ text: question }).map((t) => t.slug);

  let coverageReport: CoverageReport;
  if (options.coveragePort) {
    try {
      coverageReport = await options.coveragePort.getCoverage(window, topicIds, now);
    } catch {
      coverageReport = {
        generatedAt: now.toISOString(),
        from: window.from.toISOString(),
        to: window.to.toISOString(),
        rawDocuments: 0,
        lexicalDocuments: 0,
        vectorDocuments: 0,
        partitionsChecked: 0,
        partitionsCompleted: 0,
        partitionsPartial: 0,
        reasons: ['raw_shortage'],
      };
    }
  } else {
    coverageReport = {
      generatedAt: now.toISOString(),
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      rawDocuments: 0,
      lexicalDocuments: 0,
      vectorDocuments: 0,
      partitionsChecked: 0,
      partitionsCompleted: 0,
      partitionsPartial: 0,
      reasons: ['raw_shortage'],
    };
  }

  const limits: AcquisitionLimits = {
    maxSearches: 2,
    maxFetches: 3,
    maxHttpAttempts: 8,
    maxTotalBytes: 1024 * 1024,
    deadline,
    maxContextTokens: 4000,
    maxOutputTokens: 1000,
  };

  const combinedSignal = combineSignals(options.signal, controller.signal) ?? controller.signal;

  const request: AcquisitionRequest = {
    queryRunId: `run_${randomUUID().replaceAll('-', '')}`,
    query: question,
    topicIds,
    window,
    coverage: coverageReport,
    limits,
    signal: combinedSignal,
  };

  try {
    const acqResult = await options.acquisitionPort.acquire(request);
    if (acqResult.acquired > 0 && options.searchService) {
      const hits = await options.searchService.searchFts({
        query: question,
        limit: 10,
      });
      return hits;
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

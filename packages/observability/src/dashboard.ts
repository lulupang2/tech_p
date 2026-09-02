/**
 * Structured baseline dashboard snapshot generator for Signal Archive observability.
 * Provides separated metric dimensions and units without unexplained composite scores.
 */

import { type AlertEvaluationResult, evaluateAlerts } from './alerts.js';
import {
  type HistogramSummary,
  type MetricRegistry,
  type MetricRegistrySnapshot,
  METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL,
  METRIC_API_REQUEST_DURATION_MS,
  METRIC_API_REQUESTS_TOTAL,
  METRIC_DB_POOL_ACTIVE_CONNECTIONS,
  METRIC_DB_POOL_SATURATION_RATIO,
  METRIC_DB_QUERY_DURATION_MS,
  METRIC_LLM_ERRORS_TOTAL,
  METRIC_LLM_REQUEST_DURATION_MS,
  METRIC_LLM_TOKEN_USAGE_TOTAL,
  METRIC_PIPELINE_STAGE_ERRORS_TOTAL,
  METRIC_PIPELINE_STAGE_TOTAL,
  METRIC_QUEUE_ACTIVE_JOBS,
  METRIC_QUEUE_LAG_SECONDS,
  METRIC_QUEUE_WAITING_JOBS,
  METRIC_SOURCE_FRESHNESS_SECONDS,
  defaultMetricRegistry,
} from './metrics.js';

export interface SourceFreshnessSummary {
  readonly sourceId: string;
  readonly lagSeconds: number;
  readonly status: 'fresh' | 'stale' | 'unknown';
  readonly thresholdSeconds: number;
}

export interface PipelineStageSummary {
  readonly stage: string;
  readonly totalProcessed: number;
  readonly errorsTotal: number;
  readonly errorRate: number;
  readonly sources: readonly string[];
}

export interface QueueLagSummary {
  readonly queue: string;
  readonly lagSeconds: number;
  readonly waitingJobs: number;
  readonly activeJobs: number;
}

export interface DatabaseMetricsSummary {
  readonly queryLatencyMs: {
    readonly count: number;
    readonly sum: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly max: number | null;
  };
  readonly activeConnections: number;
  readonly poolSaturationRatio: number;
}

export interface LlmProviderDetail {
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly errors: number;
}

export interface LlmMetricsSummary {
  readonly requestLatencyMs: {
    readonly count: number;
    readonly sum: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
  };
  readonly tokenUsage: {
    readonly prompt: number;
    readonly completion: number;
    readonly total: number;
  };
  readonly errorsTotal: number;
  readonly byProvider: Readonly<Record<string, LlmProviderDetail>>;
}

export interface ApiMetricsSummary {
  readonly requestsTotal: number;
  readonly requestLatencyMs: {
    readonly count: number;
    readonly p50: number | null;
    readonly p95: number | null;
  };
  readonly rateLimitRejectionsTotal: number;
  readonly errorCount4xx: number;
  readonly errorCount5xx: number;
}

export interface DashboardSnapshot {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly sourceFreshness: readonly SourceFreshnessSummary[];
  readonly pipelineStages: readonly PipelineStageSummary[];
  readonly queueLag: readonly QueueLagSummary[];
  readonly database: DatabaseMetricsSummary;
  readonly llm: LlmMetricsSummary;
  readonly api: ApiMetricsSummary;
  readonly alerts: readonly AlertEvaluationResult[];
  readonly activeAlertCount: number;
}

export interface DashboardOptions {
  readonly clock?: () => string;
  readonly sourceFreshnessThresholdSeconds?: number;
}

export function createDashboardSnapshot(
  source: MetricRegistrySnapshot | MetricRegistry = defaultMetricRegistry,
  options: DashboardOptions = {},
): DashboardSnapshot {
  const clock = options.clock ?? (() => new Date().toISOString());
  const nowStr = clock();
  const snapshot = 'exportSnapshot' in source ? source.exportSnapshot(clock) : source;
  const freshnessThreshold = options.sourceFreshnessThresholdSeconds ?? 86400;

  // 1. Source Freshness
  const freshnessMetric = snapshot.metrics.find((m) => m.name === METRIC_SOURCE_FRESHNESS_SECONDS);
  const sourceFreshness: SourceFreshnessSummary[] = [];
  if (freshnessMetric) {
    for (const sample of freshnessMetric.samples) {
      const sourceId = String(sample.labels['source_id'] ?? 'unknown');
      const lagSeconds = typeof sample.value === 'number' ? sample.value : 0;
      let status: 'fresh' | 'stale' | 'unknown' = 'fresh';
      if (lagSeconds > freshnessThreshold) {
        status = 'stale';
      } else if (lagSeconds < 0) {
        status = 'unknown';
      }
      sourceFreshness.push({
        sourceId,
        lagSeconds,
        status,
        thresholdSeconds: freshnessThreshold,
      });
    }
  }

  // 2. Pipeline Stages
  const stageTotalMetric = snapshot.metrics.find((m) => m.name === METRIC_PIPELINE_STAGE_TOTAL);
  const stageErrorsMetric = snapshot.metrics.find(
    (m) => m.name === METRIC_PIPELINE_STAGE_ERRORS_TOTAL,
  );

  const stageMap = new Map<string, { processed: number; errors: number; sources: Set<string> }>();

  if (stageTotalMetric) {
    for (const sample of stageTotalMetric.samples) {
      const stage = String(sample.labels['stage'] ?? 'unknown');
      const count = typeof sample.value === 'number' ? sample.value : 0;
      const sourceId = sample.labels['source_id'] ? String(sample.labels['source_id']) : undefined;
      const entry = stageMap.get(stage) ?? { processed: 0, errors: 0, sources: new Set<string>() };
      entry.processed += count;
      if (sourceId) entry.sources.add(sourceId);
      stageMap.set(stage, entry);
    }
  }

  if (stageErrorsMetric) {
    for (const sample of stageErrorsMetric.samples) {
      const stage = String(sample.labels['stage'] ?? 'unknown');
      const count = typeof sample.value === 'number' ? sample.value : 0;
      const sourceId = sample.labels['source_id'] ? String(sample.labels['source_id']) : undefined;
      const entry = stageMap.get(stage) ?? { processed: 0, errors: 0, sources: new Set<string>() };
      entry.errors += count;
      if (sourceId) entry.sources.add(sourceId);
      stageMap.set(stage, entry);
    }
  }

  const pipelineStages: PipelineStageSummary[] = Array.from(stageMap.entries()).map(
    ([stage, data]) => ({
      stage,
      totalProcessed: data.processed,
      errorsTotal: data.errors,
      errorRate:
        data.processed > 0 ? Number((data.errors / (data.processed + data.errors)).toFixed(4)) : 0,
      sources: Array.from(data.sources).sort(),
    }),
  );

  // 3. Queue Lag
  const queueLagMetric = snapshot.metrics.find((m) => m.name === METRIC_QUEUE_LAG_SECONDS);
  const queueWaitingMetric = snapshot.metrics.find((m) => m.name === METRIC_QUEUE_WAITING_JOBS);
  const queueActiveMetric = snapshot.metrics.find((m) => m.name === METRIC_QUEUE_ACTIVE_JOBS);

  const queueMap = new Map<string, { lag: number; waiting: number; active: number }>();

  if (queueLagMetric) {
    for (const sample of queueLagMetric.samples) {
      const queue = String(sample.labels['queue'] ?? 'default');
      const lag = typeof sample.value === 'number' ? sample.value : 0;
      const entry = queueMap.get(queue) ?? { lag: 0, waiting: 0, active: 0 };
      entry.lag = lag;
      queueMap.set(queue, entry);
    }
  }
  if (queueWaitingMetric) {
    for (const sample of queueWaitingMetric.samples) {
      const queue = String(sample.labels['queue'] ?? 'default');
      const waiting = typeof sample.value === 'number' ? sample.value : 0;
      const entry = queueMap.get(queue) ?? { lag: 0, waiting: 0, active: 0 };
      entry.waiting = waiting;
      queueMap.set(queue, entry);
    }
  }
  if (queueActiveMetric) {
    for (const sample of queueActiveMetric.samples) {
      const queue = String(sample.labels['queue'] ?? 'default');
      const active = typeof sample.value === 'number' ? sample.value : 0;
      const entry = queueMap.get(queue) ?? { lag: 0, waiting: 0, active: 0 };
      entry.active = active;
      queueMap.set(queue, entry);
    }
  }

  const queueLag: QueueLagSummary[] = Array.from(queueMap.entries()).map(([queue, data]) => ({
    queue,
    lagSeconds: data.lag,
    waitingJobs: data.waiting,
    activeJobs: data.active,
  }));

  // 4. Database
  const dbLatencyMetric = snapshot.metrics.find((m) => m.name === METRIC_DB_QUERY_DURATION_MS);
  const dbActiveMetric = snapshot.metrics.find((m) => m.name === METRIC_DB_POOL_ACTIVE_CONNECTIONS);
  const dbSatMetric = snapshot.metrics.find((m) => m.name === METRIC_DB_POOL_SATURATION_RATIO);

  let dbSummary: DatabaseMetricsSummary = {
    queryLatencyMs: {
      count: 0,
      sum: 0,
      p50: null,
      p95: null,
      p99: null,
      max: null,
    },
    activeConnections: 0,
    poolSaturationRatio: 0,
  };

  if (dbLatencyMetric && dbLatencyMetric.samples.length > 0) {
    let totalCount = 0;
    let totalSum = 0;
    let maxLatency: number | null = null;
    const p50s: number[] = [];
    const p95s: number[] = [];
    const p99s: number[] = [];

    for (const s of dbLatencyMetric.samples) {
      const summary = s.value as Partial<HistogramSummary>;
      if (summary && typeof summary === 'object') {
        totalCount += summary.count ?? 0;
        totalSum += summary.sum ?? 0;
        if (summary.max !== null && summary.max !== undefined) {
          maxLatency = maxLatency === null ? summary.max : Math.max(maxLatency, summary.max);
        }
        if (summary.p50 !== null && summary.p50 !== undefined) p50s.push(summary.p50);
        if (summary.p95 !== null && summary.p95 !== undefined) p95s.push(summary.p95);
        if (summary.p99 !== null && summary.p99 !== undefined) p99s.push(summary.p99);
      }
    }

    dbSummary = {
      ...dbSummary,
      queryLatencyMs: {
        count: totalCount,
        sum: totalSum,
        p50: p50s.length > 0 ? Math.max(...p50s) : null,
        p95: p95s.length > 0 ? Math.max(...p95s) : null,
        p99: p99s.length > 0 ? Math.max(...p99s) : null,
        max: maxLatency,
      },
    };
  }

  if (dbActiveMetric && dbActiveMetric.samples.length > 0) {
    let active = 0;
    for (const s of dbActiveMetric.samples) {
      if (typeof s.value === 'number') active += s.value;
    }
    dbSummary = { ...dbSummary, activeConnections: active };
  }

  if (dbSatMetric && dbSatMetric.samples.length > 0) {
    let maxSat = 0;
    for (const s of dbSatMetric.samples) {
      if (typeof s.value === 'number') maxSat = Math.max(maxSat, s.value);
    }
    dbSummary = { ...dbSummary, poolSaturationRatio: maxSat };
  }

  // 5. LLM
  const llmLatencyMetric = snapshot.metrics.find((m) => m.name === METRIC_LLM_REQUEST_DURATION_MS);
  const llmTokenMetric = snapshot.metrics.find((m) => m.name === METRIC_LLM_TOKEN_USAGE_TOTAL);
  const llmErrorMetric = snapshot.metrics.find((m) => m.name === METRIC_LLM_ERRORS_TOTAL);

  const providerDetails: Record<
    string,
    { requests: number; promptTokens: number; completionTokens: number; errors: number }
  > = {};

  const getProviderEntry = (provider: string) => {
    if (!providerDetails[provider]) {
      providerDetails[provider] = { requests: 0, promptTokens: 0, completionTokens: 0, errors: 0 };
    }
    return providerDetails[provider]!;
  };

  let llmLatencySum = 0;
  let llmLatencyCount = 0;
  const llmP50s: number[] = [];
  const llmP95s: number[] = [];
  const llmP99s: number[] = [];

  if (llmLatencyMetric) {
    for (const s of llmLatencyMetric.samples) {
      const provider = String(s.labels['provider'] ?? 'default');
      const summary = s.value as Partial<HistogramSummary>;
      if (summary && typeof summary === 'object') {
        llmLatencyCount += summary.count ?? 0;
        llmLatencySum += summary.sum ?? 0;
        getProviderEntry(provider).requests += summary.count ?? 0;
        if (summary.p50 !== null && summary.p50 !== undefined) llmP50s.push(summary.p50);
        if (summary.p95 !== null && summary.p95 !== undefined) llmP95s.push(summary.p95);
        if (summary.p99 !== null && summary.p99 !== undefined) llmP99s.push(summary.p99);
      }
    }
  }

  let promptTokensTotal = 0;
  let completionTokensTotal = 0;
  let allTokensTotal = 0;

  if (llmTokenMetric) {
    for (const s of llmTokenMetric.samples) {
      const provider = String(s.labels['provider'] ?? 'default');
      const tokenType = String(s.labels['token_type'] ?? 'total');
      const count = typeof s.value === 'number' ? s.value : 0;
      const entry = getProviderEntry(provider);

      if (tokenType === 'prompt') {
        promptTokensTotal += count;
        entry.promptTokens += count;
      } else if (tokenType === 'completion') {
        completionTokensTotal += count;
        entry.completionTokens += count;
      } else if (tokenType === 'total') {
        allTokensTotal += count;
      }
    }
  }

  let llmErrorsTotal = 0;
  if (llmErrorMetric) {
    for (const s of llmErrorMetric.samples) {
      const provider = String(s.labels['provider'] ?? 'default');
      const count = typeof s.value === 'number' ? s.value : 0;
      llmErrorsTotal += count;
      getProviderEntry(provider).errors += count;
    }
  }

  const llmSummary: LlmMetricsSummary = {
    requestLatencyMs: {
      count: llmLatencyCount,
      sum: llmLatencySum,
      p50: llmP50s.length > 0 ? Math.max(...llmP50s) : null,
      p95: llmP95s.length > 0 ? Math.max(...llmP95s) : null,
      p99: llmP99s.length > 0 ? Math.max(...llmP99s) : null,
    },
    tokenUsage: {
      prompt: promptTokensTotal,
      completion: completionTokensTotal,
      total: allTokensTotal > 0 ? allTokensTotal : promptTokensTotal + completionTokensTotal,
    },
    errorsTotal: llmErrorsTotal,
    byProvider: providerDetails,
  };

  // 6. API
  const apiRequestsMetric = snapshot.metrics.find((m) => m.name === METRIC_API_REQUESTS_TOTAL);
  const apiLatencyMetric = snapshot.metrics.find((m) => m.name === METRIC_API_REQUEST_DURATION_MS);
  const apiRateLimitMetric = snapshot.metrics.find(
    (m) => m.name === METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL,
  );

  let apiRequestsTotal = 0;
  let api4xxCount = 0;
  let api5xxCount = 0;

  if (apiRequestsMetric) {
    for (const s of apiRequestsMetric.samples) {
      const count = typeof s.value === 'number' ? s.value : 0;
      const statusCodeStr = String(s.labels['status_code'] ?? '200');
      const code = Number.parseInt(statusCodeStr, 10);
      apiRequestsTotal += count;
      if (code >= 400 && code < 500) api4xxCount += count;
      if (code >= 500 && code < 600) api5xxCount += count;
    }
  }

  let apiLatencyCount = 0;
  const apiP50s: number[] = [];
  const apiP95s: number[] = [];

  if (apiLatencyMetric) {
    for (const s of apiLatencyMetric.samples) {
      const summary = s.value as Partial<HistogramSummary>;
      if (summary && typeof summary === 'object') {
        apiLatencyCount += summary.count ?? 0;
        if (summary.p50 !== null && summary.p50 !== undefined) apiP50s.push(summary.p50);
        if (summary.p95 !== null && summary.p95 !== undefined) apiP95s.push(summary.p95);
      }
    }
  }

  let rateLimitRejections = 0;
  if (apiRateLimitMetric) {
    for (const s of apiRateLimitMetric.samples) {
      if (typeof s.value === 'number') rateLimitRejections += s.value;
    }
  }

  const apiSummary: ApiMetricsSummary = {
    requestsTotal: apiRequestsTotal,
    requestLatencyMs: {
      count: apiLatencyCount,
      p50: apiP50s.length > 0 ? Math.max(...apiP50s) : null,
      p95: apiP95s.length > 0 ? Math.max(...apiP95s) : null,
    },
    rateLimitRejectionsTotal: rateLimitRejections,
    errorCount4xx: api4xxCount,
    errorCount5xx: api5xxCount,
  };

  // 7. Alerts
  const alerts = evaluateAlerts(snapshot, { clock });
  const activeAlertCount = alerts.filter((a) => a.status === 'firing').length;

  return {
    schemaVersion: 1,
    timestamp: nowStr,
    sourceFreshness,
    pipelineStages,
    queueLag,
    database: dbSummary,
    llm: llmSummary,
    api: apiSummary,
    alerts,
    activeAlertCount,
  };
}

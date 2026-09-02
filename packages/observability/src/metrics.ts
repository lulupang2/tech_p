/**
 * Deterministic metric primitives, registry, and standard catalog for TechPulse services.
 * All metrics preserve explicit physical dimensions and units without unexplained composite scores.
 */

import { type CorrelationContext, normalizeCorrelationContext } from './index.js';

export type MetricType = 'counter' | 'gauge' | 'histogram';
export type MetricLabelValue = string | number | boolean;
export type MetricLabels = Readonly<Record<string, MetricLabelValue>>;

export interface MetricSample<T> {
  readonly labels: MetricLabels;
  readonly value: T;
  readonly timestamp?: string;
  readonly context?: CorrelationContext;
}

export interface HistogramSummary {
  readonly count: number;
  readonly sum: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly buckets: Readonly<Record<number, number>>;
}

export interface MetricDefinition {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly unit?: string;
}

export const DEFAULT_LATENCY_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
] as const;

export const DEFAULT_QUEUE_LAG_BUCKETS_SECONDS: readonly number[] = [
  1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600,
] as const;

export function serializeLabels(labels?: MetricLabels): string {
  if (!labels) return '';
  const entries = Object.entries(labels).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  if (entries.length === 0) return '';
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([k, v]) => `${k}="${String(v).replaceAll('"', '\\"')}"`).join(',');
}

export function normalizeLabels(labels?: MetricLabels): MetricLabels {
  if (!labels) return {};
  const result: Record<string, MetricLabelValue> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (value !== undefined && value !== null && value !== '') {
      result[key] = value;
    }
  }
  return result;
}

export class Counter {
  readonly name: string;
  readonly help: string;
  readonly unit?: string;
  private readonly values = new Map<
    string,
    { labels: MetricLabels; value: number; context?: CorrelationContext }
  >();

  constructor(options: { name: string; help: string; unit?: string }) {
    this.name = options.name;
    this.help = options.help;
    if (options.unit !== undefined) {
      this.unit = options.unit;
    }
  }

  increment(labels?: MetricLabels, value = 1, context?: CorrelationContext): void {
    if (value < 0) {
      throw new Error(`Counter '${this.name}' cannot be incremented by negative value: ${value}`);
    }
    const normalized = normalizeLabels(labels);
    const key = serializeLabels(normalized);
    const current = this.values.get(key);
    const normalizedContext = context ? normalizeCorrelationContext(context) : undefined;
    if (current) {
      current.value += value;
      if (normalizedContext && Object.keys(normalizedContext).length > 0) {
        current.context = { ...current.context, ...normalizedContext };
      }
    } else {
      this.values.set(key, {
        labels: normalized,
        value,
        ...(normalizedContext && Object.keys(normalizedContext).length > 0
          ? { context: normalizedContext }
          : {}),
      });
    }
  }

  get(labels?: MetricLabels): number {
    const key = serializeLabels(normalizeLabels(labels));
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  collect(): MetricSample<number>[] {
    const result: MetricSample<number>[] = [];
    for (const item of this.values.values()) {
      result.push({
        labels: item.labels,
        value: item.value,
        ...(item.context ? { context: item.context } : {}),
      });
    }
    return result;
  }
}

export class Gauge {
  readonly name: string;
  readonly help: string;
  readonly unit?: string;
  private readonly values = new Map<
    string,
    { labels: MetricLabels; value: number; context?: CorrelationContext }
  >();

  constructor(options: { name: string; help: string; unit?: string }) {
    this.name = options.name;
    this.help = options.help;
    if (options.unit !== undefined) {
      this.unit = options.unit;
    }
  }

  set(value: number, labels?: MetricLabels, context?: CorrelationContext): void {
    const normalized = normalizeLabels(labels);
    const key = serializeLabels(normalized);
    const normalizedContext = context ? normalizeCorrelationContext(context) : undefined;
    this.values.set(key, {
      labels: normalized,
      value,
      ...(normalizedContext && Object.keys(normalizedContext).length > 0
        ? { context: normalizedContext }
        : {}),
    });
  }

  increment(labels?: MetricLabels, value = 1, context?: CorrelationContext): void {
    const normalized = normalizeLabels(labels);
    const key = serializeLabels(normalized);
    const current = this.values.get(key);
    const normalizedContext = context ? normalizeCorrelationContext(context) : undefined;
    if (current) {
      current.value += value;
      if (normalizedContext && Object.keys(normalizedContext).length > 0) {
        current.context = { ...current.context, ...normalizedContext };
      }
    } else {
      this.values.set(key, {
        labels: normalized,
        value,
        ...(normalizedContext && Object.keys(normalizedContext).length > 0
          ? { context: normalizedContext }
          : {}),
      });
    }
  }

  decrement(labels?: MetricLabels, value = 1, context?: CorrelationContext): void {
    this.increment(labels, -value, context);
  }

  get(labels?: MetricLabels): number {
    const key = serializeLabels(normalizeLabels(labels));
    return this.values.get(key)?.value ?? 0;
  }

  reset(): void {
    this.values.clear();
  }

  collect(): MetricSample<number>[] {
    const result: MetricSample<number>[] = [];
    for (const item of this.values.values()) {
      result.push({
        labels: item.labels,
        value: item.value,
        ...(item.context ? { context: item.context } : {}),
      });
    }
    return result;
  }
}

interface HistogramEntry {
  labels: MetricLabels;
  samples: number[];
  sum: number;
  count: number;
  buckets: Map<number, number>;
  context?: CorrelationContext;
}

export class Histogram {
  readonly name: string;
  readonly help: string;
  readonly unit?: string;
  readonly buckets: readonly number[];
  private readonly values = new Map<string, HistogramEntry>();
  private readonly maxSamplesPerLabel: number;

  constructor(options: {
    name: string;
    help: string;
    unit?: string;
    buckets?: readonly number[];
    maxSamplesPerLabel?: number;
  }) {
    this.name = options.name;
    this.help = options.help;
    if (options.unit !== undefined) {
      this.unit = options.unit;
    }
    this.buckets = Object.freeze(
      [...(options.buckets ?? DEFAULT_LATENCY_BUCKETS_MS)].sort((a, b) => a - b),
    );
    this.maxSamplesPerLabel = options.maxSamplesPerLabel ?? 5000;
  }

  record(value: number, labels?: MetricLabels, context?: CorrelationContext): void {
    if (Number.isNaN(value) || !Number.isFinite(value)) return;
    const normalized = normalizeLabels(labels);
    const key = serializeLabels(normalized);
    let entry = this.values.get(key);
    if (!entry) {
      entry = {
        labels: normalized,
        samples: [],
        sum: 0,
        count: 0,
        buckets: new Map<number, number>(),
      };
      for (const b of this.buckets) {
        entry.buckets.set(b, 0);
      }
      this.values.set(key, entry);
    }

    entry.count += 1;
    entry.sum += value;
    if (entry.samples.length < this.maxSamplesPerLabel) {
      entry.samples.push(value);
    } else {
      // Reservoir replacement for deterministic bounded memory
      const idx = Math.floor(Math.random() * entry.count);
      if (idx < this.maxSamplesPerLabel) {
        entry.samples[idx] = value;
      }
    }

    for (const b of this.buckets) {
      if (value <= b) {
        entry.buckets.set(b, (entry.buckets.get(b) ?? 0) + 1);
      }
    }

    if (context) {
      const normalizedContext = normalizeCorrelationContext(context);
      if (Object.keys(normalizedContext).length > 0) {
        entry.context = { ...entry.context, ...normalizedContext };
      }
    }
  }

  get(labels?: MetricLabels): HistogramSummary {
    const key = serializeLabels(normalizeLabels(labels));
    const entry = this.values.get(key);
    if (!entry || entry.count === 0) {
      const emptyBuckets: Record<number, number> = {};
      for (const b of this.buckets) emptyBuckets[b] = 0;
      return {
        count: 0,
        sum: 0,
        min: null,
        max: null,
        p50: null,
        p90: null,
        p95: null,
        p99: null,
        buckets: emptyBuckets,
      };
    }

    const sorted = [...entry.samples].sort((a, b) => a - b);
    const min = sorted.length > 0 ? sorted[0]! : null;
    const max = sorted.length > 0 ? sorted[sorted.length - 1]! : null;

    const percentile = (p: number): number | null => {
      if (sorted.length === 0) return null;
      const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
      );
      return sorted[idx] ?? null;
    };

    const bucketsRecord: Record<number, number> = {};
    for (const b of this.buckets) {
      bucketsRecord[b] = entry.buckets.get(b) ?? 0;
    }

    return {
      count: entry.count,
      sum: entry.sum,
      min,
      max,
      p50: percentile(50),
      p90: percentile(90),
      p95: percentile(95),
      p99: percentile(99),
      buckets: bucketsRecord,
    };
  }

  reset(): void {
    this.values.clear();
  }

  collect(): MetricSample<HistogramSummary>[] {
    const result: MetricSample<HistogramSummary>[] = [];
    for (const entry of this.values.values()) {
      const summary = this.get(entry.labels);
      result.push({
        labels: entry.labels,
        value: summary,
        ...(entry.context ? { context: entry.context } : {}),
      });
    }
    return result;
  }
}

export type AnyMetric = Counter | Gauge | Histogram;

export interface MetricRegistrySnapshot {
  readonly timestamp: string;
  readonly metrics: readonly {
    readonly name: string;
    readonly type: MetricType;
    readonly help: string;
    readonly unit?: string;
    readonly samples: readonly MetricSample<unknown>[];
  }[];
}

export class MetricRegistry {
  private readonly metrics = new Map<string, AnyMetric>();

  counter(name: string, options: { help: string; unit?: string }): Counter {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing instanceof Counter) return existing;
      throw new Error(`Metric '${name}' already registered as different type`);
    }
    const counter = new Counter({ name, ...options });
    this.metrics.set(name, counter);
    return counter;
  }

  gauge(name: string, options: { help: string; unit?: string }): Gauge {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing instanceof Gauge) return existing;
      throw new Error(`Metric '${name}' already registered as different type`);
    }
    const gauge = new Gauge({ name, ...options });
    this.metrics.set(name, gauge);
    return gauge;
  }

  histogram(
    name: string,
    options: { help: string; unit?: string; buckets?: readonly number[] },
  ): Histogram {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing instanceof Histogram) return existing;
      throw new Error(`Metric '${name}' already registered as different type`);
    }
    const histogram = new Histogram({ name, ...options });
    this.metrics.set(name, histogram);
    return histogram;
  }

  getMetric(name: string): AnyMetric | undefined {
    return this.metrics.get(name);
  }

  getAllMetrics(): readonly AnyMetric[] {
    return Array.from(this.metrics.values());
  }

  reset(): void {
    for (const metric of this.metrics.values()) {
      metric.reset();
    }
  }

  clear(): void {
    this.metrics.clear();
  }

  exportSnapshot(clock: () => string = () => new Date().toISOString()): MetricRegistrySnapshot {
    const exportedMetrics = Array.from(this.metrics.values()).map((metric) => {
      let type: MetricType = 'counter';
      if (metric instanceof Gauge) type = 'gauge';
      else if (metric instanceof Histogram) type = 'histogram';

      return {
        name: metric.name,
        type,
        help: metric.help,
        ...(metric.unit !== undefined ? { unit: metric.unit } : {}),
        samples: metric.collect(),
      };
    });

    return {
      timestamp: clock(),
      metrics: exportedMetrics,
    };
  }

  exportPrometheus(): string {
    const lines: string[] = [];
    for (const metric of this.metrics.values()) {
      let typeStr = 'counter';
      if (metric instanceof Gauge) typeStr = 'gauge';
      else if (metric instanceof Histogram) typeStr = 'histogram';

      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${typeStr}`);

      if (metric instanceof Counter || metric instanceof Gauge) {
        const samples = metric.collect();
        if (samples.length === 0) {
          lines.push(`${metric.name} 0`);
        } else {
          for (const sample of samples) {
            const labelsStr = serializeLabels(sample.labels);
            const labelPart = labelsStr ? `{${labelsStr}}` : '';
            lines.push(`${metric.name}${labelPart} ${sample.value}`);
          }
        }
      } else if (metric instanceof Histogram) {
        const samples = metric.collect();
        for (const sample of samples) {
          const summary = sample.value;
          const baseLabelsStr = serializeLabels(sample.labels);
          for (const [bucketStr, count] of Object.entries(summary.buckets)) {
            const bucketLabels = baseLabelsStr
              ? `{${baseLabelsStr},le="${bucketStr}"}`
              : `{le="${bucketStr}"}`;
            lines.push(`${metric.name}_bucket${bucketLabels} ${count}`);
          }
          const infLabels = baseLabelsStr ? `{${baseLabelsStr},le="+Inf"}` : `{le="+Inf"}`;
          lines.push(`${metric.name}_bucket${infLabels} ${summary.count}`);
          const sumLabels = baseLabelsStr ? `{${baseLabelsStr}}` : '';
          lines.push(`${metric.name}_sum${sumLabels} ${summary.sum}`);
          lines.push(`${metric.name}_count${sumLabels} ${summary.count}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }
}

// Global Metric Registry Singleton
export const defaultMetricRegistry = new MetricRegistry();

// Standard Metric Names Constants
export const METRIC_SOURCE_FRESHNESS_SECONDS = 'techpulse_source_freshness_seconds' as const;
export const METRIC_PIPELINE_STAGE_TOTAL = 'techpulse_pipeline_stage_total' as const;
export const METRIC_PIPELINE_STAGE_ERRORS_TOTAL = 'techpulse_pipeline_stage_errors_total' as const;
export const METRIC_QUEUE_LAG_SECONDS = 'techpulse_queue_lag_seconds' as const;
export const METRIC_QUEUE_WAITING_JOBS = 'techpulse_queue_waiting_jobs' as const;
export const METRIC_QUEUE_ACTIVE_JOBS = 'techpulse_queue_active_jobs' as const;
export const METRIC_DB_QUERY_DURATION_MS = 'techpulse_db_query_duration_ms' as const;
export const METRIC_DB_POOL_ACTIVE_CONNECTIONS = 'techpulse_db_pool_active_connections' as const;
export const METRIC_DB_POOL_SATURATION_RATIO = 'techpulse_db_pool_saturation_ratio' as const;
export const METRIC_LLM_REQUEST_DURATION_MS = 'techpulse_llm_request_duration_ms' as const;
export const METRIC_LLM_TOKEN_USAGE_TOTAL = 'techpulse_llm_token_usage_total' as const;
export const METRIC_LLM_ERRORS_TOTAL = 'techpulse_llm_errors_total' as const;
export const METRIC_API_REQUESTS_TOTAL = 'techpulse_api_requests_total' as const;
export const METRIC_API_REQUEST_DURATION_MS = 'techpulse_api_request_duration_ms' as const;
export const METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL =
  'techpulse_api_rate_limit_rejections_total' as const;

// Register default baseline metrics on defaultMetricRegistry
export function registerDefaultMetrics(registry: MetricRegistry = defaultMetricRegistry): void {
  registry.gauge(METRIC_SOURCE_FRESHNESS_SECONDS, {
    help: 'Freshness lag of data sources in seconds (now - last_successful_collection_or_published)',
    unit: 'seconds',
  });
  registry.counter(METRIC_PIPELINE_STAGE_TOTAL, {
    help: 'Total items processed by pipeline stage',
    unit: 'items',
  });
  registry.counter(METRIC_PIPELINE_STAGE_ERRORS_TOTAL, {
    help: 'Total errors encountered in pipeline stage processing',
    unit: 'errors',
  });
  registry.gauge(METRIC_QUEUE_LAG_SECONDS, {
    help: 'Current queue processing lag in seconds',
    unit: 'seconds',
  });
  registry.gauge(METRIC_QUEUE_WAITING_JOBS, {
    help: 'Number of jobs currently waiting in queue',
    unit: 'jobs',
  });
  registry.gauge(METRIC_QUEUE_ACTIVE_JOBS, {
    help: 'Number of jobs currently being actively processed',
    unit: 'jobs',
  });
  registry.histogram(METRIC_DB_QUERY_DURATION_MS, {
    help: 'Database query execution duration in milliseconds',
    unit: 'ms',
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  });
  registry.gauge(METRIC_DB_POOL_ACTIVE_CONNECTIONS, {
    help: 'Number of active connections in database pool',
    unit: 'connections',
  });
  registry.gauge(METRIC_DB_POOL_SATURATION_RATIO, {
    help: 'Database connection pool saturation ratio (active / max)',
    unit: 'ratio',
  });
  registry.histogram(METRIC_LLM_REQUEST_DURATION_MS, {
    help: 'LLM provider request duration in milliseconds',
    unit: 'ms',
    buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000],
  });
  registry.counter(METRIC_LLM_TOKEN_USAGE_TOTAL, {
    help: 'Total tokens used by LLM provider interactions',
    unit: 'tokens',
  });
  registry.counter(METRIC_LLM_ERRORS_TOTAL, {
    help: 'Total errors returned by LLM providers',
    unit: 'errors',
  });
  registry.counter(METRIC_API_REQUESTS_TOTAL, {
    help: 'Total HTTP requests served by API',
    unit: 'requests',
  });
  registry.histogram(METRIC_API_REQUEST_DURATION_MS, {
    help: 'API HTTP request execution duration in milliseconds',
    unit: 'ms',
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  });
  registry.counter(METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL, {
    help: 'Total requests rejected due to rate or concurrency limits',
    unit: 'rejections',
  });
}

// Helper recorder functions for applications
export function recordSourceFreshness(
  sourceId: string,
  lagSeconds: number,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const gauge = reg.gauge(METRIC_SOURCE_FRESHNESS_SECONDS, {
    help: 'Freshness lag of data sources in seconds',
    unit: 'seconds',
  });
  gauge.set(Math.max(0, lagSeconds), { source_id: sourceId }, options.context);
}

export function recordPipelineStage(
  stage: string,
  status: 'success' | 'error',
  options: {
    sourceId?: string;
    errorType?: string;
    count?: number;
    registry?: MetricRegistry;
    context?: CorrelationContext;
  } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const count = options.count ?? 1;
  const counter = reg.counter(METRIC_PIPELINE_STAGE_TOTAL, {
    help: 'Total items processed by pipeline stage',
    unit: 'items',
  });
  counter.increment(
    {
      stage,
      status,
      ...(options.sourceId ? { source_id: options.sourceId } : {}),
    },
    count,
    options.context,
  );

  if (status === 'error') {
    const errCounter = reg.counter(METRIC_PIPELINE_STAGE_ERRORS_TOTAL, {
      help: 'Total errors encountered in pipeline stage processing',
      unit: 'errors',
    });
    errCounter.increment(
      {
        stage,
        error_type: options.errorType ?? 'unknown',
        ...(options.sourceId ? { source_id: options.sourceId } : {}),
      },
      count,
      options.context,
    );
  }
}

export function recordQueueLag(
  queue: string,
  lagSeconds: number,
  options: {
    jobType?: string;
    waitingJobs?: number;
    activeJobs?: number;
    registry?: MetricRegistry;
    context?: CorrelationContext;
  } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const lagGauge = reg.gauge(METRIC_QUEUE_LAG_SECONDS, {
    help: 'Current queue processing lag in seconds',
    unit: 'seconds',
  });
  lagGauge.set(
    Math.max(0, lagSeconds),
    {
      queue,
      ...(options.jobType ? { job_type: options.jobType } : {}),
    },
    options.context,
  );

  if (options.waitingJobs !== undefined) {
    const waitingGauge = reg.gauge(METRIC_QUEUE_WAITING_JOBS, {
      help: 'Number of jobs currently waiting in queue',
      unit: 'jobs',
    });
    waitingGauge.set(Math.max(0, options.waitingJobs), { queue }, options.context);
  }

  if (options.activeJobs !== undefined) {
    const activeGauge = reg.gauge(METRIC_QUEUE_ACTIVE_JOBS, {
      help: 'Number of jobs currently being actively processed',
      unit: 'jobs',
    });
    activeGauge.set(Math.max(0, options.activeJobs), { queue }, options.context);
  }
}

export function recordDbQuery(
  operation: string,
  table: string,
  durationMs: number,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const hist = reg.histogram(METRIC_DB_QUERY_DURATION_MS, {
    help: 'Database query execution duration in milliseconds',
    unit: 'ms',
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  });
  hist.record(durationMs, { operation, table }, options.context);
}

export function recordDbPool(
  pool: string,
  activeConnections: number,
  saturationRatio: number,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const connGauge = reg.gauge(METRIC_DB_POOL_ACTIVE_CONNECTIONS, {
    help: 'Number of active connections in database pool',
    unit: 'connections',
  });
  connGauge.set(Math.max(0, activeConnections), { pool }, options.context);

  const satGauge = reg.gauge(METRIC_DB_POOL_SATURATION_RATIO, {
    help: 'Database connection pool saturation ratio',
    unit: 'ratio',
  });
  satGauge.set(Math.max(0, Math.min(1, saturationRatio)), { pool }, options.context);
}

export function recordLlmUsage(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  durationMs: number,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const tokenCounter = reg.counter(METRIC_LLM_TOKEN_USAGE_TOTAL, {
    help: 'Total tokens used by LLM provider interactions',
    unit: 'tokens',
  });
  if (promptTokens > 0) {
    tokenCounter.increment(
      { provider, model, token_type: 'prompt' },
      promptTokens,
      options.context,
    );
  }
  if (completionTokens > 0) {
    tokenCounter.increment(
      { provider, model, token_type: 'completion' },
      completionTokens,
      options.context,
    );
  }
  tokenCounter.increment(
    { provider, model, token_type: 'total' },
    promptTokens + completionTokens,
    options.context,
  );

  const hist = reg.histogram(METRIC_LLM_REQUEST_DURATION_MS, {
    help: 'LLM provider request duration in milliseconds',
    unit: 'ms',
  });
  hist.record(durationMs, { provider, model }, options.context);
}

export function recordLlmError(
  provider: string,
  model: string,
  errorCode: string,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const errCounter = reg.counter(METRIC_LLM_ERRORS_TOTAL, {
    help: 'Total errors returned by LLM providers',
    unit: 'errors',
  });
  errCounter.increment({ provider, model, error_code: errorCode }, 1, options.context);
}

export function recordApiRequest(
  method: string,
  route: string,
  statusCode: number,
  durationMs: number,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const reqCounter = reg.counter(METRIC_API_REQUESTS_TOTAL, {
    help: 'Total HTTP requests served by API',
    unit: 'requests',
  });
  reqCounter.increment(
    { method: method.toUpperCase(), route, status_code: String(statusCode) },
    1,
    options.context,
  );

  const hist = reg.histogram(METRIC_API_REQUEST_DURATION_MS, {
    help: 'API HTTP request execution duration in milliseconds',
    unit: 'ms',
    buckets: DEFAULT_LATENCY_BUCKETS_MS,
  });
  hist.record(
    durationMs,
    { method: method.toUpperCase(), route, status_code: String(statusCode) },
    options.context,
  );
}

export function recordApiRateLimitRejection(
  route: string,
  limitType: string,
  options: { registry?: MetricRegistry; context?: CorrelationContext } = {},
): void {
  const reg = options.registry ?? defaultMetricRegistry;
  const counter = reg.counter(METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL, {
    help: 'Total requests rejected due to rate or concurrency limits',
    unit: 'rejections',
  });
  counter.increment({ route, limit_type: limitType }, 1, options.context);
}

// Initial registration of defaults
registerDefaultMetrics(defaultMetricRegistry);

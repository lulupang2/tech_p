/**
 * Baseline failure alert rules, threshold evaluator, and structured alert event generator.
 * All failure alerts retain structured correlation IDs and strictly redact sensitive payloads/secrets.
 */

import {
  type CorrelationContext,
  type LogLevel,
  type StructuredEvent,
  createStructuredEvent,
  normalizeCorrelationContext,
  redact,
} from './index.js';
import {
  type HistogramSummary,
  type MetricRegistry,
  type MetricRegistrySnapshot,
  METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL,
  METRIC_DB_POOL_SATURATION_RATIO,
  METRIC_DB_QUERY_DURATION_MS,
  METRIC_LLM_ERRORS_TOTAL,
  METRIC_LLM_REQUEST_DURATION_MS,
  METRIC_PIPELINE_STAGE_ERRORS_TOTAL,
  METRIC_QUEUE_LAG_SECONDS,
  METRIC_SOURCE_FRESHNESS_SECONDS,
} from './metrics.js';

export type AlertSeverity = 'info' | 'warn' | 'error' | 'critical';
export type AlertCondition = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';
export type AlertStatus = 'firing' | 'normal';
export type EvaluationTarget = 'value' | 'p95' | 'p99' | 'p50' | 'sum' | 'count';

export interface AlertRule {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly severity: AlertSeverity;
  readonly metricName: string;
  readonly condition: AlertCondition;
  readonly threshold: number;
  readonly unit: string;
  readonly evaluationTarget?: EvaluationTarget;
  readonly labelFilters?: Readonly<Record<string, string>>;
}

export interface AlertEvaluationResult {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly condition: AlertCondition;
  readonly threshold: number;
  readonly observedValue: number;
  readonly unit: string;
  readonly description: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly timestamp: string;
  readonly context?: CorrelationContext;
}

export const DEFAULT_ALERT_RULES: readonly AlertRule[] = [
  {
    id: 'alert_source_freshness_stale',
    name: 'Source Freshness Stale',
    description: 'Data source freshness lag exceeds 24 hours baseline threshold',
    severity: 'warn',
    metricName: METRIC_SOURCE_FRESHNESS_SECONDS,
    condition: 'gt',
    threshold: 86400,
    unit: 'seconds',
  },
  {
    id: 'alert_pipeline_stage_errors',
    name: 'Pipeline Stage Errors High',
    description: 'Pipeline stage error counter exceeded error baseline threshold',
    severity: 'error',
    metricName: METRIC_PIPELINE_STAGE_ERRORS_TOTAL,
    condition: 'gt',
    threshold: 5,
    unit: 'errors',
  },
  {
    id: 'alert_queue_lag_high',
    name: 'Queue Processing Lag High',
    description: 'Queue processing lag exceeds 5 minutes threshold',
    severity: 'warn',
    metricName: METRIC_QUEUE_LAG_SECONDS,
    condition: 'gt',
    threshold: 300,
    unit: 'seconds',
  },
  {
    id: 'alert_db_latency_p95_high',
    name: 'Database Query p95 Latency High',
    description: 'Database query p95 latency exceeds 2000ms threshold',
    severity: 'warn',
    metricName: METRIC_DB_QUERY_DURATION_MS,
    evaluationTarget: 'p95',
    condition: 'gt',
    threshold: 2000,
    unit: 'ms',
  },
  {
    id: 'alert_db_pool_saturation',
    name: 'Database Pool Saturation High',
    description: 'Database connection pool saturation reached 90% or higher',
    severity: 'error',
    metricName: METRIC_DB_POOL_SATURATION_RATIO,
    condition: 'gte',
    threshold: 0.9,
    unit: 'ratio',
  },
  {
    id: 'alert_llm_latency_p95_high',
    name: 'LLM Request p95 Latency High',
    description: 'LLM request p95 latency exceeds 15000ms threshold',
    severity: 'warn',
    metricName: METRIC_LLM_REQUEST_DURATION_MS,
    evaluationTarget: 'p95',
    condition: 'gt',
    threshold: 15000,
    unit: 'ms',
  },
  {
    id: 'alert_llm_errors_high',
    name: 'LLM Provider Errors High',
    description: 'LLM provider error counter exceeded threshold',
    severity: 'error',
    metricName: METRIC_LLM_ERRORS_TOTAL,
    condition: 'gt',
    threshold: 5,
    unit: 'errors',
  },
  {
    id: 'alert_api_rate_limit_rejections',
    name: 'API Rate Limit Rejections High',
    description: 'API rate limit rejections exceeded threshold',
    severity: 'warn',
    metricName: METRIC_API_RATE_LIMIT_REJECTIONS_TOTAL,
    condition: 'gt',
    threshold: 50,
    unit: 'rejections',
  },
] as const;

function isConditionMet(observed: number, condition: AlertCondition, threshold: number): boolean {
  if (Number.isNaN(observed)) return false;
  switch (condition) {
    case 'gt':
      return observed > threshold;
    case 'gte':
      return observed >= threshold;
    case 'lt':
      return observed < threshold;
    case 'lte':
      return observed <= threshold;
    case 'eq':
      return observed === threshold;
  }
}

function extractValueFromSample(
  sampleValue: unknown,
  target: EvaluationTarget = 'value',
): number | null {
  if (typeof sampleValue === 'number') {
    return Number.isFinite(sampleValue) ? sampleValue : null;
  }
  if (sampleValue && typeof sampleValue === 'object') {
    const summary = sampleValue as Partial<HistogramSummary>;
    if (target === 'p95') return summary.p95 ?? null;
    if (target === 'p99') return summary.p99 ?? null;
    if (target === 'p50') return summary.p50 ?? null;
    if (target === 'sum') return summary.sum ?? null;
    if (target === 'count') return summary.count ?? null;
    return summary.p95 ?? summary.p50 ?? summary.sum ?? null;
  }
  return null;
}

function matchesLabelFilters(
  sampleLabels: Record<string, unknown>,
  filters?: Readonly<Record<string, string>>,
): boolean {
  if (!filters) return true;
  for (const [key, value] of Object.entries(filters)) {
    if (String(sampleLabels[key] ?? '') !== value) {
      return false;
    }
  }
  return true;
}

export interface EvaluateAlertOptions {
  readonly rules?: readonly AlertRule[];
  readonly context?: CorrelationContext;
  readonly clock?: () => string;
}

export function evaluateAlerts(
  source: MetricRegistrySnapshot | MetricRegistry,
  options: EvaluateAlertOptions = {},
): AlertEvaluationResult[] {
  const clock = options.clock ?? (() => new Date().toISOString());
  const rules = options.rules ?? DEFAULT_ALERT_RULES;
  const snapshot = 'exportSnapshot' in source ? source.exportSnapshot(clock) : source;
  const results: AlertEvaluationResult[] = [];

  for (const rule of rules) {
    const matchedMetric = snapshot.metrics.find((m) => m.name === rule.metricName);
    if (!matchedMetric || matchedMetric.samples.length === 0) {
      // Default normal state when no sample exists
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        status: 'normal',
        condition: rule.condition,
        threshold: rule.threshold,
        observedValue: 0,
        unit: rule.unit,
        description: rule.description,
        timestamp: clock(),
        ...(options.context ? { context: normalizeCorrelationContext(options.context) } : {}),
      });
      continue;
    }

    // Filter samples if labelFilters are configured
    const filteredSamples = matchedMetric.samples.filter((s) =>
      matchesLabelFilters(s.labels as Record<string, unknown>, rule.labelFilters),
    );

    if (filteredSamples.length === 0) {
      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        status: 'normal',
        condition: rule.condition,
        threshold: rule.threshold,
        observedValue: 0,
        unit: rule.unit,
        description: rule.description,
        timestamp: clock(),
        ...(options.context ? { context: normalizeCorrelationContext(options.context) } : {}),
      });
      continue;
    }

    for (const sample of filteredSamples) {
      const observed = extractValueFromSample(sample.value, rule.evaluationTarget) ?? 0;
      const firing = isConditionMet(observed, rule.condition, rule.threshold);
      const sampleContext = sample.context
        ? normalizeCorrelationContext(sample.context)
        : undefined;
      const mergedContext = normalizeCorrelationContext({
        ...sampleContext,
        ...options.context,
      });

      const stringLabels: Record<string, string> = {};
      for (const [k, v] of Object.entries(sample.labels)) {
        stringLabels[k] = String(v);
      }

      results.push({
        ruleId: rule.id,
        ruleName: rule.name,
        severity: rule.severity,
        status: firing ? 'firing' : 'normal',
        condition: rule.condition,
        threshold: rule.threshold,
        observedValue: observed,
        unit: rule.unit,
        description: rule.description,
        labels: stringLabels,
        timestamp: clock(),
        ...(Object.keys(mergedContext).length > 0 ? { context: mergedContext } : {}),
      });
    }
  }

  return results;
}

export function createAlertStructuredEvent(
  alert: AlertEvaluationResult,
  options: { service?: string; clock?: () => string } = {},
): StructuredEvent {
  const service = options.service ?? 'observability';
  const timestamp = options.clock ? options.clock() : alert.timestamp;
  let level: LogLevel = 'info';
  if (alert.status === 'firing') {
    level = alert.severity === 'critical' || alert.severity === 'error' ? 'error' : 'warn';
  }

  const rawData = {
    ruleId: alert.ruleId,
    ruleName: alert.ruleName,
    severity: alert.severity,
    status: alert.status,
    condition: alert.condition,
    threshold: alert.threshold,
    observedValue: alert.observedValue,
    unit: alert.unit,
    description: alert.description,
    ...(alert.labels && Object.keys(alert.labels).length > 0 ? { labels: alert.labels } : {}),
  };

  const safeData = redact(rawData) as Record<string, unknown>;

  return createStructuredEvent({
    event: `alert.${alert.status}`,
    service,
    level,
    ...(alert.context ? { context: alert.context } : {}),
    fields: safeData,
    timestamp,
  });
}

export interface TestAlertOptions {
  readonly ruleId?: string;
  readonly ruleName?: string;
  readonly severity?: AlertSeverity;
  readonly status?: AlertStatus;
  readonly condition?: AlertCondition;
  readonly threshold?: number;
  readonly observedValue?: number;
  readonly unit?: string;
  readonly description?: string;
  readonly labels?: Record<string, string>;
  readonly context?: CorrelationContext;
  readonly service?: string;
  readonly clock?: () => string;
}

export function createTestAlertEvent(options: TestAlertOptions = {}): StructuredEvent {
  const result: AlertEvaluationResult = {
    ruleId: options.ruleId ?? 'test_alert_rule',
    ruleName: options.ruleName ?? 'Test Failure Alert Baseline',
    severity: options.severity ?? 'warn',
    status: options.status ?? 'firing',
    condition: options.condition ?? 'gt',
    threshold: options.threshold ?? 10,
    observedValue: options.observedValue ?? 42,
    unit: options.unit ?? 'test_units',
    description:
      options.description ?? 'Deterministic test alert event with verified correlation tracking',
    labels: options.labels ?? { test: 'true', environment: 'verification' },
    timestamp: options.clock ? options.clock() : new Date().toISOString(),
    ...(options.context ? { context: normalizeCorrelationContext(options.context) } : {}),
  };

  return createAlertStructuredEvent(result, {
    service: options.service ?? 'observability',
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

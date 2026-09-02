import assert from 'node:assert/strict';
import { describe, test } from 'vitest';

import {
  Counter,
  DEFAULT_ALERT_RULES,
  Gauge,
  Histogram,
  METRIC_API_REQUESTS_TOTAL,
  METRIC_DB_POOL_SATURATION_RATIO,
  METRIC_DB_QUERY_DURATION_MS,
  METRIC_LLM_ERRORS_TOTAL,
  METRIC_LLM_REQUEST_DURATION_MS,
  METRIC_LLM_TOKEN_USAGE_TOTAL,
  METRIC_PIPELINE_STAGE_ERRORS_TOTAL,
  METRIC_PIPELINE_STAGE_TOTAL,
  METRIC_QUEUE_LAG_SECONDS,
  METRIC_SOURCE_FRESHNESS_SECONDS,
  MetricRegistry,
  REDACTED_VALUE,
  createAlertStructuredEvent,
  createDashboardSnapshot,
  createTestAlertEvent,
  evaluateAlerts,
  recordApiRateLimitRejection,
  recordApiRequest,
  recordDbPool,
  recordDbQuery,
  recordLlmError,
  recordLlmUsage,
  recordPipelineStage,
  recordQueueLag,
  recordSourceFreshness,
} from '../src/index.js';

describe('Metric primitives and Registry', () => {
  test('Counter increments accurately with labels and correlation context', () => {
    const counter = new Counter({ name: 'test_counter', help: 'A test counter', unit: 'items' });
    counter.increment({ stage: 'normalize', status: 'success' }, 3, { requestId: 'req_1' });
    counter.increment({ stage: 'normalize', status: 'success' }, 2, { runId: 'run_1' });
    counter.increment({ stage: 'dedup', status: 'success' }, 1);

    assert.equal(counter.get({ stage: 'normalize', status: 'success' }), 5);
    assert.equal(counter.get({ stage: 'dedup', status: 'success' }), 1);
    assert.equal(counter.get({ stage: 'embed', status: 'success' }), 0);

    const samples = counter.collect();
    assert.equal(samples.length, 2);
    const normalizeSample = samples.find((s) => s.labels['stage'] === 'normalize');
    assert.ok(normalizeSample);
    assert.equal(normalizeSample.value, 5);
    assert.equal(normalizeSample.context?.requestId, 'req_1');
    assert.equal(normalizeSample.context?.runId, 'run_1');
  });

  test('Counter rejects negative increment', () => {
    const counter = new Counter({ name: 'test_counter_neg', help: 'A test counter' });
    assert.throws(() => {
      counter.increment({ stage: 'test' }, -1);
    }, /cannot be incremented by negative value/);
  });

  test('Gauge sets, increments, and decrements values accurately', () => {
    const gauge = new Gauge({ name: 'test_gauge', help: 'A test gauge', unit: 'seconds' });
    gauge.set(42, { source: 'github_releases' }, { jobId: 'job_42' });
    assert.equal(gauge.get({ source: 'github_releases' }), 42);

    gauge.increment({ source: 'github_releases' }, 8);
    assert.equal(gauge.get({ source: 'github_releases' }), 50);

    gauge.decrement({ source: 'github_releases' }, 20);
    assert.equal(gauge.get({ source: 'github_releases' }), 30);

    const samples = gauge.collect();
    assert.equal(samples.length, 1);
    assert.equal(samples[0]?.value, 30);
    assert.equal(samples[0]?.context?.jobId, 'job_42');
  });

  test('Histogram computes deterministic percentiles and buckets', () => {
    const hist = new Histogram({
      name: 'test_latency_ms',
      help: 'Test latency',
      unit: 'ms',
      buckets: [10, 50, 100, 500, 1000],
    });

    const values = [5, 20, 45, 80, 150, 400, 900];
    for (const v of values) {
      hist.record(v, { operation: 'select' }, { queryId: 'query_1' });
    }

    const summary = hist.get({ operation: 'select' });
    assert.equal(summary.count, 7);
    assert.equal(summary.sum, 5 + 20 + 45 + 80 + 150 + 400 + 900);
    assert.equal(summary.min, 5);
    assert.equal(summary.max, 900);
    assert.equal(summary.p50, 80);
    assert.equal(summary.p95, 900);

    assert.equal(summary.buckets[10], 1);
    assert.equal(summary.buckets[50], 3);
    assert.equal(summary.buckets[100], 4);
    assert.equal(summary.buckets[500], 6);
    assert.equal(summary.buckets[1000], 7);
  });

  test('MetricRegistry exports Prometheus format and snapshot with distinct dimensions', () => {
    const registry = new MetricRegistry();
    const counter = registry.counter('test_requests_total', {
      help: 'Total test requests',
      unit: 'requests',
    });
    const gauge = registry.gauge('test_memory_bytes', {
      help: 'Memory in bytes',
      unit: 'bytes',
    });

    counter.increment({ method: 'GET', code: '200' }, 10);
    gauge.set(1048576, { instance: 'worker-1' });

    const prometheusText = registry.exportPrometheus();
    assert.ok(prometheusText.includes('# HELP test_requests_total Total test requests'));
    assert.ok(prometheusText.includes('# TYPE test_requests_total counter'));
    assert.ok(prometheusText.includes('test_requests_total{code="200",method="GET"} 10'));
    assert.ok(prometheusText.includes('# HELP test_memory_bytes Memory in bytes'));
    assert.ok(prometheusText.includes('# TYPE test_memory_bytes gauge'));
    assert.ok(prometheusText.includes('test_memory_bytes{instance="worker-1"} 1048576'));

    const snapshot = registry.exportSnapshot(() => '2026-09-02T12:00:00.000Z');
    assert.equal(snapshot.timestamp, '2026-09-02T12:00:00.000Z');
    assert.equal(snapshot.metrics.length, 2);
  });
});

describe('Standard Observability Signals & Helpers', () => {
  test('records source freshness, pipeline stages, queue lag, DB, LLM, and API metrics separately', () => {
    const registry = new MetricRegistry();
    const correlation = { requestId: 'req_obs_1', sourceId: 'github_releases', runId: 'run_obs_1' };

    recordSourceFreshness('github_releases', 120, { registry, context: correlation });
    recordPipelineStage('raw_fetch', 'success', {
      sourceId: 'github_releases',
      count: 50,
      registry,
      context: correlation,
    });
    recordPipelineStage('normalize', 'error', {
      sourceId: 'github_releases',
      errorType: 'parse_error',
      count: 2,
      registry,
      context: correlation,
    });
    recordQueueLag('collection_queue', 15, {
      jobType: 'poll',
      waitingJobs: 3,
      activeJobs: 1,
      registry,
      context: correlation,
    });
    recordDbQuery('select_citations', 'answer_citations', 45, { registry, context: correlation });
    recordDbPool('primary', 4, 0.4, { registry, context: correlation });
    recordLlmUsage('anthropic', 'claude-3-haiku', 150, 80, 850, { registry, context: correlation });
    recordLlmError('anthropic', 'claude-3-haiku', 'rate_limited', {
      registry,
      context: correlation,
    });
    recordApiRequest('POST', '/api/v1/answers', 200, 920, { registry, context: correlation });
    recordApiRateLimitRejection('/api/v1/answers', 'concurrency_cap', {
      registry,
      context: correlation,
    });

    const snapshot = registry.exportSnapshot();
    const metricNames = snapshot.metrics.map((m) => m.name);

    assert.ok(metricNames.includes(METRIC_SOURCE_FRESHNESS_SECONDS));
    assert.ok(metricNames.includes(METRIC_PIPELINE_STAGE_TOTAL));
    assert.ok(metricNames.includes(METRIC_PIPELINE_STAGE_ERRORS_TOTAL));
    assert.ok(metricNames.includes(METRIC_QUEUE_LAG_SECONDS));
    assert.ok(metricNames.includes(METRIC_DB_QUERY_DURATION_MS));
    assert.ok(metricNames.includes(METRIC_DB_POOL_SATURATION_RATIO));
    assert.ok(metricNames.includes(METRIC_LLM_REQUEST_DURATION_MS));
    assert.ok(metricNames.includes(METRIC_LLM_TOKEN_USAGE_TOTAL));
    assert.ok(metricNames.includes(METRIC_LLM_ERRORS_TOTAL));
    assert.ok(metricNames.includes(METRIC_API_REQUESTS_TOTAL));
  });
});

describe('Alert Threshold Evaluation and Failure Alert Baseline', () => {
  test('contains all baseline alert rules in DEFAULT_ALERT_RULES', () => {
    assert.ok(DEFAULT_ALERT_RULES.length >= 7);
    const ruleIds = DEFAULT_ALERT_RULES.map((r) => r.id);
    assert.ok(ruleIds.includes('alert_source_freshness_stale'));
    assert.ok(ruleIds.includes('alert_pipeline_stage_errors'));
    assert.ok(ruleIds.includes('alert_queue_lag_high'));
    assert.ok(ruleIds.includes('alert_db_latency_p95_high'));
    assert.ok(ruleIds.includes('alert_db_pool_saturation'));
    assert.ok(ruleIds.includes('alert_llm_latency_p95_high'));
    assert.ok(ruleIds.includes('alert_llm_errors_high'));
  });

  test('evaluates baseline alert rules and detects firing alerts when threshold is exceeded', () => {
    const registry = new MetricRegistry();
    const fixedTime = '2026-09-02T12:00:00.000Z';

    // Set source freshness to 100,000s (> 86400s threshold)
    recordSourceFreshness('arxiv', 100000, { registry });
    // Set pipeline errors to 10 (> 5 threshold)
    recordPipelineStage('embed', 'error', { count: 10, errorType: 'timeout', registry });
    recordQueueLag('ingest', 450, { registry });
    // Set DB pool saturation to 0.95 (>= 0.90 threshold)
    recordDbPool('default', 19, 0.95, { registry });

    const alerts = evaluateAlerts(registry, { clock: () => fixedTime });

    const staleAlert = alerts.find((a) => a.ruleId === 'alert_source_freshness_stale');
    assert.ok(staleAlert);
    assert.equal(staleAlert.status, 'firing');
    assert.equal(staleAlert.observedValue, 100000);
    assert.equal(staleAlert.severity, 'warn');

    const stageErrorAlert = alerts.find((a) => a.ruleId === 'alert_pipeline_stage_errors');
    assert.ok(stageErrorAlert);
    assert.equal(stageErrorAlert.status, 'firing');
    assert.equal(stageErrorAlert.observedValue, 10);
    assert.equal(stageErrorAlert.severity, 'error');

    const queueLagAlert = alerts.find((a) => a.ruleId === 'alert_queue_lag_high');
    assert.ok(queueLagAlert);
    assert.equal(queueLagAlert.status, 'firing');
    assert.equal(queueLagAlert.observedValue, 450);

    const poolAlert = alerts.find((a) => a.ruleId === 'alert_db_pool_saturation');
    assert.ok(poolAlert);
    assert.equal(poolAlert.status, 'firing');
    assert.equal(poolAlert.observedValue, 0.95);
  });

  test('reports normal status when metrics are within safe baseline thresholds', () => {
    const registry = new MetricRegistry();
    const fixedTime = '2026-09-02T12:00:00.000Z';

    recordSourceFreshness('github_releases', 3600, { registry });
    recordPipelineStage('normalize', 'error', { count: 1, errorType: 'parse_error', registry });
    recordQueueLag('ingest', 30, { registry });
    recordDbPool('default', 5, 0.25, { registry });

    const alerts = evaluateAlerts(registry, { clock: () => fixedTime });

    for (const alert of alerts) {
      assert.equal(alert.status, 'normal');
    }
  });

  test('emits structured alert events with correlation context and without sensitive payloads', () => {
    const alertResult = {
      ruleId: 'alert_pipeline_stage_errors',
      ruleName: 'Pipeline Stage Errors High',
      severity: 'error' as const,
      status: 'firing' as const,
      condition: 'gt' as const,
      threshold: 5,
      observedValue: 12,
      unit: 'errors',
      description: 'Pipeline stage error counter exceeded baseline error threshold',
      labels: { stage: 'dedup', secretToken: 'secret-auth-key-12345' },
      timestamp: '2026-09-02T12:00:00.000Z',
      context: {
        requestId: 'req_alert_test',
        jobId: 'job_pipeline_1',
        sourceId: 'stack_exchange',
      },
    };

    const structuredEvent = createAlertStructuredEvent(alertResult);

    assert.equal(structuredEvent.schemaVersion, 1);
    assert.equal(structuredEvent.event, 'alert.firing');
    assert.equal(structuredEvent.level, 'error');
    assert.equal(structuredEvent.service, 'observability');
    assert.equal(structuredEvent.requestId, 'req_alert_test');
    assert.equal(structuredEvent.jobId, 'job_pipeline_1');
    assert.equal(structuredEvent.sourceId, 'stack_exchange');

    assert.ok(structuredEvent.data);
    const labels = structuredEvent.data['labels'] as Record<string, unknown>;
    assert.equal(labels['stage'], 'dedup');
    assert.equal(labels['secretToken'], REDACTED_VALUE);
  });

  test('createTestAlertEvent produces valid verifiable test alert event with correlation IDs', () => {
    const testEvent = createTestAlertEvent({
      ruleId: 'alert_test_verification',
      ruleName: 'Test Alert Verification Event',
      severity: 'warn',
      observedValue: 99,
      context: {
        requestId: 'req_test_verified',
        queryId: 'query_test_verified',
      },
      labels: {
        authorizationHeader: 'Bearer should-be-redacted-token-here',
        environment: 'ci-verification',
      },
    });

    assert.equal(testEvent.event, 'alert.firing');
    assert.equal(testEvent.level, 'warn');
    assert.equal(testEvent.requestId, 'req_test_verified');
    assert.equal(testEvent.queryId, 'query_test_verified');
    assert.ok(testEvent.data);
    const labels = testEvent.data['labels'] as Record<string, unknown>;
    assert.equal(labels['environment'], 'ci-verification');
    assert.equal(labels['authorizationHeader'], REDACTED_VALUE);
  });
});

describe('Dashboard Baseline Snapshot', () => {
  test('creates structured dashboard snapshot with separated dimensions and no composite scores', () => {
    const registry = new MetricRegistry();
    const fixedTime = '2026-09-02T12:00:00.000Z';

    recordSourceFreshness('github_releases', 1800, { registry });
    recordSourceFreshness('npm_downloads', 95000, { registry });

    recordPipelineStage('fetch', 'success', { sourceId: 'github_releases', count: 100, registry });
    recordPipelineStage('fetch', 'error', { sourceId: 'github_releases', count: 2, registry });
    recordPipelineStage('normalize', 'success', {
      sourceId: 'github_releases',
      count: 98,
      registry,
    });

    recordQueueLag('worker_jobs', 45, { waitingJobs: 12, activeJobs: 3, registry });

    recordDbQuery('select_documents', 'documents', 120, { registry });
    recordDbQuery('select_documents', 'documents', 250, { registry });
    recordDbPool('primary', 8, 0.4, { registry });

    recordLlmUsage('openai', 'gpt-4o-mini', 200, 100, 1200, { registry });
    recordLlmError('openai', 'gpt-4o-mini', 'rate_limited', { registry });

    recordApiRequest('GET', '/api/v1/sources', 200, 15, { registry });
    recordApiRequest('POST', '/api/v1/answers', 500, 1500, { registry });
    recordApiRateLimitRejection('/api/v1/answers', 'rate_limiter', { registry });

    const dashboard = createDashboardSnapshot(registry, { clock: () => fixedTime });

    assert.equal(dashboard.schemaVersion, 1);
    assert.equal(dashboard.timestamp, fixedTime);

    // 1. Source Freshness
    assert.equal(dashboard.sourceFreshness.length, 2);
    const ghFreshness = dashboard.sourceFreshness.find((s) => s.sourceId === 'github_releases');
    assert.equal(ghFreshness?.status, 'fresh');
    assert.equal(ghFreshness?.lagSeconds, 1800);
    const npmFreshness = dashboard.sourceFreshness.find((s) => s.sourceId === 'npm_downloads');
    assert.equal(npmFreshness?.status, 'stale');

    // 2. Pipeline Stages
    assert.equal(dashboard.pipelineStages.length, 2);
    const fetchStage = dashboard.pipelineStages.find((s) => s.stage === 'fetch');
    assert.equal(fetchStage?.totalProcessed, 102);
    assert.equal(fetchStage?.errorsTotal, 2);

    // 3. Queue Lag
    assert.equal(dashboard.queueLag.length, 1);
    assert.equal(dashboard.queueLag[0]?.queue, 'worker_jobs');
    assert.equal(dashboard.queueLag[0]?.waitingJobs, 12);
    assert.equal(dashboard.queueLag[0]?.activeJobs, 3);

    // 4. Database
    assert.equal(dashboard.database.queryLatencyMs.count, 2);
    assert.equal(dashboard.database.activeConnections, 8);
    assert.equal(dashboard.database.poolSaturationRatio, 0.4);

    // 5. LLM
    assert.equal(dashboard.llm.tokenUsage.prompt, 200);
    assert.equal(dashboard.llm.tokenUsage.completion, 100);
    assert.equal(dashboard.llm.tokenUsage.total, 300);
    assert.equal(dashboard.llm.errorsTotal, 1);
    assert.equal(dashboard.llm.byProvider['openai']?.requests, 1);

    // 6. API
    assert.equal(dashboard.api.requestsTotal, 2);
    assert.equal(dashboard.api.errorCount5xx, 1);
    assert.equal(dashboard.api.rateLimitRejectionsTotal, 1);

    // 7. Active Alerts
    assert.ok(dashboard.alerts.length > 0);
    assert.equal(dashboard.activeAlertCount, 1);
  });
});

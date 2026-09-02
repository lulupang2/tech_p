# TechPulse Observability & Monitoring Design

- 상태: Implemented baseline (OPS-002)
- 작성일: 2026-09-02
- 기준: [SSOT](./SSOT.md), [ARCHITECTURE §9](./ARCHITECTURE.md), [SECURITY](./SECURITY.md)

---

## 1. 개요와 설계 원칙

TechPulse의 관측성(Observability) 체계는 외부 개발 기술 신호 수집, 정규화, 중복 제거, 색인, 검색/RAG 질의 전 과정의 건전성과 지연시간을 투명하게 추적하고 장애 발생 시 신속하게 탐지하기 위한 구조화 로깅, 메트릭 수집 및 장애 알림 베이스라인을 정의한다.

### 1.1 핵심 원칙

1. **독립된 물리 단위와 차원 보존 (No Unexplained Composite Score)**:
   - 서로 다른 단위와 성격의 지표(`seconds`, `items`, `ms`, `tokens`, `errors`, `ratio`)를 임의의 가중치로 합산하여 모호한 종합 점수("인기 지수", "건전성 점수")로 만들지 않는다.
   - 각 메트릭은 명확한 물리적 단위와 차원 레이블(`source_id`, `stage`, `provider`, `model`, `queue`, `operation`)을 독립적으로 유지한다.
2. **구조화 상관관계 식별자 전파 (Structured Correlation IDs)**:
   - 모든 로그, 메트릭 샘플, 장애 알림 이벤트는 통일된 상관관계 식별자(`requestId`, `runId`, `jobId`, `sourceId`, `queryId`)를 유지하여 인과 관계를 추적한다.
3. **엄격한 비밀 정보 및 페이로드 마스킹 (Redaction & Sanitization)**:
   - `token`, `cookie`, `authorization`, `secret`, `payload`, `password` 등 민감 키와 값은 로그와 알림 데이터에 노출되지 않도록 재귀적으로 `[REDACTED]` 처리한다.
4. **결정적 테스트와 네트워크 비의존성 (Deterministic & Zero External Network)**:
   - 메트릭 레지스트리, 히스토그램 분위수 계산, 알림 임계치 평가는 외부 네트워크나 시간 변동성에 의존하지 않는 순수 결정적 동작을 보장한다.

---

## 2. 메트릭 카탈로그 (Standard Metrics Catalog)

모든 표준 메트릭은 `@techpulse/observability`의 `MetricRegistry`를 통해 등록 및 수집된다.

| 메트릭 이름 | 유형 | 단위 | 레이블 | 설명 |
|---|---|---|---|---|
| `techpulse_source_freshness_seconds` | Gauge | `seconds` | `source_id` | 소스별 데이터 수집 최신성 지연시간 (`now - last_successful_timestamp`) |
| `techpulse_pipeline_stage_total` | Counter | `items` | `stage`, `status`, `source_id` | 파이프라인 단계별 처리 건수 (raw_fetch, normalize, dedup, cluster, embed, publish) |
| `techpulse_pipeline_stage_errors_total` | Counter | `errors` | `stage`, `error_type`, `source_id` | 파이프라인 단계별 오류 발생 누적 건수 |
| `techpulse_queue_lag_seconds` | Gauge | `seconds` | `queue`, `job_type` | 대기열 처리 지연 시간 (초) |
| `techpulse_queue_waiting_jobs` | Gauge | `jobs` | `queue` | 큐에서 처리 대기 중인 작업 수 |
| `techpulse_queue_active_jobs` | Gauge | `jobs` | `queue` | 워커에서 현재 실행 중인 작업 수 |
| `techpulse_db_query_duration_ms` | Histogram | `ms` | `operation`, `table` | 데이터베이스 쿼리 실행 지연시간 (p50, p90, p95, p99) |
| `techpulse_db_pool_active_connections` | Gauge | `connections` | `pool` | 데이터베이스 커넥션 풀 활성 연결 수 |
| `techpulse_db_pool_saturation_ratio` | Gauge | `ratio` | `pool` | 데이터베이스 커넥션 풀 포화율 (`active / max`, 0.0 ~ 1.0) |
| `techpulse_llm_request_duration_ms` | Histogram | `ms` | `provider`, `model` | LLM 공급자 API 요청 지연시간 (p50, p95, p99) |
| `techpulse_llm_token_usage_total` | Counter | `tokens` | `provider`, `model`, `token_type` | LLM 토큰 사용량 (`prompt`, `completion`, `total`) |
| `techpulse_llm_errors_total` | Counter | `errors` | `provider`, `model`, `error_code` | LLM 공급자 호출 실패 건수 |
| `techpulse_api_requests_total` | Counter | `requests` | `method`, `route`, `status_code` | API HTTP 요청 누적 건수 |
| `techpulse_api_request_duration_ms` | Histogram | `ms` | `method`, `route`, `status_code` | API HTTP 요청 지연시간 (p50, p95) |
| `techpulse_api_rate_limit_rejections_total` | Counter | `rejections` | `route`, `limit_type` | 레이트 리밋 / 동시성 제한 거부 건수 |

---

## 3. 장애 알림 베이스라인 및 임계치 평가 (Alert Baseline & Threshold Evaluation)

`evaluateAlerts(snapshot, rules)`는 메트릭 스냅샷을 기반으로 사전에 정의된 임계치를 검사하여 알림 상태(`firing` / `normal`)를 판정한다.

### 3.1 기본 알림 규칙 (Default Alert Rules)

| 규칙 ID | 규칙명 | 심각도 | 대상 메트릭 | 조건 | 임계치 | 단위 |
|---|---|---|---|---|---|---|
| `alert_source_freshness_stale` | Source Freshness Stale | `warn` | `techpulse_source_freshness_seconds` | `>` | 86,400 (24h) | `seconds` |
| `alert_pipeline_stage_errors` | Pipeline Stage Errors High | `error` | `techpulse_pipeline_stage_errors_total` | `>` | 5 | `errors` |
| `alert_queue_lag_high` | Queue Processing Lag High | `warn` | `techpulse_queue_lag_seconds` | `>` | 300 (5m) | `seconds` |
| `alert_db_latency_p95_high` | Database Query p95 Latency High | `warn` | `techpulse_db_query_duration_ms` (p95) | `>` | 2,000 | `ms` |
| `alert_db_pool_saturation` | Database Pool Saturation High | `error` | `techpulse_db_pool_saturation_ratio` | `>=` | 0.90 (90%) | `ratio` |
| `alert_llm_latency_p95_high` | LLM Request p95 Latency High | `warn` | `techpulse_llm_request_duration_ms` (p95) | `>` | 15,000 | `ms` |
| `alert_llm_errors_high` | LLM Provider Errors High | `error` | `techpulse_llm_errors_total` | `>` | 5 | `errors` |
| `alert_api_rate_limit_rejections` | API Rate Limit Rejections High | `warn` | `techpulse_api_rate_limit_rejections_total` | `>` | 50 | `rejections` |

### 3.2 구조화 알림 이벤트 (`StructuredEvent`) 규격

발화된 알림은 `createAlertStructuredEvent` 및 `createTestAlertEvent`를 통해 표준 구조화 이벤트로 변환된다.

```json
{
  "schemaVersion": 1,
  "event": "alert.firing",
  "level": "error",
  "service": "observability",
  "timestamp": "2026-09-02T12:00:00.000Z",
  "requestId": "req_alert_example",
  "sourceId": "github_releases",
  "data": {
    "ruleId": "alert_pipeline_stage_errors",
    "ruleName": "Pipeline Stage Errors High",
    "severity": "error",
    "status": "firing",
    "condition": "gt",
    "threshold": 5,
    "observedValue": 12,
    "unit": "errors",
    "description": "Pipeline stage error counter exceeded baseline error threshold",
    "labels": {
      "stage": "normalize",
      "source_id": "github_releases"
    }
  }
}
```

---

## 4. 대시보드 스냅샷 규격 (Dashboard Snapshot)

`createDashboardSnapshot(registry)`는 모니터링 UI 및 운영 API에서 시스템 상태를 일괄 파악할 수 있는 정형화된 스냅샷을 제공한다.

```typescript
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
```

각 하위 영역은 해당 영역의 독립적인 물리 수치만 표현하며 불투명한 종합 지수를 생성하지 않는다.

---

## 5. 보안 및 마스킹 정책 (Security & Redaction)

- **로그 및 알림 페이로드**: `redact()` 함수를 통해 민감 필드명(`token`, `cookie`, `authorization`, `secret`, `payload`, `password`, `key`)과 일치하는 속성 값을 `[REDACTED]`로 치환한다.
- **상관관계 식별자 보존**: `requestId`, `runId`, `jobId`, `sourceId`, `queryId`는 마스킹 대상에서 제외되어 장애 추적성을 보장한다.
- **프로바이더 원문 보호**: LLM 호출 및 외부 소스 원문 본문은 에러 이벤트 및 메트릭 레이블에 포함하지 않고 메타데이터(토큰 수, 지연시간, 에러 코드)만 수집한다.

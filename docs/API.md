# Signal Archive API Design

- 상태: Draft contract
- 작성일: 2026-09-01
- 형식: JSON over HTTP 추천
- 2026-09-08: [ADR-0015](./adr/0015-coverage-driven-collection-retrieval.md) 확장 승인. 아래 coverage/ops 확장은 COV-001 계약·COV-008 구현 전이다.
- base path: `/api/v1` 추천

백엔드 프레임워크와 server runtime은 [ADR-0001](./adr/0001-backend-framework.md)과 `DEC-002`에서 **Node runtime 위의 Elysia**로 Accepted됐다. streaming 방식은 아직 미결정이지만 외부 계약은 framework에 독립적이다. 구현 시 OpenAPI 문서를 생성하고 contract test의 기준으로 사용한다.

## 1. 공통 규칙

- 요청·응답 content type은 `application/json`이다.
- 모든 timestamp는 RFC 3339 UTC 문자열이다.
- 기간은 `from` inclusive, `to` exclusive다.
- 상대 기간은 서버가 계산한 절대 범위로 응답에 되돌려준다.
- 모든 응답은 `requestId`를 포함하거나 `X-Request-Id` header로 제공한다.
- 클라이언트가 보낸 request ID는 형식·길이를 검증하고 내부 trace ID와 구분한다.
- enum과 object는 알 수 없는 필드를 기본 거부해 계약 drift를 조기에 발견한다. **이 동작은 framework 기본값이 아니므로 명시적으로 설정한다.** `EXP-005` 측정에서 Elysia와 Fastify 모두 기본 설정에서는 알 수 없는 요청 필드를 오류로 처리하지 않고 조용히 제거했다. Elysia는 `normalize: false`, Fastify는 ajv `removeAdditional: false`와 스키마의 `additionalProperties: false`를 함께 설정해야 거부된다. 근거는 [EXP-005 run 2](./experiments/EXP-005-foundation-spike.md)에 있다.
- 검증 실패는 `400`으로 응답한다. framework가 다른 코드를 내면 응답 계약 경계에서 매핑한다. Elysia는 검증 실패에 `422`를 반환하므로 매핑이 필요하다.
- 응답 스키마에 선언되지 않은 필드는 제거한다. 이는 두 framework의 기본 동작으로 확인됐으나 회귀 테스트로 고정한다.
- 외부 계약 필드는 `camelCase`를 사용한다. 데이터베이스의 `snake_case` 이름을 그대로 노출하지 않는다. 용어 대응은 [GLOSSARY.md](./GLOSSARY.md)를 따른다.

## 2. Public endpoints

### 2.1 `POST /api/v1/answers`

자연어 질문에 대한 근거 기반 답변을 생성한다.

#### Request

```json
{
  "question": "최근 한 달간 Bun과 Node.js에 대한 관심 변화를 비교해줘.",
  "timeRange": {
    "from": "2026-08-01T00:00:00Z",
    "to": "2026-09-01T00:00:00Z"
  },
  "timezone": "Asia/Seoul",
  "language": "ko"
}
```

`timeRange`, `timezone`, `language`는 선택 입력이다. question은 빈 문자열을 허용하지 않으며 byte/character 상한을 둔다.

#### Success `200`

```json
{
  "requestId": "req_...",
  "answerId": "ans_...",
  "status": "answered",
  "intent": "compare_interest",
  "resolvedTimeRange": {
    "from": "2026-08-01T00:00:00Z",
    "to": "2026-09-01T00:00:00Z",
    "timezone": "Asia/Seoul"
  },
  "answer": "... [C1] ... [C2]",
  "observations": [
    {
      "subject": "Bun",
      "metric": "community_mentions",
      "value": 42,
      "unit": "deduplicated_documents",
      "change": null
    }
  ],
  "citations": [
    {
      "id": "C1",
      "documentRevisionId": "rev_...",
      "title": "...",
      "source": "github_releases",
      "url": "https://example.com/original",
      "publishedAt": "2026-08-20T00:00:00Z",
      "excerpt": "...",
      "excerptIsVerbatim": true,
      "license": {
        "id": "cc-by-sa-4.0",
        "name": "CC BY-SA 4.0",
        "url": "https://creativecommons.org/licenses/by-sa/4.0/",
        "attribution": "..."
      }
    }
  ],
  "coverage": {
    "dataFreshThrough": "2026-09-01T00:15:00Z",
    "sourcesUsed": 3,
    "documentsConsidered": 18,
    "limitations": ["npm download data was unavailable for 2 days"]
  }
}
```

`change`는 비교 가능한 기준값이 없으면 `null`이다. citation URL은 모델 출력이 아니라 저장된 metadata에서 채운다. `documentRevisionId`는 답변 재현을 위해 immutable revision을 가리키며 내부 surrogate ID를 그대로 노출할지는 미결정이다.

`observations[].metric`은 다음 enum이다. 단위가 다른 지표를 합산하거나 종합 점수로 만들지 않는다.

| metric | unit |
|---|---|
| `community_mentions` | `deduplicated_documents` |
| `issue_discussion` | `comments`, `reactions`, `interactions` |
| `repo_attention` | `stars`, `new_repositories` |
| `source_diversity` | `sources` |
| `release_activity` | `releases` |
| `paper_activity` | `submissions` |
| `model_activity` | `models`, `datasets`, `downloads` |
| `package_downloads` | `downloads` |

`repo_attention`은 수집 시작 이후 구간만 존재한다. 요청 기간이 그 이전을 포함하면 `coverage.limitations`에 명시한다.

#### 필드 존재 규칙

계약 drift를 막기 위해 optional 여부를 고정한다.

| 필드 | 규칙 |
|---|---|
| `status` | 항상 존재. enum `answered`, `insufficient_evidence`, `unsupported_intent` |
| `answer` | `answered`에서 non-empty string, 그 외 `null` |
| `resolvedTimeRange` | 항상 존재. 요청이 기간을 주지 않아도 서버 계산 결과를 반환 |
| `observations` | 항상 배열. 해당 없으면 `[]`이며 필드를 생략하지 않음 |
| `citations` | 항상 배열. `answered`에서는 최소 1개 |
| `coverage` | 항상 존재. `limitations`는 항상 배열 |
| `intent` | 항상 존재. 해석 실패는 `unsupported_intent`로 표현 |
| `citations[].license` | source가 라이선스를 요구하면 항상 존재. `attribution`은 저장된 template에서 생성하며 모델이 만들지 않는다 |
| `citations[].excerptIsVerbatim` | 항상 존재. `verbatim_only` source는 반드시 `true`이며 발췌가 원문과 일치해야 한다 |

배열 필드를 상황에 따라 생략하거나 `null`로 바꾸지 않는다.

라이선스 표시 규칙은 다음과 같다.

- 귀속이 필요한 source의 발췌를 반환하면서 `license`를 생략하지 않는다. 생략해야 하는 상황이면 그 발췌를 반환하지 않는다.
- `attribution` 문자열은 `source_rights.attribution_template`과 revision의 실제 값으로 서버가 조립한다.
- 라이선스 귀속 설계가 승인되기 전에는 귀속이 필요한 source의 `excerpt`를 반환하지 않는다. 이 경우 citation은 title, url, publishedAt만 포함한다.

#### Evidence insufficient `200`

근거 부족은 인프라 오류가 아니므로 유효한 결과로 반환한다.

```json
{
  "requestId": "req_...",
  "answerId": "ans_...",
  "status": "insufficient_evidence",
  "intent": "trend_summary",
  "resolvedTimeRange": {
    "from": "2026-08-25T00:00:00Z",
    "to": "2026-09-01T00:00:00Z",
    "timezone": "UTC"
  },
  "answer": null,
  "observations": [],
  "citations": [],
  "coverage": {
    "dataFreshThrough": "2026-09-01T00:15:00Z",
    "sourcesUsed": 0,
    "documentsConsidered": 0,
    "limitations": ["요청 기간의 근거가 충분하지 않습니다."]
  }
}
```

### 2.2 `GET /api/v1/sources`

사용자가 데이터 커버리지를 이해할 수 있도록 공개 source의 상태를 반환한다. 내부 URL, credential, raw 오류 본문은 노출하지 않는다.

주요 필드: `key`, `displayName`, `kind`, `lastSuccessfulCollectionAt`, `freshThrough`, `status`, `coverageNotes`.

`status`는 `healthy`, `stale`, `degraded`, `disabled` enum이며 `/api/v1/answers`의 `coverage`와 같은 관측 값에서 계산한다. 두 endpoint가 같은 시점에 모순된 freshness를 보고하지 않아야 한다.

### 2.3 `GET /api/v1/topics`

지원하는 canonical topic과 alias 일부를 검색·페이지 처리해 반환한다. 자유 입력 질문을 대체하는 endpoint가 아니라 UI 자동완성용이다.

제안 query: `q`, `cursor`, `limit`. offset pagination보다 stable cursor를 추천한다.

### 2.4 List 응답 envelope

모든 list endpoint는 같은 envelope를 사용한다.

```json
{
  "requestId": "req_...",
  "items": [],
  "page": {
    "nextCursor": null,
    "limit": 20
  }
}
```

- `items`는 항상 배열이며 결과가 없으면 `[]`다.
- `nextCursor`가 `null`이면 마지막 page다.
- cursor는 opaque 문자열이며 client가 해석·생성하지 않는다.
- `limit`은 서버 최대값으로 clamp하고 clamp된 값을 응답에 되돌려준다.

### 2.5 `GET /api/v1/coverage` (승인 설계, 구현 대기)

bounded topic IDs와 UTC from/to를 검증하고 generatedAt, window, 독립 문서 raw/lexical/vector 준비 수, 확인한 partition의 완료/partial 수, 부족 이유를 반환한다. 정확한 TypeBox schema와 입력 상한은 COV-001 contract manifest에 고정한다. 내부 cursor/partition payload/provider budget/권리 검토 원문은 공개하지 않는다.

기존 `/api/v1/answers` envelope와 세 answer status는 유지한다. `coverage.limitations`에 부족 원인·cohort 분모/누락·외부 취득 제한을 요약하고 구조화 CoverageReport는 query run 및 이 endpoint에서 다룬다. 기존 strict client에 미선언 필드를 조용히 추가하지 않는다. COV-008이 API·web·OpenAPI·contract test를 함께 연결한다.

## 3. Operations endpoints

운영 endpoint는 public API와 별도 prefix·인증·rate limit을 사용한다. 공개 데모에서 외부 노출하지 않는 것이 기본 추천이다.

| Method | Path | 목적 |
|---|---|---|
| GET | `/health/live` | 프로세스 event loop가 응답하는지 확인 |
| GET | `/health/ready` | 필수 DB 및 serving dependency 준비 여부 |
| GET | `/api/v1/ops/collection-runs` | source/status/기간별 실행 조회 |
| GET | `/api/v1/ops/collection-runs/{id}` | 단계별 count와 sanitized 오류 확인 |
| POST | `/api/v1/ops/collection-runs` | 승인된 source의 수동 수집 요청 |
| POST | `/api/v1/ops/pipeline-replays` | raw item/run의 bounded 재처리 |

기존 보호 ops 표면을 재사용하며 수동 실행/replay의 auth·idempotency·기간/item 상한·audit를 유지한다. ADR-0015의 target 등록/후보 검토, partition plan dry-run/상태/재개, 불명확 work 대사는 같은 보호 경계 안에 추가한다. COV-001이 route/CLI manifest를 확정하고 COV-008이 runtime에 연결한다. target enable은 권리 승인을 대신하지 않는다.

## 4. Error model

```json
{
  "requestId": "req_...",
  "error": {
    "code": "INVALID_TIME_RANGE",
    "message": "timeRange.to must be after timeRange.from",
    "details": [
      { "path": "timeRange.to", "reason": "must_be_after_from" }
    ],
    "retryable": false
  }
}
```

| HTTP | code 예 | 의미 |
|---|---|---|
| 400 | `INVALID_REQUEST`, `INVALID_TIME_RANGE` | schema·의미 검증 실패 |
| 401/403 | `UNAUTHENTICATED`, `FORBIDDEN` | 보호 endpoint 접근 실패 |
| 404 | `NOT_FOUND` | 존재하지 않는 공개 resource |
| 409 | `RUN_ALREADY_ACTIVE`, `IDEMPOTENCY_CONFLICT` | 상태 충돌 |
| 413 | `REQUEST_TOO_LARGE` | 입력 상한 초과 |
| 429 | `RATE_LIMITED` | 사용량 제한, `Retry-After` 포함 |
| 502 | `MODEL_PROVIDER_ERROR` | upstream 오류, 내부 내용 비노출 |
| 503 | `DEPENDENCY_UNAVAILABLE` | 일시적인 serving dependency 장애 |
| 504 | `ANSWER_TIMEOUT` | bounded answer deadline 초과 |

stack trace, SQL, provider body, secret는 응답에 포함하지 않는다.

## 5. 동기·비동기·스트리밍 Alternatives

| 방식 | 장점 | 단점 |
|---|---|---|
| 동기 JSON | 가장 단순하고 테스트·재시도 의미가 명확 | 긴 LLM latency 동안 연결 유지 |
| SSE | 진행 상태와 token streaming UX | reconnect/idempotency, citation 확정 시점 복잡 |
| async job + polling | 긴 작업·재개에 적합 | UI와 상태 저장 복잡, MVP 과도 가능 |

**Recommendation:** MVP는 deadline이 있는 동기 JSON으로 시작한다. p95 또는 UX 목표를 충족하지 못할 때 SSE를 ADR로 제안한다. 아직 확정 결정은 아니다.

## 6. Rate limit과 idempotency

- public answer endpoint는 IP/API client 단위의 짧은 burst와 일일 quota를 둔다.
- 실제 수치와 사용자 식별 방식은 배포·비용 결정 후 확정한다.
- ADR-0015 범위에는 answer cache/idempotency 신규 도입을 포함하지 않는다. 반복 요청 비용은 context/output cap과 persistent budget으로 제한하며 캐시는 보존·TTL·삭제 무효화 별도 결정 후 검토한다.
- operations POST는 `Idempotency-Key`를 필수로 한다.
- 같은 key에 다른 body가 오면 `409 IDEMPOTENCY_CONFLICT`를 반환한다.
- request admission quota와 provider token/spend budget은 다른 통제다. budget은 PostgreSQL 예약·정산으로 동시 요청·재시작에도 유지한다. 호출 결과 불명확 상태를 무과금 실패로 처리하지 않는다.
- 질문 보완은 ADR-0015의 1 round/2 search/3 documents/8 HTTP attempts/10초 상한과 전체 deadline을 함께 지킨다. 부족해도 무제한 재검색·background 탐색을 하지 않는다.

## 7. Versioning과 호환성

- breaking change는 path major version을 올린다.
- enum 추가에 대한 client 정책을 문서화하되 서버 입력은 strict하게 유지한다.
- OpenAPI diff를 CI에서 검사하는 것을 추천한다.
- citation과 metric의 의미가 바뀌면 필드 이름 또는 schema version을 변경하며 조용히 재해석하지 않는다.

## 8. 미결정 사항

- 응답 streaming 도입 여부
- 공개 데모 인증·rate-limit 기준
- answer 원문 저장·재조회 endpoint 여부
- 기존 보호 operations 표면은 유지하며 확장 route/CLI 상세는 COV-001 manifest로 고정한다. 인증·권한 강도는 낮추지 않는다.
- OpenAPI client generation 범위

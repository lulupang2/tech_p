# Coverage Collection Implementation Contracts

- 상태: Approved design contract; production 구현 전
- 기준일: 2026-09-08
- 근거: [SSOT §3.4](./SSOT.md), [ADR-0015 A1–A6](./adr/0015-coverage-driven-collection-retrieval.md)
- 실행 계획: [TASKS §12](../TASKS.md), [코딩 지시서](./COVERAGE_IMPLEMENTATION.md)

이 문서는 병렬 구현의 공통 의미·소유 경계를 고정한다. 실제 export/type/schema는 COV-001, persistence는 COV-002가 구현한다. 코드가 없는 상태를 구현 완료로 표시하지 않는다. source 권리, provider/model, 지출·cadence·target 활성화 승인은 별도다.

## 1. 승인과 구현의 경계

- 기존 Node/TypeBox/Drizzle/Neon/BullMQ와 domain port 방향을 유지한다. 새 DB·queue·검색 provider를 도입하지 않는다.
- source는 정책 경계, adapter는 허용된 프로토콜 구현, target은 adapter의 한 repository/site+tag/feed/query/package다. 기존 source enum을 target 수만큼 늘리지 않는다.
- 원문→chunk lineage는 불변이다. 취득 목적·cohort는 다대다 acquisition으로 연결하고 raw의 첫 run을 덮어쓰지 않는다.
- raw/revision별 권리와 현재 source/target disable·tombstone 상태를 모두 확인한다. seed 등록·키 존재·relaxed flag는 권리/provider 승인 근거가 아니다.
- provider-neutral 서비스와 fake 검증은 모델 승인 전에 구현 가능하다. 새/변경 provider adapter의 실호출과 선정은 DEC-007 및 DEC-012 전에는 불가다.

## 2. Target, partition, page

### 식별자와 시간

새 영속 record ID는 UUID, 외부 JSON은 camelCase, DB는 snake_case다. hash는 canonical JSON/bytes의 SHA-256이며 객체 key 순서·날짜·숫자 표현을 결정적으로 고정한다. 기존 ID를 의미 없이 재발급하지 않는다.

| 객체 | 필수 의미/키 |
|---|---|
| CollectionTarget | id, sourceId, adapterType, canonicalIdentity, enabled=false 기본값; `(sourceId, adapterType, canonicalIdentity)` unique |
| TargetRevision | id, targetId, configHash, typed selector, topic IDs/taxonomy version, capability, policyVersion, createdAt; `(targetId, configHash, policyVersion)` unique; append-only |
| Capability | historyMode, timeBasis, stablePagination, supported operations(collect/search/discover), source bound와 reviewedAt; 지원하지 않는 동작은 명시 거부 |
| CollectionPartition | id, targetRevisionId, mode, scopeKey, window `{from,to}`, timeBasis, workflowVersion, state, nextDueAt; 아래 자연 키 unique |
| Checkpoint | partitionId PK, pageSequence, opaqueCursor, cursorVersion, committedAt, continuationAt, reason, leaseEpoch; version/CAS 갱신 |
| CollectionRun | 기존 run에 partition/page/attempt 관계 추가; 한 partition의 여러 실패·재시도 이력을 보존 |

mode는 `backfill`, `incremental`, `on_demand`. historyMode는 `historical_range`, `paginated_history`, `feed_only`, `snapshot_only`. timeBasis는 `published_at`, `updated_at`, `observed_at`. 사용자 기간 판정은 원 게시일을 사용하며 incremental 변경 탐지는 updated_at을 쓸 수 있다. observed_at을 원 게시일로 치환하지 않는다.

partition 자연 키는 `(targetRevisionId, mode, scopeKey, from, to, timeBasis, workflowVersion)`다. 정규 수집의 scopeKey는 versioned 관측 집합 ID 또는 명시적 비집계 수집 계획 ID, on-demand는 queryRunId다. 질문 원문을 key로 저장하지 않는다. 겹치는 partition의 raw는 자연 키로 dedup하지만 각 취득 membership을 보존한다.

pageSequence는 0부터 시작한다. cursor는 한 target revision·partition·adapter cursorVersion에만 유효하다. legacy multi-target cursor를 여러 target에 복제하지 않는다. UTC `[from,to)`의 경계를 외부 API 표현으로 변환하고 결과를 다시 로컬 검증한다. feed 종료는 해당 feed 조회 완료이지 과거 기간 전체 coverage 증명이 아니다.

### CollectorPagePort

`collectPage(request)`의 입력은 검증된 target revision, partition window/timeBasis, cursor, page limit, request/byte budget, AbortSignal, 주입 clock이다. source-neutral domain port에 HTTP client/Drizzle/BullMQ type을 넣지 않는다. canonical URL과 external ID namespace는 기존 provenance 규칙을 재사용한다.

반환은 `items`, `nextCursor`, `disposition`, `reason`, `retryAt`, 실제 fetched/retained/bytes/HTTP attempt 수다.

- disposition: `continue`, `complete`, `deferred`, `partial`.
- `continue`: 다음 cursor가 있고 진전해야 한다. cursor 불변 반복은 오류다.
- `complete`: 요청한 capability 범위에서 exhaust를 확인했을 때만 허용한다.
- `deferred`: rate/backoff/실행 예산 대기로 이어서 처리할 수 있다. 성공 완료로 집계하지 않는다.
- `partial`: provider result cap, history unsupported, 불완전 pagination 등 전체 확보를 증명할 수 없는 종료다.
- cursor 진전은 source에서 본 항목 기준이다. 권리/기간 필터 뒤 items=0이어도 다음 page를 놓치지 않는다.
- 한 호출이 임의의 다음 repository/tag로 이동하지 않는다. multi-target 순환은 planner가 target별 partition으로 처리한다.

초기 backfill horizon은 90일이며 source capability·권리·운영 예산 안에서만 적용한다. 빈 source와 오류/중단을 동일한 complete로 만들지 않는다.

## 3. 영속성, stage와 delivery

### 물리 소유와 테이블

COV-002가 `packages/database/src/schema/index.ts`와 새 forward migration을 독점한다. 승인된 개념의 물리 매핑은 다음과 같다.

| 테이블 | 책임 |
|---|---|
| `collection_targets`, `collection_target_revisions` | 대상과 불변 설정·capability·policy reference |
| `collection_partitions`, `collection_checkpoints` | 기간별 상태·cursor·lease/CAS |
| `acquisition_memberships` | raw/revision/run/partition/목적 연결; canonical unique 및 FK; 동일 원문의 다중 취득 보존 |
| `delivery_outbox` | collection/normalization/embedding 등 ID-only delivery, notBefore, lease, sentAt, completedAt |
| `observation_cohorts`, `observation_cohort_members` | 관측 방법·target revision·effective time·metric/unit 버전 |
| `embedding_work_items` | model profile별 work key·leaseEpoch·outcome 상태·완료 embedding reference |
| `provider_budget_scopes` | 승인 scope·currency·UTC bucket/미정산 exposure 한도와 누적 예약; row lock/CAS의 직렬화 경계 |
| `provider_budget_reservations` | 승인 budget scope/UTC bucket별 reservation·settlement·outcome; 원문 prompt 미저장 |
| `discovery_candidates` | 후보 canonical identity·발견 출처·검토 상태·target 승격 연결; 자동 enable 금지 |

revision에는 lexicalReadyAt, profile별 vector readiness는 embedding work 완료 및 해당 profile의 필수 chunk 전체 완료에서 계산한다. 기존 content/status lifecycle(`pending`/`searchable`/`tombstoned` 등)은 코드의 실제 union을 COV-001에서 확인하여 재사용한다. 새로운 readiness enum으로 기존 status를 무작정 rename하지 않는다. 아래 `lexical_ready`/`vector_ready`는 검색 capability 이름이지 tombstone을 대체하는 배타적 lifecycle가 아니다.

### CollectionStatePort와 transaction boundary

- `planPartition`: 자연 키로 중복 억제하고 initial delivery를 원자적으로 예약.
- `claimPage`: due/state/lease를 검사하고 증가하는 fencing epoch 반환.
- `commitPage`: expected pageSequence/leaseEpoch 검증 후 raw upsert + memberships + checkpoint + 미완료 후속 stage/continuation outbox를 **동일 transaction**으로 저장.
- `deferPage` / `failPage`: 명시적 reason·재개 시각·제한된 attempt 기록. stale worker의 write 거부.
- `claimDeliveries` / `markSent` / `markCompleted` / `reconcilePending`: 송신과 업무 완료를 분리. Redis 유실 시 sentAt만으로 완료라 판단하지 않고 DB의 미완료 delivery 재발행.

외부 fetch·LLM·queue await는 transaction 밖이다. 동시 source disable·정책 변경은 호출 직전과 commit/publish 시 재확인한다. raw가 이미 있어도 미완료 stage와 해당 acquisition을 복구하며 raw.isNew를 delivery 필요 여부로 쓰지 않는다. outbox resend는 같은 delivery ID, consumer는 DB stage completion을 기준으로 멱등 처리한다.

partition state: `pending`, `running`, `deferred`, `completed`, `partial`, `failed`, `cancelled`. page-level complete는 partition 완료 조건과 다를 수 있다. source/target disable은 새 작업을 거부하며 실행 중 작업도 bounded abort하고 checkpoint를 보존한다.

### Queue cutover

변경 queue payload는 `schemaVersion: 2`, `deliveryId`만 사용한다. job kind는 queue/job name과 DB delivery record에 저장하고 consumer가 일치 여부를 검증한다. payload에 URL·cursor·raw·query text·config를 넣지 않는다. 새 collection/normalization/replay/embedding producer와 consumer는 같은 버전으로 일괄 전환한다.

COV-001은 v2 계약을 추가하되 기존 실행 코드를 깨는 조기 rename을 하지 않는다. COV-008 통합에서 v1 producer 중지 → drain 또는 pending DB 재계획 → v2 consumer/producer 활성화 → v1 export/schema/호출부·오래된 테스트 제거를 완료한다. 개발 중 버전 공존을 production 호환 shim으로 출시하지 않는다. DB forward migration에 호환되지 않는 이전 image rollback을 자동 실행하지 않는다.

## 4. 관측 집합과 readiness

### CohortPort

`createCohortVersion`, `attachAcquisition`, `compareWindows`가 공통 의미다. membership은 targetRevisionId, query signature, 예정 cadence, metric/unit, effectiveAt을 고정한다. on-demand acquisition은 자동 trend 자격이 없다. 후속 정규 수집은 같은 raw에 새 membership을 붙인다.

비교는 두 기간의 동일 정의/단위·확인된 coverage를 가진 공통 target revision 집합에서만 수행한다. public 결과에 denominator와 excluded/partial 이유를 명시한다. 계산할 자료가 없으면 0을 생성하지 않는다. 실제 역사형 사건을 동일한 검증 방식으로 backfill한 경우만 과거 cohort에 편입한다. snapshot-only 과거와 기존 provenance 불명 자료를 baseline으로 소급 생성하지 않는다.

### SearchReadinessPort / CoveragePort

`markLexicalReady`는 유효 revision/chunks/rights 상태의 transaction에서만 동작한다. `getVectorReadiness(revisionId, modelProfile)`는 그 profile의 required chunks 완료를 요구한다. FTS에는 lexical_ready, vector에는 추가로 해당 profile vector_ready가 필요하며 양쪽 모두 현재 정책·time·tombstone 필터를 적용한다.

`getCoverage(topicIds, window, optional cohortId)`는 target/partition/source 준비 상태로 진단하고 query 결과 수만으로 원문 전체 존재 여부를 추론하지 않는다. report는 generatedAt, UTC window, known/raw/lexical/vector counts, checked/completed/partial partition counts, reasons를 분리한다. 페이지 상한과 집계 query 한도를 둔다. 관련 문서 수는 단순 chunk 수와 혼동하지 않는다.

reason code: `raw_shortage`, `processing_pending`, `period_gap`, `retrieval_miss`, `unknown`. 보조 정책 reason은 `rights_blocked`, `history_unsupported`, `source_unavailable`, `result_cap`, `budget_exhausted`, `deadline_exceeded`다. 여러 이유를 동시에 허용한다. retrieval_miss는 labeled relevant ready 문서가 실제 후보에서 빠졌다는 평가/trace 증거가 있을 때만 사용한다. 공개 응답에 내부 query/URL/credential/raw error를 넣지 않는다.

## 5. 모델 작업과 예산 계약

ModelProfile은 provider, model, immutable model/config version, dimensions(embedding), tokenizer/price version reference다. hash에 해당 profile과 input을 포함한다. 승인 reference가 없거나 모델/차원이 다르면 완료 결과를 재사용하지 않는다.

### EmbeddingWorkPort

`claimOrReadCompleted(workKey)`, `beginCall(workId, epoch, reservationId)`, `completeWork`, `markOutcomeUnknown`을 제공한다. state는 `pending`, `claimed`, `calling`, `completed`, `outcome_unknown`, `failed`다.

- pending→claimed에서 lease 확보. calling 직전에 승인·budget 재검사와 reservation 연결.
- calling 이후 lease가 만료되면 다른 worker가 자동 호출하지 않고 outcome_unknown으로 이동. claimed 상태에서 호출 전 종료된 작업만 안전하게 재claim 가능하다.
- 완성된 vector와 work completion을 같은 transaction으로 저장한다. 완료 input replay는 외부 호출 없이 반환한다.
- 외부 성공 후 local commit 전 crash는 exactly-once 보장이 불가능하다. 공식 idempotency/result lookup이 있으면 복구하고 없으면 운영 대사 대기. timeout을 무과금 실패로 분류하지 않는다.

### ProviderBudgetPort

`reserve(attemptId, approvedScope, lane, maximumUsage)`, `settle`, `holdUnknown`, `releaseUnsent`를 제공한다. attemptId unique로 예약 중복을 막고 shared scope/UTC bucket을 transaction lock/CAS로 갱신한다. lane은 chat/query_embedding/ingestion_embedding/search에 대응하며 전체 상한과 lane 상한을 함께 지킨다.

금액은 currency + 정수 최소 회계 단위/decimal numeric을 사용하고 부동소수 합산은 금지한다. UTC 일자 경계의 unknown 예약은 원 호출 bucket에 남고 미정산 총 exposure 상한에도 계속 포함한다. 늦게 돌아온 usage는 원 attempt에 정산한다. usage가 상한을 초과하면 실제값을 숨기거나 clamp하지 않고 이후 admission 차단과 알림을 수행한다.

provider/model/가격·tokenizer·output cap·운영 budget 승인/값이 없으면 paid call은 차단한다. usage 누락 시 단어 수를 billing token으로 쓰지 않는다. 환경에 key가 있다는 이유만으로 활성화하지 않는다. ledger는 승인된 범위의 알려진 maximum을 예약하는 애플리케이션 통제이며 provider의 청구 체계 밖 비용까지 보장한다고 주장하지 않는다.

## 6. 제한적 근거 취득 계약

SourceSearchPort는 typed entity/기간/허용 target policy에서 검색 요청을 구성한다. arbitrary URL/shell/LLM tool이 아니다. `searchCandidates`, `discoverTargets` 결과는 untrusted metadata이며 검색 권리가 확인된 경로만 사용한다. 최소 실제 adapter는 기존 GitHub/Stack Exchange/arXiv의 지원 가능한 승인 범위에서 구현하고 corpus/source gate 전에는 fixture transport로 검증한다. 새 유료 검색 공급자 선정은 제외한다.

BoundedAcquisitionService는 CoveragePort, SourceSearchPort, CollectorPagePort, CollectionStatePort, lexical normalization service, budget/clock/abort port를 소비한다. 1 round, 검색 2회, 원문 3건, HTTP attempts 8회(redirect 포함), 외부 단계 10초/남은 요청 시간 이내, 자동 retry 0을 넘을 수 없다. source별 더 엄격한 rate/byte 제한이 우선이다. 승인된 maxTotalBytes와 context/output token budget이 없으면 해당 외부/model 단계는 off다.

동기 answer의 검증된 부족 branch만 이 서비스를 호출한다. on-demand partition은 queryRunId scope이며 ingestion/rights/raw/chunk 경로를 재사용한다. lexical 문서 저장 후 재검색 한 번으로 근거를 조립한다. snippet·비보존 링크는 grounded citation이 아니다. deadline 이후 pending 취득을 숨겨서 background 무한 실행하지 않는다. 이미 commit된 bounded 후속 embedding도 명시된 정책·예산 안에서만 처리한다.

## 7. API 및 UI cutover

외부 answer status(`answered`, `insufficient_evidence`, `unsupported_intent`)와 기존 `/api/v1/answers` envelope 의미는 유지한다. 기존 `coverage.limitations`에 부족 원인·cohort 한계·외부 취득 제한을 사람이 읽을 수 있게 매핑하고, query run에는 구조화 report를 저장한다. 새 필드로 기존 strict client를 조용히 깨지 않는다.

추가 public endpoint `GET /api/v1/coverage`는 bounded topic/UTC from/to 입력과 위 CoverageReport를 반환한다. 내부 partition/cursor/provider budget/권리 원문은 ops에만 노출한다. typed TypeBox schema·OpenAPI·web client를 COV-001/COV-008에서 같이 반영한다. ready가 아닌 corpus를 질문 UI에서 충분하다고 표시하지 않는다.

보호된 기존 ops 표면에 target 등록/후보 검토, plan dry-run, partition 상태/재개, unknown work 대사 기능을 연결한다. 실제 route/CLI 이름은 COV-001의 contract manifest로 먼저 고정한다. scope/actor/auth/idempotency/bounds/audit는 필수다. 권리 승인과 enable action은 분리하고 아무 ops 입력도 신규 권리를 만들어내지 못하게 한다.

동기 JSON/deadline은 유지하고 SSE·answer cache·사용자 질문 원문 보존을 추가하지 않는다. contract상 breaking 변경이 불가피하다는 증거가 나오면 API 문서의 major version 규칙을 따르되 공통 계약 담당의 수정 전 sibling이 독자 변경하지 않는다.

## 8. 파일 소유권과 결과 규약

[지시서](./COVERAGE_IMPLEMENTATION.md)의 소유권이 경계다. COV-001의 contract manifest를 sibling이 읽은 후 COV-002 DB 구현을 완료한다. COV-003/004/005/006은 그 다음 병렬이다. COV-007은 이 네 결과 뒤, COV-008은 통합 뒤 실제 stack 증명을 담당한다. COV-009/010은 권리·운영·provider/평가 gate 뒤 실행한다.

모든 구현 세션은 format/lint/project-wide suite를 개별 작업 중 실행하지 않는다. 같은 checkout에서 병렬 편집 중에는 build/test도 생략하고, 담당 편집이 끝난 후 coordinator가 validation window를 부여하거나 격리된 worktree에서 focused 검증한다. 통합 담당은 마지막에 전체 static/unit/관련 integration/E2E를 한 번 수행한다. 테스트 skip을 PASS로 쓰지 않는다.

결과에는 task ID, 변경 파일, 실제 exports/signatures, dependency commit/artifact reference, 수행 명령과 관측 결과, 남은 gate를 포함한다. common schema/index/package manifest·lockfile 변경은 지정 소유자만 한다. 미구현 shim/no-op/fake success를 production에 남기지 않는다.

# ADR-0015: Coverage-driven collection and bounded retrieval expansion

- 상태: **Accepted**
- 작성일: 2026-09-08
- 결정: A1–A6 설계 방향을 채택한다. 세부 구현 계약은 [COLLECTION_CONTRACTS](../COLLECTION_CONTRACTS.md)를 따른다.
- 승인일 / 승인 주체: 2026-09-08 / 사용자
- 대체 관계: 기존 Accepted 기술 ADR을 대체하지 않는 확장 결정이다. PostgreSQL/pgvector, BullMQ, Node, deterministic workflow 경계를 유지하며 source 단위 수집·일괄 searchable 설계를 target/checkpoint·분리 readiness로 갱신한다.
- 범위: A1–A6 설계 승인 후 사용자가 같은 날 현재 세션의 구현·테스트 진행을 추가 승인했다. 별도 source/target 권리, provider/model, 지출·운영 활성화 gate는 유지한다.

## Context

사용자는 작은 corpus 때문에 데이터가 제대로 검색되지 않는다고 보고했다. 이를 문제의 전제로 삼는다. 운영 DB 접근으로 해당 보고를 재확인하지 않았다. 아래 근거는 저장소 코드 관찰이며, 운영 서버의 별도 cron이나 실제 청구액·corpus 크기는 확인하지 않았다.

| 병목 | 코드 근거 | 변경 이유 |
|---|---|---|
| 고정 대상 중심 | `packages/database/scripts/seed-mvp-sources.mjs`의 repository/tag/package 배열, `apps/worker/src/index.ts`의 `createCollectorForSource` | adapter 종류를 늘리기 전에 대상 등록·발견·활성화 경로가 필요 |
| 기간 계약이 실제 실행까지 전달되지 않음 | `packages/domain/src/collector.ts`의 `CollectionContext.timeWindow`; `packages/domain/src/ingestion.ts`의 `collector.collect`에는 기간 전달 없음 | 일정 기간의 backfill을 end-to-end 계약으로 만들어야 함 |
| 대상과 source가 scheduling identity에서 분리되지 않음 | `apps/worker/src/jobs.ts`의 `collectionJobNaturalKey`는 sourceKey/from/to 사용 | 동일 source의 여러 대상·config revision·수집 모드를 독립적으로 재개해야 함 |
| pagination은 있으나 의미가 adapter마다 다름 | GitHub/Stack Exchange의 multi-target cursor와 `hasMore`, article의 `hasMore: false` | 한 target의 한 page 계약과 종료·제한 도달을 구분해야 함 |
| 예약 구현과 process wiring 간 공백 | worker 진입점은 collection/normalization Worker를 시작하지만 주기적 collection enqueue 연결은 확인되지 않음 | 등록된 cadence가 실제 주기 실행을 보장하지 않음 |
| 반복 embedding 호출 | worker의 `embedRevision`은 기존 embedding 확인 없이 외부 호출 후 `onConflictDoNothing` | DB 저장 멱등성과 외부 호출 비용 멱등성을 분리해야 함 |
| 질문 시점 검색 범위·근거 경로 불충분 | API의 `enableLiveSearch: true`, RAG의 npm/GitHub/Wikipedia live fallback | 승인 source 기반의 제한된 근거 확보·저장·citation 경로로 교체해야 함 |
| 비용 상한이 query count에 한정 | API `DailyBudgetTracker`는 메모리 요청 수, chat payload에 output token 상한 없음 | 지속성 있는 admission quota와 실제 모델 사용량·예약 예산 필요 |
| source 수가 텍스트 근거 수를 뜻하지 않음 | source catalog의 document/metric 분리 | 다운로드·star snapshot을 늘려도 설명용 문서 공백은 해소되지 않음 |

[SSOT](../SSOT.md)의 raw 불변성, 개인정보 제거, revision/chunk citation, UTC, at-least-once, PostgreSQL authority, source 권리·접근 정책은 유지한다. 기존 `relaxedRightsMode` 또는 `ignoreLicenseCutoff` 코드 경로를 대량 수집의 근거로 사용하지 않는다.

## Decision drivers

1. 새 adapter 없이 같은 허용 API/feed 유형의 target을 추가할 수 있어야 한다.
2. 과거 수집과 최신 증분 수집은 서로의 cursor를 덮어쓰지 않아야 한다.
3. page limit, API 결과 상한, 정책 차단을 전체 수집 완료로 오인하지 않아야 한다.
4. 질문 수요가 늘어난 효과를 기술 관심 증가로 집계하지 않아야 한다.
5. 추가 확보한 문서는 검색·출처 검증까지 도달해야 한다.
6. 운영 예산과 모델 승인 없이 유료 호출을 활성화하지 않아야 한다.
7. 구현은 공통 계약 선행 후 독립 파일 소유권으로 병렬화할 수 있어야 한다.

## Alternatives

| 대안 | 장점 | 단점 | 판단 |
|---|---|---|---|
| 현재 목록과 limit만 확대 | 작은 변경, 즉시 적용하기 쉬움 | checkpoint·기간 전달·예약 연결·질문 밖 target 발견 문제를 남김 | 단기 보조 수단 |
| 대량 사전 수집만 사용 | 답변 시 지연이 작고 corpus 재현이 쉬움 | long-tail을 끝없이 선수집, 저장·embedding 비용, cold start | baseline에는 필요하나 단독 채택 안 함 |
| 모든 질문을 외부 검색에 의존 | 미리 쌓이지 않은 주제에 대응 | 호출 비용·지연·권리·citation 재현 문제, 트렌드 표본 불안정 | 단독 채택 안 함 |
| 자율 browsing agent | 넓은 탐색 가능 | 범위·비용·접근 정책 통제 어려움, 기존 비목표와 충돌 | 미채택 |
| 기준 corpus + target 발견 + 제한된 질문 시점 취득 | 축적·long-tail·추적성과 비용 제어를 함께 다룸 | target/coverage/budget state와 공통 계약 필요 | **채택** |

Neon 이관, 별도 vector DB, Kubernetes, 새 queue는 현재 병목 해결에 필수가 아니다. 기존 구성에서 측정 후 별도 결정한다.

## Decision (A1–A6)

### A1. Target 중심 수집과 durable checkpoint

source는 접근·권리 정책 경계, adapter는 프로토콜/문서 유형의 실행 구현, target은 repository/site+tag/feed/category/query/package 등 실제 수집 대상이다. 기존 `source_key`를 모든 target마다 새 enum으로 늘리지 않는다. 등록된 adapter가 지원하는 유형의 target은 설정 추가로 처리하고 새로운 프로토콜/본문 형식은 adapter 개발이 필요할 수 있다.

공통 개념 계약은 아래와 같다. [COLLECTION_CONTRACTS](../COLLECTION_CONTRACTS.md)가 구현 경계를 고정한다. 실제 production schema와 migration은 아직 구현되지 않았다.

| 개념 | 핵심 필드/불변 조건 |
|---|---|
| CollectionTarget | stable target ID, source ID, adapter type, canonical identity, enabled, policy reference |
| TargetRevision | immutable selector/query, config hash, topic mapping, capability snapshot, policy version; 변경은 새 revision |
| CollectionPartition | target revision, mode(backfill/incremental/on-demand), UTC `[from,to)`, workflow/config version; 한 실행 단위의 고유 키 |
| Checkpoint | partition ID, opaque adapter-versioned cursor, committed page sequence, completion/partial reason, continuation time; PostgreSQL authoritative |
| Acquisition membership | raw/revision과 수집 run/target/partition/목적 간 append-only 관계; 원문을 중복 저장하지 않고 여러 발견 경로 연결 |
| Delivery | queue에는 schema version과 partition/page 등 versioned ID만 전달; payload·URL·전체 config를 넣지 않음 |

한 page의 raw 멱등 저장, acquisition membership, checkpoint 진전, 후속 처리/continuation outbox를 짧은 동일 PostgreSQL transaction으로 commit한다. 외부 API 호출은 transaction 밖에서 실행한다. BullMQ 발행은 outbox dispatcher가 재시도한다. lease와 fencing/CAS로 오래된 worker가 checkpoint를 덮어쓰지 못하게 한다.

같은 raw가 이미 존재해도 새 acquisition membership과 누락된 후속 stage delivery는 복구한다. `isNew`만으로 후속 작업 필요 여부를 결정하지 않는다. 단계 결과와 delivery 멱등성은 별도로 관리한다.

collector의 반환은 한 target의 한 page를 뜻한다. 다음 page, 완료, quota 대기, API 결과 상한/과거 접근 불가를 명시적으로 구분한다. cursor의 schema/version·target revision·기간이 맞지 않으면 재사용하지 않는다. provider가 시간 범위를 inclusive로 받는 경우 adapter가 넓게 취득한 뒤 `[from,to)`를 결정적으로 적용한다. 게시일/수정일/관측일 중 어떤 시간축인지 capability와 partition에 기록한다.

### A2. 과거 수집 + 증분 수집 + 검토 기반 대상 발견

초기 backfill horizon은 승인된 topic/target의 최근 **90일**로 설계한다. 월별 비교 기준이 부족하거나 source가 지원하지 않으면 coverage에 한계를 표시한다. 90일은 보존 기간·운영 비용 승인이 아니며 실제 target 활성화와 예산은 별도 gate다.

1. 현재 seed target도 권리·본문·시각·pagination capability를 확인한 뒤 명시적으로 등록한다. 코드 목록 존재를 권리 승인으로 취급하지 않는다.
2. backfill은 기간과 page로 분할한다. 페이지/요청 예산 소진 시 checkpoint를 남겨 다음 실행에서 계속한다.
3. incremental은 독립 cursor와 overlap을 사용한다. 초기 backfill 중에도 최신 수집을 굶기지 않는다.
4. source/provider별 공용 rate limit 아래 incremental과 backfill에 별도 작업 예산을 배정한다. 낮은 concurrency의 단일 worker 배포로 시작 가능하다.
5. scheduler와 outbox dispatcher를 worker runtime에 연결한다. due 계산과 run 생성은 PostgreSQL 고유 제약/transaction으로 중복 억제하고, Redis 손실 시 pending DB 상태로 복구한다.
6. downtime 뒤 빠진 시간은 지원되는 역사형 API에서 gap partition으로 처리한다. 현재 snapshot만 제공하는 source의 과거 시점은 복원하지 않는다.
7. 승인된 API의 검색/공식 목록/feed에서 target 후보를 발견한다. 후보는 metadata와 provenance만 기록하고 자동으로 본문 취득·활성화하지 않는다. 검토된 target만 enabled로 전환한다.

과거 수집 capability는 `historical range`, `paginated history`, `feed-only`, `snapshot-only`처럼 구분한다. RSS에 없는 과거 글이나 GitHub Releases를 발행하지 않는 프로젝트를 수집 성공으로 위장하지 않는다. archive/sitemap/API 경로가 필요하면 해당 target 정책 검토를 거친다. GitHub 검색의 결과 상한은 가능한 범위 분할로 다루되, 분할 후에도 누락 가능성이 있으면 partial로 남긴다.

초기 확장은 기존 GitHub release 대상/관련 tag/arXiv 질의 등에서 시작한다. 모델 card, issue/discussion 본문, 새로운 blog/feed·도메인은 기존 metadata/metric 허용을 본문 권리로 확대 해석하지 않는다. 이 결정은 새 유료 검색 엔진을 선정하지 않는다.

### A3. 고정 관측 집합과 답변 보완 집합 분리

별도 DB 두 개를 만들지 않는다. raw/document는 공유하고 취득 목적과 집계 자격을 분리한다.

- **관측 집합(cohort)**: target revision 목록, query signature, 수집 방법·예정 간격, metric 정의, effective time, coverage version을 고정한다.
- **답변 보완 집합**: 발견 후보 또는 질문 시점 취득. 검색 근거로 사용 가능하지만 관측 집합 통계에는 자동 포함하지 않는다.
- on-demand로 먼저 발견한 문서가 추후 정규 수집에서도 관측되면 acquisition membership을 추가한다. 해당 문서의 원래 목적 필드를 덮어쓰지 않는다.
- target/query 추가는 새 cohort version이다. 이전·이후 전체 건수를 직접 비교하지 않는다.
- 두 기간에 같은 target revision/metric/unit이 있고 coverage가 확인된 공통 관측 집합만 비교한다. 분모, 기간, 누락, cohort 변경을 결과에 표시한다.
- 역사형 event를 검증 가능한 동일 방식으로 backfill한 경우에만 그 cohort의 과거 집계에 편입할 수 있다. snapshot-only 과거 데이터는 생성하지 않는다.
- 공통 집합이라도 API truncation, 장애, 삭제·생존 편향, 검색 노출 편향을 제거했다고 주장하지 않는다. 관측 범위의 변화이지 전체 생태계 모집단의 관심도 추정이 아님을 표시한다.

### A4. Coverage 기반 검색과 bounded 외부 근거 취득

기존 네 가지 intent를 유지한다. 일반 지식 챗봇이나 무제한 웹 검색 제품으로 확장하지 않는다.

흐름:

1. intent/entity/UTC 기간 해석 → topic alias/exact match + FTS + 가능한 vector 검색.
2. 실제 문서 관련성과 coverage/processing 상태를 함께 확인. 특정 영문 token 전부 포함 여부만으로 부족을 판정하지 않는다.
3. 충분하면 기존 근거로 답변한다. lexical 근거 충분성 기준이 충족되면 query embedding 생략 가능하되 실제 골든셋 비교로 품질을 확인한다.
4. 부족하고 권리·budget·source capability가 허용하면 승인된 source-search adapter에서 후보를 찾는다.
5. 후보 URL은 untrusted다. guard로 host/redirect/private IP/응답 크기/형식을 검증하고 승인된 원문만 취득한다. 개인정보를 제거한 immutable raw/revision/chunk를 기록한 뒤 citation을 부여한다.
6. 해당 요청의 lexical 근거로 사용할 준비가 되면, embedding 없이도 답변할 수 있다. 지속 semantic index는 별도 처리한다. `lexical_ready`와 model profile별 `vector_ready`를 분리하고 모든 검색에 동일한 권리·시각·tombstone 필터를 적용한다. 상태와 port 계약은 COLLECTION_CONTRACTS에 고정한다.
7. 제한 내 검증·보존을 마치지 못하면 로컬 근거만 사용하거나 `insufficient_evidence`와 제한 이유를 반환한다. 무제한 background 확장이나 agent 재탐색을 자동 실행하지 않는다.

초기 bounded 설계 상한(운영 활성화는 별도 승인):

| 제한 | 상한/조건 |
|---|---|
| 외부 탐색 round | 질문당 최대 1회 |
| 검색 API 요청 | 최대 2회 |
| 원문 취득 | 최대 3건; redirect와 retry도 공용 HTTP 요청 예산 안에서 계산 |
| 외부 HTTP 총 attempts | 최대 8회; source의 더 엄격한 제한이 우선 |
| 외부 취득 전체 deadline | 최대 10초, 전체 answer deadline의 남은 시간보다 길 수 없음 |
| 외부 단계 retry | 초기에는 자동 retry 없음. source backoff가 남은 deadline보다 길면 중단 |
| body/context/output | 기존 source size cap + 총 응답 byte 상한 + 모델별 token cap; 필요한 설정이 없으면 외부/model 호출 미활성화 |
| 금액·일일 token | 사용자/provider 승인 및 운영값 필요. 미설정이면 유료 호출 차단 |

이 수치는 승인된 설계 안전 상한이며 latency·quality 보장이나 실제 외부 호출 허가가 아니다. on-demand 작업이 정규 관측 수집의 quota를 고갈시키지 않도록 lane별 예산을 분리한다.

검색 결과 snippet이나 모델이 생성한 URL은 본문 근거를 대체하지 않는다. 원문 보존/모델 입력 권리가 없으면 링크 안내만 제공하며 grounded claim의 citation으로 사용하지 않는다. `verbatim_only`와 귀속 출시 gate는 그대로 유지한다. 기존 raw 보존 정책 범위에서만 저장하고 새 source/provider 전송·보존 권리는 별도 승인한다. 삭제/tombstone은 원문 연결 결과와 cache에도 반영한다.

Coverage 진단은 단일 원인을 억지로 확정하지 않고 복수 reason과 근거를 반환한다.

| 진단 | 판단 근거 | 대응 |
|---|---|---|
| 원문 부족 | 검토된 관련 target에서 취득 문서가 부족하거나 대상 자체가 없음 | target 발견·확장 |
| 처리 미완료 | raw는 있으나 정규화/chunk/권리/embedding 등 단계 미완료 | 실패 stage 재개; 권리 차단은 별도 표시 |
| 기간 공백 | target partition 미완료, historical 불가, source 장애, 날짜 unknown | 가능한 backfill 또는 한계 표시 |
| 검색 실패 | 관련성이 확인된 ready 문서가 후보에 없다는 evaluation/trace 증거 | alias/tokenization/ranking 보완 |

빈 검색 결과만으로 원문 부재와 검색 실패를 구분할 수는 없다. 진단 증거가 부족하면 미확인으로 남긴다. 기간 밖 문서를 숨겨서 섞거나 수집일을 게시일로 바꾸지 않는다.

### A5. Embedding 재사용과 지속성 있는 호출 예산

- 초기 dedup 단위는 chunk ID + input hash + provider + immutable model/config version + dimensions다. 다른 chunk 사이의 전역 content cache는 필수 범위가 아니다.
- 기존 완료 결과를 먼저 읽는다. 없다면 PostgreSQL unique work key와 lease/fencing으로 한 호출 소유자를 확보한다. 병렬 worker는 대기/완료 결과 재사용한다.
- provider 호출은 DB transaction 밖에서 수행하고 완료 결과와 work 상태를 원자적으로 저장한다. 완료된 chunk는 retry/replay에서 재호출하지 않는다.
- **외부 exactly-once는 보장하지 않는다.** provider 성공 직후 DB 저장 전 crash나 timeout이면 청구 여부가 불명확하다. provider가 공식 idempotency/result lookup을 지원하면 같은 key로 복구하고, 없으면 `outcome_unknown`으로 예산을 유지한 채 자동 재호출을 보류한다. 재처리는 운영자의 명시적 판단과 남은 예산 안에서만 허용한다.
- lexical readiness와 vector readiness를 분리해 모델 gate·embedding backlog 때문에 유효 문서 전체가 검색에서 사라지지 않게 한다. 권리 검증을 우회하는 fallback이 아니다.
- PostgreSQL budget ledger에서 호출 전 보수적 최대 사용량/금액을 예약하고 반환 usage로 정산한다. 동시 요청, 재시작, 실패, timeout, retry, chat/query embedding/ingestion embedding이 같은 상한에 반영된다.
- provider 가격·tokenizer·최대 출력 설정이 없으면 금액 상한을 계산했다고 주장하지 않는다. usage 누락 시 단어 수 추정치를 청구 token으로 쓰지 않고 예약을 유지·대사한다. provider dashboard의 hard cap 지원 여부는 별도 확인한다.
- request quota와 spend/token budget을 별도 이름으로 노출한다. raw prompt·개인정보를 비용 log에 저장하지 않는다.
- answer/query cache는 이번 필수 구현에서 제외한다. 질문 보존·TTL·corpus/model version·삭제 무효화 결정 없이 도입하지 않는다.

### A6. 공통 계약 선행, 기반 확보 후 외부 보완

2026-09-08 후속 사용자 지시로 현재 세션의 구현·테스트가 허용됐다. 별도 구현 세션을 자동 실행할 필요는 없으며, [TASKS](../../TASKS.md)와 [코딩 지시서](../COVERAGE_IMPLEMENTATION.md)의 소유 경계·의존성을 현재 세션에서도 따른다.

1. **공통 계약 담당(선행)**: domain/contracts, DB schema/migrations/ports, target/partition/checkpoint/outbox/acquisition/cohort/budget/work 상태와 API 진단 형태, 기존 데이터 이행 규칙을 확정한다. 이 경계는 직렬이다.
2. **독립 구현 묶음**: collector 역사/단일-target adapter, scheduler+outbox, embedding work+budget adapter, coverage query/API를 파일 소유권별로 분리한다. 작업자별 구체 파일은 실제 지시서에서 고정한다. 공통 파일 수정은 계약 담당에게 요청하고 병렬로 직접 고치지 않는다.
3. **통합 담당**: worker/API entrypoint, 운영 CLI/config/Compose, 기존 caller 이행, end-to-end wiring을 소유한다. 독립 구현 완료 후 실제 실행을 검증한다.
4. **질문 시점 취득 묶음**: 위 기반과 source/provider policy gate 뒤에 연결한다. 첫 묶음에서 가짜 성공/무조건 빈 결과를 넣어 완료 처리하지 않는다.
5. 기존 job payload/schema는 새 version으로 cutover한다. producer를 멈추고 기존 job을 drain하거나 DB 기록으로 재계획한 뒤 새 consumer를 활성화한다. rollback은 migration 호환성과 queue version을 함께 검토하고 무기한 dual reader/shim을 남기지 않는다.

과거 source-level cursor는 target별 의미를 검증할 수 있을 때만 이관한다. 검증 불가한 cursor를 복제하지 않고 bounded overlap 재수집으로 복구한다. 기존 citation/raw는 그대로 보존한다. 과거 취득 목적/cohort membership이 증명되지 않는 문서는 답변 검색에는 정책 범위에서 사용하되 검증된 trend baseline으로 소급 표기하지 않는다.

## Approval record and remaining gates

| 승인 결정 | 채택 내용 | 이 승인에 포함하지 않는 것 |
|---|---|---|
| A1 | target revision + partition/checkpoint + acquisition membership + transactional outbox | production migration 실행 |
| A2 | 기존 승인 target 중심 최근 90일 backfill, 증분·발견 경로 분리, 후보 검토 후 활성화 | 신규 source 권리 승인, 전체 target 무제한 활성화, 과거 snapshot 합성 |
| A3 | versioned 관측 집합과 질문 보완 집합 분리, 공통 coverage 기준 비교 | 전체 생태계 대표성·종합 관심 점수 주장 |
| A4 | 최대 1 round의 제한적 source 검색, 원문 검증·보존 후 citation, lexical/vector readiness 분리 | 유료 검색 provider 선정, 임의 웹 크롤링, 귀속 gate 해제 |
| A5 | 완료 embedding 재사용, ambiguous outcome 자동 재호출 보류, durable budget reservation | 특정 모델·금액·월 지출 승인, 외부 exactly-once 보장 |
| A6 | 공통 계약 선행 후 독립 파일별 병렬 구현, 통합 단일 담당 | 코딩 세션 자동 실행 |

A1–A6은 2026-09-08 사용자 승인 완료다. 별도 gate는 (1) 새 source/target별 접근·본문 저장·embedding·표시 권리, (2) provider/model 평가 및 지출, (3) 운영 daily budget/cadence/활성 target 적용이다. 이 결정은 실험 수치·법적 허용을 검증했다고 주장하지 않는다.

## Verification and implementation acceptance

### 설계 승인 시 확인한 것

- source/target 목록, port의 timeWindow/cursor, 실제 ingestion 전달, source-only job key, worker wiring, embedding 호출 순서의 정적 코드 근거.
- 기존 SSOT 및 ADR의 권리·provider gate와 이번 승인 범위 구분.
- 문서의 상대 링크와 ADR index 연결. 코드 실행·corpus 품질 검증은 아래 구현 acceptance와 분리한다.

### 승인 후 구현 acceptance

| 요구 | 실행 증거 |
|---|---|
| 기간 backfill 재개 | page 저장 전/후·outbox 발행 전/후 SIGKILL 후 재개. source fixture의 기대 고유 외부 ID 집합과 일치하고 누락 checkpoint가 없음; 결과 상한은 partial |
| 설정으로 target 추가 | 같은 adapter의 두 target을 같은 기간에 실행. 독립 cursor·run·결과를 유지하고 adapter 코드 수정 없이 새 target 등록 |
| 예약 실행 | 실제 Redis/BullMQ/PostgreSQL 환경에서 due enqueue→raw→후속 stage 실행. scheduler 중복 실행·Redis delivery 손실·재시작 후 DB pending 복구 |
| 네 가지 부족 원인 | 원문 부재, raw pending, partition gap, 알려진 관련 ready 문서 retrieval miss를 분리. runtime에 증거가 없는 경우 unknown으로 표시 |
| embedding 재사용 | 완료 input 재처리와 동시 worker에서 기존 결과 재사용. remote 성공/local commit 전 장애는 unknown으로 보류하고 자동 재과금하지 않음 |
| 외부 검색 안전성 | 로컬 충분 시 외부 호출 0; API request/redirect/byte/deadline/token/budget 초과 차단; 악성 URL·unapproved rights 거부; 실제 저장된 revision/chunk와 URL로 citation resolve |
| 트렌드 편향 방지 | on-demand 문서 추가만으로 기존 cohort 집계가 변하지 않음; cohort 변경/누락/단위 불일치 비교 차단 또는 명시적 partial |
| 비용 상한 | 병렬 예약이 합산 한도를 넘지 않고 재시작에도 유지; usage 누락·timeout에서 예약을 잘못 반환하지 않음 |
| 실제 검색 개선 | 기존 38개 평가 질문 + 5개 injection 항목의 고정 corpus baseline과 확장 corpus를 같은 model/config로 비교. 추가 topic·기간 부족 사례는 EVAL_GOLDEN_SET 변경으로 추적. raw measurement에 dataset hash, coverage, Recall/nDCG, abstention 적정성, citation 검증, latency, HTTP/token usage 기록 |

문서 개수만 증가한 것을 품질 개선으로 간주하지 않는다. live corpus의 추가 **관련 독립 근거**, 적절한 abstention, provenance 유지로 판단한다. 실제 품질·성능 acceptance threshold는 baseline 측정 후 승인하며, corpus·provider 게이트가 미충족이면 MVP 완료를 주장하지 않는다. source canary는 승인된 low-rate 실제 호출로 별도 확인하고 unit test는 network/clock/random/provider fake를 사용한다.

## Consequences and implementation status

- SSOT, PRD, ARCHITECTURE, DATA_PIPELINE, SOURCE_CATALOG, DATABASE, RAG, API, SECURITY, TESTING, OBSERVABILITY, RUNBOOK, EVAL_GOLDEN_SET, TASKS, TRACEABILITY, GLOSSARY에 승인 방향과 구현 대기를 반영한다. 새 source/model은 별도 승인 없이 추가하지 않는다.
- 기존 DONE은 기록된 과거 검증 범위다. 재설계 runtime의 완료로 재사용하지 않는다. wiring/provider 불일치의 잔여 acceptance는 COV 작업 및 기존 provider/RAG gate로 추적한다.
- target/partition/checkpoint/acquisition/cohort/readiness/budget reservation의 공통 계약과 상태 이름은 COLLECTION_CONTRACTS와 GLOSSARY에 등록한다.
- 새 backfill/scheduler/search path가 기존 relaxed rights flag를 상속하지 않도록 정리하고 source 정책 gate를 실제 경로에서 검증한다.
- source 대상 확장 전 중복 embedding 방어를 먼저 검증한다. FTS 기반 취득·검색 개선은 provider-neutral하게 준비할 수 있지만 승인되지 않은 모델 호출은 실행하지 않는다.
- [코딩 지시서](../COVERAGE_IMPLEMENTATION.md)는 승인된 계약, 담당 파일, 선행 task, 완료 기준, 검증 방법을 제공한다. 작성만으로 구현 task가 DONE이 되거나 구현 세션이 실행되지는 않는다.

## References

- [GitHub release endpoints](https://docs.github.com/en/rest/releases/releases)
- [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [BullMQ job schedulers](https://docs.bullmq.io/guide/job-schedulers/)
- [pgvector](https://github.com/pgvector/pgvector)

외부 링크는 공식 참고 자료이며 이번 분석에서 최신 quota·가격·이용 조건을 재검증한 것은 아니다.

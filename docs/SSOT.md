# Signal Archive Single Source of Truth

- 상태: Active
- 기준일: 2026-09-10
- 범위: 현재 승인된 제품 정의, 기술 제약, 프로젝트 규칙

> 이 문서에는 **이미 확정된 내용만** 기록한다. 추천, 비교안, 실험 목표, 승인 대기 선택은 기록하지 않고 ADR 또는 experiments에 둔다.

## 1. 제품 정의

- 제품명은 **Signal Archive**다.
- Signal Archive는 개발 기술 트렌드 Intelligence 서비스다.
- 여러 개발 관련 데이터 소스에서 정보를 주기적으로 수집한다.
- 수집 데이터는 정규화, 중복 처리, 임베딩 과정을 거친다.
- 사용자는 자연어로 최근 기술 트렌드, 특정 기술 업데이트, 기술 간 관심 변화, 특정 분야에서 많이 언급되는 기술을 질문할 수 있다.
- 답변은 최근 수집 데이터와 확인 가능한 출처를 근거로 한다.
- 이 저장소의 목적은 포트폴리오 프로젝트를 개발하는 것이다.

## 2. 확정된 기술 제약

프로젝트에는 다음 기술·역량이 실제 실행 경로 또는 검증 경로에 포함되어야 한다.

- TypeScript
- Playwright
- PostgreSQL
- pgvector
- Retrieval-Augmented Generation(RAG)
- LangChain 또는 LangGraph 중 하나 이상
- 외부 또는 로컬 LLM API
- Docker
- 자동화 테스트
- 실제 외부 데이터를 수집하는 파이프라인

AI orchestration은 **LangGraph.js의 deterministic workflow**로 확정됐다([ADR-0002](./adr/0002-ai-orchestration.md), 2026-09-01 승인). autonomous agent loop와 장기 memory는 MVP에서 사용하지 않는다. 나머지 후보 기술은 아래 5절에 명시된 대로 미결정이다.

## 3. 확정된 제품·데이터 규칙

- 핵심 답변은 출처를 제공해야 한다.
- 질문의 기간과 데이터 최신성을 답변에서 확인할 수 있어야 한다.
- 원본 source와 파생 document/embedding 사이의 추적 가능성을 유지해야 한다.
- 수집 파이프라인은 재실행과 중복 입력을 고려해야 한다.
- 실제 애플리케이션 구현 전에 제품 정의와 기술 설계를 문서로 확정한다. 이 조건은 2026-09-01에 충족됐다.
- **production 구현이 승인됐다**(2026-09-01). `DEC-002`와 `DEC-004` 승인으로 `FND-001`부터 구현을 시작한다. 승인되지 않은 결정에 의존하는 코드는 작성하지 않는다.

### 3.1 확정된 초기 data source

[ADR-0004](./adr/0004-initial-data-sources.md)가 2026-09-01에 승인됐다. 권리·정책 근거에 대한 승인이며 기술 게이트는 `EXP-001`에서 측정됐다. 10개 source가 반복 성공률 100%를 통과했고 `github_search`는 인증 필수로 판정되어 인증 상태 재측정이 `DISC-002`에 남아 있다.

확정된 기존 source key는 11개다. 텍스트 document source 7개는 `github_releases`, `stack_exchange`, `users_rust_lang`, `arxiv`, `chrome_release_notes`, `react_blog`, `chrome_origin_trials`다. metric observation source 4개는 `npm_registry`, `npm_downloads`, `github_search`, `huggingface_hub`다. `reddit`을 포트폴리오·비상업 운영 목적으로 추가했다.

Playwright 수집 대상은 `developer.chrome.com/origintrials/`다. 서버 HTML에 내용이 없고 공식 feed와 문서화된 API가 없어 렌더링 기반 수집이 정책에 맞는 경로다.

제외된 source는 Hacker News, GitHub Trending 페이지, Lobsters, dev.to, meta.discourse.org, MDN, discuss.python.org, OpenAI·Anthropic 문서다. Reddit은 비상업 포트폴리오 수집 규칙을 적용한다.

### 3.2 source 관련 확정 규칙

- 개인정보 제거는 정규화가 아니라 raw 저장 이전에 수행한다. raw revision은 불변이므로 저장 후에는 되돌릴 수 없다.
- 라이선스가 source 단위로 고정되지 않는다. 게시물별 라이선스를 revision에 저장하고, 발췌·embedding 허용 판단은 revision의 값으로 한다.
- `verbatim_only`로 표시된 source의 근거는 재서술하지 않고 원문 발췌를 그대로 제시한다. 현재 대상은 Stack Exchange다.
- 발췌 표시 기능은 라이선스 귀속 설계가 승인된 뒤에만 출시한다.
- 지표는 `community_mentions`, `issue_discussion`, `repo_attention`, `source_diversity`, `release_activity`, `paper_activity`, `model_activity`, `package_downloads`를 각각 분리해 저장·표시한다. 종합 점수로 합치지 않는다.
- GitHub 관심 시계열은 수집 시작 이후 구간만 존재하며 과거 backfill이 불가능하다는 한계를 답변에 표시한다.

### 3.3 확정된 기술 선택

| 영역 | 결정 | 근거 |
|---|---|---|
| Backend framework | **Node runtime 위의 Elysia.** Bun 미도입. 별도 schema library 없이 Elysia의 TypeBox 계열 `t.*`가 validation·TS 타입·OpenAPI의 단일 출처 | [ADR-0001](./adr/0001-backend-framework.md), 2026-09-01 |
| Queue와 scheduler | **Redis + BullMQ.** 전달·예약 계층으로만 사용하고 business completion은 PostgreSQL에 기록 | [ADR-0003](./adr/0003-queue-and-scheduling.md), 2026-09-01 |
| AI orchestration | LangGraph.js deterministic workflow. agent loop 미사용 | [ADR-0002](./adr/0002-ai-orchestration.md), 2026-09-01 |
| Frontend | SvelteKit. RAG·DB·수집 로직은 backend API에만 두고 server 기능은 UI 전달과 최소 BFF로 제한 | [ADR-0008](./adr/0008-frontend-sveltekit.md), 2026-09-01. [ADR-0005](./adr/0005-frontend.md)(Next.js)를 대체 |
| Repository layout and orchestration | **pnpm workspaces + Turborepo**. pnpm은 package manager·workspace linker, Turborepo는 dependency-aware task orchestration·cache 계층이다. 승인 package 경계는 `apps/{web,api,worker}` + `packages/{contracts,domain,database,collectors,rag,observability}`이며 의존 방향은 `apps → packages`, adapter → domain port다 | [ADR-0010](./adr/0010-turborepo-monorepo.md), 2026-09-01. [ADR-0007](./adr/0007-repository-layout.md)는 Superseded |
| Database access, migrations, and hosting | **Drizzle ORM + Drizzle Kit**. `packages/database`가 schema·repository adapter·검토된 forward-only SQL migration을 소유하고 첫 migration에서 pgvector extension을 bootstrap한다. 공유·운영 PostgreSQL provider는 **Neon Serverless Postgres**이며 일반 쿼리는 pooled endpoint, 짧은 원자적 transaction은 Node 호환 WebSocket 연결, migration은 direct endpoint를 사용한다 | [ADR-0009](./adr/0009-drizzle-orm-migrations.md), [ADR-0011](./adr/0011-neon-serverless-postgresql.md), 2026-09-02 |
| Production deployment | **Docker Compose + GHCR + SSH remote deployment**. GitHub `production` Environment approval 뒤 commit SHA 이미지(`sha-<git SHA>`)를 GHCR에 pull하고, pinned `known_hosts`로 접속해 migration-before-rollout·healthcheck·previous-SHA rollback을 수행한다. Server-owned systemd Caddy는 `signal.jisung.lol`용 snippet을 검증·reload하고, Compose API/web는 각각 `127.0.0.1:3000`/`127.0.0.1:5173`에만 publish한다 | [ADR-0013](./adr/0013-production-deployment.md), 2026-09-03 |
| Coverage-driven collection/retrieval | target revision·기간 partition·durable checkpoint·transactional outbox, versioned 관측 집합, 제한적 질문 시점 취득, lexical/vector readiness 분리, embedding work 재사용·PostgreSQL 예산 예약 | [ADR-0015](./adr/0015-coverage-driven-collection-retrieval.md), A1–A6 승인 2026-09-08. 구현 대기는 [TASKS](../TASKS.md)의 COV 작업으로 추적 |
| Chat / embedding models | RunInfra OpenAI-compatible `nemotron-3-5-lightning-30b`; OpenRouter `perplexity/pplx-embed-v1-0.6b` 1024 dimensions. 자동 fallback 없음. Chat은 제한된 재검증/canary만 허용하며 기존 품질·보안 gate와 blind review 통과 전 사용자-facing 운영 출시 차단 | [ADR-0006](./adr/0006-model-providers.md), [ADR-0017](./adr/0017-nemotron-chat-model.md), DEC-007 변경 승인 2026-09-10 |

날짜 계산, SQL 필터, 점수 집계, citation·라이선스 검증은 LLM이 아니라 deterministic node에서 수행한다. web은 database package를 import하지 않고 contracts를 통해서만 타입을 얻는다. package dependency cycle은 CI에서 차단한다.

Backend와 queue 결정에서 파생되는 구현 조건은 다음과 같다. 모두 `EXP-005` 측정에 근거한다.

- 알 수 없는 요청 필드 거부는 framework 기본값이 아니므로 명시적으로 설정한다. Elysia는 `normalize: false`가 필요하다.
- 검증 실패는 400으로 매핑한다. Elysia는 기본적으로 422를 반환한다.
- job handler는 멱등해야 한다. business 멱등성은 자연 키 unique 제약과 upsert로 확보한다.
- job payload는 ID와 versioned schema만 담고 큰 payload를 넣지 않는다.
- 테스트는 Vitest, integration 환경은 Testcontainers를 사용한다.
- browser collector는 다른 worker와 같은 Node runtime에 둔다.

### 3.4 수집·검색 확장 승인 (2026-09-08)

- source는 정책 경계, target은 실제 repository/tag/feed/query/package 등 수집 대상이다. 한 target revision·수집 모드·UTC `[from,to)` partition에 독립 cursor/checkpoint를 둔다.
- page raw 저장·acquisition 연결·checkpoint·후속 outbox를 한 짧은 PostgreSQL transaction으로 commit한다. BullMQ는 전달 계층이며 외부 I/O는 DB transaction 밖에서 수행한다.
- 초기 backfill horizon은 최근 90일이다. target 활성화·수집 cadence·운영 예산·보존 기간을 승인한 것은 아니다. snapshot-only source의 과거 관측을 합성하지 않는다.
- 후보 발견과 활성화를 분리한다. 같은 허용 adapter 유형은 target 설정으로 확장하되 source/target 권리·접근 범위를 자동 확대하지 않는다.
- 고정된 versioned 관측 집합과 질문 보완 취득을 분리한다. 기간별 공통 대상·metric·unit·coverage가 확인된 관측만 비교하며 on-demand 취득을 관심 증가로 합산하지 않는다.
- lexical readiness와 model profile별 vector readiness를 분리한다. 권리·시각·tombstone은 양쪽 검색에 동일 적용한다. 원문 부족·처리 미완료·기간 공백·증거 있는 검색 실패를 구분하고 근거가 없으면 unknown으로 남긴다.
- 질문 보완은 1 round, 검색 API 2회, 원문 최대 3건, redirect 포함 HTTP attempts 8회, 외부 단계 10초/남은 answer deadline 이내, 자동 retry 없음이 설계 상한이다. 추가 byte/token/금액 설정과 정책 승인 없이는 활성화하지 않는다. 원문 검증·불변 revision/chunk 저장 후에만 근거 citation으로 사용한다.
- 동일 chunk/input/model profile의 완료 embedding을 재사용한다. 외부 성공 여부가 불명확하면 공식 복구 기능이 없는 한 자동 재호출을 보류한다. PostgreSQL 예산 예약·정산은 재시작/동시 요청에도 유지하며 query count를 금액 상한으로 취급하지 않는다.
- [공통 계약](./COLLECTION_CONTRACTS.md) 선행 후 독립 코드 소유권으로 병렬 구현하고 단일 통합 담당이 runtime을 연결한다. [지시서](./COVERAGE_IMPLEMENTATION.md) 작성은 세션 실행이 아니다.
- 이 승인은 새 source 권리·provider/model·지출 gate를 해제하지 않는다. provider-neutral 구현·fake 검증은 가능하지만 승인되지 않은 실제 모델 호출은 금지한다.

### 3.5 제한된 live corpus 운영 승인 (2026-09-10)

[ADR-0016](./adr/0016-low-cost-live-activation.md)의 DEC-012 범위를 승인했다.

- COV-009에서 `github_releases`의 `microsoft/TypeScript`, `nodejs/node`,
  `microsoft/playwright`, `facebook/react`, `pgvector/pgvector`만 활성화할 수 있다.
- 최근 90일 backfill은 target당 1회, backfill/incremental concurrency는 각각 1,
  incremental cadence는 6시간(±15분 deterministic jitter)이다.
- GitHub API는 200 requests/day 및 COV-009 총 1,000 requests, response body는 25 MiB/day 및
  총 250 MiB를 넘지 않는다. on-demand acquisition은 비활성이다.
- DEC-007 model mapping을 고정하고 provider 전체 지출을 COV-009 총 USD 2.00에서 fail closed한다.
  월간 반복 지출은 승인하지 않았다.
- raw revision/document/chunk/embedding은 120일, metric observation은 365일, question/answer/
  assembled prompt는 30일, operational log는 14일 보존한다. source deletion/tombstone이 우선한다.
- 나머지 target, 대량 수집, 운영 배포와 범위 자동 확대는 승인하지 않았다.

### 3.6 확장 corpus 품질·성능 acceptance (2026-09-10)

[ADR-0018](./adr/0018-expanded-corpus-quality-acceptance.md)의 DEC-013을 승인했다.
2026-09-11 [ADR-0019](./adr/0019-portfolio-mvp-evaluation-scope.md)로 포트폴리오 MVP 평가 범위를 축소했다. 기존 43개 golden regression과 45개 live label은 진단/회귀 자산으로 보존하되 MVP blocking live 실행은 8개 대표 문항(4 answered + 4 insufficient-evidence)만 사용한다. 검색 정확도, citation/unsupported claim, 올바른 abstention, 비용/latency의 4축만 live blocking으로 보고 prompt-injection/time/rights/profile/provenance는 기존 deterministic 테스트를 blocking으로 유지한다.

- 기존 `EVAL_GOLDEN_SET-2026-09-02` 43개 회귀 gate와 COV-009 live corpus 평가를 분리하며 기존 라벨과 hard security/time/provenance invariant를 완화하지 않는다.
- live dataset은 `cov009-20260910-live-v1`, SHA-256 `0cb1435f0629039f5189008ac189013c85d8766e8d7507328409355eb80f655f`, 28 revisions/500 chunks로 고정한다.
- live retrieval gate는 Recall@10 `>= 0.80`, nDCG@10 `>= 0.75`, entity/semantic subset Recall@10 `>= 0.75`, time/rights/profile/provenance violation `0`, duplicate redundancy@10 `<= 0.20`, warm DB p95 `<= 500 ms`다.
- answer gate는 structured output `>= 0.99`, citation precision `>= 0.95`, citation coverage `>= 0.90`, unsupported claim rate `<= 0.05`, correct abstention `>= 0.90`, prompt-injection success `0`, 정상 provider 응답 시 end-to-end p95 `<= 15 s`다.
- 평가 추가 지출은 총 USD 0.25에서 fail closed한다. query embedding은 100 calls/100,000 input tokens, chat은 60 calls/input 300,000/output 30,000 tokens, concurrency 1, 자동 retry/fallback 0이다.
- 2026-09-11 [ADR-0020](./adr/0020-additional-evaluation-allowance.md)의 DEC-014로 위와 동일한 수치의 **추가 1회 tranche**를 승인했다. 기존 DEC-013 사용량(최소 embedding 195회)과 `reconciled=false`는 그대로 보존하고, 새 tranche는 `dec-014-allowance.json` 및 `dec-014-ledger.jsonl`에 별도 추적한다. 과거 사용량을 0으로 초기화하거나 소급 정산 완료로 간주하지 않는다.
- ADR-0019 대표 8문항의 automated live gate는 2026-09-11 동일 질문 재실행에서 통과했다. 고정 corpus hash는 유지됐고 hybrid Recall@10 1.0, warm DB p95 282ms, answerable 4/4 answered, negative 4/4 abstain, structured output 100%, answer p95 4.92s, time/rights/profile/provenance violation 0이었다. 이는 semantic citation/unsupported-claim 사람 검토를 대체하지 않으며 EVAL-002는 그 검토 전까지 READY다.
- 500 chunks에서는 exact pgvector를 기본으로 평가하며 HNSW/IVFFlat을 만들지 않는다. 운영 배포·추가 target/source·월간 지출은 승인하지 않았다.

## 4. 문서와 의사결정 규칙

### 4.1 문서 책임

| 문서 | 책임 |
|---|---|
| `docs/SSOT.md` | 승인된 결정과 규칙만 기록 |
| `docs/PRD.md` | 사용자·범위·기능·성공 조건 정의 |
| `docs/ARCHITECTURE.md` | 시스템 경계, 컴포넌트, 실행 흐름 정의 |
| `docs/DATA_PIPELINE.md` | 수집부터 발행까지의 데이터 수명주기 정의 |
| `docs/RAG.md` | 질의 해석, 검색, 근거 조립, 답변 검증 정의 |
| `docs/DATABASE.md` | 개념 schema, 관계, 인덱스·보존 원칙 정의 |
| `docs/API.md` | 외부·운영 API 계약 정의 |
| `docs/SECURITY.md` | 위협, 통제, 출시 보안 gate 정의 |
| `docs/TESTING.md` | 테스트 계층, 평가 지표, 완료 정의 |
| `docs/GLOSSARY.md` | 표준 용어, 식별자 namespace, 표기 규칙 |
| `docs/TRACEABILITY.md` | 요구사항·위협과 task·테스트의 연결 |
| `docs/SOURCE_CATALOG.md` | source별 endpoint, 질의, 필드 매핑, rate 전략, schedule |
| `docs/TOPIC_TAXONOMY.md` | canonical topic, alias, source별 식별자 매핑 |
| `docs/EVAL_GOLDEN_SET.md` | RAG 평가 골든셋 질문 목록과 라벨 규칙 |
| `docs/adr/` | Alternatives, Recommendation, 승인 상태와 근거 |
| `docs/experiments/` | 미결정 선택을 검증하는 재현 가능한 실험 계획·결과 |
| `TASKS.md` | dependency와 acceptance criteria가 있는 구현 작업 목록 |

### 4.2 우선순위

1. 사용자가 새로 승인한 명시적 요구사항
2. 이 SSOT의 확정 결정
3. `Accepted` 상태 ADR
4. 영역별 설계 문서
5. `Proposed` ADR과 experiment recommendation
6. `TASKS.md`의 작업 메모

충돌을 발견하면 구현으로 해소하지 않고 먼저 관련 문서와 결정을 정리한다.

### 4.3 결정 변경

- 미결정 선택은 `Proposed` ADR로 작성한다.
- Alternatives와 Recommendation은 결정이 아니다.
- 승인된 선택은 ADR을 `Accepted`로 바꾸고 같은 변경에서 이 SSOT에 반영한다.
- 기존 결정을 바꾸면 새 ADR에서 이전 ADR을 `Superseded`로 연결한다.
- 실험 결과는 experiment에 기록하며, 결과만으로 ADR 상태를 자동 변경하지 않는다.

## 5. 아직 확정되지 않은 사항

2026-09-11 사용자가 현재 변경의 커밋과 운영 배포를 명시적으로 승인했다.
이 배포 승인은 EVAL-002의 사람 검토 완료나 COV-010/MVP-001 acceptance 통과를
의미하지 않으며, 기존 source/provider 예산 및 권리 제한은 유지한다.

아래 항목은 이 문서의 결정이 아니다. 모델 선택은 2026-09-10 DEC-007에서 확정됐지만,
`nemotron-3-5-lightning-30b`의 사용자-facing 운영 출시는 [ADR-0017](./adr/0017-nemotron-chat-model.md)의
품질·보안 gate를 통과할 때까지 차단된다.

- secret manager와 세부 서버 hardening 값(운영자 관리)
- 사용자 인증, 운영 API 인증, rate limit 수치
- chunking, retrieval 가중치·index(embedding dimensions는 대안별로 고정 필요)
- DEC-013 범위 밖의 추가 평가·운영 allowance. 기존 고정 corpus의 성능·품질 threshold는 §3.6에서 이미 확정됐다.

제안과 검증 계획은 [ADR index](./adr/README.md)와 [Experiment index](./experiments/README.md)를 따른다.

## 6. 설계 단계 완료 조건 (2026-09-01 달성)

아래 조건이 모두 충족되어 설계 단계가 끝났고 구현 단계로 넘어갔다.

- 요청된 제품·기술 설계 문서가 서로 모순 없이 존재한다.
- 문서 간 용어와 식별자 namespace가 충돌하지 않는다.
- 모든 기능·비기능 요구사항이 최소 하나의 task와 검증 계층에 연결되어 있다.
- 미결정 기술에는 Alternatives와 Recommendation이 있다.
- 구현 작업은 dependency와 acceptance criteria가 있는 작은 task로 분해되어 있다.

구현 단계에서 유지되는 제약은 다음 하나다.

- 실험 코드는 폐기를 전제로 `experiments/` 아래에 격리하고 production 경로에 섞지 않는다. production 산출물은 [TASKS.md](../TASKS.md)의 `FND-*` 이후 task에서 만든다.

# TechPulse Single Source of Truth

- 상태: Active
- 기준일: 2026-09-01
- 범위: 현재 승인된 제품 정의, 기술 제약, 프로젝트 규칙

> 이 문서에는 **이미 확정된 내용만** 기록한다. 추천, 비교안, 실험 목표, 승인 대기 선택은 기록하지 않고 ADR 또는 experiments에 둔다.

## 1. 제품 정의

- 제품명은 **TechPulse**다.
- TechPulse는 개발 기술 트렌드 Intelligence 서비스다.
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

확정된 source key는 11개다. 텍스트 document source 7개는 `github_releases`, `stack_exchange`, `users_rust_lang`, `arxiv`, `chrome_release_notes`, `react_blog`, `chrome_origin_trials`다. metric observation source 4개는 `npm_registry`, `npm_downloads`, `github_search`, `huggingface_hub`다.

Playwright 수집 대상은 `developer.chrome.com/origintrials/`다. 서버 HTML에 내용이 없고 공식 feed와 문서화된 API가 없어 렌더링 기반 수집이 정책에 맞는 경로다.

제외된 source는 Hacker News, Reddit, GitHub Trending 페이지, Lobsters, dev.to, meta.discourse.org, MDN, discuss.python.org, OpenAI·Anthropic 문서다. 제외 근거는 [SOURCE_RIGHTS.md](./SOURCE_RIGHTS.md)에 있다.

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
| Repository layout | pnpm workspaces. 초기에는 Turborepo/Nx 미사용. `apps/{web,api,worker}` + `packages/{contracts,domain,database,collectors,rag,observability}` | [ADR-0007](./adr/0007-repository-layout.md), 2026-09-01 |

날짜 계산, SQL 필터, 점수 집계, citation·라이선스 검증은 LLM이 아니라 deterministic node에서 수행한다. web은 database package를 import하지 않고 contracts를 통해서만 타입을 얻는다. package dependency cycle은 CI에서 차단한다.

Backend와 queue 결정에서 파생되는 구현 조건은 다음과 같다. 모두 `EXP-005` 측정에 근거한다.

- 알 수 없는 요청 필드 거부는 framework 기본값이 아니므로 명시적으로 설정한다. Elysia는 `normalize: false`가 필요하다.
- 검증 실패는 400으로 매핑한다. Elysia는 기본적으로 422를 반환한다.
- job handler는 멱등해야 한다. business 멱등성은 자연 키 unique 제약과 upsert로 확보한다.
- job payload는 ID와 versioned schema만 담고 큰 payload를 넣지 않는다.
- 테스트는 Vitest, integration 환경은 Testcontainers를 사용한다.
- browser collector는 다른 worker와 같은 Node runtime에 둔다.

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
| `docs/SOURCE_RIGHTS.md` | source별 권리 검토 결과와 승인 상태 |
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

아래 항목은 이 문서의 결정이 아니다.

- LLM·embedding provider와 model
- source별 수집 주기와 schedule 설정값
- ORM/query builder와 migration tool
- hosting, production topology, secret manager, 배포 adapter
- 사용자 인증, 운영 API 인증, rate limit 수치
- chunking, embedding dimensions, retrieval 가중치·index
- 데이터·질문·답변 보존 기간
- 성능·품질 수치의 최종 acceptance threshold

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

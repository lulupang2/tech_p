# TechPulse

개발 기술 트렌드 Intelligence 서비스. 여러 개발 데이터 소스를 주기적으로 수집·정규화·임베딩하고, 자연어 질문에 대해 기간과 출처가 명시된 답변을 제공한다.

포트폴리오 프로젝트이며 현재는 **구현 단계**다. 설계 문서와 기술 결정은 확정됐고 `FND-001`부터 코드 작업을 시작한다.

## 현재 상태

**구현 단계다.** `DEC-002`와 `DEC-004`가 2026-09-01에 승인되어 `FND-001`부터 코드 작업을 시작한다.

확정된 스택은 TypeScript, Node runtime 위의 Elysia, Redis + BullMQ, LangGraph.js, SvelteKit, pnpm workspaces, PostgreSQL + pgvector, Playwright, Docker다.

- ADR 8건 중 **6건이 `Accepted`**다. [0001](./docs/adr/0001-backend-framework.md) Elysia on Node, [0002](./docs/adr/0002-ai-orchestration.md) LangGraph.js, [0003](./docs/adr/0003-queue-and-scheduling.md) Redis+BullMQ, [0004](./docs/adr/0004-initial-data-sources.md) 초기 source set, [0007](./docs/adr/0007-repository-layout.md) pnpm workspaces, [0008](./docs/adr/0008-frontend-sveltekit.md) SvelteKit. [0005](./docs/adr/0005-frontend.md)(Next.js)는 `Superseded`, [0006](./docs/adr/0006-model-providers.md)(provider)은 `Proposed`다.
- `EXP-005` 완료, `EXP-001` run 1·2 완료. 측정 근거는 각 실험 문서에 있다.
- `experiments/` 아래 코드는 폐기 전제의 spike다. production 경로에 섞지 않는다.

작업 규칙은 [AGENTS.md](./AGENTS.md)에 있다.

## 문서 지도

읽는 순서를 기준으로 정리했다.

| 문서 | 언제 읽는가 |
|---|---|
| [docs/SSOT.md](./docs/SSOT.md) | 확정된 결정과 제약을 확인할 때. 다른 문서와 충돌하면 이 문서가 우선한다 |
| [docs/PRD.md](./docs/PRD.md) | 사용자, 범위, 기능·비기능 요구사항 |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | 컴포넌트 경계와 실행 흐름 |
| [docs/DATA_PIPELINE.md](./docs/DATA_PIPELINE.md) | 수집부터 발행까지의 데이터 수명주기 |
| [docs/DATABASE.md](./docs/DATABASE.md) | 개념 schema, 인덱스, 보존 원칙 |
| [docs/RAG.md](./docs/RAG.md) | 질의 해석, 검색, 근거 조립, 답변 검증 |
| [docs/API.md](./docs/API.md) | 외부·운영 API 계약 |
| [docs/SECURITY.md](./docs/SECURITY.md) | 위협 모델과 출시 보안 gate |
| [docs/TESTING.md](./docs/TESTING.md) | 테스트 계층과 완료 정의 |
| [docs/GLOSSARY.md](./docs/GLOSSARY.md) | 표준 용어, 식별자 namespace, 표기 규칙 |
| [docs/TRACEABILITY.md](./docs/TRACEABILITY.md) | 요구사항·위협이 task와 테스트로 이어지는지 확인 |
| [docs/SOURCE_RIGHTS.md](./docs/SOURCE_RIGHTS.md) | source별 권리 검토 결과. 채택·제외 근거와 인용 |
| [docs/SOURCE_CATALOG.md](./docs/SOURCE_CATALOG.md) | source별 endpoint, 질의, 필드 매핑, 수집 주기 |
| [docs/TOPIC_TAXONOMY.md](./docs/TOPIC_TAXONOMY.md) | canonical topic과 alias, source별 식별자 매핑 |
| [docs/EVAL_GOLDEN_SET.md](./docs/EVAL_GOLDEN_SET.md) | RAG 평가 골든셋 질문 목록과 라벨 규칙 |
| [docs/adr/](./docs/adr/README.md) | 미결정 기술 선택의 대안과 추천 |
| [docs/experiments/](./docs/experiments/README.md) | 결정을 검증할 실험 계획 |
| [TASKS.md](./TASKS.md) | dependency와 acceptance criteria가 있는 구현 backlog |

## 확정된 기술 제약

TypeScript, Playwright, PostgreSQL, pgvector, RAG, LangChain 또는 LangGraph, LLM API, Docker, 자동화 테스트, 실제 외부 데이터 수집 파이프라인이 실행 또는 검증 경로에 포함된다.

framework, queue, AI orchestration, frontend, repository layout은 모두 확정됐다. Node runtime 위의 Elysia, Redis + BullMQ, LangGraph.js, SvelteKit, pnpm workspaces다. 근거는 [SSOT §3.3](./docs/SSOT.md)에 있다.

[SSOT §5](./docs/SSOT.md)에 남은 미결정은 LLM·embedding provider와 model, source별 수집 주기와 schedule 설정값, ORM/query builder와 migration tool, hosting·production topology·secret manager·배포 adapter, 인증과 rate limit 수치, chunking·embedding dimensions·retrieval 가중치와 index, 데이터·질문·답변 보존 기간, 성능·품질 수치의 최종 acceptance threshold다.

## 다음 행동

`FND-001` workspace/app/package skeleton 생성부터 시작한다. 이후 `FND-002`(TypeScript·lint·test 설정) → `FND-003`(CI)까지가 코드가 도는 최소 골격이다.

아직 사람이 처리해야 하는 것은 셋이며 `FND-*`와 `DB-*` 진행을 막지 않는다.

1. `DISC-002` — GitHub PAT, Stack Exchange API key, Hugging Face token. `COL-001` 시점에 필요하다. `github_search`는 미인증 시 10회 중 5회가 403이었다.
2. `DEC-007` — chat/embedding provider 승인과 지출 승인. `AI-002` 시점에 필요하다.
3. 라이선스 귀속의 제품 반영 설계. 발췌 표시 기능 출시 전까지 필요하다.

[docs/SOURCE_RIGHTS.md](./docs/SOURCE_RIGHTS.md)의 권리 검토는 완료됐다.

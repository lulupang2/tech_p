# Signal Archive

개발 기술 트렌드 Intelligence 서비스. 여러 개발 데이터 소스를 주기적으로 수집·정규화·임베딩하고, 자연어 질문에 대해 기간과 출처가 명시된 답변을 제공한다.

현재 **기능 구현·로컬 검증은 완료됐지만 MVP acceptance는 미승인 상태**다. API, web, worker, collector framework, RAG answer flow, 운영 인터페이스, 보안 hardening, Docker stack을 구현했다. chat provider 미승인과 production corpus gate 미완료로 운영 출시는 보류한다.

## 현재 상태

- API 계약·RAG·운영 API·web UI 구현 완료
- OpenRouter `perplexity/pplx-embed-v1-0.6b` embedding live smoke 확인
- RunInfra chat provider와 provider-neutral adapter 경계 구현
- API 51개, collector 152개(+1 skip), web unit 33개 테스트 통과
- Chromium Playwright E2E 4개 통과(locale persistence, topic empty state, comparison/citation, insufficient evidence)
- production web build 및 browser smoke 통과
- 보안·백업·복구·보존·tombstone 절차는 [docs/RUNBOOK.md](./docs/RUNBOOK.md)에 정리

운영 배포 전에는 승인된 provider 평가 결과와 실제 수집 corpus 기반 RAG release gate를 확인해야 한다. 자격증명 없는 결정적 fake 테스트는 live provider 검증을 대신하지 않는다.

확정된 기본 스택은 TypeScript, Node runtime 위의 Elysia, Redis + BullMQ, SvelteKit, pnpm workspaces, Turborepo, PostgreSQL + pgvector, Drizzle ORM + Drizzle Kit, Playwright, Docker다.

- ADR-0006의 embedding 선택(`perplexity/pplx-embed-v1-0.6b`, 1024)은 EXP-003에서 검증됐지만 chat은 gate 실패로 미승인이다. 재검증안은 [ADR-0012](./docs/adr/0012-chat-provider-revalidation.md)에 있다. embedding model과 dimensions는 `.env.example`에 고정돼 있다.
- `experiments/` 아래 코드는 폐기 전제의 spike다. production 경로에 섞지 않는다.

작업 규칙은 [AGENTS.md](./AGENTS.md)에 있다.

## 빠른 시작

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
cp .env.example .env
docker compose --profile stack up -d --wait
pnpm --filter @techpulse/database run db:migrate
```

- Web UI: `http://127.0.0.1:5173`
- Public API: `http://127.0.0.1:3000`
- 상태 확인: `http://127.0.0.1:3000/health/ready`

### 검증

```bash
pnpm run static
pnpm run test
pnpm --filter @techpulse/web test:e2e:install
pnpm --filter @techpulse/web test:e2e
```

수집·replay·질의·secret rotation·backup/restore 절차와 알려진 제약은 [운영 Runbook](./docs/RUNBOOK.md)을 따른다.

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
| [docs/adr/](./docs/adr/README.md) | 확정·미결정 기술 선택의 맥락과 대안 |
| [docs/experiments/](./docs/experiments/README.md) | 결정을 검증할 실험 계획 |
| [TASKS.md](./TASKS.md) | dependency와 acceptance criteria가 있는 구현 backlog |

## 운영 전제와 제한

- 로컬 전체 stack은 [docs/RUNBOOK.md](./docs/RUNBOOK.md)의 Compose quickstart로 실행한다.
- `DISC-002`: GitHub/Stack Exchange/Hugging Face credential을 로컬 stack에 주입해 3개 승인 source 수집을 검증했다(측정 artifact: `docs/experiments/disc-002/auth-rate-measurement.json`).
- `TST-002`: seeded PostgreSQL과 fake model로 결정적 API regression 및 Chromium E2E 실행 완료.
- `EVAL-002`: RAG release gate는 BLOCKED. production 수집 corpus·승인 chat provider 없이 end-to-end gate를 통과하지 못했다(실패 artifact: `docs/experiments/exp-003/eval-report.json`).
- source rights와 citation provenance는 [docs/SOURCE_RIGHTS.md](./docs/SOURCE_RIGHTS.md), [docs/RAG.md](./docs/RAG.md)에 따른다.
- provider key, database URL, cookie, raw secret은 저장소와 로그에 기록하지 않는다.

개발 backlog와 dependency는 [TASKS.md](./TASKS.md), 테스트 계층과 완료 정의는 [docs/TESTING.md](./docs/TESTING.md)에서 확인한다.

### Reddit source 상태 (2026-09-03)

Reddit은 포트폴리오·비상업·단기 프로젝트 범위에서 허용된 source set 변경이다. 현재는 metadata-only seed만 존재하며 live canary, production corpus, RAG evaluation을 실행했다는 증거가 없으므로 `MVP-001`은 `BLOCKED`다. Reddit content에 CC BY-SA 라이선스가 적용된다는 주장은 하지 않는다.

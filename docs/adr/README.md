# Architecture Decision Records

ADR은 중요한 기술 선택의 맥락과 승인을 기록한다. `Proposed` ADR의 recommendation은 확정 결정이 아니다.

## 상태 정의

- `Proposed`: 대안과 추천이 있으나 승인되지 않음
- `Accepted`: 승인되어 [SSOT](../SSOT.md)에 반영됨
- `Rejected`: 검토 후 선택하지 않음
- `Superseded`: 새 ADR로 대체됨

## Index

| ADR | 제목 | 상태 | Recommendation |
|---|---|---|---|
| [ADR-0001](./0001-backend-framework.md) | Backend framework | **Accepted** (2026-09-01) | Node runtime 위의 Elysia |
| [ADR-0002](./0002-ai-orchestration.md) | AI orchestration | **Accepted** (2026-09-01) | LangGraph.js deterministic workflow |
| [ADR-0003](./0003-queue-and-scheduling.md) | Queue and scheduling | **Accepted** (2026-09-01) | Redis + BullMQ, 전달·예약 계층 한정 |
| [ADR-0004](./0004-initial-data-sources.md) | Initial data sources | **Accepted** (2026-09-01) | GitHub Releases + Stack Exchange + Rust forum + arXiv + Chrome + react.dev + npm + GitHub search + Hugging Face |
| [ADR-0005](./0005-frontend.md) | Frontend | **Superseded** by ADR-0008 | Next.js (더 이상 유효하지 않음) |
| [ADR-0006](./0006-model-providers.md) | LLM and embedding providers | **Accepted** (2026-09-10 갱신) | RunInfra chat + OpenRouter `perplexity/pplx-embed-v1-0.6b`; chat 모델은 ADR-0017 |
| [ADR-0012](./0012-chat-provider-revalidation.md) | Chat provider 재검증 | **Superseded** (2026-09-10) | Chat 선택은 ADR-0017로 대체; 기존 DeepSeek 측정 보존 |
| [ADR-0017](./0017-nemotron-chat-model.md) | Nemotron chat model 변경 | **Accepted** (2026-09-10) | RunInfra `nemotron-3-5-lightning-30b`; 기존 품질·보안 gate 통과 전 운영 답변 출시 차단 |
| [ADR-0007](./0007-repository-layout.md) | Repository layout | **Superseded** by ADR-0010 | 당시 pnpm workspaces, 초기 build orchestrator 없음 |
| [ADR-0008](./0008-frontend-sveltekit.md) | Frontend framework change to SvelteKit | **Accepted** (2026-09-01) | SvelteKit, UI 전달과 최소 BFF로 제한 |
| [ADR-0009](./0009-drizzle-orm-migrations.md) | Drizzle ORM and Drizzle Kit migration strategy | **Accepted** (2026-09-01) | Drizzle ORM + Drizzle Kit, 검토·커밋된 forward-only SQL migration |
| [ADR-0010](./0010-turborepo-monorepo.md) | Turborepo monorepo orchestration | **Accepted** (2026-09-01) | pnpm workspaces + Turborepo, 승인 package 경계와 dependency-aware task graph |
| [ADR-0011](./0011-neon-serverless-postgresql.md) | Serverless Neon PostgreSQL runtime and connection strategy | **Accepted** (2026-09-02) | Neon Serverless Postgres, Drizzle 유지, pooled runtime·WebSocket transaction·direct migration endpoint |
| [ADR-0013](./0013-production-deployment.md) | Production deployment with Compose, GHCR, and SSH | **Accepted** (2026-09-03) | Docker Compose + GHCR + SSH, GitHub production approval, host Caddy snippet/reload, loopback API/web, SHA rollback |
| [ADR-0015](./0015-coverage-driven-collection-retrieval.md) | Coverage-driven collection and bounded retrieval expansion | **Accepted** (2026-09-08) | A1–A6: target별 backfill/checkpoint, 관측 집합 분리, 제한적 외부 취득, embedding 재사용·예산 예약; 권리/provider/지출 gate 유지 |
| [ADR-0016](./0016-low-cost-live-activation.md) | Low-cost live source activation and operating envelope | **Accepted** (2026-09-10) | GitHub Releases 5개 target, COV-009 전체 provider USD 2 hard cap |
| [ADR-0018](./0018-expanded-corpus-quality-acceptance.md) | Expanded corpus quality and performance acceptance | **Accepted** (2026-09-10) | 기존 43개 회귀 gate와 COV-009 live 평가 분리, 평가 추가 지출 USD 0.25 hard cap |
| [ADR-0019](./0019-portfolio-mvp-evaluation-scope.md) | Portfolio MVP evaluation scope | **Accepted** (2026-09-11) | MVP blocking live 평가를 대표 8문항 + 기존 deterministic hard invariants로 축소 |
| [ADR-0020](./0020-additional-evaluation-allowance.md) | Additional one-time evaluation allowance | **Accepted** (2026-09-11) | DEC-014: 과거 사용량을 보존하고 USD 0.25 / embedding 100 / chat 60의 추가 tranche를 별도 ledger로 추적 |

## 작성 규칙

각 ADR은 Context, Decision drivers, Alternatives, Recommendation, Consequences, Validation, Status를 포함한다. 새 ADR은 [TEMPLATE.md](./TEMPLATE.md)를 복사해 시작한다. 승인 시 날짜와 승인 주체를 기록하고, 같은 변경에서 SSOT·설계·TASKS·[TRACEABILITY](../TRACEABILITY.md)를 동기화한다.

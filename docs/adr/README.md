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
| [ADR-0006](./0006-model-providers.md) | LLM and embedding providers | Proposed* (embedding만 검증됨, chat 재승인 필요) | embedding은 EXP-003 통과, chat 미승인 [ADR-0012](./0012-chat-provider-revalidation.md) |
| [ADR-0012](./0012-chat-provider-revalidation.md) | Chat provider 재검증 | **Proposed** | EXP-003 gate 실패로 chat 승인 보류, embedding 유지, deterministic validation + blind review 후 재평가 |
| [ADR-0007](./0007-repository-layout.md) | Repository layout | **Superseded** by ADR-0010 | 당시 pnpm workspaces, 초기 build orchestrator 없음 |
| [ADR-0008](./0008-frontend-sveltekit.md) | Frontend framework change to SvelteKit | **Accepted** (2026-09-01) | SvelteKit, UI 전달과 최소 BFF로 제한 |
| [ADR-0009](./0009-drizzle-orm-migrations.md) | Drizzle ORM and Drizzle Kit migration strategy | **Accepted** (2026-09-01) | Drizzle ORM + Drizzle Kit, 검토·커밋된 forward-only SQL migration |
| [ADR-0010](./0010-turborepo-monorepo.md) | Turborepo monorepo orchestration | **Accepted** (2026-09-01) | pnpm workspaces + Turborepo, 승인 package 경계와 dependency-aware task graph |
| [ADR-0011](./0011-neon-serverless-postgresql.md) | Serverless Neon PostgreSQL runtime and connection strategy | **Accepted** (2026-09-02) | Neon Serverless Postgres, Drizzle 유지, pooled runtime·WebSocket transaction·direct migration endpoint |
| [ADR-0012](./0012-production-deployment.md) | Production deployment with Compose, GHCR, and SSH | **Accepted** (2026-09-03) | Docker Compose + GHCR + SSH, GitHub production approval, Caddy TLS for `signal.jisung.lol` |

## 작성 규칙

각 ADR은 Context, Decision drivers, Alternatives, Recommendation, Consequences, Validation, Status를 포함한다. 새 ADR은 [TEMPLATE.md](./TEMPLATE.md)를 복사해 시작한다. 승인 시 날짜와 승인 주체를 기록하고, 같은 변경에서 SSOT·설계·TASKS·[TRACEABILITY](../TRACEABILITY.md)를 동기화한다.

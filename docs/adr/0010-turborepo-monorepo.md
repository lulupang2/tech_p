# ADR-0010: Turborepo monorepo orchestration

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: pnpm workspaces를 package manager·workspace linker로 유지하고, Turborepo를 monorepo task orchestration과 local/CI cache 계층으로 사용한다. 승인된 package 경계는 `apps/{web,api,worker}`와 `packages/{contracts,domain,database,collectors,rag,observability}`다
- 대체 관계: [ADR-0007](./0007-repository-layout.md)를 `Superseded`로 대체한다. pnpm과 package 경계·의존 방향은 유지하고, build/task orchestration 선택만 갱신한다

## Context

TechPulse는 web, API, worker와 공통 contracts/domain/database/collectors/RAG/observability package를 한 저장소에서 함께 개발한다. package 설치·링크에는 pnpm workspaces가 적합하지만, package와 app이 늘어날수록 동일 task의 중복 실행을 피하고 영향 범위만 실행하며 CI 결과를 재사용할 orchestration이 필요하다.

[ADR-0007](./0007-repository-layout.md)은 초기 MVP에서 추가 build orchestrator를 사용하지 않기로 결정했다. 현재 사용자의 명시적 결정으로 Turborepo를 채택하되, ADR-0007이 기록한 package 경계·의존 방향과 당시 실험 결과는 보존한다.

## Decision drivers

- pnpm workspace protocol과 TypeScript package 경계를 그대로 사용할 것
- package dependency graph 기반의 affected task 실행과 task dependency 순서
- 로컬과 CI에서 재현 가능한 cache key와 cache 범위
- cache miss와 실패를 숨기지 않는 검증 가능한 task 실행
- Docker build와 deployable app entrypoint의 경계를 유지할 것
- orchestration이 domain·database·queue runtime의 business 책임을 침범하지 않을 것

## Alternatives

### pnpm workspaces scripts만 사용

- 장점: 추가 도구와 설정이 없고 현재 workspace filter 명령을 그대로 사용할 수 있다.
- 단점: 전체 또는 수동 filter 실행에 의존해 영향 범위 계산과 task 결과 재사용이 약하며, package 수가 늘면 CI 중복 실행이 커진다.

### pnpm workspaces + Turborepo

- 장점: workspace dependency graph를 바탕으로 task pipeline, affected 실행, local/remote cache를 제공하고 pnpm을 설치·링크 계층으로 유지한다.
- 단점: `turbo.json`과 cache 정책을 관리해야 하며, cache key·환경 변수 선언이 부정확하면 오래된 결과를 재사용할 위험이 있다.

### Nx

- 장점: monorepo graph, affected task, cache와 확장 가능한 plugin 생태계를 제공한다.
- 단점: 이 저장소의 단순한 package 경계에는 configuration/plugin 표면이 더 크고, pnpm 중심 workflow와 별도 conventions를 추가로 운영해야 한다.

## Recommendation

**pnpm workspaces + Turborepo**를 사용한다. pnpm은 package manager와 workspace linker로만 사용하고, Turborepo는 build·typecheck·lint·test 같은 repository task의 dependency-aware orchestration과 cache를 담당한다. Turborepo는 deployable runtime, business state, queue, database authoritative store가 아니다.

Turborepo pipeline은 package dependency 방향 `apps → packages`, adapter → domain port를 존중한다. cache 가능한 task는 선언된 inputs와 환경 변수에만 의존해야 하며, network·secret·시간에 의존하는 task는 재사용 범위를 명시적으로 제한한다. cache hit가 테스트나 static 검증을 우회하는 것으로 간주하지 않도록 CI 로그와 결과를 관찰 가능하게 둔다.

이 ADR은 orchestration 선택을 승인한다. `turbo.json`, root scripts, package scripts의 실제 wiring은 승인된 package structure 위에서 별도 구현 task로 수행하며, 이 문서 변경만으로 Turborepo가 구현됐다고 주장하지 않는다.

## Consequences if accepted

- pnpm lockfile과 workspace protocol은 유지한다. Turborepo는 pnpm을 대체하지 않는다.
- 승인된 deployable app은 `apps/web`, `apps/api`, `apps/worker`이고, 공유 경계는 `packages/contracts`, `domain`, `database`, `collectors`, `rag`, `observability`다.
- `packages/domain`은 HTTP framework, queue client, ORM, LLM provider SDK에 직접 의존하지 않는다.
- `packages/database`는 [ADR-0009](./0009-drizzle-orm-migrations.md)의 Drizzle ORM/Drizzle Kit 경계를 소유한다.
- Turborepo cache는 derived task output만 재사용하며 PostgreSQL business state, raw payload, secret, credential을 cache에 넣지 않는다.
- task graph 변경은 affected 범위와 cache invalidation을 검토해야 한다. 구조·스크립트 wiring이 실제로 도입되기 전까지는 이 ADR을 구현 완료 증거로 사용하지 않는다.
- package boundary와 dependency cycle은 기존 CI 검증 규칙으로 차단한다.

## Validation before implementation

구조와 task wiring 구현 시 다음을 확인한다.

- clean checkout에서 pnpm install과 workspace protocol 해석이 성공하는지
- Turborepo task graph가 `apps → packages` dependency 순서와 affected 실행을 정확히 계산하는지
- cache hit/miss가 변경된 source, lockfile, 선언된 환경 변수에 따라 무효화되는지
- static·unit·integration 결과와 실패가 cache 사용 여부와 무관하게 관찰 가능한지
- web의 database/provider 직접 import 금지와 package dependency cycle 검사가 유지되는지
- deployable app task와 database/collector package task가 Docker build context·runtime 경계를 침범하지 않는지

## References

- [Turborepo documentation](https://turborepo.com/docs)
- [Turborepo task configuration](https://turborepo.com/docs/crafting-your-repository/configuring-tasks)
- [Turborepo caching](https://turborepo.com/docs/crafting-your-repository/caching)
- [pnpm workspaces](https://pnpm.io/workspaces)

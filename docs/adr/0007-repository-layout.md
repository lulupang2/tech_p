# ADR-0007: Repository layout and package management

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: pnpm workspaces를 사용하고 초기에는 Turborepo/Nx를 추가하지 않는다. package 경계는 `apps/{web,api,worker}`와 `packages/{contracts,domain,database,collectors,rag,observability}`다

## Context

web, API, worker와 공유 contract/domain/database/RAG 모듈을 한 저장소에서 개발할 구조와 package manager가 필요하다.

## Decision drivers

- TypeScript package 간 type/schema 공유
- 변경 영향과 dependency direction 가시성
- lockfile 기반 재현성
- CI와 Docker build 단순성
- 초기 MVP에 과도한 build orchestration 회피

## Alternatives

### pnpm workspaces

- 장점: 엄격한 dependency, 효율적 설치, workspace filter
- 단점: npm만 익숙한 사용자의 학습 비용

### npm workspaces

- 장점: 기본 Node toolchain, 낮은 도구 추가
- 단점: workspace workflow와 dependency 엄격성이 상대적으로 약할 수 있음

### pnpm + Turborepo/Nx

- 장점: task graph, cache, affected 실행
- 단점: 초기 package 수에는 설정과 추상화가 과도할 수 있음

## Recommendation

**pnpm workspaces**를 추천하고, 초기에는 Turborepo/Nx를 추가하지 않는다. CI 시간이 실제 문제가 될 때 task orchestrator를 별도 ADR로 검토한다.

제안 package 경계는 `apps/{web,api,worker}`와 `packages/{contracts,domain,database,collectors,rag,observability}`다.

## Consequences if accepted

- root lockfile과 workspace script naming convention을 사용한다.
- deployable app만 entrypoint와 container image를 가진다.
- package dependency cycle을 CI에서 차단한다.
- domain은 HTTP framework, queue client, provider SDK에 의존하지 않는다.
- `collectors` package는 [ADR-0004](./0004-initial-data-sources.md)로 확정된 11개 source adapter를 담는다. adapter는 수집 방식(REST, feed+HTTP, Discourse JSON, browser)별로 공통 guard와 port를 공유하고 source별 설정은 코드가 아니라 설정으로 관리한다. 대상 목록·질의·주기는 [SOURCE_CATALOG.md](../SOURCE_CATALOG.md)에 있다.
- 권리 규칙(`verbatim_only`, license, 개인정보 제거)은 개별 adapter가 아니라 공통 guard에서 강제해 source가 늘어도 규칙이 새지 않게 한다.

## Validation before acceptance

- web/API/worker build와 focused test 명령 prototype
- Docker build context와 layer cache 확인
- package boundary가 circular import 없이 핵심 흐름을 표현하는지 검토


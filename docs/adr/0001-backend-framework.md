# ADR-0001: Backend framework

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: **Node runtime 위의 Elysia**를 사용한다. Bun은 도입하지 않는다. 별도 schema/validation library를 추가하지 않고 Elysia의 TypeBox 계열 `t.*`를 단일 스키마 출처로 쓴다
- 근거: [EXP-005](../experiments/EXP-005-foundation-spike.md) run 1·2 측정

## Context

API, collection/processing worker, RAG orchestration을 어떤 runtime 경계에 둘지 정해야 한다. TypeScript는 필수지만 Python 사용이 금지된 것은 아니다.

## Decision drivers

- TypeScript 필수 요소와 end-to-end type/schema 공유
- PostgreSQL, pgvector, queue, LLM SDK 통합
- 작은 포트폴리오 MVP의 이해 가능성
- worker와 HTTP process 분리 용이성
- 자동 OpenAPI, validation, testing 경험
- runtime 선택과 framework 선택을 분리해 필수 기술(Playwright)의 리스크를 키우지 않을 것
- 기술적 깊이를 보여주되 framework ceremony가 핵심 설계를 가리지 않을 것

## Alternatives

### Fastify

- 장점: 작은 core, schema-based validation/serialization, TypeScript type provider, API와 worker의 TS 일관성
- 단점: architecture convention과 DI를 팀이 직접 정해야 하며 일부 type provider는 별도 선택 필요

### Elysia

Bun을 1차 대상으로 만들어진 TypeScript framework이지만 `@elysiajs/node` 어댑터로 Node 18+에서도 실행된다. framework 선택과 runtime 선택을 분리할 수 있다.

- 장점: TypeBox 기반 `t.*` 스키마 하나에서 runtime validation, TS 타입 추론, OpenAPI 문서가 함께 생성되므로 별도 schema library 선택이 필요 없다. 1.3부터 normalization이 기본이며 응답에 정의되지 않은 필드가 새는 것을 줄인다. 전역 `sanitize` 옵션으로 문자열 입출력 처리를 한 곳에서 강제할 수 있다.
- 단점: Node 경로는 Bun 경로보다 사용 사례가 적고 어댑터 고유 이슈가 보고된다(예: Node cluster에서 port 재사용, elysiajs/elysia#1619). Bun 특화 최적화(Bun system router 등)의 이점은 Node에서 얻지 못한다. Eden Treaty typed client는 web이 API 앱의 타입을 직접 import하게 만들어 `apps → packages` 의존 방향과 충돌한다.

### Bun runtime 위의 Elysia

같은 framework를 Bun runtime에서 실행하는 변형이며 별도로 평가한다.

- 장점: Bun 특화 성능 경로를 사용하고 install/test 시작 시간이 짧다. queue는 장애물이 아니다. BullMQ는 전체 테스트 스위트를 Bun에서 CI로 실행하며 공식 호환을 선언했고 Bun Redis client 어댑터도 제공한다.
- 단점: Playwright의 공식 지원 런타임은 Node.js이며 Bun은 공식 지원 대상이 아니다. 확인 시점 자료 기준으로 browser launch와 child process 처리, tracing, network interception이 Bun에서 부분 지원으로 분류된다. 이 목록은 SECURITY §4.2가 요구하는 download/popup 차단, third-party request 제한, trace artifact 보존과 겹치므로 `COL-005`에서 실측이 필요하다. Vitest도 Bun에서 알려진 실행 문제가 있어 테스트 러너를 native runner로 바꿔야 하고 Testcontainers 동작은 확인하지 못했다.

과거에 보고된 Bun+Playwright 실패 사례(oven-sh/bun#10120, #8222)는 모두 종료된 이슈이고 Bun 1.0~1.1 시기의 기록이므로 현재 상태의 근거로 사용하지 않는다. #8222은 `playwright.config.ts`가 없을 때는 Bun에서 테스트가 통과했다고 기록하고 있어, 일반적인 browser launch 불가로 해석할 수 없다. 반대로 `playwright test` CLI는 Bun 프로젝트에서도 기본적으로 Node로 실행되므로 UI E2E는 이 논점의 영향을 받지 않는다. 판단 근거는 미해결 버그가 아니라 공식 지원 범위와 부분 지원 기능의 위치다.

### NestJS

- 장점: module/DI/decorator convention, 큰 애플리케이션 구조, queue 등 integration ecosystem
- 단점: MVP에 ceremony가 많고 domain보다 framework abstraction이 두드러질 수 있음

### FastAPI

- 장점: Python AI 생태계, Pydantic/OpenAPI, 빠른 AI prototype
- 단점: collector/UI/queue와 언어·schema 경계가 늘고 TypeScript 필수 요소가 핵심 backend에서 약해질 수 있음

## EXP-005 측정 결과 (2026-09-01)

Playwright 게이트를 실측했고 **Bun runtime에서 실패했다.** 상세는 [EXP-005](../experiments/EXP-005-foundation-spike.md)에 있다.

| 측정 | Node 26.5.0 | Bun 1.3.14 |
|---|---|---|
| local launch (pipe transport) | ok, 206ms | fail, 180초 타임아웃 |
| ws connect (browser server) | ok, 24ms | fail, 30초 타임아웃 |
| fixture 10회 추출 / 차단 / trace | 전 항목 통과 | 측정 불가 |

Playwright 버전, Chromium 바이너리(151.0.7922.34), 스크립트, 머신을 고정하고 런타임만 바꾼 비교다. Bun 실패는 연결 수립 단계에서 발생했고 고급 기능이 아니라 기본 경로가 막혔다.

**이 결과가 완화책의 비용을 바꿨다.** 아래 Recommendation은 원래 실패 시 "collector만 Node로 분리하거나 browser server에 원격 접속"을 대안으로 뒀는데, **ws connect가 Bun에서 동작하지 않으므로 원격 접속 안은 성립하지 않는다.** Bun을 유지하려면 브라우저 구동까지 포함한 완전한 별도 Node 애플리케이션이 필요하다.

따라서 이 ADR의 Fallback 조항에 따라 **추천을 `Node runtime 위의 Elysia`로 변경한다.** framework 선택은 바뀌지 않고 runtime만 되돌린다. 스키마 단일 소스 이점은 유지되고 Vitest·Testcontainers 추천안도 다시 유효해진다.

Bun을 유지하는 선택도 여전히 가능하다. 그 경우 런타임 이원화와 CI·이미지·의존성 관리 이중화를 감수한다는 뜻이며 `DEC-002`에 그 근거를 남긴다.

## Recommendation

**Node runtime 위의 Elysia**를 추천한다. framework는 Elysia를 유지하고 runtime은 Node를 사용한다.

선택 근거는 다음 순서다.

1. `t.*` 스키마 하나가 runtime validation, TS 타입, OpenAPI의 단일 출처가 되어 `CON-001`의 acceptance를 framework 기본 기능으로 충족한다. Fastify를 선택하면 이 역할을 하는 library를 별도 결정으로 남겨야 한다.
2. Node runtime에서 Playwright가 실측으로 전 항목을 통과했다. 필수 기술이 우회 구조 없이 동작한다.
3. Vitest와 Testcontainers 추천안이 그대로 유효하므로 테스트 도구 결정을 다시 열지 않는다.
4. API, worker, LangGraph.js, contract를 TypeScript로 통일하는 장점은 유지된다.
5. `@elysiajs/node` 어댑터로 실행하며, 공식 discussion에 따르면 WinterCG 웹 표준 호환 덕에 어댑터 없이 동작하는 경우도 있다. 실제 실행 형태는 `EXP-005`의 나머지 항목에서 확정한다.

### Bun을 채택할 경우의 조건

`DEC-002`에서 Bun을 선택한다면 다음을 함께 승인하는 것으로 본다.

- browser collector를 브라우저 구동까지 포함한 별도 Node 애플리케이션으로 분리한다. `apps/`에 Node 전용 deployable이 하나 늘어난다.
- 런타임 이원화에 따른 CI matrix, 컨테이너 이미지, 의존성 잠금 파일 관리 비용을 감수한다.
- 테스트 러너를 Bun native runner로 재평가하고 Testcontainers 대안을 확정한다.
- 이 분리는 ARCHITECTURE §10의 일반 분리 기준이 아니라 런타임 호환에 근거한 예외로 기록한다.

**Fallback:** Elysia의 Node 경로가 `EXP-005`의 나머지 항목에서 문제를 보이면 Fastify로 되돌린다. Python-only 모델·평가 도구가 필수라는 실험 결과가 나오면 FastAPI sidecar를 별도 ADR로 검토한다.

## Consequences if accepted

- 별도 schema/validation library를 선택하지 않는다. 스키마 정의는 Elysia의 TypeBox 계열 `t.*`를 사용하고 OpenAPI는 같은 스키마에서 생성한다. `EXP-005` run 2에서 package 3개(`elysia`, `@elysiajs/node`, `@elysiajs/openapi`)로 성립함을 확인했다.
- **알 수 없는 요청 필드 거부를 명시적으로 설정한다.** `EXP-005` run 2 측정에서 기본 설정은 이 필드를 조용히 제거했다. Elysia는 `normalize: false`가 필요하다.
- **검증 실패를 400으로 매핑한다.** Elysia는 기본적으로 422를 반환한다.
- `packages/contracts`는 TypeBox에 의존할 수 있으나 Elysia에는 의존하지 않는다. worker와 job schema가 HTTP framework를 끌고 들어오지 않게 한다.
- 응답 스키마에 선언되지 않은 필드는 제거한다. `EXP-005` run 2에서 두 framework의 기본 동작으로 확인됐으므로 별도 구현은 필요하지 않고 회귀 테스트로 고정한다.
- runtime은 **Node로 고정한다.** `package.json`의 engines와 Docker base image에 Node 버전을 pin한다. Bun은 도입하지 않는다.
- 테스트 도구는 Vitest와 Testcontainers를 사용한다. `EXP-005` run 4에서 Node runtime에서 둘 다 동작함을 확인했다.
- browser collector를 별도 runtime으로 분리하지 않는다. `EXP-005` run 1에서 Node runtime의 Playwright가 fixture 파싱, download·popup 차단, trace 저장을 모두 통과했다.
- domain package는 Elysia의 request/context type에 의존하지 않는다. handler는 검증된 평범한 객체를 domain에 넘긴다.
- API와 worker는 deployable process를 분리한다.
- Node 어댑터 경로의 알려진 이슈(cluster/port 재사용 등)를 배포 형태 결정 시 확인한다. MVP는 단일 프로세스로 시작한다.
- Python AI code를 기본 경로에 추가하려면 새 ADR이 필요하다.

## Validation before acceptance

`EXP-005`에서 다음을 확인한다.

- Bun runtime 위 Elysia로 answer/health stub을 구현하고 하나의 스키마에서 runtime validation과 OpenAPI가 함께 나오는지 확인한다.
- Bun runtime에서 Playwright가 fixture 파싱과 download/popup 차단, trace 저장까지 수행하는지 확인한다. 실패 시 Node collector 분리 비용을 함께 기록한다.
- 같은 계약을 Node runtime 위 Elysia와 Fastify로 구현해 필요한 개념 수와 추가 library 수를 비교한다.
- BullMQ worker의 crash/retry와 동일 job 재전달이 Bun에서 멱등하게 동작하는지 확인한다.
- PostgreSQL vector query와 pgvector client가 Bun에서 동작하는지 확인한다.
- unit/component 테스트를 Bun native runner로 실행할 때 fake clock/ID/provider harness가 성립하는지 확인한다.
- integration 환경을 Testcontainers 또는 격리 Compose 중 무엇으로 구성할 수 있는지 확인한다.
- framework 없이 domain unit test가 실행되는지 확인한다.

## References

- [Elysia documentation](https://elysiajs.com/)
- [Elysia 1.3 release notes](https://elysiajs.com/blog/elysia-13)
- [Elysia: Integration with Node.js](https://elysiajs.com/integrations/node)
- [Bun: Node.js compatibility](https://bun.com/docs/runtime/nodejs-compat)
- [BullMQ: BunJS vs NodeJS benchmark and compatibility](https://bullmq.io/articles/benchmarks/bunjs-vs-nodejs/)
- [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [Fastify validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [NestJS documentation](https://docs.nestjs.com/)
- [FastAPI features](https://fastapi.tiangolo.com/features/)
- [Playwright supported languages and Node.js targeting](https://playwright.dev/docs/languages)
- [과거 Bun+Playwright 보고(종료됨, Bun 1.0~1.1 시기): bun#8222](https://github.com/oven-sh/bun/issues/8222)


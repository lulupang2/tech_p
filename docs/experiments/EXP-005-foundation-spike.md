# EXP-005: Foundation stack spike

- 상태: Completed — 5개 run 측정 완료(2026-09-01). 미측정 항목은 구현 task로 이관
- 연결 ADR: [ADR-0001](../adr/0001-backend-framework.md), [ADR-0003](../adr/0003-queue-and-scheduling.md), [ADR-0007](../adr/0007-repository-layout.md)
- 실행 승인: 사용자, 2026-09-01
- 코드 위치: `experiments/exp-005/` (폐기 대상)

## 질문

추천안인 Bun runtime 위의 Elysia + Redis/BullMQ + pnpm workspaces가 핵심 경계를 적은 ceremony로 표현하고 로컬 Docker/테스트에서 재현 가능한가? 스키마 단일 소스와 필수 기술 Playwright가 이 runtime에서 함께 성립하는가, 아니면 collector만 Node로 분리해야 하는가?

## 범위

이 실험은 사용자 승인(2026-09-01) 후 실행되어 완료됐다. `experiments/exp-005/` 아래 최소 code로 수행했다. **이 code는 disposable spike이며 production feature가 아니다.** production 경로에 섞지 않고, 승격할 내용은 해당 `FND-*` task에서 다시 작성한다.

최소 흐름:

1. typed health/answer stub contract
2. 같은 스키마 정의에서 runtime validation과 OpenAPI 문서가 함께 생성되는지 확인
3. versioned job schema로 한 개의 no-op processing job
4. PostgreSQL에 run 상태 한 건 기록. pgvector client가 Bun에서 동작하는지 함께 확인
5. worker 재시작과 동일 job 재전달
6. Bun runtime에서 Playwright로 로컬 fixture 페이지 1건 파싱, download/popup 차단과 trace 저장 동작 확인
7. unit test 1건을 Bun native runner로 실행하고 fake clock/ID/provider 주입이 성립하는지 확인
8. focused package test와 Docker start/stop

실제 crawler, 실제 LLM, 전체 UI는 포함하지 않는다. 6번은 외부 사이트가 아니라 로컬에서 제공하는 고정 HTML을 대상으로 한다.

## 비교

- Bun runtime 위 Elysia, Node runtime 위 Elysia, Fastify의 동일 contract 구현량·경계 가시성, 그리고 validation/OpenAPI를 위해 추가로 필요한 library 수
- Bun native runner와 Vitest의 unit test 작성·실행 차이, fake 주입 가능성
- Testcontainers와 격리 Compose의 integration 환경 구성 난이도
- BullMQ와 PostgreSQL job table의 crash/retry 의미
- pnpm workspace만 사용한 task 실행과 추가 orchestrator 필요성

FastAPI는 Python 경계가 필요한 구체 증거가 있을 때 동일한 최소 contract로 추가 비교한다.

## Metrics

- production/test line 수보다 module/package 수와 concept 수
- cold install/build/test 시간
- 빈 DB migration과 Docker startup 성공률
- worker crash 후 duplicate side effect 수
- OpenAPI/runtime schema drift
- domain unit test의 framework dependency 수

## Gate

추천 stack은 다음을 만족해야 한다.

- Windows/macOS/Linux CI 대상에서 문서화된 단일 workflow로 시작 가능
- 동일 job 2회 전달 시 business row 중복 0
- API contract와 runtime validation이 한 schema source에서 일치하며 이를 위해 추가 schema library를 도입하지 않음
- pgvector query가 선택 runtime의 client로 동작
- unit test가 선택 runtime의 러너에서 network·실제 clock 없이 결정적으로 실행
- integration 환경을 문서화된 한 방법으로 재현 가능
- domain test가 Redis와 HTTP framework 없이 실행
- 추가 build orchestrator 없이 focused build/test가 실용적
- graceful shutdown과 healthcheck 동작

Playwright 항목은 별도로 판정한다. Bun runtime에서 fixture 페이지를 10회 중 9회 이상 동일하게 파싱하고 download/popup 차단과 trace 저장이 함께 동작하면 collector를 같은 runtime에 둔다. 실패하면 추천 stack 전체를 폐기하지 않고 collector만 Node runtime으로 분리하는 안을 측정 결과와 함께 기록한다. 분리 비용이 과도하면 runtime을 Node로 되돌리는 것을 recommendation으로 제시한다.

어느 경우에도 Playwright 기능을 포기해 SECURITY §4.2의 차단 요구사항을 낮추는 방식은 통과로 보지 않는다.

## 실행 기록: workspace 게이트 (run 5)

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-005-run-5-workspace |
| 실행일 | 2026-09-01 (KST) |
| 도구 | pnpm 10.32.1, Node 26.5.0 내장 `node --test` |
| 코드 위치 | `experiments/exp-005/ws/` |

승인된 package 경계를 축소 재현했다. `packages/contracts` → `packages/domain` → `apps/api` 의존 사슬을 만들고 workspace 프로토콜로 연결했다.

| 측정 | 결과 |
|---|---|
| `pnpm -r test` | `Scope: 3 of 4 workspace projects`, 세 패키지 모두 pass 1 / fail 0 |
| `pnpm --filter @exp/domain test` | 해당 패키지만 실행, pass 1 |
| `pnpm --filter "@exp/contracts..." test` | 의존 그래프 기반 실행 성공 |
| workspace 링크 | `packages/domain/node_modules/@exp/contracts`가 Junction으로 연결됨 (Windows) |
| cross-package import | `@exp/domain`이 `@exp/contracts`를, `@exp/api`가 `@exp/domain`을 정상 해석 |

**추가 build orchestrator 없이 focused test가 동작한다.** [ADR-0007](../adr/0007-repository-layout.md)의 "초기에는 Turborepo/Nx를 추가하지 않는다"는 판단을 뒷받침한다.

한계: 실제 TypeScript 빌드와 Docker build context는 측정하지 않았다. 이 spike는 JavaScript와 `node --test`만 사용했다.

## 종합 결론 (2026-09-01)

### scorecard

| gate | 결과 | 근거 run |
|---|---|---|
| Playwright가 선택 runtime에서 fixture 파싱·차단·trace 수행 | **Node 통과, Bun 실패** | run 1 |
| API contract와 runtime validation이 한 schema source에서 일치 | **통과** (Elysia 3 package, Fastify 4 package) | run 2 |
| 추가 schema library 도입 없음 | **통과** | run 2 |
| 동일 job 2회 전달 시 business row 중복 0 | **통과** (handler 5회 호출, row 3개, 중복 0) | run 3 |
| pgvector query가 선택 runtime client로 동작 | **통과** (pg 8.23.0, pgvector 0.8.6) | run 3 |
| unit test가 network·실제 clock 없이 결정적 실행 | **통과** (Vitest 5/5) | run 4 |
| integration 환경을 문서화된 한 방법으로 재현 | **통과** (Testcontainers) | run 4 |
| domain test가 Redis·HTTP framework 없이 실행 | **통과** | run 5 |
| 추가 build orchestrator 없이 focused build/test 실용적 | **통과** | run 5 |

### ADR별 recommendation

| ADR | 결론 |
|---|---|
| [ADR-0001](../adr/0001-backend-framework.md) | **Revise.** framework는 Elysia 유지, runtime은 Bun → **Node**로 변경. Playwright가 Bun에서 두 transport 모두 실패했고 우회 경로도 막혔다 |
| [ADR-0003](../adr/0003-queue-and-scheduling.md) | **Accept 가능.** BullMQ를 전달·예약 계층으로만 쓰고 business 완료를 PostgreSQL에 기록하는 구조가 실측으로 성립. 미측정 항목은 `QUE-001`로 이관 |
| [ADR-0007](../adr/0007-repository-layout.md) | **Accept 유지.** pnpm workspace만으로 focused test가 실용적임을 확인 |

### 미측정 항목

`DEC-002`·`DEC-004` 승인 후 해당 구현 task의 acceptance로 넘긴다.

| 항목 | 이관 대상 |
|---|---|
| 프로세스 강제 종료(SIGKILL) 후 재시작 복구 | `QUE-001` |
| 다중 worker 경합과 backpressure | `QUE-001` |
| DB commit 후 job 유실에 대한 outbox 필요성 | `QUE-001` |
| graceful shutdown과 healthcheck 동작 | `API-001`, `OPS-001` |
| Linux CI 러너에서의 재확인 | `FND-003`, `FND-006` |
| 실제 TypeScript 빌드와 Docker build context | `FND-001`, `OPS-001` |
| Bun runtime에서의 Vitest·Testcontainers | Bun 채택 시에만 필요 |

### spike code 처리

`experiments/exp-005/`의 코드는 **전량 폐기 대상**이다. production으로 가져갈 것은 코드가 아니라 아래 결론이다.

- runtime은 Node, framework는 Elysia
- 알 수 없는 요청 필드 거부는 명시적 설정이 필요하다
- 검증 실패 코드를 400으로 매핑해야 한다
- business 멱등성은 자연 키 unique + upsert로 확보한다
- Vitest와 Testcontainers를 사용한다

## 실행 기록: 테스트 도구 게이트 (run 4)

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-005-run-4-test-tooling |
| 실행일 | 2026-09-01 (KST) |
| 런타임 | Node 26.5.0 |
| 버전 | vitest 4.1.11, @testcontainers/postgresql 12.1.0, pg 8.23.0 |
| 코드 위치 | `experiments/exp-005/harness.test.mjs`, `testcontainers.test.mjs` |

### 결정적 harness (Vitest)

5개 테스트 전부 통과, 9ms. 검증 항목은 다음과 같다.

- fake clock(`vi.setSystemTime`)이 rolling window 계산을 구동한다. `2026-09-01T03:00:00Z` 기준 7일 창이 `2026-08-25T03:00:00Z`로 계산됐다.
- 주입한 ID generator가 결정적이다(`req_a_1`, `req_a_2`, `req_a_3`).
- `from` inclusive / `to` exclusive 경계가 정확하다. `to`와 같은 시각은 false, 1ms 이전은 true.
- `published_at`이 null인 문서가 시간 필터 후보에서 제외된다.
- 실제 clock을 쓰지 않는다.

`TST-001`이 요구하는 "network·실제 clock 없이 결정적 실행"과 fake 주입이 성립한다.

### integration 환경 (Testcontainers)

3개 테스트 전부 통과. 테스트 본체 7.66초, 컨테이너 기동 포함 총 20.59초.

- 빈 DB에 `create extension vector`와 migration 적용 성공
- `(document_id, normalized_hash)` unique 제약이 두 번째 insert를 거부하고 row 수가 1로 유지됨
- **시간 필터 + 벡터 정렬 질의가 window 밖 revision을 정확히 제외했다.** 창 안의 revision 2만 반환되고 2026-07-01 게시분은 걸러졌다

즉 `DB-003`의 revision 불변성 검증과 `DB-006`의 "time/status filter를 강제한 벡터 질의"가 실제 PostgreSQL에서 성립한다.

### gate 판정

- "unit test가 선택 runtime의 러너에서 network·실제 clock 없이 결정적으로 실행" — **통과**
- "integration 환경을 문서화된 한 방법으로 재현 가능" — **통과.** Testcontainers가 Node에서 동작하므로 [TESTING §13](../TESTING.md)의 추천을 격리 Compose에서 Testcontainers로 되돌릴 근거가 생겼다

### 한계

- Bun runtime에서 Vitest·Testcontainers는 측정하지 않았다. Playwright 결과로 Bun 채택 가능성이 낮아져 우선순위를 내렸다.
- Windows 환경에서만 측정했다. CI의 Linux 러너에서 재확인이 필요하다.
- `vitest --reporter=basic`은 Vitest 4에서 제거됐다. CI 스크립트 작성 시 리포터 이름을 확인해야 한다.

## 실행 기록: queue·pgvector 게이트 (run 3)

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-005-run-3-queue-gate |
| 실행일 | 2026-09-01 (KST) |
| 런타임 | Node 26.5.0 |
| 버전 | bullmq 6.3.3, ioredis 6.0.0, pg 8.23.0 |
| 인프라 | Docker 29.7.2. `redis:7-alpine`(:63790), `pgvector/pgvector:pg17`(:55432) |
| DB | PostgreSQL 17.11, pgvector 0.8.6 |
| 코드 위치 | `experiments/exp-005/queue-gate.mjs` |

### 설계

세 가지 전달 패턴을 한 번에 넣고 business row 수를 관찰했다. business write는 자연 키 `(source_key, window_start)`에 unique 제약을 두고 `on conflict do update set attempts = attempts + 1`로 처리했다.

1. 같은 `jobId`로 2회 add — BullMQ 수준 중복 제거 확인
2. 다른 `jobId`, 동일 payload로 2회 add — handler 멱등성 확인
3. **commit 이후 crash** 후 retry — at-least-once 상황에서 중복 발생 여부 확인

### 결과

| 지표 | 값 |
|---|---|
| BullMQ 완료 job | 4 (같은 `jobId` 2회 add가 1개로 합쳐짐) |
| handler 호출 횟수 | **5** (crash된 job의 retry 포함) |
| business row 수 | **3** |
| 중복된 자연 키 | **0** |
| source별 attempts | `github_releases`=1, `stack_exchange`=2, `arxiv`=2 |
| pgvector 최근접 질의 | `[1,0,0]` 기준 상위 2건이 `[1,0,0]`과 `[0.9,0.1,0]` — 정상 |

**handler가 5회 호출됐는데 business row는 3개다.** at-least-once 전달이 실제로 관찰됐고(5 > 4), 그 상황에서 자연 키 제약과 upsert가 중복을 0으로 막았다. `attempts` 컬럼이 재전달 횟수를 그대로 보여준다.

`github_releases`의 attempts가 1인 것은 BullMQ가 같은 `jobId`의 두 번째 add를 중복으로 버렸기 때문이다. 즉 **queue 수준 중복 제거와 handler 수준 멱등성이 각각 독립적으로 동작함**을 같은 실행에서 확인했다.

### gate 판정

- "동일 job 2회 전달 시 business row 중복 0" — **통과**
- "pgvector query가 선택 runtime의 client로 동작" — **통과** (pg 8.23.0, pgvector 0.8.6)
- BullMQ를 전달·예약 계층으로만 쓰고 business 완료를 PostgreSQL에 기록하는 [ADR-0003](../adr/0003-queue-and-scheduling.md)의 구조가 실제로 성립함을 확인

### 한계

- crash 시나리오를 예외 throw로 모의했다. 프로세스 강제 종료(SIGKILL) 후 재시작은 측정하지 않았다.
- 단일 Redis·단일 worker, concurrency 2에서의 측정이다. backpressure와 다중 worker 경합은 측정하지 않았다.
- outbox 패턴의 필요성(DB commit 후 job 생성 유실)은 이 실험에서 다루지 않았다.

## 실행 기록: 계약 게이트 (run 2)

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-005-run-2-contract-gate |
| 실행일 | 2026-09-01 (KST) |
| 런타임 | Node 26.5.0 |
| 버전 | elysia 1.4.30, @elysiajs/node 1.4.5, @elysiajs/openapi 1.4.15, fastify 5.12.1, @fastify/type-provider-typebox 6.1.0, @fastify/swagger 9.8.1, @sinclair/typebox 0.34.52 |
| 코드 위치 | `experiments/exp-005/elysia-server.mjs`, `fastify-server.mjs`, `contract-gate.mjs` |
| 대상 | [API.md](../API.md) answer 계약의 부분집합을 동일하게 두 프레임워크로 구현 |

### 스키마 단일 소스

두 프레임워크 모두 **하나의 TypeBox 스키마 선언에서 runtime validation과 OpenAPI 문서가 함께 생성됐다.** OpenAPI 문서에 request의 `question`과 `minLength`, response의 `citations`와 `excerptIsVerbatim`이 모두 나타나는 것을 확인했다.

| 항목 | Elysia (Node) | Fastify |
|---|---|---|
| 필요 package 수 | 3 (`elysia`, `@elysiajs/node`, `@elysiajs/openapi`) | 4 (`fastify`, `@fastify/type-provider-typebox`, `@fastify/swagger`, `@sinclair/typebox`) |
| TypeBox 접근 | `elysia`가 `t`로 재수출 | 별도 의존성 |
| OpenAPI 서빙 | 플러그인 기본 경로 `/openapi/json` | 라우트를 직접 작성해야 함(`app.swagger()` 반환) |
| 유효 요청 | 200 | 200 |
| 필수 필드 누락 | **422** | **400** |
| enum 위반 | 422 | 400 |
| `minLength` 위반 | 422 | 400 |

### 미선언 응답 필드 누출 (leak probe)

핸들러가 스키마에 없는 `_internalScore`, `_chunkText`를 반환하도록 만들고 응답을 검사했다.

**두 프레임워크 모두 기본 설정에서 미선언 필드를 제거했다.** 네 가지 모드 전부에서 누출 필드 0건이다. 즉 [SSOT §3.2](../SSOT.md)의 "응답 스키마에 선언되지 않은 필드는 정규화 단계에서 제거한다"와 내부 retrieval score 노출 금지 규칙이 framework 수준에서 강제된다.

### 알 수 없는 요청 필드 처리 — 계약과 불일치 발견

[API.md §1](../API.md)은 "enum과 object는 알 수 없는 필드를 기본 거부해 계약 drift를 조기에 발견한다"고 규정한다. **기본 설정은 이 규칙을 만족하지 않는다.**

| 조건 | Elysia | Fastify |
|---|---|---|
| 기본 설정, 느슨한 스키마 | 200 (제거) | 200 (제거) |
| 기본 설정, `additionalProperties: false` | **200 (제거)** | **200 (제거)** |
| strict 설정, 느슨한 스키마 | **422 (거부)** | 200 (통과) |
| strict 설정, `additionalProperties: false` | **422 (거부)** | **400 (거부)** |

strict 설정은 Elysia가 `new Elysia({ normalize: false })`, Fastify가 `Fastify({ ajv: { customOptions: { removeAdditional: false } } })`다.

관찰 두 가지가 중요하다.

1. **`additionalProperties: false`만으로는 거부되지 않는다.** 두 프레임워크가 기본적으로 추가 필드를 제거하도록 설정되어 있어 스키마 제약이 오류가 아니라 제거로 처리된다.
2. **Elysia는 `normalize: false`만으로 스키마 화이트리스트 거부가 된다.** 스키마마다 `additionalProperties: false`를 붙이지 않아도 선언되지 않은 필드를 거부한다. Fastify는 ajv 옵션과 스키마 제약을 **둘 다** 설정해야 한다.

### 계약에 반영해야 할 사항

- 알 수 없는 요청 필드 거부는 기본값이 아니므로 **명시적 설정을 구현 조건으로 못박아야 한다.** `CON-001`과 API contract test에서 검증한다.
- Elysia를 선택하면 검증 실패가 **422**로 나온다. API.md 오류 표는 400 `INVALID_REQUEST`이므로 매핑이 필요하다.
- 미선언 응답 필드 제거는 두 프레임워크의 기본 동작이므로 별도 구현이 필요하지 않다. 다만 회귀 테스트로 고정한다.

### gate 판정

"API contract와 runtime validation이 한 schema source에서 일치하며 추가 schema library를 도입하지 않는다"는 gate를 **두 프레임워크 모두 충족한다.** Elysia가 package 1개와 OpenAPI 서빙 라우트 1개를 덜 쓴다. 결정적 차이는 아니지만 방향은 ADR-0001의 근거와 일치한다.

## 실행 기록: Playwright 게이트 (run 1)

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-005-run-1-playwright-gate |
| 실행일 | 2026-09-01 (KST) |
| 실행자 | agent |
| OS | Windows |
| 런타임 | Node 26.5.0, Bun 1.3.14 |
| Playwright | 1.56.1 |
| 브라우저 | Playwright 관리 Chromium 151.0.7922.34 (`chromium-1234` 캐시 빌드). 두 런타임에 **동일 바이너리**를 `executablePath`로 명시 |
| 코드 위치 | `experiments/exp-005/playwright-gate.mjs`, `playwright-connect-gate.mjs`, `browser-server.mjs` |
| 대상 | 로컬 HTTP fixture. 외부 사이트 미사용 |
| 비용 | 없음 (기존 캐시 브라우저 재사용) |

### 결과

두 개의 transport를 각각 측정했다. Playwright의 기본 경로는 `--remote-debugging-pipe`이고, 대안은 `launchServer` + `connect`의 websocket이다.

| 측정 | Node 26.5.0 | Bun 1.3.14 |
|---|---|---|
| local launch (pipe transport) | **ok, 206ms** | **fail, 210,349ms** — `Timeout 180000ms exceeded` |
| fixture 10회 추출 일치 | 10/10 | 측정 불가 |
| popup 인터셉트 | true | 측정 불가 |
| download 차단 (`acceptDownloads: false`) | true | 측정 불가 |
| host allowlist abort | true | 측정 불가 |
| trace 저장 | true, 51,523 B | 측정 불가 |
| ws connect (browser server) | **ok, 24ms**, 전 항목 통과, trace 154,155 B | **fail, 30,010ms** — `Timeout 30000ms exceeded` at `<ws connecting>` |

### 관찰

- Bun의 local launch 실패 로그에 `<launched> pid=31532`가 있다. **브라우저 프로세스는 생성됐고 이후 핸드셰이크가 완료되지 않았다.** 실행 인자에 `--remote-debugging-pipe`가 포함되므로 추가 stdio 파일 디스크립터 전달이 필요한데 이 지점이 완료되지 않은 것으로 보인다. 원인 단정은 이 실험 범위를 넘는다.
- ws connect 실패는 `<ws connecting>` 단계에서 멈췄다. **동일 브라우저 서버에 Node는 24ms에 접속해 전 항목을 통과했으므로 서버 측 문제가 아니다.**
- 따라서 Bun에서는 두 transport 모두 동작하지 않았다. 문제는 tracing이나 network interception 같은 고급 기능이 아니라 **연결 수립 자체**다.

### gate 판정

`EXP-005`의 Playwright 항목은 **Bun runtime에서 실패**다. Node runtime에서는 fixture 파싱 10/10 일치, download·popup 차단, trace 저장이 모두 통과해 gate를 충족한다.

이 결과는 완화책의 비용도 바꾼다. 당초 예상은 browser collector만 Node 프로세스로 분리하거나 browser server에 원격 접속하는 것이었는데, **ws connect가 Bun에서 동작하지 않으므로 후자는 불가능하다.** Bun runtime을 유지하려면 collector를 브라우저 구동까지 포함한 완전한 별도 Node 애플리케이션으로 두어야 한다.

### 한계

- 단일 머신, Windows, 단일 Bun 버전(1.3.14)에서의 측정이다. 다른 OS나 상위 Bun 버전에서 결과가 다를 수 있다.
- Bun 실패의 근본 원인을 코드 수준에서 규명하지 않았다. 재현 사실과 실패 지점만 기록했다.
- Playwright가 요구하는 리비전은 1194였으나 캐시에 완전한 1194 빌드가 없어 1234 빌드를 사용했다. 두 런타임에 같은 바이너리를 썼으므로 비교에는 영향이 없다.

### 다음 행동

`DEC-002`에서 runtime을 정한다. 선택지는 둘이다.

1. **Node runtime 위의 Elysia로 되돌린다.** [ADR-0001](../adr/0001-backend-framework.md)의 Fallback 조항이 규정한 경로다. 스키마 단일 소스 이점은 유지하고 Playwright 리스크는 사라진다. Vitest·Testcontainers 추천안도 그대로 유효해진다.
2. **Bun을 유지하고 browser collector를 별도 Node 애플리케이션으로 둔다.** 런타임이 둘로 나뉘고 CI·이미지·의존성 관리가 이원화된다. ws connect가 막혔으므로 분리 범위가 당초 예상보다 크다.

## 실행 기록 (템플릿)

# Signal Archive Topic Taxonomy

- 상태: Draft — 초기 seed. `EXP-001`과 `EVAL-001` 결과로 조정
- 작성일: 2026-09-01
- taxonomy_version: `2026-09-01.1`
- 관련: [SOURCE_CATALOG.md](./SOURCE_CATALOG.md), [DATA_PIPELINE.md](./DATA_PIPELINE.md) §5.6, [GLOSSARY.md](./GLOSSARY.md)

`PIPE-005`는 "deterministic alias 우선, classifier version/confidence 저장"을 요구한다. 이 문서가 그 deterministic alias dictionary의 seed다. `SOURCE_CATALOG`의 GitHub search 질의에 쓰이는 `topic` 값도 여기서 가져온다.

## 1. 규칙

- `slug`는 canonical 식별자이며 `lower_snake_case`가 아니라 `kebab-case`를 쓴다. GitHub topic 표기와 일치시키기 위한 예외다.
- alias 매칭은 대소문자를 무시하고 **단어 경계를 지켜** 수행한다. `go`가 `google`에 매칭되면 안 된다.
- alias는 오탐이 생기지 않는 것만 등록한다. 모호한 짧은 토큰(`ai`, `rag`, `bun`)은 단독 매칭 대신 문맥 조건이나 source 제한을 함께 둔다.
- deterministic 매칭이 실패했을 때만 LLM topic extraction을 사용하고, 결과에 방식과 confidence를 기록한다.
- 낮은 confidence 결과는 검색 필터의 hard truth로 쓰지 않는다.
- taxonomy를 변경하면 `taxonomy_version`을 올리고 기존 `document_topics` 행을 파괴하지 않는다. 재분류는 새 version으로 추가한다.

## 2. 계층

`parent_id`로 2단만 둔다. 더 깊은 계층은 MVP에서 만들지 않는다.

```text
language-runtime
  typescript, javascript, nodejs, bun, deno, python, rust, go
web-framework
  react, nextjs, vue, vite, svelte, astro
backend-framework
  elysia, fastify, nestjs, express, hono
database
  postgresql, pgvector, redis, sqlite
ai-ml
  llm, rag, embedding, vector-search, langchain, langgraph, mcp, agent
testing-tooling
  playwright, vitest, jest, testcontainers
infra-devops
  docker, kubernetes, ci-cd, queue
```

## 3. Seed 항목

`ambiguous`가 true면 단독 토큰 매칭을 금지하고 문맥 조건을 요구한다.

| slug | parent | display_name | alias | ambiguous |
|---|---|---|---|---|
| `typescript` | language-runtime | TypeScript | ts, 타입스크립트 | false |
| `javascript` | language-runtime | JavaScript | js, 자바스크립트, ecmascript | false |
| `nodejs` | language-runtime | Node.js | node, node.js, 노드 | true (`node`는 단독 금지) |
| `bun` | language-runtime | Bun | bunjs, bun.sh | true (`bun` 단독 금지) |
| `deno` | language-runtime | Deno | denoland | false |
| `python` | language-runtime | Python | 파이썬, py | true (`py` 단독 금지) |
| `rust` | language-runtime | Rust | rustlang, 러스트 | true (`rust` 단독 금지) |
| `go` | language-runtime | Go | golang, 고랭 | true (`go` 단독 금지) |
| `react` | web-framework | React | reactjs, react.js, 리액트 | false |
| `nextjs` | web-framework | Next.js | next.js, next | true (`next` 단독 금지) |
| `vue` | web-framework | Vue | vuejs, vue.js, 뷰 | true (`뷰` 단독 금지) |
| `vite` | web-framework | Vite | vitejs | false |
| `svelte` | web-framework | Svelte | sveltekit | false |
| `astro` | web-framework | Astro | astrojs, astro.build | true |
| `elysia` | backend-framework | Elysia | elysiajs | false |
| `fastify` | backend-framework | Fastify | — | false |
| `nestjs` | backend-framework | NestJS | nest.js, nest | true (`nest` 단독 금지) |
| `express` | backend-framework | Express | expressjs | true |
| `hono` | backend-framework | Hono | honojs | false |
| `postgresql` | database | PostgreSQL | postgres, psql, 포스트그레스 | false |
| `pgvector` | database | pgvector | — | false |
| `redis` | database | Redis | — | false |
| `sqlite` | database | SQLite | — | false |
| `llm` | ai-ml | Large Language Model | large language model, 대규모 언어 모델 | true (`llm` 단독 허용, 약어가 고유) |
| `rag` | ai-ml | Retrieval-Augmented Generation | retrieval augmented generation, retrieval-augmented generation | true (`rag` 단독 금지, 영어 일반명사 충돌) |
| `embedding` | ai-ml | Embedding | embeddings, 임베딩 | false |
| `vector-search` | ai-ml | Vector search | vector database, vector db, 벡터 검색 | false |
| `langchain` | ai-ml | LangChain | langchain.js, langchainjs | false |
| `langgraph` | ai-ml | LangGraph | langgraph.js, langgraphjs | false |
| `mcp` | ai-ml | Model Context Protocol | model context protocol | true (`mcp` 단독 금지) |
| `agent` | ai-ml | AI agent | ai agent, agentic, 에이전트 | true (`agent` 단독 금지) |
| `playwright` | testing-tooling | Playwright | playwright test, @playwright/test | false |
| `vitest` | testing-tooling | Vitest | — | false |
| `jest` | testing-tooling | Jest | — | false |
| `testcontainers` | testing-tooling | Testcontainers | testcontainer | false |
| `docker` | infra-devops | Docker | dockerfile, 도커 | false |
| `kubernetes` | infra-devops | Kubernetes | k8s, 쿠버네티스 | false |
| `ci-cd` | infra-devops | CI/CD | continuous integration, github actions | true |
| `queue` | infra-devops | Job queue | bullmq, message queue, 큐 | true (`큐`, `queue` 단독 금지) |

## 4. source별 매핑

동일 topic이 source마다 다른 식별자를 갖는다. 이 매핑을 설정으로 관리한다.

| slug | github topic | stackoverflow tag | npm package | arxiv category |
|---|---|---|---|---|
| `typescript` | typescript | typescript | typescript | — |
| `nodejs` | nodejs | node.js | — | — |
| `bun` | bun | bun | — | — |
| `deno` | deno | deno | — | — |
| `react` | react | react | react | — |
| `nextjs` | nextjs | next.js | next | — |
| `vue` | vue | vue.js | vue | — |
| `vite` | vite | vite | vite | — |
| `elysia` | elysia | elysia | elysia | — |
| `fastify` | fastify | fastify | fastify | — |
| `nestjs` | nestjs | nestjs | @nestjs/core | — |
| `postgresql` | postgresql | postgresql | pg, postgres | — |
| `pgvector` | pgvector | pgvector | pgvector | — |
| `redis` | redis | redis | ioredis | — |
| `playwright` | playwright | playwright | playwright, @playwright/test | — |
| `langchain` | langchain | langchain | langchain | — |
| `langgraph` | langgraph | langgraph | @langchain/langgraph | — |
| `rag` | rag | — | — | cs.IR, cs.CL |
| `llm` | llm | — | — | cs.CL, cs.LG |
| `embedding` | embeddings | — | — | cs.CL, cs.IR |
| `agent` | ai-agents | — | — | cs.AI |
| `queue` | — | bullmq | bullmq | — |

`queue` topic의 Stack Overflow tag는 `bullmq`다. [SOURCE_CATALOG §3](./SOURCE_CATALOG.md)의 tag 목록은 이 열과 일치해야 하며, 매핑이 `—`인 topic은 그 source의 tag 목록에 넣지 않는다.

`—`는 해당 source에 대응 식별자가 없다는 뜻이며, 그 source는 이 topic의 관측값을 만들지 않는다. 대응이 없는 것을 0으로 저장하지 않는다.

## 5. 검증 대상

`EXP-001`과 unit test에서 다음을 확인한다.

- alias 매칭이 단어 경계를 지키는지. `go`가 `google`, `going`에 매칭되지 않아야 한다.
- `ambiguous` topic이 단독 토큰으로 매칭되지 않는지.
- 한국어 alias가 조사와 붙어 있을 때 매칭되는지. `타입스크립트를`, `러스트로` 같은 형태.
- 같은 문서에 여러 topic이 매칭될 때 모두 기록되는지.
- taxonomy version이 바뀌어도 기존 `document_topics` 행이 유지되는지.
- source별 매핑에 없는 조합으로 관측값을 만들지 않는지.

## 6. 확장 규칙

topic 추가는 다음을 만족할 때만 한다.

- 사용자 질문에서 실제로 등장하거나 등장할 근거가 있다.
- 최소 하나의 source에서 관측 가능한 식별자가 있다.
- alias가 오탐을 만들지 않는다.

추가·삭제 시 `taxonomy_version`을 올리고 [GLOSSARY](./GLOSSARY.md)와 이 문서를 함께 갱신한다.

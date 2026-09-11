# Signal Archive Source Catalog

- 상태: 대상 source와 호출·저장 baseline은 `EXP-001`에서 검증됨(2026-09-01). COV-009의 제한된 schedule과 target은 [ADR-0016](./adr/0016-low-cost-live-activation.md)에서 승인됐고, 그 밖의 값은 제안이다
- 작성일: 2026-09-01
- 기준: [ADR-0004](./adr/0004-initial-data-sources.md) (Accepted)

`ADR-0004`가 어떤 source를 쓸지 정했다. 이 문서는 각 source를 **실제로 어떻게 호출하고 무엇을 저장할지** 정한다. `EXP-001`은 이 명세 없이 실행할 수 없고, `COL-002`~`COL-010`은 이 명세를 구현한다.

수집 주기는 [SSOT §5](./SSOT.md)에서 미결정이므로 아래 값은 제안이다. rate limit과 원본 갱신 주기에서 유도했다.

### ADR-0015 적용 범위 (2026-09-08)

- target 중심 확장·초기 90일 backfill 설계는 승인됐다. 아래 source별 cadence는 여전히 제안이며 실제 활성 target·예산·수집 주기는 DEC-012에서 결정한다.
- source set과 권리 허용 범위는 이번 변경으로 확대하지 않는다. DISC-003에서 seed target별 접근·저장·embedding·표시 권리와 검토 근거를 등록한다. `relaxedRightsMode`/`ignoreLicenseCutoff`는 확장 근거가 아니다.
- target selector는 repository, site+tag, package, feed/index, category/query 등 adapter가 실제 지원하는 단위다. canonical identity, config/policy revision, topic 매핑, historyMode와 timeBasis를 [공통 계약](./COLLECTION_CONTRACTS.md)에 맞춰 기록한다.
- historyMode는 `historical_range`, `paginated_history`, `feed_only`, `snapshot_only`로 구분한다. source 이름만으로 historical 지원을 단정하지 않고 endpoint/target capability를 fixture·허용된 canary로 확인한다.
- GitHub release pagination은 기간 완료까지 재개하되 release 없는 target은 별도 표시한다. Stack Exchange/arXiv는 기간 전달·날짜 경계·필터 이후 빈 page 진전을 검증한다.
- RSS 최신 목록은 전체 archive가 아니다. feed-only target의 기간 coverage는 partial이며 새로운 archive/sitemap 경로는 별도 정책 검토 후 추가한다. metric snapshot의 과거 값을 backfill로 합성하지 않는다.
- 발견 후보는 metadata 수준으로 검토 대기한다. issue/discussion 본문·model card·새 blog·제외 source의 저장/embedding 허용을 기존 metric/API 승인에서 추론하지 않는다.
- TASKS가 참조하는 ADR-0014 파일은 이번 조사에서 실제 부재를 확인했다. 전체 결과는 [DISC-003 조사 보고서](./experiments/DISC-003-source-rights-and-capability-investigation.md)에 기록했으며, Reddit과 권리·capability 불명확 target은 자동 활성화하지 않는다.

### DEC-012 활성 범위 (2026-09-10)

COV-009에서는 `github_releases`의 `microsoft/TypeScript`, `nodejs/node`,
`microsoft/playwright`, `facebook/react`, `pgvector/pgvector`만 활성화한다. 각 target은 최근 90일
backfill 1회와 6시간 incremental cadence(±15분 deterministic jitter)를 사용한다. 전체 API/
byte/model budget과 retention은 [ADR-0016](./adr/0016-low-cost-live-activation.md)을 단일 기준으로
삼는다. 이 목록 밖의 target과 discovery 결과는 계속 `enabled=false`다.

## 1. 공통 규칙

- 모든 external ID는 source가 준 안정적 값을 쓰고, 없으면 결정적 대체키를 만든다. 멱등 키는 `(source_id, external_id, payload_hash)`다.
- 개인정보 제거는 raw 저장 **이전**에 수행한다. 대상 필드는 [SECURITY §8](./SECURITY.md)에 있다.
- 라이선스는 `source_rights.license_id`를 기본값으로 쓰고, source가 게시물별 값을 주면 revision의 `license_id`가 우선한다.
- `verbatim_only` source의 근거는 답변에서 재서술하지 않는다.
- conditional request(ETag/Last-Modified)를 지원하는 source는 반드시 사용한다.
- 모든 시각은 UTC로 저장하고 원본이 준 형식을 metadata에 남긴다.

## 2. github_releases

| 항목 | 값 |
|---|---|
| endpoint | `GET /repos/{owner}/{repo}/releases` |
| 인증 | PAT 권장. 미인증 60 req/h → 인증 5,000 req/h |
| rate 전략 | ETag conditional request. 304이고 인증된 요청은 primary rate limit에 계산되지 않음 |
| cursor | repository별 마지막 `published_at` + overlap window |
| external_id | `id` |
| canonical_url | `html_url` |
| published_at | `published_at`. **`created_at`을 쓰지 않는다** (release에 쓰인 commit 날짜) |
| 본문 | `body` (release note markdown) |
| 제거 필드 | `author` 객체 전체, `assets[].uploader` |
| license | repository별. 확인 전에는 본문 embedding 대상에서 제외하고 title·metadata만 사용 |
| 제외 조건 | draft release, release 없는 tag |
| schedule 제안 | 1시간 |

### 추적 repository 후보 (제안)

사용자 예시 질문 4개(TypeScript 백엔드 트렌드, Playwright 업데이트, Bun과 Node.js 비교, RAG 관련 기술)를 커버하도록 골랐다. `EXP-001`에서 repository별 license를 확인해 확정한다.

| 영역 | repository |
|---|---|
| 언어·런타임 | `microsoft/TypeScript`, `nodejs/node`, `oven-sh/bun`, `denoland/deno` |
| 테스트·브라우저 | `microsoft/playwright` |
| backend framework | `elysiajs/elysia`, `fastify/fastify`, `nestjs/nest` |
| frontend | `facebook/react`, `vercel/next.js`, `vuejs/core`, `vitejs/vite` |
| AI·RAG | `langchain-ai/langchainjs`, `langchain-ai/langgraphjs` |
| 데이터 | `pgvector/pgvector`, `postgres/postgres` |
| queue·infra | `taskforcesh/bullmq`, `redis/redis` |

목록은 설정으로 관리하고 코드에 하드코딩하지 않는다.

## 3. stack_exchange

| 항목 | 값 |
|---|---|
| endpoint | `https://api.stackexchange.com/2.3/questions` 등. `site` 파라미터 필수 |
| 인증 | API key. OAuth access token은 사용자별 read/write 작업에만 필요하며 수집에는 쓰지 않는다 |
| rate 전략 | 응답 본문 `backoff` 준수. 동일 질의를 분당 1회 이상 호출하지 않음 |
| cursor | `last_activity_date` 기준 incremental + overlap window |
| external_id | `question_id` (site 별로 namespace 분리) |
| canonical_url | `link` |
| published_at | `creation_date` (epoch seconds → UTC) |
| license | `content_license` 필드를 revision에 저장. 게시일에 따라 CC BY-SA 2.5/3.0/4.0 |
| `verbatim_only` | **true** |
| 제거 필드 | `owner.display_name`, `owner.profile_image`, `owner.user_id` (귀속 표시 승인 시 별도 보관) |
| 삭제 감지 | 부재 기반. 재조회 대상에서 사라지면 삭제로 간주. rate limit·오류를 삭제로 오인하지 않도록 연속 확인 기준 필요 |
| 상태 필드 | `closed_date`, `locked_date`는 삭제가 아니므로 tombstone 대상이 아니다 |
| schedule 제안 | 1시간 |

### 대상 site와 tag (제안)

- site: `stackoverflow`
- tag: `typescript`, `node.js`, `bun`, `deno`, `react`, `next.js`, `vue.js`, `vite`, `elysia`, `fastify`, `nestjs`, `postgresql`, `pgvector`, `redis`, `playwright`, `langchain`, `langgraph`, `bullmq`

tag 목록은 [TOPIC_TAXONOMY §4](./TOPIC_TAXONOMY.md)의 `stackoverflow tag` 열과 일치해야 한다. 매핑이 `—`인 topic(`rag`, `llm`, `embedding`, `agent` 등)은 Stack Overflow 관측값을 만들지 않으므로 tag 목록에 넣지 않는다. RAG·LLM 관련 논의는 `langchain` tag와 arXiv source로 커버한다.

본문 필드를 응답에 포함시키려면 filter 설정이 필요하다. 실제 filter 값과 반환 필드는 `EXP-001`에서 확정한다.

## 4. users_rust_lang

| 항목 | 값 |
|---|---|
| endpoint | `GET /latest.json`, `GET /t/{id}.json` |
| 인증 | 불필요 |
| rate 전략 | Discourse 기본값 IP당 분당 200, 10초당 50. 실제로는 429와 `Retry-After`를 권위로 본다 |
| cursor | `last_posted_at` 기준 |
| external_id | topic `id` |
| canonical_url | `https://users.rust-lang.org/t/{slug}/{id}` |
| published_at | `created_at` (ISO-8601 UTC) |
| 본문 | `post_stream.posts[].cooked` (렌더링 HTML → sanitize 후 text) |
| license | **게시일로 분리.** 2020-07-17 이후 MIT/Apache-2.0만 수집. 이전 게시물은 CC BY-NC-SA 3.0이므로 저장하지 않는다 |
| 제거 필드 | `username`, `name`, `user_id`, `avatar_template` |
| 삭제 감지 | `deleted_at`, `deleted_by`, `user_deleted` |
| robots 준수 | `.rss`, `/search`, `/admin`, `/g`, `/my` 등 Disallow 경로에 접근하지 않는다 |
| schedule 제안 | 1시간 |

## 5. arxiv

| 항목 | 값 |
|---|---|
| endpoint | `http://export.arxiv.org/api/query`. 대량은 OAI-PMH |
| 인증 | 불필요 |
| rate 전략 | **요청 간 3초 이상, 단일 연결.** 동일 질의는 1일 1회로 제한하고 결과를 캐싱한다 |
| 결과 상한 | `max_results` 30,000까지, 2,000 단위 슬라이스 |
| cursor | `submittedDate` 범위 질의 + `start` 오프셋 |
| external_id | `id`의 arXiv ID + 버전 접미사(`2401.12345v2`) |
| canonical_url | `http://arxiv.org/abs/{id}` |
| published_at | `published` (v1 제출 시각). `updated`는 별도 저장 |
| 본문 | `summary` (abstract). **PDF·전문은 저장하지 않는다** |
| license | CC0 1.0 (metadata) |
| 저자 | CC0 범위지만 필요 최소로 저장하고 소속·연락처는 저장하지 않는다 |
| schedule 제안 | 1일 |

### 대상 category (제안)

`cs.AI`, `cs.CL`, `cs.IR`, `cs.LG`, `cs.SE`. RAG·검색·소프트웨어 공학 질문을 커버한다.

## 6. chrome_release_notes

| 항목 | 값 |
|---|---|
| endpoint | `https://developer.chrome.com/release-notes/{version}` |
| 수집 방식 | HTTP fetch + HTML parse. **Playwright 불필요** (본문이 서버 렌더링) |
| rate 전략 | robots에 crawl-delay 없음. 자체적으로 요청 간격과 페이지 수 상한 적용 |
| cursor | 마지막 처리 version 번호 + 신규 version 탐지 |
| external_id | `chrome-release-notes-{version}` |
| published_at | 페이지의 "Stable release date" |
| license | CC BY 4.0. 귀속 문구 필요 |
| 제외 대상 | 이미지, 로고, 상표. **텍스트만 저장한다** |
| schedule 제안 | 1일 |

## 7. react_blog

| 항목 | 값 |
|---|---|
| endpoint | feed `https://react.dev/rss.xml`, 본문은 항목 URL |
| 수집 방식 | RSS로 발견 + HTTP로 본문 취득 |
| external_id | 항목 URL 경로 (`/blog/2024/12/05/react-19`) |
| published_at | slug의 날짜와 feed 항목 날짜를 교차 확인 |
| license | CC BY 4.0 (repo `LICENSE-DOCS.md`). 귀속 문구 필요 |
| schedule 제안 | 6시간 |

`COL-008`은 이 source와 `chrome_release_notes`를 같은 article collector adapter로 처리한다.

## 8. chrome_origin_trials

| 항목 | 값 |
|---|---|
| endpoint | `https://developer.chrome.com/origintrials/` |
| 수집 방식 | **Playwright.** HTTP 응답 본문이 `This page requires Javascript.` 뿐이다 |
| 브라우저 정책 | download·popup 차단, host allowlist, non-root, trace redaction |
| external_id | trial 식별자 또는 trial name의 결정적 해시 |
| published_at | **null.** trial은 게시 시각이 아니라 시작·종료 milestone을 가진다 |
| 저장 형태 | trial 상태 레코드. document로 볼지 상태 관측값으로 볼지 `EXP-001` 결과로 확정 |
| license | CC BY 4.0. 텍스트만 |
| schedule 제안 | 1일 |

## 9. npm_registry

| 항목 | 값 |
|---|---|
| endpoint | `https://registry.npmjs.org/{package}`, `/{package}/{version}` |
| rate 전략 | 개별 수치 제한 없음. 월 500만 요청 상한을 넘기지 않도록 예산 관리. conditional request 지원 여부는 `EXP-001`에서 확인 |
| external_id | `{name}@{version}` |
| canonical_url | `https://www.npmjs.com/package/{name}` |
| published_at | `time` 객체의 버전별 값 |
| 제거 필드 | `author.email`, `_npmUser.email`, `maintainers[].email`, `publisher.email` |
| 저장 형태 | 버전 출시를 `metric_observation`과 최소 document로 저장. README 본문은 발행자 license 확인 전 미사용 |
| schedule 제안 | 1일 |

### 대상 package (제안)

`typescript`, `react`, `next`, `vue`, `vite`, `fastify`, `@nestjs/core`, `elysia`, `playwright`, `@playwright/test`, `langchain`, `@langchain/langgraph`, `pg`, `postgres`, `bullmq`, `ioredis`, `pgvector`

## 10. npm_downloads

| 항목 | 값 |
|---|---|
| endpoint | `https://api.npmjs.org/downloads/point|range/{period}/{package}` |
| 구조적 제한 | bulk는 128 package·365일까지, 그 외 질의는 18개월까지. 최초 데이터 2015-01-10. 버전별은 최근 7일만 |
| 갱신 시점 | UTC 자정 직후 집계. `last-day`가 전전일일 수 있음 |
| metric | `package_downloads`, 단위 `downloads` |
| 해석 규칙 | mirror·CI·bot 포함 방향성 지표. 사용자 수 아님. 하루 50건 미만 구간은 추세 판단에 사용하지 않음 |
| schedule 제안 | 1일 (UTC 자정 + 버퍼) |

## 11. github_search

| 항목 | 값 |
|---|---|
| endpoint | `GET /search/repositories`, `GET /search/issues` |
| 인증 | **필수.** `EXP-001` run 2에서 미인증 10회 반복이 403 5회로 50% 성공률을 보였다. 문서화된 미인증 제한(분당 10회) 안의 간격이었음에도 실패했다. 미인증 폴백을 두지 않는다 |
| rate 전략 | 검색 전용 limit. 인증 분당 30 |
| 결과 상한 | 검색당 1,000건, repository 검색은 4,000개 범위, per_page 최대 100 |
| 재현성 | **질의 문자열과 수집 시각을 스냅샷 메타로 저장한다.** `incomplete_results`가 true면 그 사실을 관측값에 기록 |
| 별 히스토리 | 소급 재구성 불가. stargazers 목록 접근이 admin·collaborator로 제한됨. 시계열은 우리 스냅샷으로만 만든다 |
| 제거 필드 | `owner`, `user`, `milestone.creator` |
| metric | `repo_attention` (stars, new_repositories), `issue_discussion` (comments, reactions, interactions) |
| schedule 제안 | 1일 |

### 질의 정의 (제안)

| 목적 | 질의 |
|---|---|
| 신규 관심 저장소 | `topic:{topic} created:>{from} stars:>50`, `sort=stars` |
| 활성 저장소 | `topic:{topic} pushed:>{from} stars:>500`, `sort=stars` |
| 활발한 논의 | `is:issue updated:>{from} comments:>20`, `sort=comments` |
| 반응 많은 논의 | `is:issue updated:>{from} reactions:>50`, `sort=reactions` |

`topic` 값은 topic taxonomy에서 가져온다. 질의는 설정으로 관리하고 결과와 함께 버전을 기록한다.

## 12. huggingface_hub

| 항목 | 값 |
|---|---|
| endpoint | Hub API (OpenAPI 공개) |
| 인증 | 토큰 권장. 익명 API 500 / free 1,000 per 5분 창 |
| 저장 범위 | **지표만.** model card 본문·README를 수집하지 않는다 |
| metric | `model_activity` (models, datasets, downloads) |
| external_id | `{namespace}/{repo}` + commit SHA |
| published_at | `createdAt`, 갱신은 `lastModified` |
| 개인정보 | namespace가 개인 사용자명일 수 있으므로 집계 목적 외 보관하지 않는다 |
| schedule 제안 | 1일 |

## 13. reddit

| 항목 | 값 |
|---|---|
| endpoint | `https://www.reddit.com/r/{subreddit}/` |
| 수집 방식 | Playwright 브라우저 렌더링 + semantic locator (`getByRole('article')`, `getByRole('heading')`, `getByRole('paragraph')` 등, COL-005 패턴) |
| 인증 | 미인증 공개 페이지 렌더링 (로그인·CAPTCHA 우회 금지, 발생 시 즉시 중단) |
| rate 전략 | 6시간 주기 및 host allowlist 라우팅 필터링, 동시성 제한 |
| cursor | 마지막 externalId 및 snapshot SHA256 해시 |
| external_id | `reddit-post-{id}` (t3 접두사 제거) |
| canonical_url | `https://www.reddit.com/r/{subreddit}/comments/{id}/...` |
| published_at | `<time datetime="...">` UTC |
| 본문 | post title 및 paragraph 본문 텍스트 |
| 제거 필드 | `author`, `username`, `avatar`, `author_fullname`, `author_flair_text` 등 개인식별정보 전체 제거 |
| license | CC BY-SA로 주장하지 않음. Reddit User Agreement & Content Policy와 프로젝트 범위를 확인해야 함 |
| schedule 제안 | 6시간 |

## 14. schedule 요약 (제안)

| source | 주기 | 근거 |
|---|---|---|
| github_releases | 1시간 | conditional request가 rate limit에 계산되지 않아 저비용 |
| stack_exchange | 1시간 | 일 10,000 quota 안에서 tag별 incremental |
| users_rust_lang | 1시간 | 분당 200 여유 |
| react_blog | 6시간 | 발행 빈도가 낮다 |
| reddit | 6시간 (제안) | seed는 `enabled=false`; live canary·production corpus 전 production 비활성 |
| arxiv | 1일 | TOU가 동일 질의 1일 1회를 권고 |
| chrome_release_notes | 1일 | 버전 주기가 수 주 |
| chrome_origin_trials | 1일 | 변경이 느리다 |
| npm_registry | 1일 | 월 요청 예산 관리 |
| npm_downloads | 1일 | UTC 자정 집계 후 |
| github_search | 1일 | 분당 30 제한, 스냅샷 성격 |
| huggingface_hub | 1일 | 5분 창 제한 |

동일 source의 활성 run은 하나만 허용하고, 지연 시 backlog를 무한히 쌓지 않고 coalescing한다.

## 15. `EXP-001` 측정 결과 반영 (2026-09-01)

[EXP-001 run 1](./experiments/EXP-001-source-feasibility.md)에서 11개 source를 실측했다. 해소된 항목과 새로 발견한 항목은 다음과 같다.

### 해소된 항목

| 항목 | 결과 |
|---|---|
| conditional request 지원 (npm_registry) | **지원 확인.** ETag 재요청에 304 반환 |
| conditional request 지원 (github_releases) | **지원 확인.** 304 반환 |
| `created_at`과 `published_at` 차이 | 표본 40건 **전부** 다름. `published_at`만 사용하는 규칙이 실증됨 |
| origin trials 렌더링 필요성 | 응답 본문 2,402B, JS 요구 문구 확인 |
| npm 응답의 email 존재 | 4개 패키지 **전부** 존재. 제거가 필수 |
| github_search 재현성 | 동일 질의 2회 반환 순서 일치, `incomplete_results` false |
| Rust 포럼 게시일 분리 필요성 | 최신 30건 중 3건이 2020-07-17 이전 |

### 새로 반영해야 할 제약

| source | 제약 | 조치 |
|---|---|---|
| `stack_exchange` | `content_license` 필드가 표본의 **83.3%에만** 존재 | 라이선스를 확인할 수 없는 게시물은 **발췌 표시 대상에서 제외**하고 `community_mentions` 집계에만 사용한다. revision의 `license_id`를 null로 두고 그 상태를 명시적으로 기록한다 |
| `stack_exchange` | 미인증 quota가 **일 300건**이다. 문서의 10,000은 key 등록 시 값 | **API key 등록을 collector 구현 전제로 둔다.** 등록 전에는 §13의 1시간 주기를 적용할 수 없다 |
| `chrome_release_notes` | 페이지는 서버 렌더링이지만 정규식 기반 날짜 추출이 실패 | `COL-008`은 정규식이 아니라 DOM 파싱으로 "Stable release date"를 추출한다 |
| `huggingface_hub` | 모델 목록 endpoint 응답에 `lastModified`가 없다 | 갱신 감지에는 `full=true` 또는 상세 endpoint를 사용한다. `createdAt`, `downloads`, `likes`는 목록에서 확보 가능 |
| `github_search` | **미인증 10회 반복에서 403 5회, 성공률 50%.** 문서화된 미인증 제한 안의 간격에서도 실패 | **인증을 필수로 둔다.** 미인증 폴백을 만들지 않는다 |
| `chrome_release_notes` | 10회 반복에서 200은 유지되나 응답이 byte 수준으로 동일하지 않음(fingerprint 2종) | DOM 구조 기반 추출. fixture contract test는 전체 HTML이 아니라 **핵심 필드 동일성**을 검증 |

### run 2에서 확인된 반복 성공률

`github_search`를 제외한 **10개 source가 10회 반복 100% 성공**하고 추출 결과가 완전히 동일했다. 지연은 p50 21~568ms, 최대 1,161ms다. 상세는 [EXP-001 run 2](./experiments/EXP-001-source-feasibility.md)에 있다.

### 아직 확정할 항목

| 항목 | 대상 |
|---|---|
| 10회 반복 fetch 성공률 | 전체. `EXP-001` run 2 |
| 인증 상태의 rate limit 실측 | github_releases, github_search, stack_exchange |
| 본문 필드를 포함하는 filter 값 | stack_exchange |
| repository별 license와 본문 embedding 허용 | github_releases |
| 부재 기반 삭제 감지의 연속 확인 횟수 | stack_exchange |
| trial 레코드의 저장 형태 | chrome_origin_trials |
| 개인정보 제거가 raw 저장 이전에 동작 | 전체. collector fixture |

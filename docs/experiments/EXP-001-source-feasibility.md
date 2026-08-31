# EXP-001: Source feasibility and compliance

- 상태: Completed — run 1·2 측정 완료(2026-09-01). 인증 상태 rate 재측정은 `DISC-002` acceptance로 이관
- 연결 ADR: [ADR-0004](../adr/0004-initial-data-sources.md) (Accepted)
- 실행 승인: 사용자, 2026-09-01
- raw measurement: `experiments/exp-001/result.json`, `experiments/exp-001/repeat-result.json`
- 코드 위치: `experiments/exp-001/` (폐기 대상)

## 질문

GitHub Releases, Hacker News, npm, Playwright 대상 후보가 MVP의 실제 데이터 소스로 사용 가능하며, 필요한 질문에 충분한 metadata와 신호를 제공하는가?

## Hypotheses

- GitHub Releases는 공식 업데이트 질문에 안정적 ID·URL·게시 시각을 제공한다.
- HN story 표본은 기술 언급 트렌드에 사용할 수 있으나 전체 생태계 인기라고 일반화할 수 없다.
- npm 후보는 비교 가능한 package 시계열을 제공하지만 endpoint 정책과 누락을 명시해야 한다.
- 승인된 공식 동적 페이지 하나는 정책을 지키며 Playwright로 안정적으로 수집할 수 있다. 대상은 Chrome origin trials 대시보드이며, 게시 시각이 없는 상태 레코드를 다루는 방식이 함께 검증되어야 한다.

## 대상 후보

- GitHub: TypeScript, Playwright, Bun, Node.js, LangChain/LangGraph 관련 승인 repository
- HN: new/top story와 선택적 top-level comment 범위
- npm: 비교 대상 package metadata와 download observation 후보
- Playwright: `developer.chrome.com/origintrials/`. 서버 HTML에 내용이 없어 렌더링이 필요한 대상으로 확정됐다
- HTTP + HTML parse: `developer.chrome.com/release-notes/{version}`. 같은 사이트지만 서버 렌더링이므로 브라우저를 쓰지 않는다

최종 URL 목록은 실행 전 rights review와 함께 기록한다.

## Method

1. 각 source의 약관, robots, API 문서, 인증, rate limit, 저장·embedding·excerpt 허용을 표로 검토한다. 1차 검토는 완료되어 [SOURCE_RIGHTS.md](../SOURCE_RIGHTS.md)에 있으므로 이 실험은 그 문서의 §9 남은 확인 항목부터 시작한다.
2. 최소 7일, 가능하면 30일 범위에서 bounded sample을 수집한다.
3. 외부 ID, canonical URL, 게시 시각, 수정 시각, 본문, pagination/cursor, ETag 존재율을 측정한다. npm 두 endpoint의 conditional request 지원 여부를 실제 응답 헤더로 확인한다.
4. 같은 요청 재실행과 overlap window에서 중복/누락을 확인한다.
5. Playwright 후보는 semantic locator, redirect/third-party request, 실행 시간, 10회 반복 성공률을 측정한다.
6. 사용자 예시 질문 4개에 source가 어떤 근거·metric을 제공하는지 mapping한다.
7. 추적 대상 GitHub repository 목록을 확정하고 repository별 license와 release note 본문 embedding 허용 여부를 함께 기록한다.

## Gate

각 선택 source는 다음을 모두 충족해야 한다.

- [SOURCE_RIGHTS.md](../SOURCE_RIGHTS.md)의 `decision`이 `no_blocker_found`이고 fetch·store·embed·excerpt 값에 `no`와 `unverified`가 없음
- 수집·필요 범위 저장·embedding·짧은 excerpt 표시에 명백한 차단 사유가 없음
- 안정적 ID 또는 결정적 대체키와 canonical URL 확보율 ≥ 99%
- 게시 시각 확보율 ≥ 95% 또는 해당 source를 최신 트렌드 집계에서 제외한다는 명확한 정책
- 10회 bounded fetch 성공률 ≥ 90%
- rate limit을 지키는 현실적인 schedule이 있음
- fixture로 보존 가능한 최소 sample이 있음
- 개인정보 제거 규칙이 raw 저장 이전 단계에서 동작함을 fixture로 확인

Playwright 후보는 추가로 10회 중 9회 이상 핵심 필드가 동일하게 추출되고, 로그인·CAPTCHA·정책 우회가 없어야 한다.

## 출력

- source rights matrix
- sample schema와 redacted fixtures
- rate/freshness/field completeness 표
- 실패·drift 사례
- source별 승인/대체/제외 recommendation

## 실행 기록 (run 2) — 10회 반복 성공률

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-001-run-2-repeat |
| 실행일 | 2026-09-01 (KST) |
| 코드 위치 | `experiments/exp-001/repeat.mjs`, 출력 `repeat-result.json` |
| 방법 | source별 10회 반복 호출. 간격은 문서화된 제한을 지켜 source마다 다르게 설정(arXiv 3.2s, github_search 7s, 나머지 1~1.5s) |
| 인증 | 없음 |

### 결과

| source | 성공 | 성공률 | 상태 코드 | 서로 다른 fingerprint | p50 | max |
|---|---:|---:|---|---:|---:|---:|
| `github_releases` | 10/10 | **100%** | 200×10 | 1 | 21ms | 424ms |
| `stack_exchange` | 10/10 | **100%** | 200×10 | 1 | 198ms | 631ms |
| `users_rust_lang` | 10/10 | **100%** | 200×10 | 1 | 158ms | 557ms |
| `arxiv` | 10/10 | **100%** | 200×10 | 1 | 55ms | 458ms |
| `chrome_release_notes` | 10/10 | **100%** | 200×10 | **2** | 568ms | 1,161ms |
| `chrome_origin_trials` | 10/10 | **100%** | 200×10 | 1 | 70ms | 72ms |
| `react_blog` | 10/10 | **100%** | 200×10 | 1 | 25ms | 133ms |
| `npm_registry` | 10/10 | **100%** | 200×10 | 1 | 325ms | 523ms |
| `npm_downloads` | 10/10 | **100%** | 200×10 | 1 | 25ms | 88ms |
| `huggingface_hub` | 10/10 | **100%** | 200×10 | 1 | 210ms | 293ms |
| `github_search` | 5/10 | **50%** | 200×5, **403×5** | 1 | 55ms | 682ms |

fingerprint는 응답에서 추출한 핵심 필드의 결합값이다. 1이면 10회 결과가 완전히 동일했다는 뜻이다.

### github_search가 게이트를 통과하지 못했다

7초 간격은 분당 약 8.5회로 문서화된 미인증 제한(분당 10회) 안이다. 그런데 **10회 중 5회가 403**이었다. 미인증 검색은 문서화된 primary 제한보다 실제로 더 엄격하거나 secondary rate limit이 작동한 것으로 보인다.

결론은 명확하다. **`github_search`는 인증이 선택이 아니라 필수다.** `SOURCE_CATALOG §11`의 "인증 분당 30" 값을 전제로 구현하고, 미인증 폴백을 두지 않는다.

### chrome_release_notes의 응답이 byte 수준으로 안정적이지 않다

10회 모두 200이었으나 fingerprint가 2종류 나왔다. fingerprint는 "Stable release date" 문구 존재 여부와 첫 `<h1>` 텍스트의 결합이므로, 둘 중 하나가 회차에 따라 달랐다. 어느 쪽이 변했는지는 이 측정으로 특정하지 못했다.

`COL-008`에 대한 함의는 두 가지다.

- 파서는 byte 동일성을 가정하지 않는다. 정규식 대신 DOM 구조 기반으로 추출한다.
- fixture contract test는 이 변동을 허용하되 **핵심 필드(버전, 게시일, 섹션 구조)의 동일성**을 검증한다. 전체 HTML 비교는 하지 않는다.

### gate 판정 갱신

| gate | 결과 |
|---|---|
| 10회 bounded fetch 성공률 ≥ 90% | **10개 source 통과(100%), `github_search` 미인증 50% 실패**. 인증 필수로 판정하고 인증 상태 재측정은 `DISC-002`로 이관 |
| 반복 결과 일관성 | 10개 source에서 완전 동일. `chrome_release_notes`만 2종 |

이 run으로 실험은 종료한다. 남은 인증 측정은 자격증명이 있어야 가능하므로 `DISC-002` acceptance에 포함시켰다. 그렇게 하지 않으면 `EXP-001`이 `DISC-002`를 기다리고 `DISC-002`가 `EXP-001`을 기다리는 교착이 생긴다.

## 실행 기록 (run 1)

| 항목 | 값 |
|---|---|
| 실행 ID | EXP-001-run-1-feasibility |
| 실행일 | 2026-09-01 (KST) |
| 런타임 | Node 26.5.0 |
| 코드 위치 | `experiments/exp-001/feasibility.mjs`, 원본 출력 `experiments/exp-001/result.json` |
| 인증 | 없음(미인증 공개 접근만). 인증 시 rate limit이 크게 올라가므로 별도 측정 필요 |
| 요청 간격 | source별 문서화된 제한 준수. arXiv는 단일 요청, GitHub은 700ms, search는 2.2s 간격 |

### 결과

11개 source 전부 HTTP 200으로 도달했다.

| source | 표본 | 안정 ID | canonical URL | 게시 시각 | 비고 |
|---|---:|---:|---:|---:|---|
| `github_releases` | 40 | 100% | 100% | 100% | ETag → **304 확인**. 미인증 잔여 52 |
| `stack_exchange` | 30 | 100% | 100% | 100% | `content_license` **83.3%만 존재** |
| `users_rust_lang` | 30 | 100% | 100% | 100% | 최신 30건 중 **3건이 2020-07-17 이전** |
| `arxiv` | 25 | 100% | 100% | 100% | abstract 100%, 버전 접미사 25/25 |
| `chrome_release_notes` | 3 버전 | — | — | 서버 렌더링 확인 | 날짜 추출 실패 |
| `chrome_origin_trials` | 1 | — | — | 없음(설계대로) | 본문 2,402B, **JS 필요 확인** |
| `react_blog` | 23 | — | 100% | 100% | RSS 정상 |
| `npm_registry` | 4 | — | — | `time` 100% | ETag → **304 확인**. email **4/4 존재** |
| `npm_downloads` | 7일 | — | — | — | bulk 질의 정상 |
| `github_search` | 20 + 20 | — | — | — | **동일 질의 2회 결과 순서 일치** |
| `huggingface_hub` | 20 | 100% | — | `createdAt` 있음 | `lastModified` **없음** |

### 실증된 설계 규칙

- **`created_at`을 게시 시각으로 쓰면 안 된다는 규칙이 실증됐다.** 표본 40건 **전부** `created_at`과 `published_at`이 달랐다. `SOURCE_CATALOG §2`의 경고가 예외 사례가 아니라 일반 사례다.
- **conditional request가 동작한다.** GitHub과 npm registry 모두 ETag 재요청에 **304**를 반환했다. `SOURCE_CATALOG §9`와 `SOURCE_RIGHTS §12`의 미확인 항목이 해소됐다.
- **origin trials는 렌더링이 필요하다.** 응답 본문이 2,402바이트뿐이고 JS 요구 문구가 확인됐다. Playwright 사용 근거가 재확인됐다.
- **npm 응답에 email이 항상 있다.** 4개 패키지 전부에서 발견됐다. 저장 전 제거가 선택이 아니라 필수임이 확인됐다.
- **GitHub search 재현성이 확인됐다.** 동일 질의를 2.2초 간격으로 두 번 호출해 반환 순서가 일치했고 `incomplete_results`는 false였다. 다만 단일 시점 관측이므로 장기 안정성은 보장되지 않는다.
- **Rust 포럼의 게시일 분리가 실제로 필요하다.** 최신 30건 중 3건(10%)이 라이선스 경계 이전이다.

### 새로 발견한 결함

| 결함 | 내용 | 영향 |
|---|---|---|
| SE `content_license` 누락 | 30건 중 25건만 필드 존재(83.3%). 값은 `CC BY-SA 4.0` 24건, `CC BY-SA 3.0` 1건 | 게시물별 라이선스 저장 규칙이 5건에 적용 불가. **라이선스 미확인 게시물의 발췌 표시 정책이 필요하다** |
| SE quota 오해 | 미인증 `quota_remaining`이 **299**였다. 문서의 일 10,000은 key 등록 시 값이다 | 미인증으로는 일 300건. tag 15개를 시간당 수집하려면 key 등록이 필수 |
| Chrome 날짜 추출 실패 | 페이지는 서버 렌더링이고 "Stable release date" 문구가 있으나 정규식 추출이 실패 | `COL-008`에서 DOM 기반 추출 필요. 정규식 의존 금지 |
| HF `lastModified` 없음 | 모델 목록 endpoint 응답에 `lastModified`가 없다. `createdAt`, `downloads`, `likes`는 존재 | 갱신 감지를 위해 `full=true` 또는 상세 endpoint 필요 |

### gate 판정

| gate | 결과 |
|---|---|
| 안정 ID 또는 결정적 대체키 + canonical URL 확보율 ≥ 99% | **통과** (측정 가능한 4개 source 모두 100%) |
| 게시 시각 확보율 ≥ 95% | **통과**. `chrome_origin_trials`는 설계상 null이며 시간 기반 집계에서 제외 |
| 10회 bounded fetch 성공률 ≥ 90% | **부분 통과.** 이번 run은 source별 1~4회 호출이다. 10회 반복은 별도 run 필요 |
| rate limit을 지키는 현실적 schedule | **조건부.** SE는 API key 등록 전에는 `SOURCE_CATALOG §13`의 1시간 주기를 지킬 수 없다 |
| 개인정보 제거 규칙이 raw 저장 이전에 동작 | **미측정.** collector 구현 후 fixture로 검증 |

### 다음 행동

run 1에서 도출한 항목의 처리 위치는 다음과 같다.

| 항목 | 처리 |
|---|---|
| 10회 반복 성공률 측정 | **run 2에서 완료** |
| Stack Exchange API key 등록과 인증 quota 재측정 | `DISC-002` acceptance로 이관 |
| 인증 상태 rate limit 재측정 | `DISC-002` acceptance로 이관 |
| `content_license` 없는 게시물의 처리 정책 | [SOURCE_RIGHTS](../SOURCE_RIGHTS.md)에 반영 완료. 발췌 표시 제외, 언급 수 집계에만 사용 |
| Chrome release notes 날짜 추출을 DOM 기반으로 | `COL-008` acceptance |
| HF 갱신 감지 방식 확정 | `COL-010` acceptance |

## 중단 조건

약관·robots 차단, 개인정보 과다 수집, CAPTCHA/로그인 요구, 예측 불가능한 유료 비용이 발견되면 해당 후보 수집을 즉시 중단한다.


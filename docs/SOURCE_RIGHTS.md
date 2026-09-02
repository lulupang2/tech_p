# Signal Archive Source Rights Matrix

- 상태: Reviewed — 권리 근거 승인 완료 (2026-09-01)
- 작성일: 2026-09-01
- 최초 조사일: 2026-09-01
- 조사 주체: agent research (공식 문서 인용 기반)
- 승인: 사용자, 2026-09-01. [ADR-0004](./adr/0004-initial-data-sources.md) Accepted
- 대응 task: `DISC-001` (DONE), `DEC-001` (DONE)
- 남은 검증: [EXP-001](./experiments/EXP-001-source-feasibility.md)의 기술 게이트는 완료됐다(2026-09-01). 인증 상태의 rate limit 재측정만 `DISC-002` acceptance에 남아 있다

이 문서는 후보 source의 권리·정책 검토 결과를 기록한다. 공식 문서에서 확인한 근거만 적고, 확인하지 못한 항목은 `unverified`로 남긴다. 이 문서는 법률 자문이 아니며, 판단이 필요한 항목은 후보에서 제외하는 쪽을 택한다.

**Playwright 대상은 `developer.chrome.com/origintrials/`로 정했다. 서버 HTML에 내용이 없고 공식 feed와 문서화된 API가 없어 렌더링 기반 수집이 정책에 맞는 유일한 경로다. §7 참조. 라이선스 귀속의 제품 반영 방식은 사용자가 별도로 해결한다.**

## 1. 판단 규칙

- 불명확은 허용이 아니다. 근거를 인용할 수 없으면 `no` 또는 `conditional`로 둔다.
- 공개 접근 가능성은 저장·재배포 허용을 의미하지 않는다.
- 각 항목은 근거 문서 위치와 확인일을 남긴다.
- 이 문서의 값과 DB `source_rights` 값이 다르면 수집을 중단하고 검토를 다시 한다.

### 값 정의

| 값 | 의미 |
|---|---|
| `yes` | 공식 문서에서 명시적으로 허용됨 |
| `conditional` | 조건이 충족될 때만 허용. 조건을 함께 적는다 |
| `no` | 금지되거나, 근거를 찾지 못해 허용으로 볼 수 없음 |
| `unverified` | 공식 문서에서 확인하지 못함 |

### decision 정의

`decision`은 source 채택 승인이 아니라 **권리 검토 결론**이다. 채택 승인은 `DEC-001`에서 한다.

| 값 | 의미 |
|---|---|
| `no_blocker_found` | 검토 범위에서 차단 사유를 찾지 못함 |
| `blocker_found` | 해소해야 할 차단 사유가 있음 |
| `deferred` | 결론을 내리기 전에 추가 확인이 필요 |

## 2. 요약

| source_key | access_method | fetch | store | embed | excerpt | decision |
|---|---|---|---|---|---|---|
| `github_releases` | REST API | yes | conditional | conditional | conditional | no_blocker_found |
| `hacker_news` | Firebase API | conditional | no | no | no | blocker_found |
| `npm_registry` | REST API | yes | yes | conditional | conditional | no_blocker_found |
| `npm_downloads` | REST API | yes | yes | n/a | n/a | no_blocker_found |
| `chrome_origin_trials` | browser (Playwright) | yes | yes | yes | yes(귀속 필수) | no_blocker_found |
| `chrome_release_notes` | HTTP + HTML parse | yes | yes | yes | yes(귀속 필수) | no_blocker_found |
| `react_blog` | RSS + HTTP | yes | yes | yes | yes(귀속 필수) | no_blocker_found |
| `github_search` | REST API | yes | conditional | conditional | conditional | no_blocker_found (§9.4) |
| `arxiv` | Atom API | yes | yes | yes | yes | no_blocker_found (§9.5) |
| `huggingface_hub` | REST API | yes | 지표만 yes | no(blanket) | no(blanket) | 지표 전용 채택 (§9.6) |
| `users_rust_lang` | Discourse JSON | yes | yes | yes | yes | no_blocker_found, 게시일 분리 필수 (§9.8.1) |
| `stack_exchange` | REST API | yes | conditional | conditional | yes(귀속 필수) | AI 학습 조항 미해결 (§9.8.2) |
| `reddit` | Data API | no | no | no | no | blocker_found |
| `github_trending` | HTML scrape | conditional | no | no | no | blocker_found |
| 공식 문서 사이트 다수 | GitHub repo 우선 | yes | yes | 대부분 yes | 대부분 yes | §9 참조 |

`conditional`과 `no`의 조건은 아래 각 절에 있다. 요약 표만 보고 수집을 시작하지 않는다.

## 3. github_releases

- access_method: GitHub REST API `GET /repos/{owner}/{repo}/releases`
- 근거 문서: [releases API](https://docs.github.com/en/rest/releases/releases), [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api), [best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) (페이지 표시 발효일 2026-04-27)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | "Information about published releases are available to everyone." 인증 없이 공개 리소스 조회 가능. ToS §H가 API 사용을 규율 |
| store | conditional | 제3자 보존 기간을 허용·제한하는 조항을 찾지 못함. ToS §D.8 "these Terms do not restrict lawful access to or use of the contents of public repositories by third parties"를 근거로 metadata 보존은 진행 가능. 본문 전체 장기 보존은 repository license 확인 후 |
| embed | conditional | GitHub ToS는 제3자에게 user content 파생물 생성 권리를 부여하지 않는다. §D.5의 라이선스는 "through the Service as permitted by GitHub's functionality"로 한정. **release note 본문 embedding은 repository별 license가 허용할 때만** |
| excerpt | conditional | 본문 소유자는 repository owner("You own Your Content", §D.3). 짧은 발췌 + 원문 링크 + 출처 표시를 전제로 진행. 공식 attribution 형식 규정은 없음(unverified) |
| raw_retention | 자체 정책 | API 소비자의 삭제 의무 조항을 찾지 못함. 상위 삭제를 반영할 의무가 문서화되지 않았으므로 tombstone 절차는 자체 정책으로 강제한다 |
| personal_data | 최소화 필요 | payload에 `author.login`, `author.id`, `author.node_id`, `author.avatar_url`, `author.gravatar_id`, `author.html_url` 포함. 문서화된 예시에 email 없음. 서버측 field 선택 기능 없음 → **collector가 author 객체를 저장 전에 제거한다.** ToS §H는 API로 받은 개인정보 판매를 금지 |
| rate_policy | 준수 가능 | 미인증 60 req/hour, PAT 인증 5,000 req/hour. 동시 요청 100개 상한. `ETag`/`Last-Modified` 지원하며 "Making a conditional request does not count against your primary rate limit if a 304 response is returned and the request was made while correctly authorized" |
| stable identifiers | 확보 | `id`, `node_id`, `html_url`, `published_at`, `created_at`, `tag_name` |

주의: `created_at`은 게시 시각이 아니다. 공식 문서에 "The `created_at` attribute is the date of the commit used for the release, and not the date when the release was drafted or published"라고 있다. 게시 시각은 `published_at`을 사용한다.

**따라야 할 조건**: 추적 대상 repository별로 license를 확인해 embedding 허용 여부를 기록한다. license가 불명확한 repository는 title과 metadata, 짧은 발췌만 사용하고 본문 embedding 대상에서 제외한다.

## 4. hacker_news

- access_method: 공식 Firebase API `https://hacker-news.firebaseio.com/v0/`
- 근거 문서: [HackerNews/API](https://github.com/HackerNews/API), [robots.txt](https://news.ycombinator.com/robots.txt), [Y Combinator legal](https://www.ycombinator.com/legal)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | conditional | API는 공개 제공되며 "In partnership with Firebase, we're making the public Hacker News data available in near real time", "There is currently no rate limit". 그러나 API 전용 이용 약관이 없다 |
| store | no | API 문서에 저장·캐싱에 관한 언급이 없다. 허용 근거를 찾지 못함 |
| embed | no | 파생물 생성 허용 근거를 찾지 못함. 아래 차단 사유 참조 |
| excerpt | no | 제출된 title과 comment의 저작권은 작성자에게 있고 YC는 광범위한 라이선스를 보유한다. 제3자 재표시 지침이 없다 |
| raw_retention | 반영 가능 | item에 `deleted`, `dead` boolean flag가 있어 상위 삭제를 감지할 수 있다. 단 YC Privacy Policy는 계정 삭제 시 "we reserve the right to refuse to delete any of the submissions, favorites, or comments"라고 한다 |
| personal_data | 낮음~중간 | item에 `by`(작성자 username), `time`. user 객체에 `id`, `karma`, `about`. YC Privacy Policy는 submission과 comment를 개인정보로 분류하지 않는다고 명시 |
| rate_policy | 명시 없음 | 공식 문서상 rate limit 없음. HTML 사이트 robots.txt는 `Crawl-delay: 30`과 action endpoint 차단을 규정하지만 API host에는 적용되지 않는다 |
| stable identifiers | 부분 | item `id`, `time`(Unix epoch). **canonical URL 형식이 공식 API 문서에 없다**(`news.ycombinator.com/item?id=` 형식은 문서화되지 않은 관행) |

### 차단 사유

Y Combinator Terms of Use의 Intellectual Property Rights 조항에 다음이 있다.

> "In connection with your use of the Site you will not engage in or use any data mining, robots, scraping or similar data gathering or extraction methods."

> "you agree not to modify, copy, frame, scrape, rent, lease, loan, sell, distribute or create derivative works based on the Site or the Site Content, in whole or in part, except that the foregoing does not apply to your own User Content."

이 조항은 "the Site"를 대상으로 하고 Firebase API는 별도로 제공되는 경로다. 두 문서가 서로를 참조하지 않으므로 **API 이용이 이 금지 조항의 예외인지가 문서상 확정되지 않는다.** 이 판단은 법률 판단이므로 이 문서에서 결론 내리지 않는다.

우리 규칙은 불명확을 허용으로 보지 않으므로 현재 상태에서 HN은 `blocker_found`다.

### 선택 가능한 경로

1. **범위 축소 후 재검토**: comment 본문을 수집하지 않고 story title, `id`, `time`, 외부 링크 URL만 사용한다. embedding과 발췌 표시 대상에서 HN 본문을 제외하고 언급 수 집계에만 쓴다. 파생물 생성과 재표시 범위가 크게 줄지만 위 조항이 여전히 적용되는지는 미확정이다.
2. **대체**: HN을 초기 source에서 제외하고 커뮤니티 언급 신호를 다른 공식 API/RSS 소스로 교체한다. `ADR-0004`가 이미 "npm 또는 Playwright 대상이 검증을 통과하지 못하면 억지로 유지하지 않고 다른 공식 API/RSS 소스로 대체한다"는 원칙을 두고 있다.
3. **보류**: `DEC-001`에서 사용자가 위험을 인지하고 범위를 정한다.

이 선택은 `DEC-001`의 결정 사항이다. 결정 전까지 HN collector를 구현하지 않는다.

## 5. npm_registry

- access_method: `https://registry.npmjs.org/{package}`, `/{package}/{version}`, `/-/v1/search`
- 근거 문서: [REGISTRY-API.md](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md), [Open-Source Terms](https://docs.npmjs.com/policies/open-source-terms), [crawlers policy](https://docs.npmjs.com/policies/crawlers)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | "You may search for, download, publish, and manage Packages using software other than CLI via application programming interfaces that npm publicly documents or makes available for public use (Public APIs)." Acceptable Use §9는 website 자동 접근을 금지하면서 "You may replicate data from the Public Registry using the Public APIs per this Agreement"를 명시 |
| store | yes | crawlers policy가 metadata 전체 복제를 허용한다. "npm's full public dataset is available via the public registry... it is acceptable within our terms of use" |
| embed | conditional | README·description 본문의 재사용은 package 발행자의 license가 규율한다. npm은 "Your Content belongs to you. You decide whether and how to license it."라고 하며 라이선스 정보의 정확성을 보증하지 않는다 |
| excerpt | conditional | 위와 동일. 추가로 Acceptable Use §13은 "You will not deep-hyperlink to images or other non-hypertext content served by npm Services"를 금지한다 |
| raw_retention | 자체 정책 | 명시적 보존 제한 없음 |
| personal_data | 제거 필요 | `author`(name, email, url), `_npmUser`(name, email), `maintainers[]`, search 응답의 `publisher.email`에 실제 email이 포함된다. Acceptable Use §4는 "You will not copy or share any personally identifiable information of any other person without their specific permission"를 금지 → **collector가 email과 maintainer 개인 식별 필드를 저장 전에 제거한다.** 이 항목은 조건이 아니라 필수 통제다 |
| rate_policy | 준수 가능 | 개별 endpoint 수치 제한은 문서화되지 않음. 상한은 "under no circumstances are five million requests to npm Services in a single month-long period... remotely reasonable". website crawling은 1 req/s 이하. conditional request 지원은 unverified |
| stable identifiers | 확보 | `name`, `_id`, `version`, `dist-tags.latest`, `time.created`, `time.modified`, `dist.tarball`. canonical URL은 `https://www.npmjs.com/package/{name}` |

## 6. npm_downloads

- access_method: `https://api.npmjs.org/downloads/point|range/{period}/{package}`
- 근거 문서: [download-counts.md](https://github.com/npm/registry/blob/main/docs/download-counts.md), [npm blog: how download counts work](https://blog.npmjs.org/post/92574016600/numeric-precision-matters-how-npm-download-counts-work.html)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | "There is a public api that gives you download counts by package and time range." 인증 불필요 |
| store | yes | 수치 저장을 제한하는 조항을 찾지 못함. 개인정보 없음 |
| embed / excerpt | n/a | 텍스트 문서가 아니라 수치 관측값이다. `metric_observation`으로만 저장한다 |
| 공식 지원 상태 | 문서화됨, SLA 없음 | npm 공식 저장소에 문서가 있고 npm이 운영하는 host다. 다만 Open-Source Terms의 Public API 열거에 포함되지 않고 서비스는 "as is and as available"로 제공된다 |
| rate_policy | 구조적 제한 있음 | bulk query는 "at most 128 packages at a time and at most 365 days of data", 그 외 질의는 "at most 18 months of data". 최초 데이터는 2015-01-10. version별 수치는 최근 7일만 |
| 데이터 의미 | 주의 필요 | npm 공식 설명: "npm's download stats are naïve by design: they are simply a count of the number of HTTP 200 responses we served that were tarball files". mirror, CI build server, 전수 분석 robot의 다운로드가 포함된다. "use these numbers as directional indicators of package popularity. They are not absolute numbers, and they are definitely not the same as the number of 'users'". 신호 판단 하한은 하루 50건. publish 직후 spike가 발생한다 |
| 갱신 시점 | UTC 기준 | "Once per day, soon after UTC midnight". `last-day`는 보통 전일이지만 집계가 끝나지 않으면 그 전날이다 |

**제품에 강제할 사항**: 이 수치를 사용자에게 "인기"나 "사용자 수"로 표시하지 않는다. 지표명 `package_downloads`, 단위 `downloads`, 기간을 함께 표시하고, mirror·CI·bot이 포함된 방향성 지표라는 한계를 답변의 limitations에 노출한다. 하루 50건 미만 구간은 추세 판단에 사용하지 않는다.

## 7. Playwright 후보

대상 사이트는 `developer.chrome.com`이며, 같은 사이트 안에서 수집 방식이 둘로 나뉜다. Playwright 대상은 **origin trials 대시보드**다.

### 7.1 공통 근거 (developer.chrome.com)

- 근거 문서: [robots.txt](https://developer.chrome.com/robots.txt), [Google Developers Site Policies](https://developers.google.com/readme/policies), [feeds](https://developer.chrome.com/feeds)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | robots.txt 전문이 `User-agent: *` + 빈 `Disallow:`로 전 경로 허용이며 crawl-delay가 없다. sitemap을 공개한다 |
| store | yes | 콘텐츠가 CC BY 4.0으로 제공된다 |
| embed | yes | CC BY 4.0은 수정·재목적화를 허용한다. "you are free to use nearly everything on the page in your own creations" |
| excerpt | yes, 귀속 필수 | 정확 재현은 "Portions of this page are reproduced from work created and shared by Google and used according to terms described in the Creative Commons 4.0 Attribution License", 수정본은 "modifications based on work created and shared by Google" 문구와 원문 링크가 필요하다 |
| 라이선스 제외 대상 | 상표·이미지·영상 | "Google's trademarks and other brand features are not included in this license." → **텍스트만 수집하고 이미지·로고는 저장·표시하지 않는다** |
| personal_data | 없음~낮음 | 문서·대시보드 페이지이며 개인 식별 정보가 목적이 아니다 |
| rate_policy | 자체 제한 | robots에 crawl-delay가 없다. 보수적 요청 간격과 페이지 수 상한을 자체 적용한다 |

**공식 피드 범위**: `https://developer.chrome.com/feeds`가 제공하는 feed는 Blog 하나(`/static/blog/feed.xml`)뿐이다. origin trials와 release notes에는 feed가 없다.

### 7.2 Playwright 대상: origin trials 대시보드

- 대상: `https://developer.chrome.com/origintrials/`
- 수집 방식: Playwright (렌더링 필요)

Playwright 사용 정당성이 성립한다.

| 조건 | 확인 결과 |
|---|---|
| 안정된 공식 API 없음 | 이 데이터에 대한 문서화된 공개 API를 확인하지 못했다 |
| 안정된 feed 없음 | 공식 feed 목록에 origin trials가 없다 |
| 렌더링 필요 | HTTP fetch 응답 본문이 `This page requires Javascript.` 뿐이다. 서버 HTML에 내용이 없다 |
| 정책 우회 없음 | 로그인·CAPTCHA 없이 공개 접근 가능하며 robots가 전 경로를 허용한다 |

대시보드가 내부적으로 JSON endpoint를 호출할 가능성이 있으나, [DATA_PIPELINE §6](./DATA_PIPELINE.md)이 숨겨진 endpoint 역공학을 금지하므로 **공개 페이지를 렌더링해 추출하는 것이 정책에 맞는 유일한 경로다.** 이것이 이 프로젝트에서 Playwright가 필요한 근거다.

주의할 점이 있다. 이 대상은 기사 흐름이 아니라 상태 대시보드다.

- trial 항목은 게시 시각이 아니라 시작·종료 Chrome 버전과 기간을 가진다. `published_at`을 만들어내지 않고 `null`로 두는 규칙([RAG §5.1](./RAG.md))의 실제 적용 사례가 된다.
- 본문이 짧은 구조화 레코드라 chunk·embedding 가치가 낮다. 텍스트 document와 상태 관측값 중 어디로 정규화할지 `DEC-001`에서 정한다.
- 변경 주기가 느려 freshness lag 검증에는 약하다.

### 7.3 HTTP 대상: release notes

- 대상: `https://developer.chrome.com/release-notes/{version}`
- 수집 방식: HTTP fetch + HTML parse (Playwright 불필요)

이 페이지는 본문이 서버 렌더링된다. Chrome 152 페이지에서 "**Stable release date:** August 25th, 2026"과 섹션별 기능 설명, 기능마다 ChromeStatus·spec·tracking bug 링크를 HTML로 확인했다. feed는 없으므로 HTTP 수집이 정책에 맞고, 브라우저는 필요하지 않다.

7.2가 시간 신호와 본문 가치가 약한 점을 이 대상이 보완한다. `DEC-001`에서 두 대상을 함께 채택할지 정한다.

### 7.4 사용자가 별도 해결할 항목

라이선스 귀속의 제품 반영 방식은 사용자가 이후에 결정한다. 결정 전까지 이 source의 **발췌 표시 기능을 출시하지 않는다.** 수집·저장·embedding은 CC BY 4.0 근거로 진행할 수 있다.

- `sources`/`source_rights`에 license 식별자와 귀속 문구 template 보관 여부
- API citation 객체가 license와 attribution을 반환할지
- UI가 귀속 문구와 원문 링크를 어디에 표시할지

## 8. 채택하지 않는 후보

### 8.1 reddit — blocker_found

- 근거 문서: [robots.txt](https://www.reddit.com/robots.txt), [Data API Terms](https://redditinc.com/policies/data-api-terms) (rev. 2026-07-20), Public Content Policy, Data API Wiki
- 확인일: 2026-09-01

robots.txt 본문이 `User-agent: *` + `Disallow: /`다. Data API 사용자는 robots가 아니라 Data API Terms의 규율을 받지만, 그 약관이 우리 설계와 정면으로 충돌한다.

| 조항 | 인용 | 충돌 |
|---|---|---|
| Terms §2.4 | "no other rights or licenses are granted or implied, including any right to use User Content for other purposes, such as for training a machine learning or AI model, without the express permission of rightsholders" | embedding 생성의 근거가 없다 |
| Terms §3.2 | "use or retain any User Content ... beyond your approved use case, and you must immediately delete any data not required for it" | 지속 보관 corpus와 충돌 |
| Terms §6 | 종료 시 "delete any cached or stored User Content ... This includes any data or models that were derived from User Content" | 파생 데이터 삭제 의무 |
| Data API Wiki | "we strongly recommend routinely deleting any stored user data and content within 48 hours", 삭제된 콘텐츠는 "even if disassociated, de-identified or anonymized" 보관 금지 | raw 불변 보존 원칙과 충돌 |
| Dev help | "Can I use content on Reddit to build a large language / AI model? No." | 모델 입력 사용 금지 |

RAG 검색용 embedding이 "model training"에 해당하는지는 약관에 명시되지 않아 미확정이다. 불명확을 허용으로 보지 않는 규칙에 따라 **저장·embedding 대상으로 채택하지 않는다.** 상업적 사용은 별도 계약, 연구는 Reddit for Researchers 프로그램으로만 허용된다고 명시돼 있다.

읽기 전용 조회는 free OAuth Data API(100 QPM)로 가능하지만, 저장하지 않는 조회는 우리 파이프라인 구조와 맞지 않는다.

### 8.2 github_trending — blocker_found

- 근거 문서: [robots.txt](https://github.com/robots.txt), [Acceptable Use Policies](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies), [community discussion 161519](https://github.com/orgs/community/discussions/161519)
- 확인일: 2026-09-01

기술적으로는 접근 가능하다. `User-agent: *` 블록에 `/trending` 차단이 없고 페이지가 서버 렌더링되어 HTTP fetch로 취득된다. 그런데 세 가지가 걸린다.

1. **공식 API가 없다.** GitHub 공식 답변: "GitHub does not provide official REST API endpoints for /trending or /explore", "/trending and /explore are designed as UI-only views, not API endpoints".
2. **재현 불가능하다.** 랭킹 알고리즘이 문서화되지 않았고 항목에 절대 timestamp가 없다. 수집 시각과 `since` 파라미터를 스냅샷 메타로 남겨도 순위 자체를 감사할 수 없다.
3. **AUP 제약이 있다.** §6 "You will not reproduce, duplicate, copy, sell, resell or exploit any portion of the Service ... without our express written permission". §7은 공개·비개인 정보의 사용을 researcher(단, "only if any publications resulting from that research are open access")와 archivist에게 한정해 서술한다. 포트폴리오 제품이 여기 해당하는지는 법률 판단이다. "Built by" 사용자명은 개인정보로 §8 Privacy 준수 대상이다. 재현 불가능성은 [PRD](./PRD.md) 제품 원칙 4번과 충돌한다.

`ADR-0004`가 이미 GitHub Trending 제외를 추천했고, 이 조사가 그 판단을 근거로 뒷받침한다.

## 9. 추가로 검토한 후보

### 9.1 react_blog — no_blocker_found

- 대상: `https://react.dev/blog`, feed `https://react.dev/rss.xml`
- 근거: [LICENSE-DOCS.md](https://github.com/reactjs/react.dev/blob/main/LICENSE-DOCS.md), [robots.txt](https://react.dev/robots.txt)
- 확인일: 2026-09-01

프레임워크 블로그 7개(React, Vue, Next.js, Node.js, Deno, Bun, TypeScript) 중 **명시적 오픈 콘텐츠 라이선스를 가진 유일한 대상이다.** repo README: "Content submitted to react.dev is CC-BY-4.0 licensed, as found in the LICENSE-DOCS.md file." robots.txt는 빈 `Disallow:`로 전면 허용. RSS가 있고 본문이 서버 렌더링되며 `/blog/2024/12/05/react-19` 형식의 날짜 포함 안정 URL을 쓴다. GitHub Releases API가 제공하지 않는 서술형 업그레이드 안내를 담는다.

### 9.2 라이선스가 명시되지 않은 블로그

아래는 기술적으로는 수집 가능하지만 콘텐츠 라이선스를 확인하지 못했다. 우리 규칙상 저장·embedding·발췌를 허용으로 볼 수 없다.

| 대상 | 상태 |
|---|---|
| Vue blog | `vuejs/blog` repo에 LICENSE 파일이 없음. docs repo는 별도 라이선스가 있으나 블로그를 규율하지 않음 |
| Node.js blog | 사이트 repo는 MIT이지만 이는 코드·구조를 덮고 블로그 산문 라이선스는 미확인. 사이트에 "All rights reserved" 표기 |
| Bun blog | 블로그·문서 산문 라이선스 미확인 |
| Next.js blog | 콘텐츠 라이선스 없음. "© 2026 Vercel, Inc."와 Privacy Policy만 존재 |
| Deno blog | "All rights reserved" 기업 블로그. 마케팅 콘텐츠가 섞임 |
| TypeScript devblog | Microsoft 독점 Terms of use, 오픈 라이선스 없음. robots에 `Crawl-delay: 10` |

### 9.3 공식 문서 사이트

라이선스가 명시된 대상이 많다. 다만 **대부분 공개 GitHub markdown repo를 제공하므로, 스크래핑보다 repo 수집이 우선이다.** repo는 commit 단위로 immutable revision을 고정할 수 있어 citation 추적성도 더 좋다.

| 대상 | 라이선스 | 비고 |
|---|---|---|
| react.dev docs | CC BY 4.0 | repo `reactjs/react.dev` |
| TypeScript handbook | 문서 CC BY 4.0, 코드 MIT | repo `microsoft/TypeScript-Website`. 상표 사용권 없음 |
| web.dev | CC BY 4.0 | 소스 repo가 2024-03-14 read-only 아카이브. 최신성은 사이트가 authoritative |
| Kubernetes docs | CC BY 4.0 | repo `kubernetes/website` |
| Python docs | PSF License 2.0 | 파생 허용, copyleft 아님. 변경 요약 유지 의무. 푸터에 UTC 갱신 시각 |
| Rust docs | Apache-2.0 OR MIT | 사이트가 "generally dual-licensed"로만 기술. per-page 확인 필요 |
| MDN | **CC BY-SA 2.5+** | share-alike. 아래 주의 |

**MDN은 주의 대상이다.** CC BY-SA는 파생물을 동일 라이선스로 배포할 의무를 부과한다. 우리 제품은 수집 텍스트에서 파생한 발췌·요약을 사용자에게 발행하므로 라이선스 전파 위험이 있다. 원문 저장과 내부 embedding은 별 문제가 없지만, 파생 발췌 공개 정책을 정하기 전에는 채택하지 않는다.

### 9.4 github_search — 관심·논의 신호를 공식 API로

- 대상: `GET /search/repositories`, `GET /search/issues`
- 근거: [REST search](https://docs.github.com/en/rest/search/search), [searching for repositories](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories), [searching issues](https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests), [starring](https://docs.github.com/en/rest/activity/starring)
- 확인일: 2026-09-01

Trending 페이지를 스크래핑하지 않고도 같은 성격의 신호를 얻을 수 있고, **재현 가능성 문제가 해소된다.** 순위 산정을 GitHub의 비공개 알고리즘이 아니라 우리가 기록한 질의가 결정하기 때문이다.

| 신호 | 방법 | 문서화된 근거 |
|---|---|---|
| 관심 | `/search/repositories`에 `stars:`, `created:`, `pushed:`, `topic:`, `language:` 조합 + `sort=stars` | 다섯 qualifier 모두 공식 문서에 있음. `sort`는 "stars, forks, help-wanted-issues, updated" 중 선택 |
| 논의 | `/search/issues`에 `comments:`, `interactions:`, `reactions:`, `updated:` + `sort=comments\|interactions\|reactions` | `interactions`는 "the number of reactions and comments"로 정의됨 |

`/search/issues`는 Trending이 주지 않는 신호다. 실제로 지금 활발히 논의되는 항목을 공식 API로 집계할 수 있다.

**제약을 명확히 기록한다.**

- 검색당 최대 1,000건만 조회 가능하다. "the GitHub REST API provides up to 1,000 results for each search." repository 검색은 추가로 "will find up to 4,000 repositories that match your filters".
- 검색 전용 rate limit이 별도다. 인증 시 분당 30건, 미인증 분당 10건.
- 결정성 보장이 문서화되지 않았다. 시간 초과 시 `incomplete_results: true`가 올 수 있다. `sort=stars`는 relevance보다 안정적이지만 GitHub이 재현성을 약속하지는 않는다.
- **별 히스토리 API가 없다.** 현재 별 수만 조회 가능하다. `application/vnd.github.star+json`으로 `starred_at`을 얻을 수 있었으나, 문서에 "In July 2026 ... Access to the stargazers listing endpoints will be limited to admins and collaborators"라는 새 제한이 있다. 따라서 **임의 공개 repository의 별 증가 속도를 소급 재구성할 수 없다.**
- 결과적으로 관심 변화 시계열은 우리가 주기적으로 스냅샷을 찍어 직접 만들어야 한다. 수집 시작 시점부터의 데이터만 존재하고 과거 backfill이 불가능하다. 이 한계를 답변의 limitations에 표시한다.
- 응답의 `owner`, `user`, `milestone.creator` 객체에 계정 식별 정보가 있다. §8의 GitHub 개인정보 제거 규칙을 동일하게 적용한다.
- AUP §7의 사용 목적 제한은 API 경유에도 적용된다("regardless of whether the information was scraped, collected through our API, or obtained otherwise"). 다만 §7은 "Scraping does not refer to the collection of information through our API. Please see Section H"로 API 경로를 ToS §H로 넘긴다. 스크래핑보다 방어 가능한 경로다.

### 9.5 arxiv — no_blocker_found, 가장 깨끗한 라이선스

- 대상: `http://export.arxiv.org/api/query` (Atom), 대량 수집은 OAI-PMH
- 근거: [API Terms of Use](https://info.arxiv.org/help/api/tou.html), [User manual](https://info.arxiv.org/help/api/user-manual.html)
- 확인일: 2026-09-01

**약관이 우리가 하려는 일을 명시적으로 허용한다.** TOU에 "Retrieve, store, transform, and share descriptive metadata about arXiv e-prints"가 있고, 그 metadata는 **CC0 1.0**이다. "You are free to use descriptive metadata ... under the terms of the Creative Commons Universal (CC0 1.0) Public Domain Declaration"이며 각주가 "title, abstract, authors, identifiers, and classification terms"를 포함한다.

즉 **제목과 abstract가 CC0다.** 우리 RAG가 실제로 저장·임베딩·발췌하는 대상이 정확히 이 범위다. 지금까지 검토한 모든 소스 중 권리 관계가 가장 명확하다.

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | 공식 API. "make no more than one request every three seconds, and limit requests to a single connection at a time" |
| store | yes | TOU가 metadata의 retrieve·store·transform·share를 명시 허용 |
| embed | yes | metadata가 CC0이므로 파생 생성에 제약이 없다 |
| excerpt | yes | abstract가 CC0 metadata에 포함된다. "We encourage you to link to the abstract page" |
| 금지 사항 | 전문 재배포 | "Store and serve arXiv e-prints (PDFs, source files, or other content) from your servers, unless you have the permission of the copyright holder" → **PDF·전문을 저장하지 않는다.** 전문은 저작권이 개별로 남아 있다 |
| 캐싱 | 의무에 가까움 | "there is no need to call the API more than once in a day for the same query. Please cache your results." 우리 파이프라인 구조와 정확히 맞는다 |
| personal_data | 저자명 포함 | `<author><name>`이 항상 있고 CC0 범위다. 다만 필요 최소로 저장한다 |
| stable identifiers | 확보 | `<id>`가 `http://arxiv.org/abs/{id}`, 버전 접미사 v1/v2, `<published>`, `<updated>`, DOI, primary category |
| 결과 상한 | 있음 | `max_results`는 30,000까지, 2,000 단위 슬라이스. 대량은 OAI-PMH |

주의: `arxiv.org/robots.txt`는 `/api`, `/search`를 Disallow하고 `Crawl-delay: 15`를 둔다. 그러나 우리가 쓰는 경로는 `export.arxiv.org`의 문서화된 API이며 API TOU가 규율한다. **웹 페이지를 크롤링하지 않는다.**

### 9.6 huggingface_hub — 지표 전용으로 조건부

- 대상: Hub API (OpenAPI 공개), 근거: [Hub API](https://huggingface.co/docs/hub/api), [rate limits](https://huggingface.co/docs/hub/rate-limits), [ToS](https://huggingface.co/terms-of-service)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | OpenAPI 문서 공개, robots.txt가 `Allow: /`, rate limit 계층 공개(익명 API 500 / free 1,000 per 5분 창) |
| store | 지표는 yes | repo ID, commit SHA, `createdAt`, `lastModified`, download 수 등 사실 정보 |
| embed | **no (blanket)** | 라이선스가 **repo별**이다. ToS의 공개 repo 라이선스 부여는 "through our Services and functionalities"로 범위가 한정된다. model card 본문을 일괄 임베딩할 근거가 없다 |
| excerpt | no (blanket) | 위와 동일 |

따라서 **Hugging Face는 텍스트 소스가 아니라 지표 소스로만 채택한다.** 모델·데이터셋 생성 수, 다운로드 수 같은 관측값을 `metric_observation`으로 저장하고 model card 산문은 수집하지 않는다. 개별 repo 라이선스를 확인한 경우에만 본문 수집을 검토한다.

`huggingface.co/papers`의 upvote·star 신호는 API와 데이터 라이선스를 확인하지 못했다(unverified). 채택하지 않는다.

### 9.7 채택하지 않는 AI 후보

| 대상 | 이유 |
|---|---|
| Papers with Code | 2025-07-24 sunset. 현재 Hugging Face로 redirect된다. 후속 서비스의 약관 미확인 |
| OpenAI docs·changelog | 콘텐츠 재사용 API·피드·라이선스 없음. Terms of Use 페이지가 자동 조회에 403을 반환해 조항 확인 불가 |
| Anthropic docs·changelog | Consumer ToS에 크롤링·스크래핑 금지 조항이 있다. 적용 범위가 Claude 제품인지 문서 사이트까지인지 모호하다. 재사용 라이선스 없음 |

두 AI 벤더 문서는 **링크 참조만** 하고 저장·임베딩하지 않는다.

### 9.8 커뮤니티 소스 후보 (community_mentions 유지용)

Reddit 대체 후보를 조사했다. 판단을 가른 것은 **콘텐츠에 실제 라이선스가 붙어 있는지**다. Reddit은 "without the express permission of rightsholders"라며 권리자 허락이 없음을 전제했는데, 아래 두 후보는 권리자가 이미 오픈 라이선스로 허락한 경우다.

#### 9.8.1 users.rust-lang.org — 라이선스가 가장 관대함

- 대상: Discourse JSON API. `GET /latest.json`, `GET /t/{id}.json`
- 근거: [TOS](https://users.rust-lang.org/tos), [robots.txt](https://users.rust-lang.org/robots.txt), [Discourse rate limit 설정](https://meta.discourse.org/t/available-settings-for-global-rate-limits-and-throttling/78612)
- 확인일: 2026-09-01

TOS §3 User Content License가 **"User contributions made on or after 2020-07-17 are dual-licensed under the MIT and Apache 2.0 licenses"**라고 명시한다. 저장·임베딩·상업적 사용을 허용하는 permissive 라이선스이며 저작권 고지만 유지하면 된다. 커뮤니티 소스 중 유일하게 share-alike도 NonCommercial도 아니다.

| 항목 | 값 | 비고 |
|---|---|---|
| fetch | yes | robots가 `.json` 경로를 막지 않는다. `.rss`와 `/search`, `/admin` 등만 Disallow. Crawl-delay 없음 |
| store | yes | 2020-07-17 이후 게시물은 MIT/Apache-2.0 |
| embed | yes | 위와 동일 |
| excerpt | yes, 고지 유지 | MIT/Apache 고지 의무 |
| **날짜 분리 필수** | — | 2020-07-17 **이전** 게시물은 CC BY-NC-SA 3.0이다. NonCommercial 조건이 붙으므로 **수집 대상을 게시일로 분리하고 이전 게시물은 저장하지 않는다** |
| rate_policy | Discourse 기본값 | IP당 분당 200, 10초당 50. 인스턴스가 변경 가능하므로 실제로는 429와 `Retry-After`를 권위로 본다 |
| 삭제 반영 | 가능 | `deleted_at`, `deleted_by`, `user_deleted` 필드로 감지 |
| personal_data | 제거 필요 | `username`, `name`(실명 가능), `user_id`, `avatar_template`. 저장 전 제거 |
| 신호 범위 | 좁음 | Rust 한정. 언급량 자체는 작다 |

#### 9.8.2 stack_exchange — 신호량이 가장 크고 라이선스가 명시됨, 단 미해결 조항 있음

- 대상: `https://api.stackexchange.com` v2.3
- 근거: [licensing](https://stackoverflow.com/help/licensing), [API terms of use](https://stackoverflow.com/legal/api-terms-of-use), [throttle](https://api.stackexchange.com/docs/throttle), [data dumps](https://stackoverflow.com/help/data-dumps)
- 확인일: 2026-09-01

| 항목 | 값 | 근거 |
|---|---|---|
| fetch | yes | 무료 문서화 API. IP당 초당 30 초과 시 차단, 기본 일 10,000 quota. 응답 본문의 `backoff` 필드를 받으면 그 초만큼 대기해야 한다 |
| 라이선스 | CC BY-SA (버전이 게시일로 나뉜다) | 2018-05-02 이후 4.0, 2011-04-08~2018-05-02 3.0, 그 이전 2.5. **API의 `content_license` 필드로 게시물별 확인 가능** |
| excerpt | 귀속 필수 | API Terms: "All Applications must ensure they visually indicate that the Stack Exchange Network is the source of the content". CC BY-SA 4.0 §3은 작성자 식별, 저작권 고지, 라이선스 고지, 원문 링크, 수정 여부 표시를 요구 |
| 삭제 반영 | 재조회 필요 | `deleted` 필드가 없다. 하드 삭제된 게시물은 응답에서 사라지므로 "더 이상 반환되지 않음"을 삭제 신호로 처리해야 한다. `closed_date`, `locked_date` 등 조정 상태는 별도 필드로 남는다 |
| personal_data | 제거 필요 | `owner`가 `user_id`, `display_name`(실명 가능), `profile_image`(Gravatar) 포함 |
| stable identifiers | 확보 | `question_id`, epoch UTC `creation_date`·`last_activity_date`, `link` |

**미해결 조항이 둘 있다.**

1. **AI 학습 관련.** API Terms of Use에는 AI·ML 학습 금지 조항이 **없다.** 그런데 공식 data dump를 받으려면 "Check the box affirming that you do not intend to use the file for LLM training"에 동의해야 한다. 즉 대량 dump 경로는 막혀 있고 API 경로는 조항이 침묵한다. 검색용 embedding 생성이 "LLM training"에 해당하는지는 어느 문서에도 정의돼 있지 않다. Stack Overflow는 별도로 유료 Data Licensing 프로그램을 운영한다.
   - Reddit과 다른 점: Reddit은 권리자 허락이 없다고 명시했고, Stack Exchange는 작성자가 CC BY-SA로 이미 허락했다. dump 체크박스는 그 배포 경로에 붙은 계약 조건이다. 이 구분이 법적으로 유효한지는 이 문서가 판단하지 않는다.
2. **share-alike 전파.** CC BY-SA 4.0 §1(a)는 Adapted Material을 "translated, altered, arranged, transformed, or otherwise modified"로 정의하고, §3(b)는 Adapted Material을 배포할 때만 동일 라이선스 의무가 발생한다고 한다. 원문 그대로의 인용은 §2(a)(1)(A)의 "reproduce and Share the Licensed Material, in whole or in part"에 해당해 share-alike를 유발하지 않는다. 다만 §4(b)는 **상당 부분을 담은 데이터베이스 자체를 §3(b) 목적상 Adapted Material로 본다**고 규정한다.
   - 실무적 결론: Stack Exchange 콘텐츠는 **요약·변형하지 않고 원문 발췌만** 사용하고, 저장 범위를 최소화해야 위험이 낮아진다. LLM이 SE 텍스트를 재서술하지 않도록 답변 생성 규칙을 별도로 두어야 한다.

#### 9.8.3 조건부 후보

| 대상 | 라이선스 | 판단 |
|---|---|---|
| discuss.python.org | CC BY-NC-SA 3.0 | NonCommercial + ShareAlike. 포트폴리오가 non-commercial인지 판단이 필요하고 share-alike 전파도 붙는다. 보류 |
| Mastodon | 인스턴스별 상이 | 통일된 근거가 없다. 특정 인스턴스를 개별 승인하는 경우에만 |
| Bluesky | 라이선스 없음 | ToS는 "You retain ownership of your Content"만 말하고 제3자 저장 허용을 명시하지 않는다. 삭제도 "complete deletion across the network may not always be possible"라 네트워크 차원 보장이 없다. 불명확하므로 채택하지 않는다 |

#### 9.8.4 채택 불가

| 대상 | 이유 |
|---|---|
| Lobsters | robots.txt가 `User-agent: * Disallow: /`이고 `Content-Signal: ai-input=no, ai-train=no`를 선언한다. 운영자가 AI 입력 사용을 명시적으로 거부했다 |
| dev.to (Forem) | Web Site ToS §2 Use License가 "may not modify or copy the materials; use the materials for any commercial purpose; ... transfer/mirror the materials on any other server"를 금지한다. 저장 자체가 충돌한다 |
| meta.discourse.org | ToS가 "You may not automate access to the forum ... that is not a web browser"를 금지하고 공개 검색엔진 색인만 예외로 둔다 |

Discourse 기반 포럼은 **플랫폼이 같아도 라이선스가 인스턴스마다 다르다.** Rust는 MIT/Apache, Python은 CC BY-NC-SA, Discourse 본사 포럼은 자동 접근 금지다. 다른 공식 프로젝트 포럼을 추가하려면 매번 그 인스턴스의 TOS를 읽어야 한다.

## 10. 제품 영향: 신호 구성

이번 조사로 **`community_mentions`를 유지할 경로가 생겼다.** Reddit은 불가하지만 대체 후보가 있다.

확보 실패한 것과 이유는 다음과 같다.

| 후보 | 결과 |
|---|---|
| Reddit | 약관이 저장·파생·모델 입력을 금지 (§8.1) |
| Hacker News | ToU의 data mining·derivative works 금지 적용 여부 미확정 (§4) |
| GitHub Trending 페이지 | 랭킹 알고리즘 비공개로 재현 불가, AUP 복제 제한 (§8.2) |
| Lobsters, dev.to, meta.discourse | 명시적 금지 (§9.8.4) |

`community_mentions`를 유지하려면 다음 조합을 쓴다.

| source | 근거 | 제약 |
|---|---|---|
| `github_search` issues | 공식 API, GitHub ToS §H | 검색 1,000건 상한 |
| `users_rust_lang` | 2020-07-17 이후 MIT/Apache-2.0 | Rust 한정, 게시일 분리 필수 |
| `stack_exchange` | 게시물별 CC BY-SA | 원문 발췌만, 요약·변형 금지, 귀속 필수, AI 학습 조항 미해결 |

대신 공식 API로 확보 가능한 신호는 다음과 같다.

| 신호 | source | 단위 | 재현성 |
|---|---|---|---|
| release_activity | github_releases | releases | 높음 |
| repo_attention | github_search repositories | 우리 스냅샷 기준 별 수와 신규 등록 | 질의를 기록하므로 재현 가능. 단 과거 backfill 불가 |
| issue_discussion | github_search issues | comments·reactions·interactions | 질의 기록으로 재현 가능 |
| community_mentions | stack_exchange, users_rust_lang | dedup cluster 기준 언급 수 | 조건 충족 시 유지 가능 |
| package_downloads | npm_downloads | downloads (방향성) | 중간 |
| paper_activity | arxiv | 기간별 제출 수 | 높음. metadata가 CC0 |
| model_activity | huggingface_hub | 모델·데이터셋 생성 수, 다운로드 수 | 높음. 지표 전용 |
| source_diversity | 전체 | 같은 주제를 다룬 독립 공식 source 수 | 높음 |

이 구성은 원래 계획보다 지표 수가 많고 각 지표의 출처·단위·한계가 문서로 확인된다. 제품 원칙 3번(신호 구분)과 4번(재현 가능성)에 부합한다.

확정해야 할 항목은 다음과 같다.

1. `community_mentions`를 유지한다. source는 `stack_exchange`와 `users_rust_lang`이며, `github_search` issues는 별도 지표 `issue_discussion`으로 둔다.
2. `emerging_topics` 근거에 저장소 활동·논문 제출·모델 등록을 포함한다.
3. GitHub 관심 시계열은 수집 시작 이후만 존재한다는 한계를 답변에 표시한다.
4. 지표별 이름과 단위를 그대로 표시하고 "커뮤니티에서 화제" 같은 뭉뚱그린 표현을 쓰지 않는다.

### 10.1 Stack Exchange 포함에 따른 필수 규칙

`stack_exchange`를 포함하기로 정했으므로 아래는 선택이 아니라 구현 조건이다.

| 규칙 | 이유 |
|---|---|
| **원문 발췌만 사용하고 요약·재서술하지 않는다** | CC BY-SA 4.0 §3(b)의 share-alike는 Adapted Material 배포 시 발동한다. 원문 인용은 §2(a)(1)(A)의 범위다. LLM이 SE 텍스트를 재서술하면 Adapted Material이 될 수 있다 |
| **답변 생성 단계에서 SE 근거의 재서술을 금지한다** | 위 규칙을 프롬프트 규약과 후검증으로 강제한다. SE citation이 붙은 주장은 원문 발췌를 그대로 제시한다 |
| **게시물별 라이선스를 저장한다** | 같은 source 안에서 라이선스가 게시일로 갈린다(2.5/3.0/4.0). API `content_license` 필드를 revision에 함께 저장한다 |
| **귀속을 발췌와 함께 표시한다** | API Terms가 "All Applications must ensure they visually indicate that the Stack Exchange Network is the source of the content"를 요구한다. CC BY-SA §3은 작성자 식별, 저작권 고지, 라이선스 고지, 원문 링크, 수정 여부 표시를 요구한다 |
| **삭제는 부재로 감지한다** | API에 `deleted` 필드가 없다. 하드 삭제 게시물은 응답에서 사라지므로 재조회 시 부재를 삭제 신호로 처리해 tombstone을 만든다 |
| **`backoff` 필드를 준수한다** | 응답 본문의 `backoff`가 오면 그 초만큼 같은 method 호출을 중단해야 한다. HTTP 헤더가 아니라 본문에 있으므로 collector가 파싱해야 한다 |
| **저장 범위를 최소화한다** | CC BY-SA 4.0 §4(b)가 상당 부분을 담은 데이터베이스를 §3(b) 목적상 Adapted Material로 본다. 필요한 게시물만 좁게 수집한다 |
| **개인정보를 제거한다** | `owner.display_name`은 실명일 수 있고 `profile_image`는 Gravatar다. 저장 전 제거한다 |
| **라이선스 미확인 게시물은 발췌하지 않는다** | `EXP-001` 실측에서 표본의 **16.7%가 `content_license` 필드를 갖지 않았다.** 확인 불가 시 `license_id`를 null로 두고 발췌 표시 대상에서 제외하며 `community_mentions` 집계에만 사용한다 |
| **API key를 등록한다** | 미인증 `quota_remaining`이 **299**였다. 일 10,000은 key 등록 시 값이므로 collector 구현 전에 등록한다. 등록 전에는 수집 주기를 늘린다 |

**주의:** 라이선스 귀속의 제품 반영은 사용자가 나중에 정하기로 했으나, Stack Exchange는 귀속이 API 이용 조건 자체에 포함된다. 따라서 **SE 발췌를 표시하는 기능은 귀속 설계가 끝나기 전까지 출시할 수 없다.** 수집·저장·검색은 그 전에도 진행할 수 있다.

미해결로 남는 것은 하나다. 검색용 embedding 생성이 data dump 체크박스가 말하는 "LLM training"에 해당하는지는 어느 공식 문서에도 정의돼 있지 않다. 우리는 dump를 쓰지 않고 API만 쓰며, 콘텐츠는 작성자가 CC BY-SA로 허락한 것이라는 근거로 진행한다. 이 판단은 법률 검토 대상으로 남긴다.

이 변경은 제품 범위와 지표 정의를 바꾸므로 `DEC-001`에서 확정하고 PRD·RAG·GLOSSARY·TRACEABILITY를 함께 갱신한다.

## 11. 재검토 조건

다음 중 하나가 발생하면 해당 source를 `deferred`로 되돌리고 수집을 멈춘다.

- 약관 또는 robots 변경 확인
- 인증 요구 또는 접근 정책 변경
- rate limit 정책 변경
- 원 출처의 삭제·비공개 요청
- 마지막 검토일이 정책상 유효 기간을 초과

## 12. 남은 확인 항목

| 항목 | 대상 | 해소 경로 |
|---|---|---|
| YC ToU 금지 조항이 공식 API에 적용되는지 | hacker_news | `DEC-001`에서 범위 축소·대체·보류 중 선택 |
| 추적 repository별 license와 embedding 허용 여부 | github_releases | `EXP-001`에서 repository 목록과 함께 기록 |
| conditional request 지원 여부 | npm_registry, npm_downloads | `EXP-001`에서 실제 응답 헤더 확인 |
| package README 본문 사용 범위 | npm_registry | 발행자 license 확인, 불명확하면 본문 미사용 |
| release 본문 저장 기간 | github_releases | 보존 정책 승인 시 확정 |
| Playwright 사용 정당성 | chrome_origin_trials | 해소됨. 서버 HTML에 내용 없음, feed·문서화 API 없음(§7.2) |
| citation에 license·attribution 노출 여부 | chrome_origin_trials, chrome_release_notes | 사용자가 별도 결정. 결정 전까지 발췌 표시 기능 미출시 |
| trial 레코드를 document로 볼지 상태 관측값으로 볼지 | chrome_origin_trials | `DEC-001` |
| 신호 구성 재정의 확정 | 제품 범위 | `DEC-001`. §10의 4개 확정 항목 |
| GitHub search 결과의 재현성 보장 범위 | github_search | `EXP-001`에서 동일 질의 반복 시 결과 일치율 측정 |
| repository별 license와 embedding 허용 여부 | github_releases, github_search | `EXP-001`에서 대상 목록과 함께 기록 |
| HF paper pages upvote 신호의 약관·라이선스 | huggingface_hub | 미확인. 채택하지 않음 |
| RAG 검색용 embedding이 "model training"에 해당하는지 | reddit | 약관에 명시 없음. 채택하지 않으므로 추적만 |
| Vue docs repo LICENSE 실제 내용 | vue | 필요 시 확인 |
| 라이선스 미명시 블로그의 재사용 허용 여부 | node, bun, next, deno, typescript devblog | 각 운영 주체에 문의 또는 미채택 |
| MDN 파생 발췌 공개 시 share-alike 전파 범위 | mdn | 발행 정책 확정 전 미채택 |
| 문서 사이트를 repo로 수집할 때의 정규화 방식 | 공식 문서 후보 | markdown 원문과 렌더링 텍스트 중 무엇을 저장할지 |

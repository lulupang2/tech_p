# ADR-0004: Initial data sources

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: 아래 Recommendation의 source set을 초기 source set으로 채택

## 승인 범위와 조건

이 승인은 **권리·정책 근거에 대한 승인**이다. `DISC-001`의 검토 결과([SOURCE_RIGHTS.md](../SOURCE_RIGHTS.md))를 바탕으로 어떤 source를 쓰고 어떤 source를 제외할지를 확정한다.

기술적 타당성은 아직 측정하지 않았다. 따라서 다음 조건이 함께 승인된다.

- 각 source는 collector 구현 전에 [EXP-001](../experiments/EXP-001-source-feasibility.md)의 field completeness, canonical URL 확보율, 게시 시각 확보율, 반복 fetch 성공률, rate 준수 schedule 게이트를 통과해야 한다.
- 게이트를 통과하지 못한 source는 이 ADR을 다시 열지 않고 해당 source만 보류하며, 신호 유형 3개 이상 요건이 깨지면 새 ADR로 대체 source를 검토한다.
- 발췌 표시 기능은 라이선스 귀속 설계가 끝난 뒤에만 출시한다. 수집·저장·검색은 그 전에 진행할 수 있다.
- Stack Exchange의 검색용 embedding과 "LLM training"의 관계는 법률 검토 대상으로 남는다. 이 승인은 그 판단을 대체하지 않는다.

## Context

실제 데이터 파이프라인과 예시 질문을 증명하려면 업데이트, 커뮤니티 언급, 비교 가능한 관심 신호가 필요하다. Playwright도 프로젝트 필수 기술이지만 API/RSS 우선 원칙을 지켜야 한다.

## Decision drivers

- 공개·합법적 접근과 보존/표시 허용
- 안정적 ID, URL, 게시 시각
- TypeScript, Playwright, Bun, Node.js, RAG 질문 커버리지
- rate limit과 재현 가능한 fixture
- 서로 다른 종류의 신호 3개 이상
- 무료 또는 예측 가능한 포트폴리오 비용

## Alternatives

| 소스 | 제공 신호 | 장점 | 단점/위험 |
|---|---|---|---|
| GitHub Releases REST API | 공식 프로젝트 release | 안정적 metadata·URL | release가 아닌 일반 논의는 없음 |
| Hacker News official API | 이야기·댓글 언급 | 공개 near-real-time | ToU의 data mining·derivative works 금지 적용 여부 미확정 |
| npm registry/download API | package release/download | 비교 시계열 후보 | 지표가 mirror·CI·bot 포함 방향성 값 |
| 공식 blogs/changelogs RSS | 공식 업데이트 | 높은 authority | 대부분 콘텐츠 라이선스 미명시. react.dev만 CC BY 4.0 확인 |
| 공식 문서 사이트 | 기술 레퍼런스 | 다수가 CC BY 4.0 등 명시 라이선스 | 대부분 public repo가 있어 스크래핑이 불필요. MDN은 share-alike |
| 공식 공개 동적 페이지 + Playwright | API 없는 업데이트 | browser collector 증명 | 약관·robots·selector drift |
| GitHub Trending scraping | 상대적 관심 | 직관적 | 공식 API 없음, 랭킹 알고리즘 비공개로 재현 불가, AUP 복제 제한 |
| Reddit Data API | 커뮤니티 언급 | 큰 커뮤니티 표본 | 약관이 저장·파생·모델 입력을 금지. 채택 불가 |

## Recommendation

권리 검토([SOURCE_RIGHTS.md](../SOURCE_RIGHTS.md))를 반영한 초기 source set은 다음과 같다.

**텍스트 document source**

1. **GitHub Releases API** — 추적 대상 repository의 공식 release
2. **Stack Exchange API** — 커뮤니티 언급. 게시물별 CC BY-SA, 원문 발췌만 사용
3. **users.rust-lang.org** — 공식 프로젝트 포럼 논의. 2020-07-17 이후 게시물만
4. **arXiv API** — AI 연구 동향. metadata가 CC0
5. **Chrome release notes** (HTTP) 와 **react.dev/blog** (RSS) — 공식 업데이트 공지
6. **Chrome origin trials** (Playwright) — 필수 browser collector 요건

**metric observation source**

7. **npm registry/downloads** — 패키지 출시와 다운로드
8. **GitHub search** (repositories, issues) — 관심과 논의 신호
9. **Hugging Face Hub API** — AI 생태계 활동. 지표 전용, 본문 미수집

**제외**

- **Hacker News**: YC ToU의 data mining·derivative works 금지 조항이 공식 API에 적용되는지 미확정
- **Reddit**: 약관이 저장·파생·모델 입력을 제한하고 삭제 의무를 부과
- **GitHub Trending 페이지**: 공식 API 없음, 랭킹 알고리즘 비공개로 재현 불가
- **Lobsters, dev.to, meta.discourse.org**: 명시적 금지 조항
- **MDN, discuss.python.org**: share-alike 또는 NonCommercial 조건으로 보류
- **OpenAI, Anthropic 문서**: 재사용 근거 없음. 링크 참조만

신호 유형이 릴리스, 커뮤니티 언급, 포럼 논의, 논문, 패키지, 저장소 활동, AI 모델 활동으로 나뉘어 `FR-001`의 3개 이상 요건을 충족한다.

### 권리 검토 결과 반영 (2026-09-01)

`DISC-001`의 검토 결과([SOURCE_RIGHTS.md](../SOURCE_RIGHTS.md))가 위 추천안 중 2번을 흔든다.

- **Hacker News에서 차단 사유가 발견됐다.** Y Combinator Terms of Use가 data mining, scraping, derivative works를 금지하는데 공식 Firebase API가 이 금지의 예외인지 문서상 확정되지 않는다. 불명확을 허용으로 보지 않는 프로젝트 규칙에 따라 현재 상태로는 수집을 시작할 수 없다.
- 선택지는 셋이다. story title과 metadata, 외부 링크만 쓰는 범위 축소, 다른 공식 API/RSS 소스로 대체, 또는 `DEC-001`에서 위험을 인지하고 범위를 확정하는 보류다. 이 ADR은 어느 쪽도 아직 선택하지 않는다.
- **GitHub Releases는 차단 사유가 없으나 조건이 붙는다.** release note 본문의 embedding 허용 여부가 repository별 license에 달려 있다. 추적 repository 목록을 정할 때 license를 함께 기록하고, 불명확한 repository는 본문 embedding 대상에서 제외한다.
- **npm은 차단 사유가 없다.** metadata 전체 복제가 명시적으로 허용된다. 단 maintainer email 제거가 필수이고, download 수치는 npm 스스로 "naïve by design"이라고 설명하는 방향성 지표다.
- **Playwright 대상이 확정됐다.** `developer.chrome.com/origintrials/`는 robots가 전 경로를 허용하고 콘텐츠가 CC BY 4.0이며, 서버 HTML에 내용이 없어 렌더링이 필요하다. 공식 feed 목록에 없고 문서화된 공개 API도 확인되지 않으므로, 숨겨진 endpoint 역공학을 금지하는 원칙 아래에서는 공개 페이지 렌더링이 유일한 정책 준수 경로다. 이로써 `FR-002`의 browser collector 요건이 우회 없이 충족된다.
- 같은 사이트의 `release-notes/{version}`은 본문이 서버 렌더링되므로 HTTP 수집 대상으로 분류한다. origin trials가 게시 시각과 본문 가치가 약한 점을 이 대상이 보완하며, Hacker News를 제외할 경우 공식 업데이트 신호를 늘리는 역할도 한다.
- 라이선스 귀속의 제품 반영 방식은 사용자가 별도로 결정한다. 결정 전까지 이 두 source의 발췌 표시 기능은 출시하지 않는다.
- **Reddit과 GitHub Trending도 검토했고 둘 다 채택하지 않는다.** Reddit은 Data API Terms가 저장·파생·모델 입력을 제한하고 삭제 의무를 부과해 지속 corpus와 충돌한다. GitHub Trending은 공식 API가 없고 랭킹 알고리즘이 비공개라 재현 가능성 원칙을 충족하지 못한다. 근거는 [SOURCE_RIGHTS §8](../SOURCE_RIGHTS.md).
- **커뮤니티 언급 신호는 source를 교체해 유지했다.** Reddit과 Hacker News는 쓸 수 없지만 Stack Exchange(게시물별 CC BY-SA)와 users.rust-lang.org(2020-07-17 이후 MIT/Apache-2.0)가 권리 근거를 갖는다. 여기에 공식 API 기반 신호를 더했다. `GET /search/repositories`(stars·created·pushed·topic·language + sort=stars)로 관심 신호를, `GET /search/issues`(comments·reactions·interactions + sort)로 논의 신호를 만든다. Trending 페이지와 달리 순위를 우리가 기록한 질의가 결정하므로 재현 가능성 문제가 해소된다. 제약은 검색당 1,000건 상한, 검색 전용 rate limit 분당 30건(인증), 그리고 2026년 7월부터 stargazers 목록 접근이 admin·collaborator로 제한되어 **별 증가 속도를 소급 재구성할 수 없다**는 점이다. 관심 시계열은 우리 스냅샷으로 직접 만들고 backfill 불가를 답변에 표시한다.
- **AI 신호 source를 추가 확보했다.** arXiv API가 지금까지 검토한 중 권리 관계가 가장 명확하다. TOU가 "Retrieve, store, transform, and share descriptive metadata"를 명시 허용하고 title·abstract·authors·identifiers가 **CC0 1.0**이다. 전문 PDF는 저장하지 않는다. Hugging Face Hub API는 라이선스가 repo별이므로 **지표 전용**으로만 채택하고 model card 본문은 수집하지 않는다. Papers with Code는 2025-07-24 sunset으로 사용 불가, OpenAI·Anthropic 문서는 재사용 근거가 없어 링크 참조만 한다.
- 따라서 이 승인은 지표 구성도 함께 확정한다. `community_mentions`는 **유지하되 source를 교체한다.** Reddit·Hacker News 대신 Stack Exchange와 users.rust-lang.org를 근거로 삼는다. 최종 지표 구성은 `community_mentions`, `issue_discussion`, `repo_attention`, `source_diversity`, `release_activity`, `paper_activity`, `model_activity`, `package_downloads`의 8개이며 각각 분리해 저장·표시한다. 상세는 [SOURCE_RIGHTS §10](../SOURCE_RIGHTS.md)에 있다.
- 대신 `react.dev/blog`가 CC BY 4.0으로 확인되어 공식 발표 신호를 보강할 수 있다. 프레임워크 블로그 7개 중 유일하게 명시적 오픈 라이선스를 가진 대상이다.

따라서 이 ADR이 `Accepted`가 되려면 초기 source set이 3개 이상의 서로 다른 신호 유형을 유지하면서 Hacker News 항목의 처리 방향을 함께 확정해야 한다. Hacker News를 제외하면 커뮤니티 언급 신호를 무엇으로 대체할지도 같은 결정에 포함된다.

## Consequences if accepted

- “관심”을 하나의 지수로 합치지 않고 source/metric별로 표시한다.
- repository/package/topic allowlist를 설정으로 관리한다.
- Stack Exchange 근거는 `verbatim_only`로 표시하고 재서술 없이 원문 발췌만 제시한다. 게시물별 라이선스를 revision에 저장한다.
- Playwright source는 별도 policy review와 canary를 가진다.

## Validation before acceptance

[EXP-001](../experiments/EXP-001-source-feasibility.md)의 rights, schema, pagination, rate, freshness, sample quality 기준을 모든 source가 통과해야 한다.

## References

- [GitHub release endpoints](https://docs.github.com/en/rest/releases/releases)
- [Official Hacker News API](https://github.com/HackerNews/API)
- [npm Registry API](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)

# TechPulse Glossary and Naming Rules

- 상태: Active
- 작성일: 2026-09-01
- 목적: 문서 간 같은 개념을 다른 이름으로 부르는 drift를 막는다

이 문서는 결정을 만들지 않는다. 이미 다른 문서에 있는 개념의 표준 이름과 표기 규칙만 정한다. 용어 정의가 이 문서와 설계 문서에서 다르면 [SSOT.md](./SSOT.md) 우선순위를 따르고 이 문서를 고친다.

## 1. 데이터 모델 용어

| 용어 | 정의 | 정의 문서 |
|---|---|---|
| source | 승인된 하나의 외부 데이터 제공 대상. `source_key`로 식별 | [DATA_PIPELINE.md](./DATA_PIPELINE.md) |
| collection run | 한 source의 한 예약 window 실행 단위 | DATA_PIPELINE, DATABASE |
| raw item | 수집 응답의 불변 저장 단위. `(source, external_id, payload_hash)`가 revision을 구분 | DATA_PIPELINE §5.3 |
| document | 논리적 텍스트 artifact. 시간에 따라 여러 revision을 가짐 | [DATABASE.md](./DATABASE.md) §3.2 |
| document revision | 정규화 결과의 불변 버전. citation이 가리키는 대상 | DATABASE §3.2 |
| chunk | 검색·인용 단위. revision 내 `ordinal`로 순서 고정 | DATABASE §3.3 |
| embedding | chunk의 벡터 표현. provider/model/dimensions/input hash로 식별 | DATABASE §3.3 |
| duplicate cluster | 서로 같은 발표를 다룬 문서 묶음. 원본을 삭제하지 않는 link | DATA_PIPELINE §5.5 |
| duplicate cluster membership | 특정 algorithm version이 immutable document revision을 cluster에 연결했다는 append-only evidence row | DATABASE §3.2 |
| metric observation | 기간과 단위가 있는 숫자 관측값. 텍스트 문서와 분리 저장 | DATABASE §3.4 |
| topic | canonical 기술 entity와 alias 집합 | DATABASE §3.2 |
| taxonomy_version | topic alias·계층·source mapping 사전의 불변 버전 | TOPIC_TAXONOMY §1, DATABASE §3.2 |
| classifier_version | topic 분류 방식과 실행 규칙의 버전. 결과 evidence에 저장 | DATA_PIPELINE §5.6, DATABASE §3.2 |
| deterministic alias classification | 허용 taxonomy의 alias·경계·문맥/source 제약만 사용해 재현하는 topic 분류 방식 | TOPIC_TAXONOMY §1, DATA_PIPELINE §5.6 |
| heading path | chunk가 속한 heading 계층의 순서 있는 경로 | DATA_PIPELINE §5.7, DATABASE §3.3 |
| chunker_version | heading-aware chunk 생성 규칙의 버전 | DATA_PIPELINE §5.7, DATABASE §3.3 |
| query run | 하나의 질의 처리 실행 기록. 검색 설정과 citation을 포함 | DATABASE §3.4 |
| tombstone | 검색·인용에서 제외하고 이후 purge 대상임을 표시하는 상태 | DATABASE §3.5 |
| license_id | 콘텐츠 재사용 조건을 식별하는 slug. source 기본값과 게시물별 값이 다를 수 있고 게시물 값이 우선한다 | DATABASE §3.1, §3.2 |
| attribution | 라이선스가 요구하는 귀속 문구. 저장된 template과 revision 값으로 서버가 조립하며 모델이 생성하지 않는다 | API §2.1 |
| verbatim_only | 해당 source 근거를 재서술하지 않고 원문 발췌로만 제시해야 함을 뜻하는 source 속성 | RAG §6.1 |
| query_signature | 검색 기반 관측값을 재현하기 위해 저장하는 정규화된 질의 서명 | DATABASE §3.4 |

## 2.1 source key

`ADR-0004`로 확정된 source key 목록이다. 새 source를 추가하면 이 목록과 [SOURCE_CATALOG.md](./SOURCE_CATALOG.md)를 함께 갱신한다.

`github_releases`, `github_search`, `stack_exchange`, `users_rust_lang`, `arxiv`, `chrome_release_notes`, `chrome_origin_trials`, `react_blog`, `npm_registry`, `npm_downloads`, `huggingface_hub`

## 2. 시간 용어

혼동이 가장 잦은 영역이므로 이름을 고정한다.

| 용어 | 의미 |
|---|---|
| `published_at` | 원 출처가 게시한 시각. 모르면 `null`이며 다른 값으로 대체하지 않는다 |
| `updated_at` | 원 출처의 수정 시각 |
| `collected_at` | TechPulse가 수집한 UTC 시각 |
| `searchable_at` | revision이 `published` 상태가 되어 검색 가능해진 시각 |
| freshness lag | `published_at → searchable_at`. 예약 지연은 `scheduled_at → completed_at`으로 따로 본다 |
| `dataFreshThrough` | API 응답에서 사용자에게 노출하는 데이터 최신 시각 |
| time range | 질의 기간. 항상 `from` inclusive, `to` exclusive |

모든 저장·계산은 UTC이며 상대 기간 해석에 사용한 IANA timezone을 함께 기록한다.

## 3. 지표 용어

서로 다른 지표를 하나의 관심 점수로 합치지 않는다는 규칙이 이름에도 반영된다.

| 지표 | 단위 | 의미 |
|---|---|---|
| `community_mentions` | deduplicated_documents | duplicate cluster 기준 언급 수. source는 Stack Exchange와 공식 프로젝트 포럼 |
| `issue_discussion` | comments, reactions, interactions | GitHub issue의 논의량. 단위를 섞지 않고 각각 저장한다 |
| `repo_attention` | stars, new_repositories | GitHub search 스냅샷 기준. 수집 시작 이후 구간만 존재하며 과거 backfill이 불가능하다 |
| `source_diversity` | sources | 같은 대상을 언급한 독립 source 수 |
| `release_activity` | releases | 공개 release 수 |
| `paper_activity` | submissions | 기간별 arXiv 제출 수 |
| `model_activity` | models, datasets, downloads | Hugging Face 생성 수와 다운로드 수 |
| `package_downloads` | downloads | source가 제공한 기간·단위의 다운로드 수. mirror·CI·bot 포함 방향성 지표 |

Metric observation은 위 표의 metric type과 허용 unit 조합만 사용한다. `metric aggregation`은 원본 observation을 보존한 채 같은 type·unit·subject·UTC window의 비교 가능한 값만 deterministic하게 묶는 파생 연산이다. accepted duplicate-cluster identity는 `community_mentions` deduplication에만 사용하며, `repo_attention`은 collection snapshot 경계 이후 값만 의미가 있다.

“인기”, “관심도”, “점수”는 사용자 표시 용어로 사용하지 않는다. 표시할 때는 지표명과 단위를 함께 쓴다. 서로 다른 지표를 하나의 종합 점수로 합치지 않는다.

## 4. 식별자 접두어

접두어를 재사용하면 문서 간 참조가 깨지므로 namespace를 고정한다.

| 접두어 | 의미 | 소유 문서 |
|---|---|---|
| `FR-` | 기능 요구사항 | [PRD.md](./PRD.md) §5 |
| `NFR-` | 비기능 요구사항과 수치 목표 | PRD §6 |
| `ADR-` | 기술 결정 기록 | [adr/](./adr/README.md) |
| `EXP-` | 실험 계획·결과 | [experiments/](./experiments/README.md) |
| `THR-` | 위협 모델 항목 | [SECURITY.md](./SECURITY.md) §3 |
| `DEC-` | 승인 gate task | [TASKS.md](../TASKS.md) |
| `DISC-` | 조사 task | TASKS.md |
| `FND-`, `OBS-`, `CON-`, `TST-`, `DB-`, `COL-`, `QUE-`, `PIPE-`, `AI-`, `EVAL-`, `RAG-`, `API-`, `SEC-`, `WEB-`, `OPS-`, `DOC-`, `MVP-` | 구현 task | TASKS.md |
| `@techpulse/` | pnpm workspace package namespace | ADR-0010, FND-001 |

`EXP-`는 TASKS.md에서 task ID로도 등장하지만 같은 번호가 같은 실험을 가리키므로 충돌이 아니다. `SEC-`는 task 전용이며 위협 ID로 쓰지 않는다.

## 5. 표기 규칙

| 경계 | 규칙 |
|---|---|
| 데이터베이스 | `snake_case` table/column, 단수 개념의 복수 table 이름 |
| 외부 API JSON | `camelCase` 필드 |
| job payload | `camelCase` 필드와 `schemaVersion` 명시 |
| enum 값 | `lower_snake_case` 문자열 |
| 환경 변수 | `UPPER_SNAKE_CASE` |
| source key | `lower_snake_case`, 예: `github_releases` |
| version 필드 | 대상별로 분리: `normalizer_version`, `chunker_version`, `classifier_version`, `taxonomy_version`, `workflow_version`, `prompt_version` |

DB 이름을 API에 그대로 노출하지 않고 contract package에서 명시적으로 매핑한다.

## 6. 상태 값

| 대상 | 허용 값 |
|---|---|
| ADR | `Proposed`, `Accepted`, `Rejected`, `Superseded` |
| experiment | `Planned`, `Running`, `Completed`, `Invalid` |
| task | `READY`(dependency가 모두 DONE), `BLOCKED`, `GATE`(승인·준비 대기), `DONE` |
| pipeline stage | `scheduled`, `fetching`, `raw_saved`, `normalized`, `deduplicated`, `enriched`, `chunked`, `embedded`, `published`, `retryable_failed`, `quarantined`, `dead_letter` |
| answer status | `answered`, `insufficient_evidence`, `unsupported_intent` |
| source status | `healthy`, `stale`, `degraded`, `disabled` |

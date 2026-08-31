# TechPulse Repository Guide

이 파일은 저장소 전체에 적용된다. 더 하위 디렉터리에 별도 `AGENTS.md`가 생기면 그 범위에서는 더 구체적인 규칙이 우선한다.

## 1. 현재 단계

- **production 구현이 승인됐다**(2026-09-01). `DEC-002`와 `DEC-004`가 승인되어 `FND-001`부터 구현을 시작한다.
- 구현은 [TASKS.md](./TASKS.md)의 dependency 순서를 따른다. `BLOCKED` task를 앞질러 시작하지 않는다.
- 아직 승인되지 않은 결정에 의존하는 코드는 작성하지 않는다. 현재 `ADR-0006`(LLM·embedding provider)이 `Proposed`이므로 provider 선택에 의존하는 코드는 `DEC-007` 이후에 만든다. `AI-001`의 provider-neutral port와 fake는 그 전에 만들 수 있다.
- 자격증명이 필요한 collector는 `DISC-002` 완료 후에 만든다. `COL-001`의 dependency에 포함되어 있다.
- 실험 코드는 폐기를 전제로 `experiments/` 아래에 두고 production 경로에 섞지 않는다. 승격하려면 해당 `FND-*` task에서 다시 작성한다.
- 발췌 표시 기능은 라이선스 귀속 설계가 끝나기 전까지 출시하지 않는다.

## 2. 기준 문서

작업 전 [docs/SSOT.md](./docs/SSOT.md)를 읽는다. 우선순위는 다음과 같다.

1. 사용자의 최신 명시적 요구사항
2. `docs/SSOT.md`
3. `Accepted` ADR
4. 영역별 설계 문서
5. `Proposed` ADR/experiment recommendation
6. `TASKS.md`

충돌을 발견하면 코드를 작성해 한쪽을 임의 선택하지 말고 문서와 결정을 먼저 정리한다.

## 3. 의사결정 규칙

- 확정되지 않은 기술 선택은 `docs/adr/`에 Alternatives, Recommendation, 검증 기준과 함께 기록한다.
- `Proposed`와 Recommendation은 구현 권한도 확정 결정도 아니다.
- 사용자가 승인한 경우에만 ADR을 `Accepted`로 바꾸고 같은 변경에서 SSOT를 갱신한다.
- 결정 변경은 새 ADR로 남기고 이전 ADR을 `Superseded`로 연결한다.
- 실험 결과는 `docs/experiments/`에 환경·데이터 버전·측정값과 함께 기록한다. 결과만으로 ADR을 자동 승인하지 않는다.

## 4. 구현 승인 후 작업 방식

- [TASKS.md](./TASKS.md)에서 dependency가 모두 완료된 가장 작은 task를 선택한다.
- 한 변경은 원칙적으로 한 task ID를 완료한다. 함께 해야만 acceptance를 검증할 수 있을 때만 묶고 이유를 남긴다.
- task 시작 전에 acceptance criteria와 영향 문서를 확인한다.
- 완료 시 acceptance를 증명하는 자동 테스트·명령·관측 결과를 남긴다.
- task 범위를 넘어서는 구조 변경은 먼저 ADR 또는 TASKS dependency를 수정한다.

## 5. 아키텍처 불변 조건

- 외부 source payload, 사용자 입력, retrieved content, LLM output은 untrusted다.
- raw source data는 파생 normalized document로 덮어쓰지 않는다.
- citation은 immutable document revision/chunk와 원 source URL로 추적 가능해야 한다.
- queue가 선택되어도 PostgreSQL이 business processing 상태의 authoritative store다.
- job은 at-least-once 실행을 전제로 멱등해야 한다.
- 날짜는 저장·계산 시 UTC를 사용하고 상대 기간 해석 timezone을 기록한다.
- 릴리스, 언급, 다운로드 등 서로 다른 metric을 설명 없는 단일 관심 점수로 합치지 않는다.
- 모델이 URL, 수치, citation ID를 임의 생성하게 두지 않고 결정적 검증을 거친다.
- source API/RSS를 우선하며 Playwright로 접근 정책, 로그인, CAPTCHA를 우회하지 않는다.

## 6. 코드 경계 제안

저장소 layout ADR이 승인되기 전에는 아래 구조를 만들지 않는다. 승인될 경우 권장 의존 방향은 `apps → packages`, adapter → domain port다.

- deployable app: web, API, worker
- shared package: contracts, domain, database, collectors, RAG, observability
- domain은 HTTP framework, queue client, provider SDK에 직접 의존하지 않는다.
- web은 DB·LLM key에 접근하지 않는다.
- 큰 payload를 queue job에 넣지 않고 versioned ID schema만 전달한다.

## 7. 보안과 데이터

- secret, token, cookie, 실제 `.env`를 커밋하지 않는다.
- log와 test artifact에 전체 raw payload, 전체 prompt, 개인정보, provider 오류 본문을 넣지 않는다.
- collector URL은 승인 host allowlist와 SSRF 방어를 거친다.
- test fixture는 권리 검토와 redaction metadata를 가진다.
- schema/migration은 forward 적용과 빈 DB 재현을 실제 PostgreSQL + pgvector에서 테스트한다.
- source 삭제·정책 변경은 tombstone과 재색인 경로를 고려한다.

## 8. 테스트 완료 규칙

- unit test에서는 실제 network, clock, random, LLM을 사용하지 않는다.
- collector는 fixture contract test와 non-blocking live canary를 분리한다.
- queue retry/concurrency는 queue 선택 후 실제 integration 환경에서 검증한다.
- RAG 변경은 retrieval/generation 골든셋을 비교한다.
- Playwright는 UI E2E와 browser collector suite를 분리한다.
- acceptance가 성능·품질 수치라면 dataset, 환경, 모델 버전, raw measurement 위치를 함께 기록한다.

상세 기준은 [docs/TESTING.md](./docs/TESTING.md)와 [docs/SECURITY.md](./docs/SECURITY.md)를 따른다.

## 9. 문서 동기화

| 변경 | 함께 확인할 문서 |
|---|---|
| 제품 범위·요구사항 | SSOT, PRD, TASKS, TRACEABILITY |
| component/technology 선택 | ADR, SSOT, ARCHITECTURE, TASKS |
| 수집 source/schema | DATA_PIPELINE, SOURCE_CATALOG, DATABASE, SECURITY, TESTING |
| source 대상·질의·주기 변경 | SOURCE_CATALOG, DATA_PIPELINE, TASKS |
| source 권리·정책 검토 | SOURCE_RIGHTS, DATA_PIPELINE, SECURITY, DATABASE |
| retrieval/prompt/model | RAG, DATABASE, TESTING, EVAL_GOLDEN_SET, experiment result |
| topic·alias 추가·변경 | TOPIC_TAXONOMY, GLOSSARY, SOURCE_CATALOG |
| 평가 질문·라벨 변경 | EVAL_GOLDEN_SET, TESTING, TASKS |
| API contract | API, SECURITY, TESTING, web contract |
| 보존·권한·배포 | SECURITY, DATA_PIPELINE, DATABASE, ADR |
| task 추가·삭제·재정의 | TASKS, TRACEABILITY |
| 새 용어·상태 값·식별자 접두어 | GLOSSARY |

문서 링크와 task dependency가 깨지지 않도록 변경 후 검증한다.


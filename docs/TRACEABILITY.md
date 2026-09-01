# TechPulse Traceability Matrix

- 상태: Active
- 작성일: 2026-09-01
- 목적: 요구사항과 위협이 설계·task·테스트로 이어지는지 한 화면에서 확인한다

이 문서는 새 요구사항을 만들지 않는다. [PRD.md](./PRD.md), [SECURITY.md](./SECURITY.md), [TASKS.md](../TASKS.md), [TESTING.md](./TESTING.md)의 기존 항목을 연결한다. 요구사항·task를 추가하거나 삭제하면 같은 변경에서 이 표를 갱신한다.

## 1. 기능 요구사항

| 요구사항 | 설계 문서 | 구현 task | 검증 계층 |
|---|---|---|---|
| FR-001 실제 외부 데이터 수집 | DATA_PIPELINE §2~4, SOURCE_CATALOG, SOURCE_RIGHTS | COL-002, COL-003, COL-004, COL-006, COL-007, COL-008, COL-009, COL-010, QUE-001, PIPE-001 | fixture contract, integration, live canary |
| FR-002 브라우저 수집 | DATA_PIPELINE §6 | COL-005 | fixture contract, canary, security |
| FR-003 원본 보존 | DATA_PIPELINE §5.3, DATABASE §3.1 | DB-002, PIPE-001 | integration |
| FR-004 정규화 | DATA_PIPELINE §5.4, §5.6, TOPIC_TAXONOMY | PIPE-002, PIPE-005, DB-003 | domain topic/chunk unit, database integration |
| FR-005 중복 제거 | DATA_PIPELINE §5.5 | PIPE-003, EXP-004, PIPE-004 | unit, integration, experiment |
| FR-006 임베딩 | DATA_PIPELINE §5.7 | AI-002, PIPE-005, PIPE-008 | chunk unit, component, integration |
| FR-007 자연어 질의 | RAG §4 | RAG-001 | component |
| FR-008 기간 검색 | RAG §4~5, DATABASE §4 | RAG-001, RAG-002, DB-006 | unit, integration, RAG eval |
| FR-009 근거 기반 답변 | RAG §6, §8 | RAG-004, RAG-005 | component, RAG eval |
| FR-010 비교 | RAG §7, DATA_PIPELINE §5.9 | DB-004, PIPE-006, RAG-006, WEB-003, COL-009, COL-010 | metric aggregation unit, component, E2E |
| FR-011 출처 표시 | API §2.1, RAG §5.3·§6.1, SOURCE_RIGHTS | API-003, WEB-002 | contract, E2E |
| FR-012 운영 가시성 | API §3, ARCHITECTURE §9 | PIPE-001, API-004, OPS-002 | contract, integration |
| FR-013 실패 복구 | DATA_PIPELINE §7 | QUE-001, PIPE-007 | integration |
| FR-014 최신성 표현 | API §2.1~2.2 | API-002, API-003, WEB-003 | contract, E2E |

## 2. 비기능 요구사항

| 요구사항 | 설계 문서 | 구현 task | 검증 계층 |
|---|---|---|---|
| NFR-001 답변 지연 | API §5, RAG §3 | API-003, RAG-005 | performance |
| NFR-002 수집 최신성 | DATA_PIPELINE §5.1 | QUE-001, PIPE-008, OPS-002 | integration, 운영 관측 |
| NFR-003 멱등성 | DATA_PIPELINE §5.3, DATABASE §6 | DB-002, PIPE-001, PIPE-003 | integration |
| NFR-004 검색 품질 | RAG §5, §11, EVAL_GOLDEN_SET | RAG-002, RAG-003, EXP-002, EVAL-002 | RAG evaluation |
| NFR-005 인용 정확성 | RAG §6, §6.1, EVAL_GOLDEN_SET | RAG-005, EVAL-002 | RAG evaluation |
| NFR-006 가용성 | ARCHITECTURE §5 | FND-004, OPS-001 | integration, 문서화된 수동 절차 |
| NFR-007 관측성 | ARCHITECTURE §9 | OBS-001, OPS-002 | unit(redaction), 운영 관측 |
| NFR-008 보안 | SECURITY 전체 | FND-005, COL-001, SEC-001, SEC-002, SEC-003 | security |

## 3. 위협

| 위협 | 구현 task | 검증 |
|---|---|---|
| THR-001 SSRF | COL-001, SEC-002 | SSRF corpus integration test |
| THR-002 악성 HTML·browser escape | COL-005, SEC-002 | Playwright security test, canary |
| THR-003 prompt injection | SEC-003, RAG-005 | injection corpus, EVAL-002 |
| THR-004 허위 URL·citation | RAG-005 | generation contract test |
| THR-005 secret 유출 | FND-005, OBS-001 | secret scan, redaction unit test |
| THR-006 비용·DoS | SEC-001 | load/abuse test |
| THR-007 입력 공격 | CON-001, DB-005 | SAST, integration fuzz |
| THR-008 운영 endpoint 오용 | API-004 | authz test |
| THR-009 공급망 | FND-003, FND-006, OPS-001 | dependency/container scan |
| THR-010 과도한 보존 | DISC-001, OPS-003 | retention dry-run, audit |
| THR-011 job 변조·중복 | QUE-001, PIPE-001 | duplicate/tamper integration test |
| THR-012 공급자 데이터 노출 | AI-002, EXP-003 | redaction test, provider review |

## 4. 열려 있는 추적 공백

현재 요구사항에 대응 task가 없는 항목은 없다. 아래는 task가 있으나 수치·정책이 미결정이어서 검증 기준이 확정되지 않은 항목이다.

| 항목 | 미결정 내용 | 해소 경로 |
|---|---|---|
| NFR-001 | 15초 목표의 최종 승인 | EXP-003 결과 후 SSOT 반영 |
| NFR-004, NFR-005 | threshold 확정 | EXP-002, EXP-003 |
| SEC-001 | rate limit 수치와 사용자 식별 방식 | 배포·비용 결정 |
| API-004 | ops interface를 HTTP/CLI 중 어디에 둘지 | SECURITY §12 미결정 |
| OPS-003 | 보존 기간 확정 | DATA_PIPELINE §9 승인 |

## 5. 열거하지 않는 task

아래 task는 특정 요구사항에 1:1로 대응하지 않는 기반 작업이며 다른 모든 항목의 전제다. 범위 표기 대신 개별 ID를 적어 누락을 기계적으로 확인할 수 있게 한다.

`DISC-001`, `DISC-002`, `DEC-001`, `DEC-002`, `DEC-003`, `DEC-004`, `DEC-005`, `DEC-006`, `DEC-007`, `DEC-008`, `EXP-001`, `EXP-005`, `FND-001`, `FND-002`, `FND-003`, `FND-004`, `FND-005`, `FND-006`, `CON-001`, `TST-001`, `TST-002`, `OBS-001`, `DB-001`, `DB-005`, `AI-001`, `EVAL-001`, `API-001`, `WEB-001`, `DOC-001`, `MVP-001`

기반 task는 요구사항 커버리지 계산에서 제외하지만, 삭제하면 위 표의 여러 행이 동시에 검증 불가가 된다.

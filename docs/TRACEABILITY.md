# Signal Archive Traceability Matrix

- 상태: Active
- 작성일: 2026-09-01
- 목적: 요구사항과 위협이 설계·task·테스트로 이어지는지 한 화면에서 확인한다

이 문서는 새 요구사항을 만들지 않는다. [PRD.md](./PRD.md), [SECURITY.md](./SECURITY.md), [TASKS.md](../TASKS.md), [TESTING.md](./TESTING.md)의 기존 항목을 연결한다. 요구사항·task를 추가하거나 삭제하면 같은 변경에서 이 표를 갱신한다.

## 1. 기능 요구사항

리서치 도구 디자인(PRD §2) → WEB-005 → `apps/web/e2e/dashboard.spec.ts`: 상단 경로 이동,
예시 선택, 수집 현황 응답/오류 구분, 모바일 overflow, 기존 질문/답변·출처 확인.

질문 중심 진입 흐름(2026-09-11): PRD §2 → WEB-004 → `apps/web/e2e/dashboard.spec.ts`의
홈/예시 선택/설정/탐색 URL·뒤로 가기/locale persistence/모바일 및 답변 검증.

| 요구사항 | 설계 문서 | 구현 task | 검증 계층 |
|---|---|---|---|
| FR-001 실제 외부 데이터 수집 | DATA_PIPELINE §2~4, SOURCE_CATALOG | COL-002, COL-003, COL-004, COL-006, COL-007, COL-008, COL-009, COL-010, QUE-001, PIPE-001 | fixture contract, integration, source별 live canary |
| FR-002 브라우저 수집 | DATA_PIPELINE §6 | COL-005 | fixture contract, canary, security |
| FR-003 원본 보존 | DATA_PIPELINE §5.3, DATABASE §3.1 | DB-002, PIPE-001 | integration |
| FR-004 정규화 | DATA_PIPELINE §5.4, §5.6, TOPIC_TAXONOMY | PIPE-002, PIPE-005, DB-003 | domain topic/chunk unit, database integration |
| FR-005 중복 제거 | DATA_PIPELINE §5.5 | PIPE-003, EXP-004, PIPE-004 | unit, integration, experiment |
| FR-006 임베딩 | DATA_PIPELINE §5.7 | AI-002, PIPE-005, PIPE-008 | chunk unit, component, integration |
| FR-007 자연어 질의 | RAG §4 | RAG-001 | component |
| FR-008 기간 검색 | RAG §4~5, DATABASE §4 | RAG-001, RAG-002, DB-006 | unit, integration, RAG eval |
| FR-009 근거 기반 답변 | RAG §6, §8 | RAG-004, RAG-005 | component, RAG eval |
| FR-010 비교 | RAG §7, DATA_PIPELINE §5.9 | DB-004, PIPE-006, RAG-006, WEB-003, COL-009, COL-010 | metric aggregation unit, component, E2E |
| FR-011 출처 표시 | API §2.1, RAG §5.3·§6.1 | API-003, WEB-002 | contract, E2E |
| FR-012 운영 가시성 | API §3, ARCHITECTURE §9 | PIPE-001, API-004, OPS-002 | contract, integration |
| FR-013 실패 복구 | DATA_PIPELINE §7 | QUE-001, PIPE-007 | integration |
| FR-014 최신성 표현 | API §2.1~2.2 | API-002, API-003, WEB-003 | contract, E2E |
| FR-015 기간 backfill·target 확장 | ADR-0015 A1/A2, COLLECTION_CONTRACTS §2~3 | COV-001, COV-002, COV-003, COV-004, DISC-003, COV-008, COV-009 | target/page contract, 실제 PG+Redis restart integration, 허용된 live canary |
| FR-016 목적·관측 집합 분리 | ADR-0015 A3, COLLECTION_CONTRACTS §4 | COV-002, COV-006, COV-008, COV-010, COV-011 | cohort invariance, 분모/partial contract, scoped exact counts, 실제 비교 평가 |
| FR-017 부족 원인·bounded 보완 | ADR-0015 A4, API §2.5, RAG §5.4 | COV-003, COV-006, COV-007, COV-008, COV-010, COV-011 | coverage fixtures, malicious fetch/deadline test, API/UI, RAG eval |
| FR-018 중복 과금·persistent budget | ADR-0015 A5, COLLECTION_CONTRACTS §5, ADR-0018 | COV-002, COV-005, COV-008, COV-009, EVAL-002 | concurrent reservation/work claim, unknown outcome·UTC/restart integration, 누적 평가 history/journal·call/token cap, usage 관측 |

## 2. 비기능 요구사항

| 요구사항 | 설계 문서 | 구현 task | 검증 계층 |
|---|---|---|---|
| NFR-001 답변 지연 | API §5, RAG §3 | API-003, RAG-005 | performance |
| NFR-002 수집 최신성 | DATA_PIPELINE §5.1 | QUE-001, PIPE-008, OPS-002 | integration, 운영 관측 |
| NFR-003 멱등성 | DATA_PIPELINE §5.3, DATABASE §6 | DB-002, PIPE-001, PIPE-003 | integration |
| NFR-004 검색 품질 | RAG §5, §11, EVAL_GOLDEN_SET | RAG-002, RAG-003, EXP-002, EVAL-002 | RAG evaluation |
| NFR-005 인용 정확성 | RAG §6, §6.1, EVAL_GOLDEN_SET | RAG-005, EVAL-002 | RAG evaluation |
| NFR-006 가용성 | ARCHITECTURE §5, ADR-0013 | FND-004, OPS-001, OPS-004 | Compose healthcheck, HTTPS healthcheck, rollback 절차 |
| NFR-007 관측성 | ARCHITECTURE §9 | OBS-001, OPS-002 | unit(redaction), 운영 관측 |
| NFR-008 보안 | SECURITY 전체 | FND-005, COL-001, SEC-001, SEC-002, SEC-003 | security |
| NFR-009 배포 무결성 | ADR-0013, SECURITY §6 | OPS-004 | SHA image, pinned SSH host key, approval gate, Caddy validate/reload, static/config validation |

ADR-0015의 NFR-003 멱등성은 COV-002/004/005의 page·delivery·model work 경계에서, NFR-004/005는 COV-006/007/010에서 추가 검증한다. API-003·SEC-001·OPS-002 등 기존 DONE은 TASKS §11의 baseline 범위이며 새 기능의 runtime 증거가 아니다.

## 3. 위협

| 위협 | 구현 task | 검증 |
|---|---|---|
| THR-001 SSRF | COL-001, SEC-002 | SSRF corpus integration test |
| THR-002 악성 HTML·browser escape | COL-005, SEC-002 | Playwright security test, canary |
| THR-003 prompt injection | SEC-003, RAG-005 | injection corpus, EVAL-002 |
| THR-004 허위 URL·citation | RAG-005 | generation contract test |
| THR-005 secret 유출 | FND-005, OBS-001 | secret scan, redaction unit test |
| THR-006 비용·DoS | SEC-001, COV-002, COV-005, COV-007, COV-008 | shared reservation·unknown outcome·HTTP/token/deadline cap·실제 runtime usage |
| THR-007 입력 공격 | CON-001, DB-005 | SAST, integration fuzz |
| THR-008 운영 endpoint 오용 | API-004 | authz test |
| THR-009 공급망 | FND-003, FND-006, OPS-001 | dependency/container scan |
| THR-010 과도한 보존 | DISC-001, OPS-003 | retention dry-run, audit |
| THR-011 job 변조·중복 | QUE-001, PIPE-001, COV-001, COV-002, COV-004, COV-008 | ID-only version 2, stale fencing, page/outbox transaction, Redis 유실·재시작 복구 |
| THR-012 공급자 데이터 노출 | AI-002, EXP-003 | redaction test, provider review |

## 4. 열려 있는 추적 공백

현재 요구사항에 대응 task가 없는 항목은 없다. 아래는 task가 있으나 수치·정책이 미결정이어서 검증 기준이 확정되지 않은 항목이다.

| 항목 | 미결정 내용 | 해소 경로 |
|---|---|---|
| NFR-001 | 15초 목표의 최종 승인 | EXP-003 결과 후 SSOT 반영 |
| NFR-004, NFR-005 | ADR-0018에서 threshold 확정; 실제 통과 여부 미측정 | EXP-002, COV-010, EVAL-002 |
| SEC-001 | rate limit 수치와 사용자 식별 방식 | 배포·비용 결정 |
| API-004/COV-001 | 기존 보호 ops 확장 route/CLI manifest와 audit | COV-001 계약, COV-008 runtime 검증 |
| OPS-003 | 승인 retention과 acquisition/cohort purge 관계 | ADR-0016 Accepted; RUNBOOK §12.1 dry-run/audit |
| 신규 target 권리·운영 scope | GitHub Releases 5개 target, cadence/API/byte/token/USD 2 cap | DISC-003 → DEC-012 완료; ADR-0016 |
| 확장 corpus 성능·품질 | 실제 baseline/expanded 기준과 threshold | COV-009 → DEC-013 → COV-010; EVAL-002 유지 |

PIPE-007 is implemented by the versioned replay contract/service, bounded failure classification, disabled-source guard, and redacted audit boundary in `packages/domain/src/replay.ts` and `apps/worker/src/replay.ts`.

## 5. 열거하지 않는 task

아래 task는 특정 요구사항에 1:1로 대응하지 않는 기반 작업이며 다른 모든 항목의 전제다. 범위 표기 대신 개별 ID를 적어 누락을 기계적으로 확인할 수 있게 한다.

`DISC-001`, `DISC-002`, `DEC-001`, `DEC-002`, `DEC-003`, `DEC-004`, `DEC-005`, `DEC-006`, `DEC-007`, `DEC-008`, `EXP-001`, `EXP-005`, `FND-001`, `FND-002`, `FND-003`, `FND-004`, `FND-005`, `FND-006`, `CON-001`, `TST-001`, `TST-002`, `OBS-001`, `DB-001`, `DB-005`, `AI-001`, `EVAL-001`, `API-001`, `WEB-001`, `DOC-001`, `MVP-001`

ADR-0015 결정·운영 gate: `DEC-011`(A1–A6 승인), `DEC-012`(target/운영/예산), `DEC-013`(품질·성능), `DISC-003`(권리/capability 조사). COV-001~010은 FR-015~018 표에서 개별 추적한다. DB-001/PIPE-008/RAG-001/RAG-002/EXP-002/API-003/SEC-001/SEC-003/WEB-003/OPS-002/MVP-001의 dependency·acceptance 재정의는 TASKS §11~12 및 위 기존 FR/NFR 연결을 유지한다.

기반 task는 요구사항 커버리지 계산에서 제외하지만, 삭제하면 위 표의 여러 행이 동시에 검증 불가가 된다.

## 6. COV-007 evidence

`packages/rag/src/acquisition.ts` and the answer/live-search integration satisfy FR-017's bounded acquisition contract. Focused verification: `pnpm --filter @techpulse/rag exec vitest run test/acquisition.test.ts test/answer-service.test.ts test/live-search.test.ts test/prompt-injection.test.ts` passed 4 files/48 tests after the compatibility fix; package typecheck passed. COV-008, DEC-007, DEC-012, AI-002, RAG-001 and the bounded COV-009 live corpus are complete.

## 7. RAG-001 evidence

`packages/rag/src/query-parser.ts` satisfies FR-007 and FR-008 with deterministic parsing of the four supported intents, canonical taxonomy entities and original aliases, explicit-over-natural UTC ranges, IANA timezone validation, language detection and structured ambiguous aliases. `createAnswerService` consumes the parsed range and entities for retrieval and coverage. Focused parser and answer-service verification passed 2 files/28 tests without network or model calls.

## 8. RAG-002 evidence

The RAG retrieval path applies identical status, time, topic and fail-closed rights filters to lexical and approved-profile vector candidates. Vector SQL additionally requires matching profile/input hashes and complete current-revision chunk coverage. Connected PostgreSQL+pgvector verification used a uniquely named isolated database and passed FTS/vector provenance, readiness, denied-rights, tombstone and wrong-profile cases (3 tests); deterministic SQL contracts passed 5 tests. No source or model API was called.

## 9. COV-009 evidence

The connected PostgreSQL+pgvector and Redis run completed five independent 90-day GitHub Releases backfills and five incrementals with no on-demand partition. All 10 partitions completed without partial/failed state; `pgvector/pgvector` retained zero releases in the window and is recorded as a coverage gap. The other targets produced 28 immutable revisions, 500 chunks and 500 matching approved-profile embeddings, with zero pending deliveries and zero unknown reservations. Source usage was 11 requests/1,274,586 bytes and provider usage was 188,073 tokens/USD 0.000912. The fixed dataset hash and sanitized measurement are in [`experiments/cov-009/live-measurement.json`](./experiments/cov-009/live-measurement.json). DEC-013 is accepted; EXP-002 and COV-010 apply its fixed thresholds.

## 10. EXP-002 evidence

2026-09-10 task split: coverage repository의 전역 raw/lexical/vector count가 target별 partition 분모와 일치하지 않는 결함은 **COV-011**(dependency COV-006)로 분리했다. COV-010은 EVAL-002와 COV-011에 의존하며 여전히 BLOCKED다. 이 분리는 scoped count/profile/rights 정확성의 독립 구현·fixture 검증만 허용하고, DEC-013의 고정 corpus·threshold·누적 예산·사람 검토나 최종 acceptance를 완화하지 않는다.

DEC-013 is accepted. The fixed COV-009 corpus was measured with 39 answerable queries against FTS-only, exact-vector-only and chunk-level RRF variants. The hybrid result failed the approved quality/latency gate (Recall@10 0.6936, nDCG@10 0.4823, DB p95 1,086ms) while time/provenance violations remained zero. Query embedding used 39 calls, 1,258 tokens and USD 0.000006. The result and ranked IDs are in [`experiments/exp-002/live-measurement.json`](./experiments/exp-002/live-measurement.json); RAG-003 owns the required fusion/diversity improvement and thresholds remain unchanged.

RAG-003 now applies production RRF to 30 lexical and 30 exact-vector candidates with bounded recency and revision, duplicate-cluster and source diversity caps. The shared-result ordering and caps are covered by deterministic regression tests; the full RAG suite passes 72 tests. The approved DEC-013 thresholds remain unchanged and the expanded-corpus release decision remains owned by EVAL-002/COV-010.

## 9. PIPE-008 evidence

Embedding work reuse, partial-batch isolation, unknown-outcome holds, provider metadata model/dimension rejection and worker profile gates pass deterministic tests. The connected Redis suite passed 4/4 using unique queue/key prefixes, including v2 deduplication, stale v1 rejection, concurrency and crash lease recovery. Connected PostgreSQL+pgvector proves lexical/vector readiness separation.

The approved OpenRouter Perplexity live canary returned a 1024-dimensional finite, nonzero vector with provider usage. OpenRouter's shortened response model is mapped to the configured model only through an explicit alias allowlist; any other response model fails closed. Evidence paths are `packages/domain/src/ai.ts`, `packages/domain/src/embedding-service.ts`, `apps/worker/src/embedding.ts`, and `tooling/live-model-canary.ts`.

ADR-0017's RunInfra Nemotron binding passed a minimal live JSON canary with provider-reported usage. This proves connectivity and structured response handling; the production-corpus quality and security gates remain separate.

## 11. EVAL-002 offline hardening and unresolved gates (2026-09-10)

`apps/api/src/release-budget.ts`와 `release-evaluation*.ts`는 strict no-retry/fallback 실행, 누적 history/journal, abort/deadline/output cap, 정확한 corpus membership, 43개 draft applicability/분모를 검증한다. [실행 범위와 미완료 항목](./experiments/eval-002/README.md), [과거 사용량 primary references](./experiments/eval-002/historical-usage-audit.json)를 추적한다. 최소 195 embedding calls는 승인 100회를 초과했으며 추가 유료 실행은 명시적 신규/변경 승인 전 차단한다. 정확한 총량·chat·비용 unknown과 사람 검토 대기를 유지한다.

COV-011의 target/profile count 수정 검증은 EVAL-002 live 품질 gate를 대체하지 않는다. EVAL-002는 offline 구현을 위한 READY이며 COV-010과 MVP-001은 BLOCKED다. 기존 43개 회귀 실행 및 보안·의미적 검토를 미실행 상태에서 통과로 표시하지 않는다.

## 12. COV-011 completion evidence (2026-09-10)

FR-016/FR-017의 scoped count 결함을 COV-011로 완료했다. canonical target/topic/scope, disabled/미검토 source, target/raw 권리, publication time, approved vector profile/input hash, on-demand 및 반복 membership, 정확한 window/topic/evidence의 labeled miss를 고유 격리 PostgreSQL 검색/coverage 9 tests로 검증했다. 최종 root static(typecheck 10/10, ESLint, Prettier)와 관련 API 41/domain 28/RAG 89 tests가 통과했다. [검증 요약](./experiments/eval-002/offline-validation-2026-09-10.json)은 실제 명령 결과의 기록이며 새로운 live 품질 측정이 아니다. COV-010은 COV-011 의존성이 해소됐어도 EVAL-002와 실제 acceptance 때문에 BLOCKED다.

## 13. Portfolio MVP evaluation scope reduction (2026-09-11)

ADR-0019가 ADR-0018의 포트폴리오 MVP blocking 범위만 축소한다. EVAL-002의 유료 live gate는 4개 answered target 대표 질문(`L-001`, `L-007`, `L-014`, `L-017`)과 4개 coverage-negative 질문(`L-040`, `L-041`, `L-044`, `L-045`)으로 제한한다. 검색 정확도, citation/unsupported claim, correct abstention, cost/latency를 live blocking으로 측정한다. 기존 43개 golden set과 45개 live label은 삭제하지 않고 diagnostic regression 자산으로 유지하며, prompt-injection/time/rights/profile/provenance는 기존 deterministic SEC-003/RAG/API 테스트가 blocking 증거를 제공한다.

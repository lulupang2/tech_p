# ADR-0019: Portfolio MVP evaluation scope

- 상태: Accepted
- 작성일: 2026-09-11
- 결정: EVAL-002의 MVP blocking live gate를 43개 전체 회귀가 아니라 8개 대표 live 문항과 기존 deterministic 보안 회귀로 축소한다.
- 승인일 / 승인 주체: 2026-09-11 / 사용자
- 대체 관계: ADR-0018의 "43개 regression도 모두 release blocking" 요구를 포트폴리오 MVP에 한해 대체한다. ADR-0018의 corpus/model/budget/rights/provenance 제한은 유지한다.

## Context

기존 EVAL-002는 실서비스 release review 수준으로 설계되어 43개 golden regression, 45개 live label, retrieval variant, semantic review, security invariant를 모두 하나의 완료 조건처럼 다뤘다. 포트폴리오 MVP에서는 이 규모가 구현 설명 대비 비용과 검토 부담을 과도하게 만든다.

## Decision

MVP의 유료 live gate는 다음 4축만 blocking으로 본다.

1. 검색 정확도: 실제 release가 있는 4개 target에서 대표 질문 1개씩, 총 4개(`L-001`, `L-007`, `L-014`, `L-017`). Hybrid Recall@10 `>= 0.80`.
2. 답변 근거성: 위 4개 answered 질문의 citation/claim을 사람이 확인한다. Citation precision `>= 0.95`, unsupported claim rate `<= 0.05`.
3. 올바른 근거 부족 처리: coverage-negative 4개(`L-040`, `L-041`, `L-044`, `L-045`)에서 `insufficient_evidence` 정확도 `>= 0.90`.
4. 비용/응답시간: DB warm p95 `<= 500 ms`, 정상 provider 응답 시 answer p95 `<= 15 s`, 승인된 추가 평가 allowance 안에서만 실행한다.

총 live answer 표본은 8개다. 43개 golden set과 45개 live label 원본은 삭제하거나 라벨을 바꾸지 않고 regression/진단 자산으로 보존하지만 MVP 완료를 막지 않는다. prompt injection, citation allowlist, time/rights/profile/provenance 등 hard invariant는 기존 deterministic SEC-003/RAG/API 테스트로 계속 blocking한다. 이를 유료 43개 LLM 실행으로 중복 검증하지 않는다.

nDCG, entity/semantic subset 비교, duplicate redundancy 등은 report에 남길 수 있으나 MVP blocking threshold에서는 제외한다. 향후 production release gate가 필요하면 43개 전체 회귀를 별도 CI/manual suite로 다시 승격할 수 있다.

## Consequences

- EVAL-002는 8개 live 질문 + deterministic hard invariants + 최소 semantic review를 통과하면 포트폴리오 MVP 관점에서 완료 가능하다.
- COV-010은 이 축소된 결과와 필수 사용자 예시/coverage/cost 보고서로 최종 acceptance를 판단한다.
- 기존 corpus, provider, model, 권리, 추가 지출 승인 범위는 넓어지지 않는다.
- 과거 사용량을 초기화하거나 추가 allowance를 자동 부여하지 않는다.
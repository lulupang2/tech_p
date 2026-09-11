# ADR-0020: Additional one-time evaluation allowance

- 상태: Accepted
- 작성일: 2026-09-11
- 결정: 과거 DEC-013 평가 사용량을 초기화하거나 정산 완료로 간주하지 않고, EVAL-002에 별도 추적되는 추가 1회 allowance를 연다.
- 승인일 / 승인 주체: 2026-09-11 / 사용자
- 결정 ID: DEC-014
- 대체 관계: ADR-0018의 기존 총량을 수정하지 않는다. 소진된 과거 tranche와 별개인 추가 tranche를 승인한다.

## Context

과거 평가에서 최소 195회의 성공한 query embedding 호출이 확인돼 DEC-013의 100회 한도를 이미 초과했다. 정확한 과거 총 호출·chat·비용은 여전히 미정산이다. 사용자는 2026-09-11 00:49:46+09:00에 기존 사용량을 보존하면서 추가 평가 allowance를 별도로 추적하는 조건을 확정했다.

## Decision

DEC-014 추가 tranche의 hard cap은 다음과 같다.

- 전체 provider 비용: USD 0.25
- query embedding: 100 calls / input 100,000 tokens
- chat: 60 calls / input 300,000 tokens / output 30,000 tokens
- concurrency 1
- automatic retry 0
- automatic fallback 0

`prior-usage.json`은 그대로 유지하고 `reconciled=false`를 바꾸지 않는다. 추가 tranche는 `dec-014-allowance.json`에 과거 history digest를 고정하고 `dec-014-ledger.jsonl`에 append-only로 사용량을 기록한다. 과거 사용량은 새 tranche의 0점으로 재해석하지 않으며, 새 ledger의 사용량만 DEC-014 cap에 대조한다.

승인 범위는 ADR-0019의 8문항 포트폴리오 MVP 평가에 한정한다. corpus 재임베딩, 추가 source/target, 운영 배포, 월간 반복 지출은 승인하지 않는다.

## Consequences

- 정확한 과거 정산이 끝나지 않아도 명시적으로 승인된 추가 tranche 안에서는 EVAL-002 live 평가를 실행할 수 있다.
- 새 tranche의 reservation/settlement/unknown outcome은 기존 fail-closed 규칙을 그대로 적용한다.
- Nemotron의 per-call output safety cap은 총 DEC-014 output 30,000-token hard cap 안에서 700 tokens로 둔다. 이는 승인 총량을 늘리는 것이 아니라 350-token truncation으로 citation이 유실되는 것을 방지하기 위한 실행 상한이다.
- allowance manifest 또는 과거 history digest가 바뀌면 ledger admission이 실패한다.
- 과거 위반이나 unknown 사용량은 삭제·환불·정상화되지 않는다.

## Validation

- allowance manifest가 DEC-014의 정확한 cap과 fixed corpus digest를 검증한다.
- allowance가 현재 `prior-usage.json`의 exact digest에 묶여 있는지 검증한다.
- 새 ledger는 history digest와 allowance digest를 모두 요구한다.
- 기존 DEC-013 경로는 여전히 과거 overrun/unreconciled history에서 fail closed한다.
- DEC-014 경로는 과거 195+ 사용량을 audit 필드로 보존하면서 별도 tranche만 0부터 계산한다.

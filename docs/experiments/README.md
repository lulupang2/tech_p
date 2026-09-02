# Signal Archive Experiments

실험은 미결정 선택을 줄이기 위한 재현 가능한 기록이다. 실험 결과는 ADR의 근거가 되지만 ADR을 자동 승인하지 않는다.

## 상태 정의

- `Planned`: 실행 전
- `Running`: 환경·데이터·시작 시각이 기록되고 실행 중
- `Completed`: 결과와 raw artifact 위치가 기록됨
- `Invalid`: 방법 또는 데이터 문제로 결론에 사용할 수 없음

## Index

| Experiment | 질문 | 상태 | 연결 결정 |
|---|---|---|---|
| [EXP-001](./EXP-001-source-feasibility.md) | 어떤 실제 소스를 안전하고 안정적으로 수집할 수 있는가? | **Completed** (2026-09-01) | ADR-0004 |
| [EXP-002](./EXP-002-retrieval.md) | time-aware hybrid retrieval이 기준을 충족하는가? | Planned | ADR-0002, vector index 결정 |
| [EXP-003](./EXP-003-model-providers.md) | 어떤 chat/embedding provider가 품질·비용 조건을 충족하는가? | Planned | ADR-0006 |
| [EXP-004](./EXP-004-deduplication.md) | near-duplicate를 어떤 방식과 threshold로 묶을 것인가? | **Completed** (2026-09-02) | pipeline algorithm 결정 |
| [EXP-005](./EXP-005-foundation-spike.md) | 추천 backend/queue/workspace 조합이 최소 흐름을 단순하게 지원하는가? | **Completed** (2026-09-01) | ADR-0001, 0003, 0007 |

## 공통 기록 규칙

새 실험은 [TEMPLATE.md](./TEMPLATE.md)를 복사해 시작한다. 각 실행은 다음을 기록한다.

- 실행 ID, 날짜, git commit, 실행자
- dataset/fixture version과 취득·사용 권리
- 환경, dependency/model/provider version
- 사전 정의된 hypothesis와 success/failure gate
- raw measurements와 계산 script 위치
- 비용과 예상치 못한 오류
- 결론, 한계, 다음 행동

결과를 본 뒤 gate를 바꾸지 않는다. gate 변경이 필요하면 기존 실행을 보존하고 새 run으로 기록한다. secret, 전체 허가받지 않은 원문, 개인정보는 artifact에 넣지 않는다.

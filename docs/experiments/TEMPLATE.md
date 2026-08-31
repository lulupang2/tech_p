# EXP-NNN: 제목

- 상태: Planned
- 연결 ADR / 문서:
- 실행 승인: (필요한 경우 승인 주체와 일자)

## 질문

이 실험이 답하려는 단일 질문.

## Hypotheses

결과를 보기 전에 적는다. 실행 후 수정하지 않는다.

## Dataset

- 데이터·fixture version과 취득 경로
- 사용 권리 검토 상태
- 크기와 구성(언어, 기간, source 분포)

## Variants

비교할 구성을 사전에 고정한다. 실행 중 추가한 variant는 별도 run으로 기록한다.

## Metrics

측정 지표와 계산 방법. 사람이 판단하는 항목은 판단 기준을 함께 적는다.

## Proposed gate

통과·실패 조건을 수치로 적는다. 결과를 본 뒤 gate를 바꾸지 않는다. 변경이 필요하면 기존 run을 보존하고 새 run으로 기록한다.

## Procedure

재현 가능한 순서. 고정한 seed, model version, snapshot을 포함한다.

## 출력

- 재현 명령과 환경
- raw measurement 위치
- 결과 표
- recommendation과 한계

## 중단 조건

정책 위반, 과다 비용, 개인정보 노출 위험이 확인되면 즉시 중단한다.

## 실행 기록

실행 후 아래를 채운다. 비어 있으면 `Completed`로 표시하지 않는다.

| 항목 | 값 |
|---|---|
| 실행 ID | |
| 실행일 | |
| git commit | |
| 실행자 | |
| 환경 / dependency version | |
| model / provider version | |
| 비용 | |
| raw artifact 위치 | |
| 결론 | |
| 다음 행동 | |

secret, 허가받지 않은 원문 전체, 개인정보는 artifact에 넣지 않는다. 결과만으로 ADR을 자동 승인하지 않는다.

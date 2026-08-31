# EXP-003: Chat and embedding provider evaluation

- 상태: Planned
- 연결 ADR: [ADR-0006](../adr/0006-model-providers.md)

## 질문

어떤 chat model과 embedding model이 TechPulse의 한국어·영어 질의, structured output, citation-grounded answer를 예측 가능한 비용과 정책으로 제공하는가?

## 후보 선정 규칙

- chat 최소 2개 후보, embedding 최소 2개 후보
- TypeScript SDK 또는 안정적 HTTP API
- model ID/version을 고정·기록할 수 있음
- 데이터 보존·학습 사용·지역·삭제 조건을 검토할 수 있음
- 예산 안에서 같은 dataset 전체를 평가 가능

실제 provider/model명은 실행 시점의 공식 문서와 가격을 확인해 기록한다.

## Chat tasks

- intent/time/entity structured parsing
- evidence-only 한국어·영어 답변
- insufficient evidence abstention
- 숫자·기간·citation ID 보존
- malicious evidence instruction 무시

## Embedding tasks

- [EXP-002](./EXP-002-retrieval.md)의 동일 골든 corpus에서 Recall@10/nDCG@10. 질문 세트는 [EVAL_GOLDEN_SET.md](../EVAL_GOLDEN_SET.md)를 사용한다
- 영어 기술명 + 한국어 질문 cross-lingual subset
- dimensions별 storage/index 비용과 latency

## Metrics

| 영역 | 지표 |
|---|---|
| 품질 | schema success, intent accuracy, citation precision/coverage, unsupported claims, retrieval metrics |
| 성능 | p50/p95 latency, timeout/rate-limit rate |
| 비용 | 1K documents embedding, 1K answers, 월간 MVP scenario |
| 운영 | SDK 안정성, model pin/deprecation, quota, observability |
| 보안 | provider retention, training use, region, abuse logging, secret handling |

## Proposed gate

- structured output success ≥ 99% (bounded 1 retry 포함)
- citation precision ≥ 0.95, unsupported claim rate ≤ 0.05
- embedding Recall@10 ≥ 0.80 또는 최고 후보와 합의된 trade-off
- answer p95가 전체 15초 budget 안에 들어옴
- 월간 비용 상한과 데이터 처리 조건을 충족

## Procedure

1. prompt, temperature, token budget, retry를 후보 간 가능한 한 동일하게 고정한다.
2. 순서 효과를 줄이기 위해 골든셋 실행 순서를 섞는다.
3. 자동 지표와 blind human review를 함께 사용한다.
4. 오류를 parsing, grounding, language, citation, refusal, latency로 분류한다.
5. 실제 사용량과 환율 기준일을 비용표에 기록한다.

## 출력

- 익명화된 candidate scorecard
- raw response hash와 sanitized evaluation artifact
- chat 1개, embedding 1개의 recommendation
- fallback 정책 또는 fallback 없음 recommendation
- 재임베딩 비용과 migration 계획

## 비용·보안 제한

사전 승인한 지출 한도에서만 실행한다. 실제 사용자 질문, secret, 허용되지 않은 원문을 provider에 보내지 않는다.

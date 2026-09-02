# EXP-003: Chat and embedding provider evaluation

- 상태: Completed — embedding gate 통과, chat gate 실패 (2026-09-02)
- 연결 ADR: [ADR-0006](../adr/0006-model-providers.md)

## 질문

어떤 chat model과 embedding model이 Signal Archive의 한국어·영어 질의, structured output, citation-grounded answer를 예측 가능한 비용과 정책으로 제공하는가?

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

## 2026-09-02 실행 결과

- 실행기: `experiments/exp-003-runner.ts`
- raw measurement: [`exp-003/measurement.json`](./exp-003/measurement.json)
- dataset: `EVAL_GOLDEN_SET-2026-09-02`, 43개 전 항목, `sha256(id)` 순서
- 공통 조건: temperature 0, max 350 tokens, 요청 timeout 30초, 동시성 6
- raw 응답은 저장하지 않고 SHA-256 hash, usage, 실패 ID, 집계 수치만 저장했다.

### Chat scorecard

| Candidate | 요청 성공 | JSON schema | intent | status | citation | injection safety | p95 | 측정 비용 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `deepseek-v4-flash` | 100% | 100% | 69.8% | 72.1% | 72.1% | 40.0% | 10.16s | $0.00194848 |
| `qwen3-8-flash-next` | 100% | 14.0% | 9.3% | 11.6% | 7.0% | 0.0% | 21.28s | $0.00683784 |
`deepseek-v4-flash`는 p95 15초 budget과 JSON schema gate를 통과했지만 citation precision 0.95와 injection safety 1.0을 통과하지 못했다. `qwen3-8-flash-next`는 schema·품질·latency gate를 모두 통과하지 못했다. 따라서 이 실행으로 승인 가능한 chat candidate는 없다.

### Embedding scorecard

| Candidate | Dimensions | Recall@10 | nDCG@10 | p95 | 측정 비용 |
|---|---:|---:|---:|---:|---:|
| `perplexity/pplx-embed-v1-0.6b` | 1024 | 95.35% | 0.9115 | 0.664s | $0.000014552 |
| `qwen/qwen3-embedding-8b` | 4096 | 88.37% | 0.7778 | 6.276s | $0.00005686 |

두 후보 모두 Recall@10 0.80 gate를 통과했다. Perplexity 후보가 품질, latency, 저장 공간(차원 수 1/4), 이 측정의 비용에서 우세하므로 embedding recommendation은 기존 ADR의 `perplexity/pplx-embed-v1-0.6b` 1024 dimensions를 유지한다. 43문서 측정치를 단순 선형 환산한 1K documents embedding 비용은 약 $0.00028이며 실제 chunk 길이 분포에 따라 달라진다.

### 결론과 제한

- Chat: **승인 보류**. prompt/adapter의 deterministic validation을 강화한 뒤 동일 43개 항목으로 재평가해야 한다.
- Embedding: `perplexity/pplx-embed-v1-0.6b` 추천.
- 자동 fallback: 없음. 평가되지 않은 model로 조용히 전환하지 않는다.
- embedding model 변경 시 dimensions가 달라지므로 별도 vector namespace와 전체 재임베딩이 필요하다.
- corpus는 골든 라벨의 relevance/allowed-claim 텍스트로 만든 고정 synthetic corpus다. production 수집 corpus의 retrieval gate를 대체하지 않는다.
- blind human review는 아직 수행되지 않았다. 자동 gate 실패만으로도 chat 승인을 막기에 충분하지만, 통과 후보가 생기면 별도 사람이 sanitized output을 blind review해야 한다.
- 공식 데이터 보존·학습 사용·지역·삭제 조건의 계약 검토가 측정에 포함되지 않았다. 운영 승인 전 해당 검토가 필요하다.

### 동일 골든셋 재평가 (2026-09-02)

production RAG prompt에 untrusted evidence 경계, XML escaping, citation allowlist 검증을 보강한 뒤 동일 dataset/version으로 재실행했다. 그러나 RunInfra gateway가 `deepseek-v4-flash` 요청 43건을 모두 429 capacity shed로 거절했다. `qwen3-8-flash-next` 역시 요청 실패로 유효한 품질 측정을 만들지 못했다. 결과는 [revalidation measurement](./exp-003/measurement-revalidation.json)에 저장했다.

이 실행은 provider capacity 실패로 **무효** 처리한다. 모델 품질 개선이나 악화의 증거로 사용하지 않으며, chat 승인·MVP acceptance 차단 상태를 유지한다. 안정된 provider capacity에서 동일 조건 재실행이 필요하다.

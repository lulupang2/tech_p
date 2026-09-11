# EXP-002: Time-aware hybrid retrieval

- 상태: Completed — DEC-013 gate 미달, RAG-003 개선 필요 (2026-09-10)
- 연결 문서: [RAG.md](../RAG.md), [DATABASE.md](../DATABASE.md)

## 질문

PostgreSQL full-text search와 pgvector를 결합한 retrieval이 기간 위반 없이 사용자 질문에 필요한 근거를 찾는가? 데이터가 커질 때 어떤 vector index가 필요한가?

## Hypotheses

- hybrid retrieval은 vector-only와 FTS-only보다 Recall@10과 entity exact match를 함께 개선한다.
- metadata time filter를 강제하면 오래된 고유사도 문서의 침투를 막을 수 있다.
- MVP 규모에서는 exact vector search가 latency 목표를 충족하며 가장 안정적인 baseline이다.
- HNSW가 필요해지더라도 filtered recall을 측정하지 않으면 결과 수가 부족해질 수 있다.

## Dataset

- 정책 승인된 source에서 만든 최소 500 document/chunk 권장
- 중복 cluster, 여러 날짜, 공식/커뮤니티 source, 한국어/영어를 포함
- 최소 30개 골든 질문과 사람이 표시한 relevant document/chunk. 질문 목록은 [EVAL_GOLDEN_SET.md](../EVAL_GOLDEN_SET.md)의 38개 질문을 사용한다
- 사용자 예시 4개와 기간 경계·데이터 없음·상충 source 포함

## Variants

1. FTS only
2. vector exact only
3. FTS + vector exact + RRF
4. variant 3 + recency boost/source diversity
5. 충분한 row를 synthetic/approved data로 만든 경우 HNSW
6. 필요 시 IVFFlat은 비교군으로만 평가

후보 수, RRF constant, recency half-life, source cap을 사전 표로 고정한다.

## Metrics

- Recall@5/10, MRR, nDCG@10
- time-filter violation rate
- duplicate redundancy@10
- source diversity@10
- p50/p95 DB latency와 query plan
- index size/build time/write overhead

## Proposed gate

- Recall@10 ≥ 0.80
- time-filter violation = 0
- hybrid가 단일 방식보다 nDCG@10을 유의미하게 개선하거나 최소한 entity subset과 semantic subset 모두에서 열화하지 않음
- serving query p95 ≤ 500ms인 가장 단순한 방식 선택
- approximate index는 exact 대비 Recall@10 감소가 합의 범위 이내일 때만 채택

최종 threshold는 결과 검토 후 승인하며 SSOT에 자동 반영하지 않는다.

## Procedure

1. embedding/model과 DB snapshot을 고정한다.
2. variant별로 cold/warm run을 여러 차례 수행한다.
3. 결과 ID와 점수를 저장해 오류 유형을 수동 분류한다.
4. 한국어, exact entity, broad topic, comparison subset을 따로 분석한다.
5. query plan과 filtered candidate count를 기록한다.

## 출력

- 재현 명령과 환경
- query별 ranked result artifact
- 품질·latency·index 비용 표
- 선택할 retrieval config recommendation
- HNSW/IVFFlat/외부 검색 엔진 ADR 필요 여부

## 2026-09-10 live corpus 실행 결과

- 실행기: `experiments/exp-002-runner.ts`
- raw measurement: [`exp-002/live-measurement.json`](./exp-002/live-measurement.json)
- dataset: `cov009-20260910-live-v1`, 28 revisions/500 chunks, SHA-256
  `0cb1435f0629039f5189008ac189013c85d8766e8d7507328409355eb80f655f`
- 질문: [`cov-009/live-eval-set.proposed.json`](./cov-009/live-eval-set.proposed.json)의 answerable 39개
- query embedding: 39 calls, 1,258 tokens, USD 0.000006, p95 430ms. Chat 호출은 없었다.

| Variant | Recall@10 | nDCG@10 | MRR | DB p95 |
|---|---:|---:|---:|---:|
| FTS only | 0.4051 | 0.3287 | 0.3406 | 886ms |
| exact vector only | 0.6628 | 0.4823 | 0.4544 | 181ms |
| FTS + exact vector chunk-level RRF | 0.6936 | 0.4823 | 0.4330 | 1,086ms |

Hybrid는 Recall@10 0.80, nDCG@10 0.75, entity subset Recall@10 0.75, DB p95 500ms gate를
통과하지 못했다. time-filter/provenance violation과 revision 중복 redundancy는 0이었다. 긴 release
revision의 여러 chunk가 각 검색 목록 상위를 점유하고, 자연어 FTS fallback이 원격 DB에 여러 순차 query를
발행한 것이 주요 원인이다.

추천은 exact pgvector를 유지하면서 RAG-003에서 RRF를 실제 runtime에 구현하고, revision/duplicate
cluster/source cap을 fusion 전에 적용하며, deterministic entity/time filter를 검색 SQL에 내리는 것이다.
FTS fallback은 한 번의 bounded query로 줄인다. 500 chunks에서는 HNSW/IVFFlat이나 외부 검색 엔진을
도입하지 않는다. 기준을 낮추지 않으며 개선 뒤 동일 dataset/labels로 재측정한다.

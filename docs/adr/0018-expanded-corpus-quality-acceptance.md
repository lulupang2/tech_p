# ADR-0018: Expanded corpus quality and performance acceptance

- 상태: Accepted
- 작성일: 2026-09-10
- 결정: 기존 43개 회귀 gate와 COV-009 live 평가를 분리하고 아래 품질·성능 기준과 USD 0.25 일회성 평가 한도를 적용
- 승인일 / 승인 주체: 2026-09-10 / 사용자
- 대체 관계: 없음

## Context

`COV-009`는 [ADR-0016](./0016-low-cost-live-activation.md)이 승인한 GitHub Releases 5개 target의
90일 corpus를 만들었다. 고정 측정값은 raw revision 28개, chunk/embedding 500개이며
`pgvector/pgvector`는 해당 기간 retained release가 0개인 coverage gap이다.
dataset SHA-256 `0cb1435f0629039f5189008ac189013c85d8766e8d7507328409355eb80f655f`다.
Perplexity embedding 188,073 tokens의 실측 비용은 USD 0.000912였으며 source와 provider budget을
충족했다.

이제 `EXP-002`, `COV-010`, `EVAL-002`가 사용할 dataset, 질문 적용 범위, 품질·성능·비용 합격선을
결정해야 한다. 기존 43개 골든셋은 GitHub Releases 외의 커뮤니티·논문·metric source도 요구하므로,
현재 live corpus만으로 모든 항목을 `answered`로 강제하면 근거 없는 답변을 장려한다. 기존 라벨과 hard
security/time/provenance invariant는 낮추거나 변경하지 않는다.

## Decision drivers

- 포트폴리오에서 재현 가능하고 설명 가능한 작은 평가여야 한다.
- 현재 승인된 corpus와 model profile만 사용한다.
- 검색 품질과 생성 품질을 분리해 실패 원인을 알 수 있어야 한다.
- 근거가 없는 질문은 정확한 abstention과 coverage limitation이 합격 동작이어야 한다.
- 외부 호출과 비용을 작게 고정하고 자동 재시도·fallback을 허용하지 않는다.
- 기존 PRD/TESTING의 품질 및 보안 기준을 완화하지 않는다.

## Alternatives

### A. 기존 43개 항목을 live corpus에 그대로 적용

- 장점: 평가표가 하나라 단순하다.
- 단점: 승인되지 않은 source가 필요한 질문도 `answered`를 기대해 corpus coverage와 모델 품질을 혼동한다.
  부족한 근거를 생성하도록 압박하거나 정당한 abstention을 실패로 처리한다.

### B. live corpus에 맞춰 기존 골든셋 라벨과 threshold를 낮춤

- 장점: 적은 데이터로 높은 통과율을 얻기 쉽다.
- 단점: 기존 회귀 기준을 훼손하고 COV-009 전후 결과를 비교할 수 없다. 보안·인용 실패를 가릴 수 있다.

### C. 기존 회귀 gate와 live corpus 평가를 분리하고 둘 다 통과

- 장점: 기존 43개 규칙을 보존하면서 실제 corpus의 retrieval, coverage, abstention, 비용을 정직하게
  측정한다. 실패 원인을 retrieval/generation/coverage로 분리할 수 있다.
- 단점: 두 개의 결과표와 live 질문 relevance label 검토가 필요하다.

## Recommendation

대안 C를 추천한다.

### 고정 입력

- live dataset: `COV-009/cov009-20260910-live-v1`, 위 SHA-256, 28 revisions/500 chunks
- source/targets: ADR-0016의 GitHub Releases 5개만
- embedding: OpenRouter `perplexity/pplx-embed-v1-0.6b`, version `2026-03-16`, 1024 dimensions
- chat: RunInfra `nemotron-3-5-lightning-30b`, version
  `NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16`
- 기존 regression: `EVAL_GOLDEN_SET-2026-09-02` 43개 라벨을 변경 없이 유지
- live retrieval set: 실제 revision이 있는 4개 target은 각각 최소 3개 질문을 둔다. 90일 구간 retained
  release가 0개인 `pgvector/pgvector`는 coverage-negative 질문으로 두며 answered 분모에 넣지 않는다.
  사람이 relevant revision/chunk와 기간을 고정하고 dataset 밖 문서를 relevant로 표시하지 않는다.
- live answer set: 공식 release로 답할 수 있는 질문과 현재 source 범위에서 답할 수 없는 질문을 각각
  최소 5개 포함한다. 후자는 `insufficient_evidence`와 구체적 coverage limitation이 정답이다.

검토용 초안은 [`live-eval-set.proposed.json`](../experiments/cov-009/live-eval-set.proposed.json)에 있다.
12개 answerable retrieval 질문은 실제 evidence가 있는 4개 target의 불변 revision/chunk ID 28/500개를
모두 포괄하고, 6개 coverage-negative 질문에는 `pgvector/pgvector` 0건과 미승인 source/금지된 종합
점수 요청을 포함한다.

### 합격 기준

| 영역 | 기준 |
|---|---:|
| live hybrid retrieval Recall@10 | `>= 0.80` |
| live hybrid retrieval nDCG@10 | `>= 0.75` |
| entity/semantic 각 subset Recall@10 | `>= 0.75` |
| time-filter violation | `0` |
| tombstone/rights/profile/provenance violation | `0` |
| duplicate redundancy@10 | `<= 0.20` |
| DB retrieval warm p95 | `<= 500 ms` |
| answer structured-output success | `>= 0.99` |
| citation precision | `>= 0.95` |
| citation coverage | `>= 0.90` |
| unsupported claim rate | `<= 0.05` |
| correct abstention | `>= 0.90` |
| prompt-injection success | `0` |
| 정상 provider 응답 시 answer end-to-end p95 | `<= 15 s` |

검색 variant는 FTS-only, exact-vector-only, FTS+exact-vector RRF를 비교한다. hybrid는 Recall@10과
nDCG@10을 모두 통과해야 하며 entity/semantic 어느 subset에서도 가장 좋은 단일 방식보다 0.05를 초과해
열화하면 채택하지 않는다. 500 chunks에서는 exact pgvector를 기본으로 하고 HNSW/IVFFlat은 만들지 않는다.

기존 43개 regression에서 time, citation allowlist, unsupported claim, injection invariant 실패가 하나라도
있으면 live subset 점수와 관계없이 실패다. 현재 corpus가 지원하지 않는 기존 질문은 기존 expected status를
바꾸지 않고 `coverage_not_applicable`로 별도 보고한다. 이 항목은 분모에서 숨기지 않으며 COV-010 coverage
보고서에 원인과 필요한 미승인 source를 기록한다.

### 비용과 실행 한도

- 평가 추가 지출 hard cap: **USD 0.25 total**
- query embedding: 최대 100 calls / 100,000 input tokens
- chat: 최대 60 calls / input 300,000 tokens / output 30,000 tokens
- 동시성 1, 자동 retry 0, 자동 fallback 0
- 기존 완료 embedding은 재사용하며 corpus 재임베딩은 하지 않는다.
- provider 결과가 불명확하면 비용 예약을 보류하고 자동 재호출하지 않는다.
- raw prompt/response, secret, 전체 source body는 artifact에 저장하지 않는다. hash, sanitized score,
  citation ID, usage, latency만 기록한다.

모든 hard gate를 통과해야만 `COV-010`과 `EVAL-002`를 DONE으로 표시한다. 실패하면 결과와 실패 ID를
보존하고 MVP는 BLOCKED로 유지한다. threshold를 사후에 낮추려면 별도 사용자 승인이 필요하다.

## Consequences if accepted

- `EXP-002`는 고정 corpus와 live retrieval label을 만들고 세 retrieval variant를 측정한다.
- `RAG-003/004`는 통과한 가장 단순한 retrieval config만 구현한다.
- `COV-010/EVAL-002`는 기존 regression과 live corpus scorecard를 별도로 출력한다.
- ADR-0016의 source 범위, retention, 월간 운영 미승인 상태는 유지된다.
- 이 결정은 운영 배포나 추가 target/source 활성화를 승인하지 않는다.

## Validation before acceptance

- COV-009 measurement의 dataset hash, model profiles, usage, 10/10 partition 완료를 확인한다.
- 기존 43개 라벨이 수정되지 않았는지 확인한다.
- live 질문마다 relevant revision/chunk, expected status, 기간과 limitation을 사람이 검토할 수 있는 형태로
  기록한다.
- 실행기가 USD/call/token/deadline을 호출 전에 fail closed하는지 fake test로 검증한다.
- 사용자가 DEC-013의 기준과 USD 0.25 일회성 평가 한도를 명시적으로 승인한다.

## References

- [COV-009 measurement](../experiments/cov-009/live-measurement.json)
- [Proposed live evaluation set](../experiments/cov-009/live-eval-set.proposed.json)
- [RAG golden set](../EVAL_GOLDEN_SET.md)
- [Testing gates](../TESTING.md)
- [EXP-002 retrieval plan](../experiments/EXP-002-retrieval.md)
- [ADR-0016](./0016-low-cost-live-activation.md)
- [ADR-0017](./0017-nemotron-chat-model.md)

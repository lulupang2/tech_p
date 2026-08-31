# EXP-004: Duplicate detection

- 상태: Planned
- 연결 문서: [DATA_PIPELINE.md](../DATA_PIPELINE.md)

## 질문

원본 provenance를 잃지 않으면서 exact duplicate와 cross-source near duplicate를 어떤 방식으로 식별할 것인가?

## Hypotheses

- source external ID + canonical URL + normalized text hash로 exact duplicate 대부분을 결정적으로 처리할 수 있다.
- fingerprint/lexical similarity가 embedding-only보다 boilerplate와 짧은 release note에서 안전한 후보 생성을 제공한다.
- embedding similarity는 자동 merge가 아니라 cluster candidate ranking에 유용하다.

## Dataset

최소 200 pair를 사람이 다음으로 label한다.

- same revision
- updated revision of same artifact
- syndicated/copy of same upstream announcement
- related but independent coverage
- unrelated

짧은 release, 긴 article, 번역/요약, boilerplate, URL 변형을 포함한다.

확정된 source 구성([ADR-0004](../adr/0004-initial-data-sources.md))에서 실제로 나타나는 중복 패턴을 반드시 포함한다.

| 패턴 | 예 |
|---|---|
| 같은 릴리스를 공식 저장소와 공식 블로그가 각각 발표 | `github_releases`의 React release와 `react_blog`의 릴리스 글 |
| 같은 브라우저 변경을 릴리스 노트와 실험 대시보드가 다룸 | `chrome_release_notes`와 `chrome_origin_trials` |
| 같은 패키지 출시가 registry와 저장소 release에 동시 존재 | `npm_registry`와 `github_releases` |
| 같은 주제를 커뮤니티가 반복 질문 | `stack_exchange` 내 유사 질문 |
| 같은 논문의 버전 갱신 | `arxiv`의 v1과 v2 |
| 포럼 스레드가 공식 발표를 인용 | `users_rust_lang`과 `github_releases` |

`verbatim_only` source가 포함되므로, cluster 대표 문서를 고를 때 원문 발췌 규칙이 더 엄격한 쪽을 임의로 버리지 않는다. 대표 선택과 무관하게 모든 member의 provenance와 라이선스를 보존한다.

## Variants

1. external ID/canonical URL/hash rules
2. variant 1 + text fingerprint/Jaccard 후보
3. variant 2 + embedding cosine candidate
4. title + date window + entity constraints 조합

## Metrics

- pairwise precision/recall/F1
- false merge rate(관련 있지만 독립인 문서를 하나로 묶음)
- false split rate
- cluster 대표 문서 선택 안정성
- 처리 latency와 embedding 추가 비용

## Proposed gate

- exact duplicate precision = 1.00
- near-duplicate false merge rate ≤ 0.02
- near-duplicate precision ≥ 0.95를 recall보다 우선
- 모든 cluster member의 원본 URL·revision provenance 보존

## Procedure

1. normalization version과 boilerplate rule을 고정한다.
2. label을 보지 않고 threshold grid를 train subset에서 탐색한다.
3. 고정 holdout에서 한 번 평가한다.
4. 오류 pair를 source/type별로 분류한다.
5. threshold와 algorithm version을 결과에 기록한다.

## 출력

- label guideline과 pair dataset metadata
- variant별 confusion matrix
- 추천 rule/threshold와 수동 검토 대상
- 재-clustering과 algorithm version migration 계획

## 안전 원칙

near duplicate는 physical delete가 아니라 cluster link다. 실험 결과가 좋아도 원본·citation을 자동으로 제거하지 않는다.


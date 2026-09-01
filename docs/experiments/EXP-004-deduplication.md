# EXP-004: Duplicate detection

- 상태: **Completed** (2026-09-02)
- 연결 문서: [DATA_PIPELINE.md](../DATA_PIPELINE.md)
- 실행 코드: [`experiments/exp-004/experiment.mjs`](../../experiments/exp-004/experiment.mjs)
- raw 측정: [`dataset.json`](../../experiments/exp-004/dataset.json), [`result.json`](../../experiments/exp-004/result.json)

## 질문과 범위

원본 provenance를 잃지 않으면서 exact duplicate와 cross-source near duplicate를 식별하는 방법을 비교했다. 실제 source payload를 재배포할 권리가 없는 환경이므로 approved source pattern을 재현하는 synthetic/redacted metadata-only fixture를 사용했다. 이 결과는 live corpus의 성능을 주장하지 않으며, PIPE-003의 production exact-dedup 동작을 변경하지 않는다.

## Dataset와 labeling

| 항목 | 실제 측정값 |
|---|---|
| dataset version | `exp004-synthetic-redacted-v1` |
| pair 수 | **240** (train 160, fixed holdout 80) |
| split | `pairIndex mod 3 == 0` → holdout; seed `exp004-fixed-split-2026-09-02` 기록 |
| labels | 각 48: `same_revision`, `updated_revision`, `syndicated_copy`, `related_independent`, `unrelated` |
| source pattern | 6개: GitHub/React, Chrome release/origin trial, npm/GitHub, Stack Exchange 반복 질문, arXiv version, Rust forum/GitHub |
| fixture rights | `synthetic_metadata_only`, `rawPayloadStored=false`, `verbatimTextStored=false` |
| runtime | Node.js **v26.5.0**, pnpm 10.32.1, Windows, network/LLM 미사용 |

각 pair에는 source key, artifact type, external ID, revision ID, canonical URL, normalized hash, raw item ID, source URL, license ID, `verbatimOnly` flag가 있다. 원문 payload 대신 생성 규칙과 redacted feature token만 저장한다. `stack_exchange` fixture는 `verbatimOnly=true`이며 어떤 variant도 이 보호를 우회하지 않는다.

## 고정 normalization과 algorithm

- normalizer version: `pipe-002-v1.0.0`
- boilerplate rule version: `exp004-boilerplate-v1`
- 모든 feature token은 NFKC, lowercase 후 비교한다.
- `read_more`, `subscribe`, `all_rights_reserved`, `cookie_notice`, `view_on_github`, `generated_by_fixture`를 boilerplate로 제거하고, 제거 목록을 fixture metadata에 기록한다.
- exact identity는 동일 revision이며 canonical URL, normalized hash 또는 external ID가 일치할 때만 true다.
- lexical score는 `0.72 * body Jaccard + 0.28 * title Jaccard`다.
- variant 3은 ADR-0006이 Proposed라 실제 embedding provider를 호출하지 않는다. synthetic token에 대한 deterministic cosine proxy를 비교용으로만 계산했으며, live embedding 결과나 provider 선택으로 해석하지 않는다.
- algorithm version: `exp004-dedup-v1.0.0`

## Blinded threshold search와 holdout protocol

threshold grid `0.50`부터 `0.90`까지 `0.02` 간격을 사용했다. grid 탐색 함수에는 train label만 전달하고, holdout label은 선택 단계에 노출하지 않는다. 선택 규칙은 `precision >= 0.95`와 `false_merge_rate <= 0.02`를 만족하는 후보 중 F1 최대, 동률이면 precision과 높은 threshold 우선이다. 선택 후 fixed holdout을 variant별 한 번 평가했으며, 모든 grid 측정·선택값은 `result.json`에 기록했다.

## Holdout confusion matrices와 metrics

양성은 `same_revision`, `updated_revision`, `syndicated_copy`다. 아래는 80-pair holdout의 `TP / FP / FN / TN`과 pairwise metrics다.

| variant | selected threshold | TP / FP / FN / TN | precision | recall | F1 | false merge | false split |
|---|---:|---:|---:|---:|---:|---:|---:|
| `v1_exact_identity` | 0.90 | 16 / 0 / 32 / 32 | 1.0000 | 0.3333 | 0.5000 | 0.0000 | 0.6667 |
| `v2_lexical_fingerprint` | **0.80** | 48 / 0 / 0 / 32 | **1.0000** | **1.0000** | **1.0000** | **0.0000** | **0.0000** |
| `v3_embedding_proxy` | 0.88 | 48 / 0 / 0 / 32 | 1.0000 | 1.0000 | 1.0000 | 0.0000 | 0.0000 |
| `v4_entity_date_lexical` | 0.80 | 48 / 0 / 0 / 32 | 1.0000 | 1.0000 | 1.0000 | 0.0000 | 0.0000 |

`v2_lexical_fingerprint` is the recommended comparison rule because it has no provider dependency and passes the proposed gate on this fixed synthetic holdout. The exact precision is 1.0000; near-duplicate precision is 1.0000 and false-merge rate is 0.0000. These are fixture measurements only, not unsupported live-corpus results.

## Source/type error analysis

`result.json`의 각 variant `sourceTypeErrorAnalysis`는 6개 source pattern × 5개 label별 pair 수, confusion matrix, precision/recall을 보존한다. 선택 variant의 holdout에는 오류 pair가 없었다. exact-only variant의 32개 false split은 updated/syndicated cross-source 유형에서 발생하며, source별 세부 행과 `errorPairs`에 pair ID로 기록했다. score가 선택 threshold ±0.08 안에 있는 holdout pair 최대 20개와 `verbatimOnly` member가 있는 모든 holdout pair는 `manualReviewList`로 기록했으며, 그 목록은 label·source/type·score·`verbatimOnly`와 함께 보존된다.

## Recommendation과 safety gate

- 추천 variant/threshold: **`v2_lexical_fingerprint`, `0.80`**
- 적용 규칙: exact identity를 먼저 확인하고, 그 외에는 normalized title/body lexical score가 threshold 이상일 때 cluster candidate로 제안한다.
- near duplicate는 **자동 merge하지 않고 cluster link 후보**로만 둔다. physical delete, raw overwrite, revision/citation 변경은 금지한다.
- threshold ±0.08, `verbatim_only` member, revision·canonical URL 충돌은 수동 검토 대상이다.
- 모든 cluster member에 대해 `documentId`, immutable `revisionId`, `rawItemId`, source URL, source key, external ID, canonical URL, license와 `verbatimOnly`를 유지한다.

## Re-clustering migration/provenance plan

1. `exp004-dedup-v1.0.0` algorithm version을 가진 versioned recluster run을 생성한다.
2. immutable document revision과 raw provenance를 읽고 후보를 재계산한다. source/raw/revision/citation row를 삭제·수정하지 않는다.
3. 새 algorithm-version namespace에 cluster link를 만들고, 기존 link는 superseded 상태로 남긴다.
4. low-confidence, threshold 근처, `verbatim_only` 후보는 manual review로 보낸다.
5. old/new membership diff와 provenance completeness를 검증한 뒤에만 승격한다. 문제 시 새 version을 비활성화하고 기존 link로 rollback한다.

## Reproduction and evidence

```text
cd experiments/exp-004
node --test experiment.test.mjs
node experiment.mjs
```

검증 결과: deterministic contract tests 3개 통과, dataset 240 pairs 생성, fixed holdout 80 pairs, 네 variant confusion matrix·threshold grid·source/type analysis·manual review list·migration plan 생성. `node experiment.mjs`는 network, clock, random, LLM, embedding provider를 사용하지 않는다.

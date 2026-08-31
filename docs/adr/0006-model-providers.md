# ADR-0006: LLM and embedding providers

- 상태: Proposed
- 작성일: 2026-09-01
- 결정: 미정

## Context

질의 구조화·답변 생성용 chat model과 document/query embedding model이 필요하다. 비용, 한국어, structured output, latency, 데이터 처리 조건이 provider마다 다르다.

## Decision drivers

- 한국어·영어 기술 질문 품질
- JSON structured output과 긴 context 안정성
- embedding retrieval quality와 고정 dimensions
- 비용, quota, rate limit, latency
- 데이터 보존·학습 사용·지역 조건
- TypeScript SDK와 관측성
- 모델 변경 시 재임베딩·평가 가능성

## Alternatives

- 하나의 상용 provider에서 chat + embedding
- chat과 embedding에 서로 다른 provider
- 상용 chat + local embedding
- 완전 local model

## Recommendation

공급자를 지금 선택하지 않는다. `ChatModelPort`와 `EmbeddingPort`를 분리하고 [EXP-003](../experiments/EXP-003-model-providers.md)에서 최소 2개 후보를 같은 골든셋·비용표로 비교한 뒤 선택한다. MVP에서는 운영 단순성을 위해 선택된 chat 1개, embedding 1개만 production path에 활성화하는 것을 추천한다.

## Consequences if accepted

- provider SDK type이 domain과 API contract로 새지 않는다.
- 모델 ID, provider, prompt/embedding version, token/cost를 기록한다.
- embedding model 변경은 새 vector 공간과 재색인을 요구한다.
- fallback model은 조용히 품질을 바꿀 수 있으므로 명시적 상태·평가 없이는 자동 전환하지 않는다.
- `verbatim_only` source의 근거는 provider에 요약·재서술을 요청하지 않는다. prompt는 원문 발췌를 인용으로 제시하도록 구성한다. 근거는 [RAG §6.1](../RAG.md)에 있다.
- provider에 보내는 excerpt는 필요한 범위로 제한한다. 라이선스가 전문 재배포를 금지하는 source(arXiv 전문 등)는 애초에 저장하지 않으므로 전송 대상도 아니다.

## Validation before acceptance

- [EXP-003](../experiments/EXP-003-model-providers.md)의 quality, latency, cost, policy gate
- monthly budget 시나리오
- rate-limit과 timeout failure handling
- provider 로그/보존 설정 검토


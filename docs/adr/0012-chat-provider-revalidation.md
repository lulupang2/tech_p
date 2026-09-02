# ADR-0012: Chat provider revalidation after EXP-003

- 상태: Proposed
- 작성일: 2026-09-02
- 대체 대상: [ADR-0006](./0006-model-providers.md)의 chat 결정만

## Context

ADR-0006은 RunInfra chat과 OpenRouter embedding을 함께 승인했지만 필수 선행 검증인 EXP-003이 뒤늦게 실행됐다. 43개 골든 항목의 동일 조건 비교에서 `deepseek-v4-flash`는 JSON schema 100%와 p95 10.16초를 달성했으나 citation precision 72.1%, injection safety 93.0%로 gate(각 95%, 100%)를 통과하지 못했다. `qwen3-8-flash-next`도 통과하지 못했다. Embedding recommendation은 검증 결과와 일치했다.

## Alternatives

1. 기존 RunInfra `deepseek-v4-flash`를 그대로 운영 승인한다.
2. RunInfra adapter/prompt의 deterministic validation을 보강하고 같은 모델을 재평가한다.
3. 새 chat 후보를 추가해 동일 43개 항목과 blind human review를 다시 수행한다.
4. chat 기능을 비활성화하고 deterministic retrieval 결과만 제공한다.

## Recommendation

**2와 3을 함께 수행하고 chat 승인은 보류한다.** Embedding 결정은 유지한다.

- 자동 fallback은 두지 않는다.
- 다음 후보는 JSON object 강제, citation allowlist, unsupported/insufficient 구분을 동일 조건에서 지원해야 한다.
- 43개 전 항목에서 schema success ≥99%, citation precision ≥95%, unsupported claim rate ≤5%, injection success 0, p95 ≤15초를 모두 만족해야 한다.
- 자동 gate 통과 후 sanitized output을 사람이 blind review한다.
- provider 보존·학습 사용·지역·삭제 조건과 월간 비용 상한을 승인 기록에 포함한다.

## Consequences

- ADR-0006의 embedding model `perplexity/pplx-embed-v1-0.6b` 1024 dimensions는 유지한다.
- 새 chat 결정이 Accepted 되기 전 production chat 호출과 이를 전제로 한 MVP acceptance는 차단한다.
- 현재 RunInfra adapter는 provider-neutral 경계 검증 및 실험 용도로만 유지한다.
- 이 ADR이 Accepted 되면 ADR-0006의 chat 부분을 Superseded로 연결하고 SSOT/RAG/DATABASE/TASKS를 같은 변경에서 갱신한다.

## Evidence

- [EXP-003 보고서](../experiments/EXP-003-model-providers.md)
- [Sanitized measurement](../experiments/exp-003/measurement.json)

## Revalidation update (2026-09-02)

citation allowlist와 검색 근거의 XML 경계를 production `AnswerService`에 적용하고, 근거 필드를 XML escape하도록 보강했다. 기존 43개 골든셋을 같은 실행기로 재평가했지만 RunInfra gateway가 `deepseek-v4-flash` 요청 전부를 429로 shed하여 해당 chat 결과는 판정 불가다. `qwen3-8-flash-next`도 전 항목이 실패 처리되어 승인 근거가 되지 않는다. 임베딩 수치는 기존 결과와 동일하게 유지한다.

따라서 이번 재평가는 provider capacity 오류로 무효이며, chat gate와 MVP acceptance는 계속 차단한다. 재시도 시 provider 측 capacity가 안정된 실행 창에서 동일 dataset/version과 비용·timeout 통제를 유지해야 한다.

## Revalidation evidence

- [Sanitized revalidation measurement](../experiments/exp-003/measurement-revalidation.json)

두 번째 재평가에서는 gateway 응답이 일부 회복됐지만 `deepseek-v4-flash`도 schema 79.1%, citation precision 65.1%, injection safety 60.0%, p95 29.14초로 모든 핵심 gate를 통과하지 못했다. `qwen3-8-flash-next`는 schema 14.0%, citation precision 16.3%, injection safety 0%, p95 17.83초로 역시 부적합했다. chat 승인은 계속 보류한다.

- [Second revalidation measurement](../experiments/exp-003/measurement-revalidation-2.json)

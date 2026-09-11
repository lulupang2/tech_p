# ADR-0017: Nemotron chat model replacement

- 상태: Accepted (DEC-007 변경, 2026-09-10 사용자 승인)
- 범위: RunInfra chat model 선택
- 대체: [ADR-0012](./0012-chat-provider-revalidation.md)의 `deepseek-v4-flash` 선택

## Context

승인됐던 `deepseek-v4-flash`는 연결 검증에서 RunInfra model catalog에는 존재했지만 최소 chat completion이 두 번 HTTP 503으로 실패했다. 포트폴리오 운영 비용을 낮추면서 기존 OpenAI-compatible JSON 응답 경계를 유지할 수 있는 대안이 필요하다.

RunInfra의 2026-09-10 공개 사양에서 `nemotron-3-5-lightning-30b`는 262,144 token context, JSON mode와 tool calling을 지원하며 가격은 1M tokens당 input USD 0.05, cached input USD 0.01, output USD 0.15다.

## Decision

RunInfra chat model을 `nemotron-3-5-lightning-30b`로 변경한다. Endpoint는 `https://api.runinfra.ai/v1`, embedding은 OpenRouter `perplexity/pplx-embed-v1-0.6b` 1024 dimensions를 유지한다. 자동 fallback은 두지 않는다.

예산 예약에는 보수적으로 output 가격인 1K tokens당 150 micro-USD를 input/output 공통 상한으로 적용한다. 실제 사용량은 provider가 보고한 token usage로 정산한다.

이 승인은 제한된 canary와 평가 실행을 허용한다. 기존 골든셋의 citation, injection, JSON schema, latency gate를 통과하기 전 사용자-facing 운영 출시는 계속 차단한다.

## Consequences

- API binding은 정확한 endpoint와 두 승인 모델이 모두 일치할 때만 활성화한다.
- DeepSeek의 기존 EXP-003 측정은 삭제하거나 Nemotron 결과로 재해석하지 않는다.
- Nemotron의 한국어·citation 품질은 같은 골든셋과 blind review로 새로 측정해야 한다.
- 모델 변경으로 embedding profile이나 기존 embedding 재생성은 발생하지 않는다.

## Validation evidence

2026-09-10 최소 live canary에서 RunInfra `nemotron-3-5-lightning-30b`가 837ms에 유효한 JSON object를 반환했다. Provider usage는 input 28, output 6, total 34 tokens였다. 같은 실행에서 OpenRouter Perplexity embedding도 1024차원·유한·비영 벡터를 반환해 기존 embedding 구성이 유지됨을 확인했다. 응답 본문, vector와 secret은 측정 출력에 기록하지 않았다.

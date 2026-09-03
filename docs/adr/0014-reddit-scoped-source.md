# ADR-0014: Reddit 제한적 source set 추가

- Status: Accepted
- Date: 2026-09-03

## Context

사용자는 포트폴리오·비상업·단기 프로젝트에서 Reddit 수집을 허용하고 residual rights risk를 명시적으로 수용했다. 이는 [ADR-0004](./0004-initial-data-sources.md)의 기존 source set 변경이다. Reddit content에 CC BY-SA가 적용된다고 주장할 근거는 없다.

## Alternatives

1. Reddit을 계속 제외한다.
2. Reddit을 상업·장기 운영 source로 채택한다.
3. 포트폴리오·비상업·단기 프로젝트에 한정해 Reddit을 추가한다.

## Decision

3번을 채택한다. `reddit`을 제한된 source set에 추가하고, 사용자가 수용한 residual rights risk를 이 범위 안에서 기록한다.

- 재배포와 사용자-facing 원문 발췌(excerpt) 기능은 출시하지 않는다.
- robots 정책을 준수하며 로그인·CAPTCHA·접근 정책을 우회하지 않는다.
- author, username, avatar 등 PII는 저장 전에 제거한다.
- 삭제 요청과 source 정책 변경을 반영할 수 있도록 tombstone·retention 경로를 유지한다.
- metadata-only seed는 기존 seed script에 통합하되 Reddit은 `enabled=false`로 삽입한다.

## Consequences

Reddit은 프로젝트 내부의 제한된 수집 후보가 되지만 상업적·장기 corpus source가 아니다. embedding 및 표시 범위는 위 결정과 provenance 정책을 따른다. rights residual risk의 추가 승인은 남은 blocker가 아니다.

## Evidence and acceptance gates

근거 문서는 [SOURCE_RIGHTS.md](../SOURCE_RIGHTS.md), [SOURCE_CATALOG.md](../SOURCE_CATALOG.md), Reddit [robots.txt](https://www.reddit.com/robots.txt), [Data API Terms](https://redditinc.com/policies/data-api-terms)다. 현재 실제 실행 증거는 없으므로 다음만 남은 gate다: Reddit live canary, 실제 production corpus, `EVAL-002` RAG evaluation. 그 전까지 `MVP-001`과 `EVAL-002`는 `BLOCKED`다.

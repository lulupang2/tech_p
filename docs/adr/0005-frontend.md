# ADR-0005: Frontend

- 상태: Superseded
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 대체: [ADR-0008](./0008-frontend-sveltekit.md)이 2026-09-01에 이 결정을 대체했다. frontend는 SvelteKit을 사용한다
- 원래 결정: Next.js를 사용한다. RAG·DB·수집 로직은 backend API에만 두고 Next.js server 기능은 UI 전달과 최소 BFF로 제한한다

> 이 ADR은 이력 보존을 위해 남겨둔다. 현재 유효한 frontend 결정은 [ADR-0008](./0008-frontend-sveltekit.md)이다. 아래 내용은 대체 시점의 기록이며 지금의 결정이 아니다.

## Context

포트폴리오 사용자가 질문하고 답변, 기간, 지표, citation, source freshness를 이해할 최소 web UI가 필요하다.

## Decision drivers

- TypeScript와 Playwright E2E
- citation 중심의 접근 가능한 UI
- API secret이 client bundle에 들어가지 않을 것
- 빠른 포트폴리오 배포와 metadata/SEO
- MVP에서 불필요한 BFF·state complexity 회피

## Alternatives

### Next.js

- 장점: TypeScript React, routing/rendering/deployment ecosystem, portfolio presentation
- 단점: 별도 backend와 함께 쓰면 server boundary가 중복될 수 있고 cache/runtime 선택이 복잡

### Vite + React SPA

- 장점: 단순한 client, 독립 API 경계가 분명
- 단점: SSR/metadata/deployment 통합을 별도 처리

### Backend-rendered minimal UI

- 장점: 가장 적은 component
- 단점: interactive answer/citation UX와 필수 TypeScript 활용이 약함

## Recommendation

**Next.js**를 추천하되, RAG·DB·수집 로직은 backend API에만 둔다. Next.js server 기능은 UI 전달과 필요 최소 BFF에 한정한다.

## Consequences if accepted

- web과 API contract를 공유하되 web이 database package를 import하지 않는다.
- server/client component 경계를 문서화한다.
- citation, loading, insufficient evidence, source status를 Playwright로 검증한다.
- 라이선스 귀속이 필요한 source의 발췌는 귀속 문구와 원문 링크를 함께 표시한다. 귀속 정보가 없으면 발췌를 표시하지 않는다.
- 지표는 이름과 단위를 함께 표시하고 서로 다른 단위를 하나의 그래프나 점수로 합치지 않는다. `repo_attention`은 수집 시작 이후 구간만 있다는 표시가 필요하다.
- streaming은 API ADR 결정 전 가정하지 않는다.

## Validation before acceptance

- 동기 JSON 기준 질문·답변 UI prototype
- accessibility와 citation navigation 확인
- 귀속 문구와 지표 단위를 함께 표시했을 때의 레이아웃 검토
- standalone deployment와 API origin/CORS 구성 비교


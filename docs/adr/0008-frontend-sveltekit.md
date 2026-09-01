# ADR-0008: Frontend framework change to SvelteKit

- 상태: Accepted
- 작성일: 2026-09-01
- 승인일: 2026-09-01
- 승인 주체: 사용자
- 결정: SvelteKit을 사용한다. RAG·DB·수집 로직은 backend API에만 두고 SvelteKit server 기능은 UI 전달과 최소 BFF로 제한한다
- 대체 관계: [ADR-0005](./0005-frontend.md)를 `Superseded`로 대체한다

## Context

[ADR-0005](./0005-frontend.md)가 2026-09-01에 Next.js로 승인됐다. 같은 날 사용자가 frontend를 Svelte로 변경하도록 지시했다.

변경 시점이 유리하다. **frontend 코드가 아직 한 줄도 없다.** `WEB-001`~`WEB-003`은 `BLOCKED`이고 `FND-001`도 시작되지 않았다. 따라서 이 변경의 마이그레이션 비용은 0이며, 문서 정합성만 맞추면 된다.

## Decision drivers

ADR-0005의 기준을 그대로 유지한다.

- TypeScript와 Playwright E2E
- citation 중심의 접근 가능한 UI
- API secret이 client bundle에 들어가지 않을 것
- 빠른 포트폴리오 배포와 metadata/SEO
- MVP에서 불필요한 BFF·state complexity 회피

여기에 하나를 추가한다.

- **frontend framework 선택이 backend·pipeline 결정에 영향을 주지 않을 것.** web은 `packages/contracts`를 통해서만 타입을 얻으므로 framework 교체가 다른 경계로 번지지 않아야 한다.

## Alternatives

### SvelteKit

- 장점: routing, SSR, metadata, server route를 한 framework에서 제공하므로 ADR-0005의 SSR·SEO 기준을 그대로 충족한다. TypeScript를 1급으로 지원한다. `+page.server.ts`로 server 전용 코드 경계가 파일 이름 수준에서 드러나 secret 유출 경로를 검토하기 쉽다.
- 단점: SvelteKit의 server 기능이 backend API와 역할이 겹칠 수 있다. adapter 선택이 배포 대상에 종속된다.

### Svelte + Vite SPA

- 장점: 가장 단순하다. server 계층이 없어 backend API와 역할이 겹치지 않는다.
- 단점: SSR과 metadata를 별도로 처리해야 하므로 ADR-0005의 SEO 기준이 약해진다. 포트폴리오의 공개 페이지 성격과 맞지 않을 수 있다.

### Next.js 유지

- 장점: 이미 승인된 결정이며 생태계가 크다.
- 단점: 사용자가 Svelte로 변경하도록 지시했다.

## Decision

**SvelteKit**을 사용한다. ADR-0005가 SSR과 metadata를 decision driver로 명시했으므로, 그 기준을 유지하는 직접 대응물은 순수 SPA가 아니라 SvelteKit이다.

`Svelte + Vite SPA`가 더 적합하다고 판단되면 이 ADR을 대체하는 새 ADR로 변경한다. 그 경우 변경 범위는 이 ADR의 Consequences 중 SSR·metadata 항목과 배포 adapter 항목으로 한정된다.

## Consequences if accepted

- web과 API는 `packages/contracts`를 통해 타입을 공유한다. **web은 `database`, `collectors`, `rag`, provider SDK package를 import하지 않는다.** 이 규칙은 framework와 무관하게 유지된다.
- server 전용 코드는 `+page.server.ts`, `+server.ts`, `$lib/server/` 경계 안에만 둔다. client bundle에 들어가는 코드에서 LLM key, DB 자격증명, 내부 endpoint를 참조하지 않는다.
- SvelteKit server 기능은 UI 전달과 최소 BFF에 한정한다. RAG 실행, DB 접근, 수집 로직을 SvelteKit 안에 두지 않는다.
- 라이선스 귀속이 필요한 source의 발췌는 귀속 문구와 원문 링크를 함께 표시한다. 귀속 정보가 없으면 발췌를 표시하지 않는다.
- 지표는 이름과 단위를 함께 표시하고 서로 다른 단위를 하나의 그래프나 종합 점수로 합치지 않는다. `repo_attention`은 수집 시작 이후 구간만 있다는 표시가 필요하다.
- Playwright UI E2E는 framework에 종속되지 않으므로 [TESTING](../TESTING.md) §8의 흐름을 그대로 사용한다. `EXP-005`의 측정 결과도 영향을 받지 않는다. frontend는 그 실험 범위에 없었다.
- 배포 adapter는 hosting 결정과 함께 정한다. [SSOT §5](../SSOT.md)의 hosting 미결정 항목에 종속된다.
- `apps/web`의 내부 구조만 바뀌고 [ADR-0010](./0010-turborepo-monorepo.md)이 승인한 package 경계와 의존 방향은 그대로다. [ADR-0007](./0007-repository-layout.md)는 해당 경계의 당시 근거를 기록한 Superseded ADR이다.

## Validation before implementation

`WEB-001`에서 확인한다.

- `packages/contracts`의 타입이 SvelteKit에서 그대로 소비되고 API contract type drift test가 동작하는지
- client bundle에 secret이 포함되지 않는지 빌드 산출물 검사로 확인
- loading, error, empty, insufficient evidence 상태의 접근성 smoke
- citation과 귀속 문구 표시가 keyboard·screen reader로 접근 가능한지

## References

- [SvelteKit documentation](https://svelte.dev/docs/kit)
- [Svelte documentation](https://svelte.dev/docs/svelte)
- [ADR-0005](./0005-frontend.md) (Superseded)

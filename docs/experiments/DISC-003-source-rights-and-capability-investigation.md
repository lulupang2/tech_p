# DISC-003: Source Rights, Capability, and Candidate Target Investigation Report

- **Investigation ID**: `DISC-003`
- **Date**: 2026-09-09
- **Status**: Research Completed (Gated / Advisory Only — Research Is Not Authorization)
- **Primary Governance References**: [ADR-0004](../adr/0004-initial-data-sources.md), [ADR-0015](../adr/0015-coverage-driven-collection-retrieval.md), [SOURCE_CATALOG](../SOURCE_CATALOG.md), [SECURITY](../SECURITY.md), [COLLECTION_CONTRACTS](../COLLECTION_CONTRACTS.md), [TASKS](../../TASKS.md)
- **Audience**: Coordinator, Architecture Owners, Decision Gate (`DEC-012`, `DEC-007`)

---

## 1. Executive Summary & Legal/Governance Scope

This investigation completes the research mandate of **DISC-003** across the repository's full seed source inventory and candidate target catalog.

### Fundamental Project Invariants & Research Scope
1. **Research is Not Authorization**: Documenting a public URL, endpoint, or license does not grant live activation, production ingestion, or budget spend. All targets remain `enabled: false` by default until explicitly enabled by the user in `DEC-012`.
2. **Access/Robots vs. Copyright/License Distinction**: An accessible HTTP/200 response, a permissive `robots.txt`, or an open source repository software license does not imply unconstrained rights to store, redistribute, input into LLMs, or embed user-generated text.
3. **Model Training & Embedding Nuance**: Rights to generate vector embeddings or use text as model context cannot be inferred from ambiguous terms or pure software licenses. Where terms are unclear or restrictive (e.g., Reddit, YC/Hacker News, Stack Exchange commercial AI clauses), pipeline policies enforce `verbatim_only`, excerpt-only display with attribution, or total exclusion.
4. **No Synthetic Fallback**: Historical gaps, lack of pagination, or unsupported backfill endpoints must be recorded truthfully as partial/unsupported capability; synthetic or fake data must never substitute for live source limitations.

---

## 2. ADR-0014 Reconciliation: File Existence & Status Audit

### 2.1 Audit Findings
- **Repository File Audit**: Inspection of `docs/adr/` confirms that no file named `0014-*.md` exists in the repository. The sequential sequence jumps directly from `0013-production-deployment.md` to `0015-coverage-driven-collection-retrieval.md`.
- **References in Governance**:
  - `TASKS.md` line 27 (`DEC-010`) records: *"Reddit 제한적 source set 추가 승인 (ADR-0014 Accepted 2026-09-03)"*.
  - `TASKS.md` line 478 (`DEC-010`) states: *"TASKS의 ADR-0014 참조와 현재 문서 부재 대조 필요"*.
  - `docs/SOURCE_CATALOG.md` line 20 records: *"TASKS가 참조하는 ADR-0014 파일은 이번 조사 경로에 없었다. Reddit 관련 최신 사용자 결정과 문서 근거를 DISC-003에서 대조하고 불명확 범위를 자동 활성화하지 않는다"*.
- **Codebase State**:
  - `packages/collectors/src/reddit.ts` and `policies.ts` contain a hardened Reddit collector using Playwright and semantic selectors.
  - In `SOURCE_CATALOG.md` §14, Reddit is marked as `enabled=false` with a proposal of 6-hour cadence, pending live canary/gate.

### 2.2 Official Legal & Rights Reconciliation for Reddit
- **Reddit Data API Terms & Developer Terms (2023–2026)**:
  1. Reddit's Data API Terms and Developer Terms explicitly prohibit using Reddit User Content to train machine learning or AI models, or building commercial derivative datasets, without express written agreement with Reddit Inc.
  2. Reddit terms mandate ongoing deletion synchronization (listening to user/post deletions and immediately removing them from storage/caches).
  3. Non-commercial and portfolio use without commercial AI training still faces strict rate limits (OAuth mandatory for API; unauthenticated Playwright scraping is subject to anti-bot measures and User Agreement restrictions).
- **Reconciliation Recommendation for Coordinator**:
  - **Do NOT fabricate an ADR-0014 document** retrospectively.
  - Acknowledge that ADR-0014 was referenced in TASKS.md as a proposed decision that was never finalized or committed as an accepted ADR file.
  - Under `ADR-0004` (Accepted) and current Reddit Developer Terms, Reddit remains **BLOCKED / DISABLED** (`enabled: false`) for live data ingestion and embedding.
  - Any future adoption of Reddit requires a formal user-approved ADR and `DEC-012` scope approval with explicit acknowledgment of Reddit's Data API constraints.

---

## 3. Comprehensive Target Inventory Matrix

The table below catalogs every seed source and candidate target identified across `SOURCE_CATALOG.md`, `ADR-0004`, `TOPIC_TAXONOMY.md`, `COLLECTION_CONTRACTS.md`, and experimental artifacts.

| # | Source Key | Canonical Target Selector / Identity | Latest Official URL(s) | Retrieval Date | Applicable License / Rights Unit | Fetch | Store | Model Input | Embed | Display Excerpt | Retention Scope | History / Pagination Capability | Rate Limits / Auth Req | Unsupported / Unknown Facts | Current Enable Status |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `github_releases` | `microsoft/TypeScript` | `https://api.github.com/repos/microsoft/TypeScript/releases` | 2026-09-09 | Apache-2.0 | Allowed | Allowed | Allowed | Allowed | Allowed (with attribution) | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Release note bodies only; excludes git commit tags without release | Candidate (`enabled: false`) |
| 2 | `github_releases` | `nodejs/node` | `https://api.github.com/repos/nodejs/node/releases` | 2026-09-09 | MIT (Node.js license) | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Node uses release notes heavily; changelog links present | Candidate (`enabled: false`) |
| 3 | `github_releases` | `oven-sh/bun` | `https://api.github.com/repos/oven-sh/bun/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | High release frequency; markdown release bodies | Candidate (`enabled: false`) |
| 4 | `github_releases` | `denoland/deno` | `https://api.github.com/repos/denoland/deno/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Structured changelog formatting | Candidate (`enabled: false`) |
| 5 | `github_releases` | `microsoft/playwright` | `https://api.github.com/repos/microsoft/playwright/releases` | 2026-09-09 | Apache-2.0 | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Release notes include code snippets | Candidate (`enabled: false`) |
| 6 | `github_releases` | `elysiajs/elysia` | `https://api.github.com/repos/elysiajs/elysia/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Minor releases may have brief descriptions | Candidate (`enabled: false`) |
| 7 | `github_releases` | `fastify/fastify` | `https://api.github.com/repos/fastify/fastify/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Stable semver releases | Candidate (`enabled: false`) |
| 8 | `github_releases` | `nestjs/nest` | `https://api.github.com/repos/nestjs/nest/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Monorepo releases | Candidate (`enabled: false`) |
| 9 | `github_releases` | `facebook/react` | `https://api.github.com/repos/facebook/react/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Major/minor infrequent; canaries tagged separately | Candidate (`enabled: false`) |
| 10 | `github_releases` | `vercel/next.js` | `https://api.github.com/repos/vercel/next.js/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Very high release volume (canary releases filter required) | Candidate (`enabled: false`) |
| 11 | `github_releases` | `vuejs/core` | `https://api.github.com/repos/vuejs/core/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Clean changelog format | Candidate (`enabled: false`) |
| 12 | `github_releases` | `vitejs/vite` | `https://api.github.com/repos/vitejs/vite/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Monorepo releases (packages/vite) | Candidate (`enabled: false`) |
| 13 | `github_releases` | `langchain-ai/langchainjs` | `https://api.github.com/repos/langchain-ai/langchainjs/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Frequent package updates | Candidate (`enabled: false`) |
| 14 | `github_releases` | `langchain-ai/langgraphjs` | `https://api.github.com/repos/langchain-ai/langgraphjs/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Core package releases | Candidate (`enabled: false`) |
| 15 | `github_releases` | `pgvector/pgvector` | `https://api.github.com/repos/pgvector/pgvector/releases` | 2026-09-09 | PostgreSQL License (BSD-like) | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | C extension releases; changelog summary | Candidate (`enabled: false`) |
| 16 | `github_releases` | `postgres/postgres` | `https://api.github.com/repos/postgres/postgres/releases` | 2026-09-09 | PostgreSQL License | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Git tags vs GitHub Releases: Postgres mirrors git tags; releases may be empty/sparse | Candidate (`enabled: false`) |
| 17 | `github_releases` | `taskforcesh/bullmq` | `https://api.github.com/repos/taskforcesh/bullmq/releases` | 2026-09-09 | MIT | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | Standard releases | Candidate (`enabled: false`) |
| 18 | `github_releases` | `redis/redis` | `https://api.github.com/repos/redis/redis/releases` | 2026-09-09 | **Dual RSALv2 / SSPLv1** (from v7.4, 2024-03; pre-7.4 BSD-3-Clause) | Allowed (public API) | Allowed | **Restricted/Review** | **Restricted/Review** | Allowed (with attribution) | 90-day backfill + rolling | `paginated_history` (`published_at`, ETag 304) | 5,000 req/h (Auth: `GITHUB_PAT`) | **License Changed in 2024 from BSD-3-Clause to non-OSI source-available terms.** Commercial / hosted SaaS embedding must be reviewed | Candidate (`enabled: false`, Pending DEC-012) |
| 19 | `stack_exchange` | `stackoverflow:typescript` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=typescript` | 2026-09-09 | CC BY-SA 4.0 (per-post `content_license`) | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` (`fromdate`/`todate`, `last_activity_date`) | 10,000 req/day (Auth: `STACK_EXCHANGE_KEY`) | Requires custom filter for body; posts without `content_license` excluded from excerpt | Candidate (`enabled: false`) |
| 20 | `stack_exchange` | `stackoverflow:node.js` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=node.js` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High volume tag | Candidate (`enabled: false`) |
| 21 | `stack_exchange` | `stackoverflow:bun` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=bun` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Moderate volume | Candidate (`enabled: false`) |
| 22 | `stack_exchange` | `stackoverflow:deno` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=deno` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Moderate volume | Candidate (`enabled: false`) |
| 23 | `stack_exchange` | `stackoverflow:react` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=react` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High volume tag | Candidate (`enabled: false`) |
| 24 | `stack_exchange` | `stackoverflow:next.js` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=next.js` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High volume tag | Candidate (`enabled: false`) |
| 25 | `stack_exchange` | `stackoverflow:vue.js` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=vue.js` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High volume tag | Candidate (`enabled: false`) |
| 26 | `stack_exchange` | `stackoverflow:vite` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=vite` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Moderate volume | Candidate (`enabled: false`) |
| 27 | `stack_exchange` | `stackoverflow:elysia` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=elysia` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Low volume tag | Candidate (`enabled: false`) |
| 28 | `stack_exchange` | `stackoverflow:fastify` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=fastify` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Moderate volume | Candidate (`enabled: false`) |
| 29 | `stack_exchange` | `stackoverflow:nestjs` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=nestjs` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Moderate volume | Candidate (`enabled: false`) |
| 30 | `stack_exchange` | `stackoverflow:postgresql` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=postgresql` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High volume tag | Candidate (`enabled: false`) |
| 31 | `stack_exchange` | `stackoverflow:pgvector` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=pgvector` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Low volume tag | Candidate (`enabled: false`) |
| 32 | `stack_exchange` | `stackoverflow:redis` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=redis` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High volume tag | Candidate (`enabled: false`) |
| 33 | `stack_exchange` | `stackoverflow:playwright` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=playwright` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Moderate volume | Candidate (`enabled: false`) |
| 34 | `stack_exchange` | `stackoverflow:langchain` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=langchain` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | High growth volume | Candidate (`enabled: false`) |
| 35 | `stack_exchange` | `stackoverflow:langgraph` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=langgraph` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Emerging tag | Candidate (`enabled: false`) |
| 36 | `stack_exchange` | `stackoverflow:bullmq` | `https://api.stackexchange.com/2.3/questions?site=stackoverflow&tagged=bullmq` | 2026-09-09 | CC BY-SA 4.0 | Allowed | Allowed | **Verbatim Only** | Allowed (`verbatim_only`) | Allowed (`verbatim_only` + attribution link) | 90-day backfill + rolling | `historical_range` | 10,000 req/day | Low volume tag | Candidate (`enabled: false`) |
| 37 | `users_rust_lang` | `users_rust_lang:all` | `https://users.rust-lang.org/latest.json` | 2026-09-09 | **Dual MIT / Apache-2.0** (Strict cutoff: **post-2020-07-17 only**; prior CC BY-NC-SA 3.0 excluded) | Allowed | Allowed | Allowed (post-cutoff) | Allowed (post-cutoff) | Allowed | Rolling / incremental only | `feed_only` (`last_posted_at`; no native range query) | ~200 req/min (Discourse IP rate limit) | Pre-2020-07-17 posts must be dropped by collector guard | Candidate (`enabled: false`) |
| 38 | `arxiv` | `arxiv:cs.ai` | `http://export.arxiv.org/api/query?search_query=cat:cs.AI` | 2026-09-09 | **CC0 1.0 Universal** (Descriptive metadata only) | Allowed | Allowed | Allowed (Abstract only) | Allowed (Abstract only) | Allowed | 90-day backfill + rolling | `historical_range` (`submittedDate:[from TO to]`) | **Mandatory ≥ 3.0s interval, single connection** | **Full text PDFs strictly excluded (not CC0)** | Candidate (`enabled: false`) |
| 39 | `arxiv` | `arxiv:cs.cl` | `http://export.arxiv.org/api/query?search_query=cat:cs.CL` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Computation & Language | Candidate (`enabled: false`) |
| 40 | `arxiv` | `arxiv:cs.ir` | `http://export.arxiv.org/api/query?search_query=cat:cs.IR` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Information Retrieval (RAG core) | Candidate (`enabled: false`) |
| 41 | `arxiv` | `arxiv:cs.lg` | `http://export.arxiv.org/api/query?search_query=cat:cs.LG` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Machine Learning | Candidate (`enabled: false`) |
| 42 | `arxiv` | `arxiv:cs.se` | `http://export.arxiv.org/api/query?search_query=cat:cs.SE` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Software Engineering | Candidate (`enabled: false`) |
| 43 | `arxiv` | `arxiv:cs.cv` | `http://export.arxiv.org/api/query?search_query=cat:cs.CV` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Discovered candidate | Candidate (`enabled: false`) |
| 44 | `arxiv` | `arxiv:cs.db` | `http://export.arxiv.org/api/query?search_query=cat:cs.DB` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Discovered candidate | Candidate (`enabled: false`) |
| 45 | `arxiv` | `arxiv:cs.dc` | `http://export.arxiv.org/api/query?search_query=cat:cs.DC` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Discovered candidate | Candidate (`enabled: false`) |
| 46 | `arxiv` | `arxiv:cs.cr` | `http://export.arxiv.org/api/query?search_query=cat:cs.CR` | 2026-09-09 | CC0 1.0 Universal | Allowed | Allowed | Allowed | Allowed | Allowed | 90-day backfill + rolling | `historical_range` | 3.0s interval | Discovered candidate | Candidate (`enabled: false`) |
| 47 | `chrome_release_notes` | `chrome_release_notes:all` | `https://developer.chrome.com/release-notes/{version}` | 2026-09-09 | CC BY 4.0 | Allowed | Allowed | Allowed | Allowed | Allowed (with attribution) | Rolling / per-version | `feed_only` (Sequential version polling) | Unthrottled HTTP; polite interval (1s) | Server-rendered HTML; DOM parser required (regex unstable per EXP-001) | Candidate (`enabled: false`) |
| 48 | `react_blog` | `react_blog:feed` | `https://react.dev/rss.xml` | 2026-09-09 | CC BY 4.0 (repo `LICENSE-DOCS.md`) | Allowed | Allowed | Allowed | Allowed | Allowed (with attribution) | Rolling / feed-based | `feed_only` (RSS items + HTTP page fetch) | Polite interval (1s) | Excludes non-doc code in react repo | Candidate (`enabled: false`) |
| 49 | `chrome_origin_trials` | `chrome_origin_trials:all` | `https://developer.chrome.com/origintrials/` | 2026-09-09 | CC BY 4.0 | Allowed (Playwright) | Allowed | Allowed (Status text) | Allowed (Status text) | Allowed | Current snapshot | `snapshot_only` (No historical time-range) | Playwright headless browser; 1 concurrent | Requires Javascript rendering; published_at is null (milestones only) | Candidate (`enabled: false`) |
| 50 | `npm_registry` | `npm:typescript` | `https://registry.npmjs.org/typescript` | 2026-09-09 | Metadata public; package Apache-2.0 | Allowed | Allowed (metadata) | Metric observation only | Not embedded | Metric only | Current metadata snapshot | `snapshot_only` (ETag conditional 304 supported) | Monthly 5M budget guideline | Email addresses stripped before raw store; README not embedded | Candidate (`enabled: false`) |
| 51 | `npm_registry` | `npm:react` | `https://registry.npmjs.org/react` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 52 | `npm_registry` | `npm:next` | `https://registry.npmjs.org/next` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 53 | `npm_registry` | `npm:vue` | `https://registry.npmjs.org/vue` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 54 | `npm_registry` | `npm:vite` | `https://registry.npmjs.org/vite` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 55 | `npm_registry` | `npm:fastify` | `https://registry.npmjs.org/fastify` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 56 | `npm_registry` | `npm:@nestjs/core` | `https://registry.npmjs.org/@nestjs/core` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 57 | `npm_registry` | `npm:elysia` | `https://registry.npmjs.org/elysia` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 58 | `npm_registry` | `npm:playwright` | `https://registry.npmjs.org/playwright` | 2026-09-09 | Apache-2.0 | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 59 | `npm_registry` | `npm:@playwright/test` | `https://registry.npmjs.org/@playwright/test` | 2026-09-09 | Apache-2.0 | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 60 | `npm_registry` | `npm:langchain` | `https://registry.npmjs.org/langchain` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 61 | `npm_registry` | `npm:@langchain/langgraph` | `https://registry.npmjs.org/@langchain/langgraph` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 62 | `npm_registry` | `npm:pg` | `https://registry.npmjs.org/pg` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 63 | `npm_registry` | `npm:postgres` | `https://registry.npmjs.org/postgres` | 2026-09-09 | Unlicense / MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 64 | `npm_registry` | `npm:bullmq` | `https://registry.npmjs.org/bullmq` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 65 | `npm_registry` | `npm:ioredis` | `https://registry.npmjs.org/ioredis` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 66 | `npm_registry` | `npm:pgvector` | `https://registry.npmjs.org/pgvector` | 2026-09-09 | MIT | Allowed | Allowed | Metric only | Not embedded | Metric only | Snapshot | `snapshot_only` | 5M monthly cap | PII email strip | Candidate (`enabled: false`) |
| 67 | `npm_downloads` | 17 package selectors matching above | `https://api.npmjs.org/downloads/range/{period}/{package}` | 2026-09-09 | Public metric data | Allowed | Allowed | Metric observation | Metric observation | Allowed | Up to 18 months history | `historical_range` (Bulk up to 128 packages, 365 days per query) | Unauthenticated public API | Directional metric only (mirrors, CI, bot traffic included; <50/day ignored) | Candidate (`enabled: false`) |
| 68 | `github_search` | `github_search:query:topic_created` | `https://api.github.com/search/repositories?q=topic:{topic}+created:>{from}` | 2026-09-09 | GitHub API metadata | Allowed | Allowed | Metric observation | Not embedded | Metric only | Snapshot series | `paginated_history` (Max 1,000 results per query) | **30 req/min (Auth mandatory: `GITHUB_PAT`)** | Unauthenticated 50% failure rate; Star growth history cannot be backfilled | Candidate (`enabled: false`) |
| 69 | `github_search` | `github_search:query:topic_pushed` | `https://api.github.com/search/repositories?q=topic:{topic}+pushed:>{from}` | 2026-09-09 | GitHub API metadata | Allowed | Allowed | Metric observation | Not embedded | Metric only | Snapshot series | `paginated_history` | 30 req/min (Auth mandatory) | Max 1,000 items | Candidate (`enabled: false`) |
| 70 | `github_search` | `github_search:query:issues_comments` | `https://api.github.com/search/issues?q=is:issue+updated:>{from}+comments:>20` | 2026-09-09 | GitHub API metadata | Allowed | Allowed | Metric observation | Not embedded | Metric only | Snapshot series | `paginated_history` | 30 req/min (Auth mandatory) | Issue body/comments excluded from document store; count only | Candidate (`enabled: false`) |
| 71 | `github_search` | `github_search:query:issues_reactions` | `https://api.github.com/search/issues?q=is:issue+updated:>{from}+reactions:>50` | 2026-09-09 | GitHub API metadata | Allowed | Allowed | Metric observation | Not embedded | Metric only | Snapshot series | `paginated_history` | 30 req/min (Auth mandatory) | PII fields stripped | Candidate (`enabled: false`) |
| 72 | `huggingface_hub` | `huggingface_hub:models` | `https://huggingface.co/api/models` | 2026-09-09 | Platform API metadata | Allowed | Allowed | Metric observation | Not embedded | Metric only | Snapshot series | `paginated_history` | Free auth 1,000 / 5min (`HUGGINGFACE_TOKEN`) | Model cards & README text strictly excluded (diverse licenses); metrics only | Candidate (`enabled: false`) |
| 73 | `reddit` | `reddit:r/typescript`, `reddit:r/node`, etc. | `https://www.reddit.com/r/{subreddit}/` | 2026-09-09 | **Reddit User Agreement & Data API Terms** | Restricted / Anti-bot | **Prohibited/Restricted** | **Prohibited** (Data API Terms forbid AI model training without agreement) | **Prohibited** | **Restricted** | Real-time deletion obligation | `feed_only` (Playwright semantic DOM scraping; no historical range) | Unauthenticated scraping rate-limited/blocked | **ADR-0014 missing; Reddit Developer Terms forbid commercial AI model training & require real-time deletion. Excluded from active corpus** | **BLOCKED / DISABLED** (`enabled: false`) |

---

## 4. In-depth Capability & Rights Analysis by Source Key

### 4.1 `github_releases`
- **Endpoints**: `GET /repos/{owner}/{repo}/releases`
- **Rights & Licenses**: Releases inherit the respective repository's open source license. All 17 evaluated open source repositories (except `redis/redis`) are permissive (MIT, Apache-2.0, PostgreSQL). For `redis/redis`, the March 2024 license transition to RSALv2/SSPLv1 requires commercial SaaS review, though reading public release notes under attribution remains permissible.
- **Capabilities**:
  - `historyMode`: `paginated_history` (page-by-page traversal via `published_at`).
  - `timeBasis`: `published_at` (strictly distinct from commit `created_at`).
  - `cursorVersion`: 1 (opaque ISO timestamp + overlap buffer).
  - Rate handling: Fully supports HTTP conditional requests (`If-None-Match` with ETag). Responses returning `304 Not Modified` do not consume authenticated primary rate quota (5,000 req/h).
- **PII Stripping**: Strips `author` object, `user`, `owner`, and `assets[].uploader` prior to raw persistence.
- **Limitation**: Repositories using raw git tags without published GitHub release records (e.g. historical `postgres/postgres` mirror tags) return empty lists and must be flagged as `no_releases`.

### 4.2 `stack_exchange`
- **Endpoints**: `GET https://api.stackexchange.com/2.3/questions` and `/search/advanced`
- **Rights & Licenses**:
  - All user contributions are licensed under Creative Commons ShareAlike (`CC-BY-SA-2.5`, `CC-BY-SA-3.0`, or `CC-BY-SA-4.0` depending on creation date).
  - The API explicitly returns a `content_license` field (e.g. `CC BY-SA 4.0`).
  - **Policy Enforcement**: `verbatim_only: true`. Text must not be paraphrased or rewritten without citation; displayed answers must provide an explicit canonical link and attribution to the author/platform. Where `content_license` is absent in legacy items, the item is downgraded to metric counting only (`community_mentions`) and excluded from excerpt display.
- **Capabilities**:
  - `historyMode`: `historical_range` using `fromdate` and `todate` Unix epoch seconds.
  - Rate handling: Mandatory `STACK_EXCHANGE_KEY` provides 10,000 requests/day (unauthenticated is limited to 300/day). Must strictly honor response `backoff` headers (coalescing calls to at least 1 min per identical query).

### 4.3 `users_rust_lang`
- **Endpoints**: `GET https://users.rust-lang.org/latest.json`, `GET https://users.rust-lang.org/t/{id}.json`
- **Rights & Licenses**:
  - **Crucial License Cutoff Date (2020-07-17)**: On July 17, 2020, the Rust Foundation/Community updated the forum Terms of Service to dual MIT / Apache-2.0 for all user contributions.
  - All contributions posted *prior* to 2020-07-17 remain under `CC BY-NC-SA 3.0` (NonCommercial), which violates the project's unrestricted storage/commercial neutrality standard.
  - **Enforcement**: Collector guard unconditionally drops and purges any topic or post where `created_at < 2020-07-17T00:00:00Z`.
- **Capabilities**:
  - `historyMode`: `feed_only`. Discourse does not provide an arbitrary date-range query endpoint for non-admin API consumers; historical backfill beyond recent topics is unsupported.
  - Rate limit: Standard Discourse IP throttle (~200 req/min, 50 req/10s).

### 4.4 `arxiv`
- **Endpoints**: `GET http://export.arxiv.org/api/query` (OAI-PMH for bulk)
- **Rights & Licenses**:
  - arXiv API Terms of Use expressly dedicate all descriptive metadata (title, abstract, authors, DOI, categories, publication dates) to the public domain under **CC0 1.0 Universal**.
  - **Full-Text PDF Exemption**: PDF full-text and figures are NOT CC0 and are subject to individual author copyrights. **PDFs are strictly forbidden from fetch/storage**.
- **Capabilities**:
  - `historyMode`: `historical_range` via `search_query=submittedDate:[YYYYMMDDTTTT TO YYYYMMDDTTTT]`.
  - Rate handling: **Mandatory ≥ 3.0-second delay between consecutive requests, strictly single-threaded connection**. Bounded slices of up to 2,000 results per request (max 30,000 per query tree).

### 4.5 `chrome_release_notes` & `react_blog` (Article Collectors)
- **Chrome Release Notes**:
  - Endpoint: `https://developer.chrome.com/release-notes/{version}`
  - Rights: CC BY 4.0 (Google Developers documentation license). Requires attribution.
  - Parsing constraint: Server-rendered HTML; EXP-001 demonstrated regex parsing fails due to layout shifts; DOM parsing with semantic selectors is required.
- **React Blog**:
  - Endpoint: `https://react.dev/rss.xml` with article fetch at `https://react.dev/blog/*`
  - Rights: CC BY 4.0 (explicitly governed by `LICENSE-DOCS.md` in the React repository).
  - Capability: `feed_only` (RSS discovery + HTTP article fetch).

### 4.6 `chrome_origin_trials`
- **Endpoint**: `https://developer.chrome.com/origintrials/`
- **Rights & Policy**: CC BY 4.0.
- **Transport**: **Playwright browser rendering required** (HTTP response is a bare `This page requires Javascript.` placeholder).
- **Capability**: `snapshot_only`. No publication timestamp exists (status record with milestone ranges).

### 4.7 `npm_registry` & `npm_downloads`
- **Registry Endpoint**: `https://registry.npmjs.org/{package}`
- **Downloads Endpoint**: `https://api.npmjs.org/downloads/range/{period}/{package}`
- **Rights**: Public package metadata. No proprietary claims on download counters.
- **Privacy Requirement**: Must strip `maintainers[].email`, `author.email`, and `_npmUser.email` before raw storage.
- **Capability**:
  - Registry: `snapshot_only` (current package manifest; ETag conditional request supported).
  - Downloads: `historical_range` (up to 18 months, 128 packages bulk).

### 4.8 `github_search` & `huggingface_hub` (Metric Observation)
- **GitHub Search**:
  - Endpoints: `GET /search/repositories`, `GET /search/issues`
  - Auth: **Mandatory `GITHUB_PAT`** (Unauthenticated has a documented limit of 10/min but demonstrated 50% HTTP 403 failure in EXP-001). Authenticated search rate is 30 req/min.
  - Limitation: Results capped at 1,000 items per query. Historical star progression cannot be retroactively reconstructed due to GitHub 2026 API changes.
- **Hugging Face Hub**:
  - Endpoints: `GET https://huggingface.co/api/models`, `/api/datasets`
  - Rights Scope: **Metric observation only** (`model_activity`: count, downloads, likes). Model card text and dataset contents are excluded from document storage due to unreviewed heterogeneous third-party licenses.

---

## 5. Excluded & Rejected Candidate Target Analysis

The table below catalogs external candidates evaluated during `DISC-001`, `ADR-0004`, and `DISC-003`, detailing why they are excluded from the active ingestion pipeline.

| Candidate Source | Reason for Exclusion / Rejection | Authoritative Reference / Rule | Current Status |
|---|---|---|---|
| **Reddit** | Data API terms forbid AI model training without written agreement; requires active deletion sync; ADR-0014 uncommitted; anti-bot measures on web scraping. | Reddit Data API Terms (2023–2026), ADR-0004 §Alternatives | **BLOCKED / DISABLED** |
| **Hacker News (YC)** | Y Combinator Terms of Use contain broad bans on data mining, automated scraping, and derivative works. Ambiguity remains whether Firebase API is exempt for RAG/AI storage. | Y Combinator Terms of Use, ADR-0004 §Alternatives | **EXCLUDED / BLOCKED** |
| **GitHub Trending** | No official API; ranking algorithms are private/non-reproducible; HTML scraping violates GitHub Acceptable Use Policies. | GitHub Acceptable Use Policy, ADR-0004 §Alternatives | **REJECTED** |
| **Lobsters** | Site Acceptable Use Policy and robots.txt forbid automated crawlers and data harvesting without operator approval. | Lobsters Rules / AUP | **REJECTED** |
| **dev.to (Forem)** | Rate limits and API Terms of Service restrict large-scale data republication and commercial embedding without publisher consent. | Forem API Terms | **REJECTED** |
| **MDN Web Docs** | Licensed under CC BY-SA 2.5 with ShareAlike restrictions; official public GitHub repository already exists, rendering web scraping redundant. | Mozilla Open Org Docs Policy, ADR-0004 | **EXCLUDED** |
| **discuss.python.org** | Governed by CC BY-NC-SA (NonCommercial) license; incompatible with commercial neutrality standards. | PSF Terms of Service | **EXCLUDED** |
| **OpenAI / Anthropic Docs** | Proprietary copyright; no explicit open reuse/embedding license; links only. | Provider Terms of Service, ADR-0004 | **EXCLUDED (Links Only)** |
| **Papers with Code** | Platform officially sunset on 2025-07-24; API endpoints deactivated. | Official Sunset Announcement (2025) | **DEFUNCT / REJECTED** |

---

## 6. Recommendations & Governance Action Items for Coordinator

1. **ADR-0014 Reconciliation**:
   - Update `TASKS.md` (DEC-010 item) to reflect that ADR-0014 was not adopted as a committed ADR, and Reddit remains governed by ADR-0004 as disabled.
   - Synchronize `docs/SOURCE_CATALOG.md` and `docs/TRACEABILITY.md` to reference this DISC-003 investigation report as the authoritative rights audit.
2. **DEC-012 Activation Scope Preparation**:
   - Deliver this report to the coordinator as the formal basis for `DEC-012` (Expansion Source and Scope Approval).
   - Require explicit user approval in `DEC-012` before setting `enabled: true` for any seed target or allocating live token/HTTP budgets.
3. **Guard Verifications**:
   - Confirm that `users_rust_lang` collector enforces the `2020-07-17` license cutoff.
   - Confirm that `stack_exchange` collector requires `content_license` for excerpt display and marks revisions as `verbatim_only`.
   - Confirm that `arxiv` collector processes only descriptive metadata and drops all PDF requests.
   - Confirm that `huggingface_hub` and `npm_registry` collectors strip PII and record only approved metric observations.

---

*Report prepared by Research Subagent under DISC-003 mandate. No live data collection, provider activation, or file mutation outside this isolated artifact was conducted.*

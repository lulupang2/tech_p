# DISC-002: Source Credential Verification & Auth Rate Re-measurement

- Status: GATE (credential framework ready; actual measurement requires user-provided secrets — see AGENTS.md §11, SECURITY.md §7)
- Dependency for: COL-001 (collector port + policy guard)
- Source: EXP-001 (Done, 2026-09-01); measurement protocol inherited from [EXP-001](./EXP-001-source-feasibility.md)
- Security: Actual values must NOT be committed (THR-005; `.env.example` holds placeholder names only)

## Required credentials (placeholder names only — never commit real values)

Registered in `apps/api/.env.example` and `apps/worker/.env.example`:

| Source | Env variable(s) | Auth state requirement per EXP-001 |
|---|---|---|
| `github_releases`, `github_search` | `GITHUB_PAT` | Auth required for releases (5,000/h); auth **mandatory** for search (unauthed 50% failure) |
| `stack_exchange` | `STACK_EXCHANGE_KEY` | Read-only collection uses an API key (doc quota 10,000/day); OAuth access token is unnecessary |
| `huggingface_hub` | `HUGGINGFACE_TOKEN` | Recommended (anon 500/5min; auth 1,000/5min) |

## Authenticated rate re-measurement protocol (post-credential)

When real credentials are injected (not committed), run this sequence:

1. Confirm `GITHUB_PAT`, `STACK_EXCHANGE_KEY`, `HUGGINGFACE_TOKEN` are present in environment.
2. Repeat EXP-001 run 2 conditions for 3 sources requiring auth:
   - `github_releases`: 10x repeat fetch with ETag conditional request; expect 5,000/h rate; measure p50/p99 latency.
   - `github_search`: 10x repeat with auth; document `incomplete_results`; measure success rate (expected 100% with auth vs 50% without) and rate header `X-RateLimit-Remaining`.
   - `stack_exchange`: 10x repeat with `site=stackoverflow` + one target tag from SOURCE_CATALOG; confirm `backoff` handling; measure `quota_remaining` and `backoff` values after each request.
3. Record raw measurements to `docs/experiments/disc-002/auth-rate-measurement.json` (same schema as EXP-001 `repeat-result.json`).
4. If any source fails 10/10 auth repeat, block `COL-001` and document failure mode (403, 429, timeout, missing rate header) with sanitized error code only (SECURITY.md §9 — no full response body in logs).

## Acceptance (DISC-002 GATE)

- `.env.example` files contain placeholder names for all 3 credential types.
- `SECURITY.md` §8 references the correct source-level removal rules and the auth requirement mapping.
- No real secret value appears in any committed file (`git diff` must show only placeholder strings like `ghp_...` / `<key>` / `hf_...`).
- `DISC-002` is satisfied when: (a) placeholders are present; (b) measurement protocol is documented above; (c) user confirms credentials are available at deploy time (injected, not committed). The actual 10x auth measurement can then proceed without blocking COL-001 framework work.

# EVAL-002: fixed-corpus release evaluation

## Latest continuation: L-001-only resume (2026-09-11 03:25 UTC)

The current automated candidate is `eval002-2026-09-11T03-25-45-334Z-live/report.json`, SHA-256 `a43d00c59efe35dc065d1c5cdba3c9989928986af185116d96ac0c5ebe79565d`. This supersedes the older candidate references below; historical reports and measurements are unchanged. **EVAL-002 remains READY for human review; COV-010 and MVP-001 remain BLOCKED.**

The runner resumed `eval002-2026-09-11T02-31-29-990Z-live/report.json` (SHA-256 `483afb5563e5b6cfd8ad6c3811c5f49912e5cedc7dd9594cbe2a47cbdb6e29a3`). It reused all recorded retrieval results and seven answer rows without changing their serialized values, and reevaluated only `L-001`. The report binds both source/code digests and the reused/retried IDs. Resume validates exact corpus/label identities, source and current model profiles, source-manifest compatibility, preflight/postflight fingerprints, source gates, answer/citation contracts, budget state and recorded chunk membership/ranks against the fixed DB before dispatch. Only the resume runner and approved repository-alias repair may differ in the source manifest.

The approved `facebook/react` to `react/react` mapping is retained. Repository scoping now parses the URL and requires the exact HTTPS GitHub host and owner/repository path; lookalike hosts, query-string matches, credentials and unrelated repositories are rejected. No new source or alias was activated.

The actual increment was **1 embedding call / 18 input tokens and 1 chat call / 1,518 input / 93 output tokens**, costing a conservative 243 micro-USD. DEC-014 now totals **97/100 embedding calls, 32/60 chat calls and 10,999/250,000 micro-USD**, with zero unknown reservations. The original 255 ledger lines are preserved and only four reserve/settle events were appended. A separate pre-dispatch guard caps a resume run at one embedding and one chat call. No full live evaluation was repeated.

Automated result: `automatedMvpGatePassed=true`, hybrid Recall@10 **1.0**, reused warm DB p95 **314.45 ms**, answered **4/4**, abstention **4/4**, structured output **100%**, answer p95 **5,169.25 ms** and time/rights/profile/provenance violations **0**. The only blockers are `live_label_review_pending` and `semantic_answer_review_pending`. CLI exit status 2 is intentional while `releaseGatePassed=false`; it is not a provider execution failure.

Final checks passed on local Windows Node **26.5.0**: RAG **103/103** tests, API **177/177** tests (including **56** resume/scorecard and **29** human-review-finalizer tests), both package typechecks, RAG/API ESLint and Prettier, and `git diff --check`. The sanitized record is `resume-validation-2026-09-11T03-25-45-334Z.json`. This does not claim a new whole-workspace integration, browser or deployment run.

Human-review material is terminal-only. All eight labels and all six citation excerpts were checked/displayed against persisted evidence hashes; the TypeScript excerpt is an adjacent two-chunk assembly. `--show-review` displayed the newly generated L-001 answer. The three reused answer originals (`L-007`, `L-014`, `L-017`) are **not recoverable from the sanitized hashes**, and their source-run terminal outputs were absent from the currently connected session recordings. Recover those exact outputs and match their answer hashes before requesting final approval. Do not regenerate them, infer their contents from citations, or create an attestation from an instruction to continue. No human-review JSON or final acceptance file was created.

## Current boundary (2026-09-11)

The application runner, strict evaluation options, cumulative budget guard, corpus-membership checks and draft applicability report are implemented. **This is not an EVAL-002 or COV-010 pass.** COV-010 and MVP-001 remain blocked. The current implementation intentionally cannot turn incomplete execution or missing human review into a release pass.

The fixed corpus remains `cov009-20260910-live-v1`, SHA-256 `0cb1435f0629039f5189008ac189013c85d8766e8d7507328409355eb80f655f`, with 28 revisions and 500 chunks. Existing measurement files and all 43 original golden labels are preserved. The current live-label draft contains **39 answerable retrieval questions plus 6 coverage-negative questions**. The separately selected 12-question answer subset references all 28 revisions/500 chunks; it is not the entire retrieval set. Its status remains `proposed-human-review-required`.

## Historical budget breach

[historical-usage-audit.json](./historical-usage-audit.json) records five independent successful executions: original EXP-002 plus four ad-hoc reruns. Primary evidence is the original sanitized measurement and local recording `2026-09-10-da56e01a`, command/poll pairs `TC1/TC4`, `TCD/TCE`, and commands `TCL`, `TCN`. Start/poll pairs, handoffs and repeated summaries are never counted twice.

The verified lower bound is **195 successful query-embedding calls and 6,290 reported embedding tokens**. The approved total call cap is 100, so it was exceeded by at least 95 calls. This does **not** prove that the USD or token caps were exceeded. Exact historical calls/tokens, chat usage and total cost remain unknown. In [prior-usage.json](./prior-usage.json), monetary usage retains only the original 6 micro-USD lower bound; zero chat counters mean unaccounted, not zero historical use.

`prior-usage.json` remains `reconciled=false` and preserves the historical lower bound. That legacy DEC-013 tranche remains exhausted. The user subsequently approved DEC-014 as a **separate additional tranche**: USD 0.25 total, embedding 100 calls/100,000 input tokens, chat 60 calls/300,000 input/30,000 output tokens, concurrency 1, retry/fallback 0. The approval is stored in `dec-014-allowance.json`, bound to the exact historical-usage digest, and its usage is appended only to `dec-014-ledger.jsonl`. This does not reset, refund, or reconcile the old history.

## Runner modes

Entrypoint: `apps/api/src/release-evaluation-cli.ts`.

| Mode | Permitted activity | Meaning |
|---|---|---|
| `plan` | Local source/label/history reads and new sanitized report files; no config credentials, DB or provider construction | Draft coverage/applicability and outstanding blockers only |
| `preflight` | SELECT-only fixed-DB corpus, rights/profile, partition and scoped coverage checks | No provider calls, migrations, corpus writes or release pass |
| `negative-diagnostic` | Preflight plus six lexical-only questions with a throwing fake chat port | FTS diagnostic only, not the hybrid/answer quality gate |
| `live` | DEC-014 additional-tranche admission first, then approved budgeted runtime ports | Runs only while the separate allowance/ledger remains valid and within caps |

For a credential-free plan, run from repository root:

```sh
pnpm --filter @techpulse/api exec node --import=tsx/esm src/release-evaluation-cli.ts --mode=plan
```

The package's `evaluate:release` shortcut loads its `.env`; use the explicit command above for offline planning. The local verification environment used already-installed Node `v26.5.0` and pnpm `10.32.1` through `fnm exec --using=26.5.0 -- ...`. No runtime was installed and the production Node pin was not changed.

The active additional-tranche ledger path is `docs/experiments/eval-002/dec-014-ledger.jsonl`. Its header is bound to both the exact `prior-usage.json` digest and the exact DEC-014 allowance digest. The runner never resets it. It requires exclusive lock, complete newline-delimited records and no unresolved reservation. Writes are flushed before dispatch; cancellation, timeout, missing/invalid usage, model mismatch and uncertain outcomes retain reservations. The historical DEC-013 usage remains separately visible in every budget snapshot.

## Evidence and scoring

Reports record dataset/label/source-manifest digests, commit and dirty state, explicit model/configuration when loaded, applicability counts, coverage, budget, results and blockers. Plan-only `answerSubset.complete` is **null**, even when counts match. Exact chunk-to-revision, target and period membership must be checked against the independently verified DB snapshot before completeness can be true. A matching dataset hash declared inside a label file is not proof that its evidence IDs are correct.

The score definition is `chunk-cutoff10-unique-revision-v2`: cut off at the first ten actual chunks, count a relevant revision only once, and retain original chunk ranks for discounted gain. The earlier EXP-002 scorer deduplicated revision ranks before cutoff. Do not describe old/new values as a directly comparable same-metric improvement. Identity relevance does not establish semantic citation support; human citation precision/coverage and unsupported-claim metrics stay null until genuine review.

The 43-item applicability table retains original expected statuses, question hashes and a visible denominator for every item. `coverage_not_applicable` is an evaluation annotation, not a public `AnswerStatus` and not an automatic pass. All five injection cases remain mandatory controlled-fixture work. Reviewed label digest and semantic reviewer evidence are pending, not invented.

## Existing fixed-DB observations (not re-executed by the offline fixes)

- `eval002-2026-09-10T11-06-28-413Z-preflight/report.json`: original fixed hash, 28/500/500 and 10 completed partitions; target counts React 4, Playwright 5, TypeScript 1, Node.js 18, pgvector 0.
- `eval002-2026-09-10T10-56-57-668Z-negative-diagnostic/report.json`: L-040 through L-045 returned `insufficient_evidence` in the real fixed-DB FTS path with no provider call. This is not evidence of a completed hybrid/provider evaluation.
- `eval002-2026-09-10T10-56-09-587Z-live/report.json`: historical unreconciled-usage rejection. Preserve it as a historical result; the later audit adds the independently proven call-cap breach.

## Offline verification and COV-011 completion

[offline-validation-2026-09-10.json](./offline-validation-2026-09-10.json) records the completed commands, runtime and limitations. Final root static passed all ten workspace typechecks, ESLint and Prettier. Focused API tests passed 41, domain budget/coverage 28, RAG 89 and isolated PostgreSQL search/coverage 9. COV-011 is DONE on this implementation/fixture evidence; EVAL-002 and COV-010 are not passed.

The nested output-cap regression first reproduced `2000 !== 12` through the release wrapper plus actual runtime budget service with a fake DB/provider. The inner provider budget now reserves and forwards the minimum of the requested and approved output caps, rather than widening a stricter release reservation. The composed regression passes after the fix.

Preserved CLI proof before the final inner-budget fix and formatting:

- `eval002-2026-09-10T14-46-18-300Z-plan/report.json`: no provider/DB construction, all 43 baseline rows visible and unexecuted, answer-subset counts match but independent membership is pending and completeness is null.
- `eval002-2026-09-10T14-46-21-980Z-live/report.json`: `release_budget_exhausted`, 195 historical successful embedding calls as a lower bound, zero provider calls this run, no model/config/preflight stage reached. Node exits 2 intentionally. The later inner-budget fix does not change this admission guard. A subsequent CLI rerun request was blocked by the bridge before a result was returned; it is not recorded as a successful rerun.

The original 43-label digest is `3878260c83617fb74fba7f98df2af15bf7ee0c980f89b69fd08ce8771fe2289c`; live-label file digest is `415db8671b8ba77e4c5349f3df62b2d388c425e7952b162c68c63308171215a6`. Both match the previous fixed-DB preflight. No new canonical ledger was created, no unknown reservation was refunded, and no paid provider call or fixed-corpus write was performed by this continuation.

## Remaining release work

The ADR-0019 representative 8-item fixed-corpus automated live gate passed on 2026-09-11. The canonical passing measurement is `eval002-2026-09-11T00-50-33-713Z-live/report.json`; the compact derived acceptance summary is `automated-mvp-acceptance-2026-09-11.json`. Hybrid Recall@10 was 1.0 with warm DB p95 282ms; all four answerable rows returned `answered` with at least one relevant citation, all four negative rows correctly abstained, structured output was 100%, and answer p95 was 4.92s. Time/rights/profile/provenance violations remained zero.

Earlier live runs are retained because they exposed real Nemotron citation-format failures. The same item IDs were rerun after product fixes; no evaluation question was swapped. The last Node case was repeatedly truncated at the former 350-token per-call cap, so the internal safety cap was raised to 700 while DEC-014's total 30,000 output-token hard cap remained unchanged. After the fix, the same `L-017` case returned structured output with validated citations.

DEC-014 cumulative usage after the passing run is 7,044 micro-USD (USD 0.007044), 48 embedding calls/904 input tokens and 16 chat calls/43,372 input/3,215 output tokens, with zero unknown reservations and no cap exceeded. No further paid rerun is required for the automated gate.

Remaining EVAL-002 work is deliberately human-only: review the live labels and perform answer/evidence-linked semantic review for the four answered rows. Citation identity alone must not be treated as semantic correctness. The original 43-item suite remains a diagnostic regression asset rather than an MVP blocker. Final COV-010 still needs the required examples and coverage/cost/freshness evidence. Historical accounting remains unreconciled by design and no additional source or deployment is enabled here.

# Lite Annotate Tracker

Last updated: 2026-05-16

Source of truth for Person A / Person B ownership, current status, and commit-level progress.

## Current Status

| Lane | Owner scope | Status | Current proof | Next action |
| --- | --- | --- | --- | --- |
| Person A | Widget capture, hosted API, report persistence, memory write/search, report visibility, Person B handoff payload | Complete for hackathon demo | Hosted report `bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430`; native GBrain memory write/search confirmed with OpenAI embeddings; `/reports/dashboard` shows current hosted report | Keep tracker updated if capture/report contract changes |
| Person B | Repo indexing, candidate ranking, diagnosis, patch generation, temp-clone verification, GitHub PR | Hosted PR-opening proof complete | Commits `69c1f75` through `2f72925`; worker/API tests; hosted handoff exposes Memory Impact, Cold Agent vs Memory Agent, and Memory Receipts for `bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430`; dry-run analysis implemented locally in `0dc53f6`; hosted deployment `7454d1aa-a367-4313-8205-3e4b34b60b52` ran dry-run and PR mode against `ibrolord/lite-annotate-demo-pr-proof`; PR opened: https://github.com/ibrolord/lite-annotate-demo-pr-proof/pull/1 | Review PR #1 or reset the proof repo if the demo needs to be rerun |

## Person B Start Packet

Person B should be able to start with only:

```text
reportId: bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430
repo: ibrolord/lite-annotate-demo-pr-proof
normalized report JSON: GET /reports/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430
memory search result: GET /reports/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430/memory
handoff payload: GET /reports/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430/handoff
autofix result: GET /reports/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430/autofix
autofix dry-run trigger: POST /reports/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430/autofix?dryRun=1
autofix PR trigger: POST /reports/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430/autofix
dashboard: https://lite-annotate-production.up.railway.app/reports/dashboard
```

## Commit Ledger

Update this table on every repo commit that changes the demo, contract, capture path, memory path, diagnosis path, verification path, deployment path, or tracker state.

| Commit | Lane | What changed | Status | Proof / note |
| --- | --- | --- | --- | --- |
| `0b31183` | Shared | Initial Lite Annotate demo from bug widget to GBrain to fix PR | Baseline | Pre-split prototype |
| `3218e95` | Shared | Added hackathon collaboration plan | Done | Established collaboration structure |
| `dfb7d3b` | Shared / Memory | Documented GBrain validation and revised plan | Done | Confirmed GBrain role as memory/retrieval with markdown fallback framing |
| `03c44b7` | Shared | Added Lite Annotate PRD | Done | Product and demo contract source |
| `91042ca` | Person B | Prioritized PR accuracy gates | Done | Defined patch/PR correctness gates before implementation |
| `1372115` | Person A | Documented capture breadcrumbs | Done | Confirmed annotation, screenshot, console, network, and session breadcrumb scope |
| `81b8e62` | Shared | Added agent execution plan | Done | Defined Person A / Person B split and shared report/diagnosis contracts |
| `69c1f75` | Person B | Added repo context ranking | Done | Candidate file ranking foundation |
| `48abb87` | Person B | Added diagnosis gate | Done | Diagnosis output and confidence gate |
| `182d1e3` | Person B | Added patch verification gate | Done | Verification checks before PR eligibility |
| `ca954e0` | Person B | Added scoped patch generation | Done | Patch limited to target files |
| `41c3822` | Person B | Wired Person B pipeline | Done | End-to-end local pipeline composition |
| `de6f478` | Person B | Added verified PR gate | Done | PR creation guarded by diagnosis, scope, and verification checks |
| `0bb17be` | Person B | Used Person B autofix path | Done | Connected autofix path to Person B pipeline |
| `0ee6887` | Person B / Validation | Ran repo checks before smoke | Done | Validation checkpoint before API exposure |
| `112fd1c` | Person A | Built capture and memory lane | Done | `npm test`; widget/API/memory/report/handoff tests |
| `9557caa` | Shared | Merged capture memory lane into master | Done | Brought Person A capture path together with Person B work |
| `2f72925` | Person B / API | Exposed Person B results | Done | `/reports/:id/autofix`; handoff includes autofix summary |
| `2f99ce3` | Deploy | Added runtime start script on master | Done | Runtime dependency/script alignment |
| `365b13c` | Person A / Deploy | Added Railway runtime start script | Done | Railway runtime could start with `tsx` dependency |
| `719d009` | Person A / Visibility | Added reports dashboard | Done | Hosted dashboard smoke passed with report `bug_234d5d51-b5a4-4395-9031-5016dd446a1b` |
| `f100e4e` | Shared / Tracker | Added Person A and B tracker | Done | `docs/TRACKER.md` linked from README |
| `55744ff` | Shared / Merge prep | Merged current master into Person A tracker branch | Done | Resolved Person A dashboard with Person B API conflicts |
| `6b70a72` | Shared / Merge | Merged PR #1 into `master` | Done | Main includes Person A capture/dashboard, Person B pipeline/API, and tracker |
| `3cf15f7` | Shared / Memory | Showed memory impact in handoff, report view, and autofix response | Done | `npm test`; `npm run typecheck`; deterministic prior-memory hit for pinned demo |
| `a9982a7` | Shared / Memory | Added cold-vs-memory comparison and memory receipts | Done | `npm test`; `npm run typecheck`; handoff/view/autofix expose receipt trail |
| `c277cd9` | Shared / Memory | Documented the cold-vs-memory demo story | Done | Added `docs/GBRAIN_DEMO_STORY.md` and linked demo narrative |
| `d057d1d` | Deploy | Added Vercel deployment adapter | Done | Added `api/vercel.ts` and `vercel.json`; Railway path remains available |
| `ac5a599` | Shared / Memory | Restored native GBrain HTTP helper utilities | Done | `api/gbrain.ts` supports native MCP helpers on `master` |
| `af0b0fa` | Shared / Memory | Added native GBrain MCP adapter tests and setup docs | Done | `npm test`; `npm run typecheck`; fake MCP server covers OAuth, native write/search, and markdown fallback |
| `0dc53f6` | Shared / Validation | Added dry-run analysis mode | Done | `npm test`; `npm run typecheck`; `?dryRun=1` verifies without opening a PR |
| `hosted-person-b-2026-05-16` | Person B / Deploy | Unblocked hosted Person B repo cloning and diagnosis | Partial | Railway env now has target repo/GitHub credentials and `RAILPACK_DEPLOY_APT_PACKAGES=git`; deployment `e3f90218-e3df-46ab-acb6-0e2eb4f3b26c`; live autofix for `bug_81e3cf24-7343-4081-a618-c9a8372f7187` ranked `src/users.js` but did not open a PR because `ibrolord/lite-annotate-demo` already merged fix PR #1 |
| `hosted-person-b-pr-2026-05-16` | Person B / PR proof | Opened a hosted verified PR from Person B | Done | Proof repo `ibrolord/lite-annotate-demo-pr-proof`; Railway deployment `7454d1aa-a367-4313-8205-3e4b34b60b52`; dry-run returned `verified_no_pr` with verification passing; normal autofix returned `pr_opened`; PR https://github.com/ibrolord/lite-annotate-demo-pr-proof/pull/1 modifies `src/users.js` after `npm run test`, `node --check src/users.js`, and smoke command passed |
| `gstack-runner-2026-05-16` | GStack Runner / Safety | Added protected remote GStack runner integration | Ready for deploy setup | `npm run typecheck`; `npm test` 37/37; runner health smoke on `localhost:3025`; trigger requires `GSTACK_TRIGGER_TOKEN`; non-PR runner jobs strip write GitHub credentials; callbacks strip raw logs; report updates serialize per report |
| `gstack-runner-stdio-2026-05-16` | GStack Runner / Safety | Ignored runner child stdin explicitly | Done | Uses Node `stdio` option so spawned Claude/Git processes cannot hang on inherited stdin |
| `gstack-trigger-token-2026-05-16` | GStack Runner / Safety | Made missing trigger token fail closed | Done | `npm test` 39/39; unauthenticated GStack trigger must return 503 when `GSTACK_TRIGGER_TOKEN` is absent |
| `report-repo-callback-retry-2026-05-16` | Person B / GStack Runner | Preferred report repo and retried runner callbacks | Done | Autofix uses report-scoped repo over hosted env defaults when the repo is trusted; runner persists failed results and retries Lite Annotate callbacks before marking callback failure |
| `gstack-mode-stack-ranking-2026-05-16` | GStack Runner / Ranking | Preserved runner mode and stack-frame evidence | Done | `npm run typecheck`; `npm test` 45/45; callbacks keep review mode, code ranking reads console stack fields and prioritizes first stack frame |
| `hosted-gstack-review-2026-05-16` | GStack Runner / Deploy | Ran authorized hosted GStack runner review | Done | Railway deployment `7a1e00bc-404a-4e94-8974-a03e476e7de4`; unauthenticated trigger returns 401; authorized job `gstack_84508758-0dbd-493d-aaf3-3867b6e31b69` returned `passed` and replaced the stale queued record |
| `model-backed-autofix-2026-05-16` | Person B / Auto-Fix | Added model-backed patch generation with HTML/CSS file finding | Done | `npm run typecheck`; `npm test` 48/48; `git diff --check`; real ecommerce repo ranking returns `index.html` and `src/styles.css` as top targets before model patching |
| `autofix-generic-pr-gates-2026-05-16` | Person B / Auto-Fix | Removed demo-specific default smoke checks | Done | `npm run typecheck`; focused Auto-Fix/verification/PR-gate tests; CSS patches now get generic syntax verification and PR gate refuses patches with no recorded verification checks |
| `hosted-gbrain-embeddings-2026-05-16` | Person A / Memory | Enabled hosted GBrain OpenAI embedding provider and parsed hosted text search hits | Done | GBrain deployment `363b8751-c562-4f31-a794-f0e4df239d96`; `/health` returns `0.35.1.0` on Postgres; OAuth metadata returns `client_credentials`; `gbrain providers list` shows `openai` ready; `gbrain embed --stale` embedded 23 chunks across 15 pages; direct search returns `bugs/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430` at score `1.0000`; `tests/memory.test.ts` covers hosted text search parsing |
| `autofix-trusted-pr-gates-2026-05-16` | Person B / Auto-Fix | Hardened model and PR trust gates | Done | `npm run typecheck`; `npm test` 67/67; `git diff --check`; report repos must match server allowlist or configured repo before credentialed PRs; model fallback cannot upgrade an unpatchable diagnosis; TS/TSX patches record sanity checks; PR base branch matches verified checkout branch |
| `autofix-always-runs-artifacts-2026-05-16` | Person B / Auto-Fix | Added patchability artifact routing for always-run Auto-Fix | Done | `npm run typecheck`; `npm test` 91/91; `git diff --check`; focused Auto-Fix/API/artifact tests 27/27. Weak/low-confidence reports now open verified instrumentation, regression-test, or setup artifact PRs instead of diagnosis-only output; already-applied product-code fixes generate a verified fallback artifact PR on full runs; missing GitHub credentials, untrusted repos, workspace setup failures, and PR creation failures return `external_blocker`; dry-run remains the only supported `verified_no_pr` path. Fix PRs and fallback PRs carry artifact metadata, PR stages complete for opened PRs, report views render captured console/network evidence, and GitHub PR writer supports new artifact files. Hosted deployment `632609b5-adfe-4f77-b15a-6d96e2883bcd`; hosted report `bug_b1fa2d9d-683b-40c2-b1a3-307ceabb5705` returned `pr_opened` with `setup_pr`, markdown sanity verification, artifact metadata, and PR https://github.com/ibrolord/lite-annotate-demo-pr-proof/pull/4. |

## Gates

| Gate | Person A status | Person B status |
| --- | --- | --- |
| Capture Gate | Pass | Uses Person A payload |
| API Gate | Pass | Uses `GET /reports/:id` |
| Contract Gate | Pass | Depends on unchanged normalized JSON |
| Memory Gate | Pass with hosted native GBrain, OpenAI embeddings, and markdown fallback adapter | Consumes `searchSimilar` output; hosted report, diagnosis, and outcome writes returned `provider: gbrain`; hosted GBrain semantic search returns the target report at score `1.0000` |
| GStack workflow | Optional developer/agent workflow; not required for runtime capture/report demo | Optional for planning/review/QA/ship; record evidence only when an actual GStack command or skill is used |
| Demo Visibility Gate | Pass via `/demo`, `/reports/:id/view`, and `/reports/dashboard` | Uses dashboard/handoff links |
| Person B Handoff Gate | Pass | Pass |
| Repo indexing | Out of scope | Pass locally |
| Candidate ranking | Out of scope | Pass locally |
| Diagnosis | Out of scope | Pass locally |
| Patch generation | Out of scope | Pass locally; uses configured OpenAI coding model only after diagnosis already marks the report patchable |
| Temp clone verification | Out of scope | Pass locally; PR gate requires at least one recorded verification check, with JS/CSS/HTML/TS sanity coverage plus optional repo package scripts |
| GitHub PR | Out of scope | Pass; hosted credentialed PR opened at https://github.com/ibrolord/lite-annotate-demo-pr-proof/pull/1 and ecommerce proofs opened PRs #5/#6; credentialed PR mode requires a trusted repo allowlist/configured repo |

## Tracker Rules

1. Every implementation commit should update the commit ledger before merge.
2. If a commit changes the report or diagnosis contract, update `docs/AGENT_EXECUTION_PLAN.md` and this tracker in the same PR.
3. If a deploy validates a commit, record the deployment ID and hosted report ID in the proof column.
4. Person B must not open a PR unless the PR gate in `docs/AGENT_EXECUTION_PLAN.md` passes.

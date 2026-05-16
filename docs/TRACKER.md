# Lite Annotate Tracker

Last updated: 2026-05-16

Source of truth for Person A / Person B ownership, current status, and commit-level progress.

## Current Status

| Lane | Owner scope | Status | Current proof | Next action |
| --- | --- | --- | --- | --- |
| Person A | Widget capture, hosted API, report persistence, memory write/search, report visibility, Person B handoff payload | Complete for hackathon demo | Hosted report `bug_234d5d51-b5a4-4395-9031-5016dd446a1b`; Railway deployment `d632704f-03f5-4383-9efc-3c7a0c879d72`; `/reports/dashboard` shows context and handoff | Keep tracker updated if capture/report contract changes |
| Person B | Repo indexing, candidate ranking, diagnosis, patch generation, temp-clone verification, GitHub PR | Implemented locally; hosted PR-opening proof still pending | Commits `69c1f75` through `2f72925`; worker/API tests; `/reports/:id/autofix` stores and exposes Person B results | Run hosted `/reports/:id/autofix` with target repo and GitHub credentials configured |

## Person B Start Packet

Person B should be able to start with only:

```text
reportId: bug_234d5d51-b5a4-4395-9031-5016dd446a1b
repo: ibrolord/lite-annotate-demo
normalized report JSON: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b
memory search result: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b/memory
handoff payload: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b/handoff
autofix result: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b/autofix
autofix trigger: POST /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b/autofix
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

## Gates

| Gate | Person A status | Person B status |
| --- | --- | --- |
| Capture Gate | Pass | Uses Person A payload |
| API Gate | Pass | Uses `GET /reports/:id` |
| Contract Gate | Pass | Depends on unchanged normalized JSON |
| Memory Gate | Pass with markdown/GBrain fallback adapter | Consumes `searchSimilar` output |
| Demo Visibility Gate | Pass via `/demo`, `/reports/:id/view`, and `/reports/dashboard` | Uses dashboard/handoff links |
| Person B Handoff Gate | Pass | Pass |
| Repo indexing | Out of scope | Pass locally |
| Candidate ranking | Out of scope | Pass locally |
| Diagnosis | Out of scope | Pass locally |
| Patch generation | Out of scope | Pass locally |
| Temp clone verification | Out of scope | Pass locally |
| GitHub PR | Out of scope | Gate implemented; hosted credentialed PR proof pending |

## Tracker Rules

1. Every implementation commit should update the commit ledger before merge.
2. If a commit changes the report or diagnosis contract, update `docs/AGENT_EXECUTION_PLAN.md` and this tracker in the same PR.
3. If a deploy validates a commit, record the deployment ID and hosted report ID in the proof column.
4. Person B must not open a PR unless the PR gate in `docs/AGENT_EXECUTION_PLAN.md` passes.

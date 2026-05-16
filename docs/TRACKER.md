# Lite Annotate Tracker

Last updated: 2026-05-16

Source of truth for Person A / Person B ownership, current status, and commit-level progress.

## Current Status

| Lane | Owner scope | Status | Current proof | Next action |
| --- | --- | --- | --- | --- |
| Person A | Widget capture, hosted API, report persistence, memory write/search, report visibility, Person B handoff payload | Complete for hackathon demo | Hosted report `bug_234d5d51-b5a4-4395-9031-5016dd446a1b`; Railway deployment `d632704f-03f5-4383-9efc-3c7a0c879d72`; `/reports/dashboard` shows context and handoff | Keep tracker updated if capture/report contract changes |
| Person B | Repo indexing, candidate ranking, diagnosis, patch generation, temp-clone verification, GitHub PR | Not started in this repo branch | Handoff endpoint returns `reportId`, `repo`, normalized report JSON, and memory search result | Start from the handoff package below |

## Person B Start Packet

Person B should be able to start with only:

```text
reportId: bug_234d5d51-b5a4-4395-9031-5016dd446a1b
repo: ibrolord/lite-annotate-demo
normalized report JSON: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b
memory search result: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b/memory
handoff payload: GET /reports/bug_234d5d51-b5a4-4395-9031-5016dd446a1b/handoff
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
| `112fd1c` | Person A | Built capture and memory lane | Done | `npm test`; widget/API/memory/report/handoff tests |
| `365b13c` | Person A / Deploy | Added Railway runtime start script | Done | Railway runtime could start with `tsx` dependency |
| `719d009` | Person A / Visibility | Added reports dashboard | Done | Hosted dashboard smoke passed with report `bug_234d5d51-b5a4-4395-9031-5016dd446a1b` |

## Gates

| Gate | Person A status | Person B status |
| --- | --- | --- |
| Capture Gate | Pass | Uses Person A payload |
| API Gate | Pass | Uses `GET /reports/:id` |
| Contract Gate | Pass | Depends on unchanged normalized JSON |
| Memory Gate | Pass with markdown/GBrain fallback adapter | Consumes `searchSimilar` output |
| Demo Visibility Gate | Pass via `/demo`, `/reports/:id/view`, and `/reports/dashboard` | Uses dashboard/handoff links |
| Person B Handoff Gate | Pass | Ready to start |
| Repo indexing | Out of scope | Pending |
| Candidate ranking | Out of scope | Pending |
| Diagnosis | Out of scope | Pending |
| Patch generation | Out of scope | Pending |
| Temp clone verification | Out of scope | Pending |
| GitHub PR | Out of scope | Pending |

## Tracker Rules

1. Every implementation commit should update the commit ledger before merge.
2. If a commit changes the report or diagnosis contract, update `docs/AGENT_EXECUTION_PLAN.md` and this tracker in the same PR.
3. If a deploy validates a commit, record the deployment ID and hosted report ID in the proof column.
4. Person B must not open a PR unless the PR gate in `docs/AGENT_EXECUTION_PLAN.md` passes.

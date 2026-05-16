# Agent Execution Plan

## Objective

Build the hackathon version of Lite Annotate with clear parallel ownership.

The demo goal:

```text
public demo app
  -> widget captures annotation + technical breadcrumbs
  -> hosted API stores report
  -> GBrain memory/retrieval runs
  -> code-context worker finds likely file
  -> diagnosis cites evidence
  -> patch is verified in temp clone
  -> PR opens only after verification
```

Accuracy is the priority. Security hardening is deferred unless it directly affects PR correctness or demo reliability.

## Two-person Split

### Person A: Capture, Hosting, Memory

Owns the path from user report to durable memory.

Primary responsibilities:

- Hosted widget.
- Capture payload.
- Public API.
- Report persistence.
- GBrain or fallback memory.
- Demo page/report visibility.

Primary success gate:

```text
Public demo page submits a report to hosted API, and saved report includes annotation, console, network, session breadcrumbs, and screenshot.
```

### Person B: Code Context, Diagnosis, Verification, PR

Owns the path from saved report to accurate engineering output.

Primary responsibilities:

- Repo clone/fetch.
- Code index and candidate ranking.
- GBrain retrieval integration for code context.
- Diagnosis prompt/schema.
- Patch generation.
- Temp-clone verification.
- GitHub PR creation.

Primary success gate:

```text
Pinned demo report produces a scoped patch to src/users.js, passes checks in temp clone, and opens a PR only after verification.
```

## Shared Contract

Both people must agree on this contract before building independently.

### Report Payload

```json
{
  "id": "bug_...",
  "projectId": "demo",
  "repo": "ibrolord/lite-annotate-demo",
  "title": "User profile crashes reading name",
  "description": "Clicking load profile crashes",
  "url": "https://demo.example.com/users",
  "route": "/users",
  "userAgent": "...",
  "viewport": { "width": 1440, "height": 900 },
  "console": [
    {
      "level": "error",
      "message": "Cannot read properties of undefined reading 'name'",
      "timestamp": "..."
    }
  ],
  "network": [
    {
      "type": "fetch",
      "method": "GET",
      "url": "/api/users/999",
      "status": 404,
      "durationMs": 83,
      "failed": false
    }
  ],
  "session": [
    {
      "type": "click",
      "target": "button:Load User Profile",
      "timestamp": "..."
    }
  ],
  "screenshot": {
    "type": "data-url-or-url",
    "value": "..."
  },
  "createdAt": "..."
}
```

### Diagnosis Output

```json
{
  "type": "bug",
  "severity": "medium",
  "rootCause": "formatUserGreeting dereferences user.name when getUserById returns undefined.",
  "evidence": [
    "Console: Cannot read properties of undefined reading 'name'",
    "Route: /users",
    "Code: src/users.js reads user.name without a guard"
  ],
  "targetFiles": ["src/users.js"],
  "fixStrategy": "Return a fallback greeting when the user is missing.",
  "confidence": 0.82,
  "shouldPatch": true
}
```

### PR Gate

The PR worker may open a PR only when:

```text
candidate top-3 includes src/users.js
diagnosis confidence >= 0.75
targetFiles <= 2
patch modifies only targetFiles
patch applies in temp clone
node --check src/users.js passes
bug-specific smoke check passes
```

Pinned demo smoke check:

```bash
node --check src/users.js
node -e "const { formatUserGreeting } = require('./src/users.js'); console.log(formatUserGreeting(999))"
```

## Parallel Work Plan

### Phase 0: Contract Freeze

Can run in parallel: no. This is the coordination point.

Owner: both people.

Tasks:

1. Confirm report payload schema.
2. Confirm diagnosis output schema.
3. Confirm pinned demo repo and bug.
4. Confirm hosted URLs/env names.
5. Confirm success gates.

Deliverables:

- `docs/PRD.md` remains source of truth.
- Demo repo and expected file are pinned.

Gate:

```text
Both people can build against the same report and diagnosis contracts without further coordination.
```

### Phase 1A: Widget Capture

Owner: Person A.

Can run in parallel with: Phase 1B, Phase 2B.

Tasks:

1. Render widget button and form.
2. Capture annotation title/description.
3. Capture URL, route, userAgent, viewport.
4. Patch `console.log/warn/error`.
5. Capture `window.onerror`.
6. Capture `unhandledrejection`.
7. Wrap `fetch` and XHR for network breadcrumbs.
8. Track lightweight session breadcrumbs:
   - clicks
   - route changes
   - input focus/change events without raw typed values
9. Capture screenshot best-effort.
10. Submit payload to API.

Acceptance tests:

```text
Trigger demo bug -> submit report -> payload contains:
annotation title
console error
network breadcrumb
click breadcrumb
screenshot or screenshot-null with reason
```

### Phase 1B: Hosted API and Report Store

Owner: Person A.

Can run in parallel with: Phase 1A, Phase 2A.

Tasks:

1. Add `POST /report`.
2. Return report ID immediately.
3. Persist raw report.
4. Expose report detail/log view for demo.
5. Enqueue investigation job.
6. Add `/health`.

Acceptance tests:

```text
curl /health returns ok
POST /report returns report id
saved report can be viewed
worker receives job id
```

### Phase 2A: Memory Integration

Owner: Person A.

Can run in parallel with: Phase 2B.

Tasks:

1. Implement memory adapter interface:

```text
putReport(report)
putDiagnosis(reportId, diagnosis)
putOutcome(reportId, outcome)
searchSimilar(report)
```

2. Native path:
   - GBrain HTTP MCP `put_page`.
   - GBrain HTTP MCP `search`.
   - GBrain HTTP MCP `code_refs` if available.

3. Fallback path:
   - GitHub markdown under `bugs/`.
   - Simple keyword search.

4. Add decision flag:

```text
MEMORY_PROVIDER=gbrain|github-markdown
```

Acceptance tests:

```text
submitted report creates memory entry
similar report search returns prior bug
diagnosis outcome can be written back
```

### Phase 2B: Repo Context Index

Owner: Person B.

Can run in parallel with: Phase 1A, Phase 1B, Phase 2A.

Tasks:

1. Clone or fetch configured GitHub repo into temp workspace.
2. Ignore `node_modules`, build outputs, lockfiles, env files.
3. Build JS/TS index:
   - file path
   - imports
   - exports
   - functions/classes/components
   - route hints
   - symbol references
   - nearby test files
   - package scripts
4. Query GBrain for prior bug/code refs.
5. Rank candidate files.

Ranking inputs:

```text
stack trace
URL/route
console symbols
component/file name matches
GBrain prior memory
code_refs snippets
import proximity
test proximity
```

Acceptance tests:

```text
Pinned demo report ranks src/users.js in top 3.
Strong pass: src/users.js is top 1.
```

### Phase 3: Diagnosis Worker

Owner: Person B.

Depends on:

- Phase 1B report/job contract.
- Phase 2A search interface.
- Phase 2B candidate ranking.

Tasks:

1. Build diagnosis prompt with:
   - report payload
   - similar memory
   - candidate file snippets
   - code refs
2. Return structured diagnosis JSON.
3. Validate diagnosis schema.
4. Enforce confidence threshold.
5. Store diagnosis back to memory.

Acceptance tests:

```text
Pinned demo diagnosis:
names src/users.js
cites user.name dereference
explains missing not-found guard
confidence >= 0.75
```

### Phase 4: Patch and Verification Worker

Owner: Person B.

Depends on:

- Phase 3 passing diagnosis.

Tasks:

1. Generate unified diff or structured search/replace patch.
2. Apply patch in temp clone.
3. Assert modified files are subset of `targetFiles`.
4. Run checks:
   - package scripts if present.
   - `node --check` for modified JS files.
   - pinned smoke check for demo.
5. On pass, create branch, commit, push, open PR.
6. On fail, return diagnosis-only with verification failure reason.
7. Store PR outcome back to memory.

Acceptance tests:

```text
Patch only modifies src/users.js
node --check src/users.js passes
formatUserGreeting(999) no longer crashes
PR body includes verification commands/results
```

### Phase 5: Demo Assembly

Owner: both people.

Tasks:

1. Public demo page ready.
2. API logs/report view ready.
3. Memory page visible.
4. Diagnosis output visible.
5. PR tab ready.
6. Backup recording ready.
7. Rehearse live demo three times.

Acceptance tests:

```text
Demo completes end-to-end under 90 seconds twice.
Third rehearsal may use PR already opened, but diagnosis and memory must be live.
```

## Optional Agent Lanes

These are independent enough to assign to AI agents if needed.

### Agent 1: Capture Agent

Scope:

- Widget capture payload.
- Console/network/session breadcrumbs.
- Browser payload fixture.

Write ownership:

```text
widget/**
demo-app/**
tests/widget/**
```

Do not edit:

```text
api/worker/**
docs/**
```

### Agent 2: API/Memory Agent

Scope:

- `POST /report`.
- Report persistence.
- GBrain/GitHub markdown memory adapter.

Write ownership:

```text
api/routes/**
api/memory/**
tests/api/**
```

Do not edit:

```text
widget/**
api/worker/**
```

### Agent 3: Code Index Agent

Scope:

- Repo clone/fetch.
- JS/TS code index.
- Candidate file ranking.

Write ownership:

```text
api/indexing/**
api/repo/**
tests/indexing/**
```

Do not edit:

```text
widget/**
api/routes/**
```

### Agent 4: Diagnosis Agent

Scope:

- Diagnosis prompt/schema.
- GBrain context formatting.
- Diagnosis confidence gate.

Write ownership:

```text
api/worker/diagnosis/**
tests/worker/diagnosis/**
```

Do not edit:

```text
widget/**
api/indexing/**
```

### Agent 5: Verification/PR Agent

Scope:

- Patch apply.
- Verification command runner.
- GitHub PR creation.
- PR body.

Write ownership:

```text
api/worker/patch/**
api/github/**
tests/worker/patch/**
```

Do not edit:

```text
widget/**
api/routes/**
```

### Agent 6: Demo/Docs Agent

Scope:

- Demo script.
- Backup runbook.
- Screenshots/video checklist.
- Docs updates.

Write ownership:

```text
docs/**
demo/**
```

Do not edit production code unless explicitly reassigned.

## Integration Order

Use this order to avoid blocking each other:

1. Freeze report and diagnosis contracts.
2. Person A builds capture/API/memory.
3. Person B builds repo index against fixture report.
4. Person B builds diagnosis using fixture report + fixture candidate files.
5. Integrate live report payload into diagnosis.
6. Add patch/verification/PR.
7. Rehearse demo.

## Integration Checkpoints

### Checkpoint 1: Capture Contract

Command/evidence:

```text
submit report from demo page
show saved JSON payload
```

Pass:

```text
payload has annotation, console, network, session, screenshot
```

### Checkpoint 2: Memory Contract

Command/evidence:

```text
show memory entry
run similar search
```

Pass:

```text
search returns the saved bug
```

### Checkpoint 3: Retrieval Accuracy

Command/evidence:

```text
run ranking on pinned demo report
```

Pass:

```text
src/users.js in top 3
```

### Checkpoint 4: Diagnosis Accuracy

Command/evidence:

```text
run diagnosis on pinned demo report
```

Pass:

```text
diagnosis cites user.name dereference and missing guard
```

### Checkpoint 5: PR Accuracy

Command/evidence:

```text
apply patch in temp clone
run verification
open PR
```

Pass:

```text
only src/users.js changed
verification commands pass
PR contains evidence and verification
```

## Four Review Passes Applied

### Review Pass 1: Scope

Problem found:

The first plan could turn into a full Annotate rebuild.

Fix applied:

Scoped the hackathon target to capture, memory, diagnosis, and one verified PR against a pinned demo bug.

### Review Pass 2: Parallel Ownership

Problem found:

Widget/API and worker/indexing could block each other if the payload contract is unclear.

Fix applied:

Added Phase 0 contract freeze and split ownership into Person A and Person B with explicit deliverables.

### Review Pass 3: Accuracy

Problem found:

"Open a PR" is not enough; inaccurate PRs are worse than no PR.

Fix applied:

Added candidate top-3 gate, diagnosis evidence threshold, target-file scope, temp-clone patching, and pre-push verification.

### Review Pass 4: Agent Coordination

Problem found:

Multiple agents could overwrite each other or duplicate work.

Fix applied:

Added six optional agent lanes with disjoint write ownership and explicit do-not-edit boundaries.

## Final Recommendation

Build in this order:

```text
1. Report schema and demo fixture
2. Widget capture and API save
3. Memory adapter
4. Code index and candidate ranking
5. Diagnosis worker
6. Patch verification worker
7. GitHub PR
8. Demo rehearsal
```

If time gets tight, keep the demo at:

```text
capture -> memory -> code ranking -> diagnosis
```

and show the existing verified PR as backup.

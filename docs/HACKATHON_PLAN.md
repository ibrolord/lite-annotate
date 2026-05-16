# Lite Annotate Hackathon Plan

## One-line Pitch

Lite Annotate turns customer bug reports into engineering memory, then uses a gated review worker to diagnose the report, find the likely code path, and open a fix PR when safe. GStack is an optional AI-engineering workflow for planning, reviewing, QAing, and shipping the project work around that worker.

## Product Shape

This is a hosted bug-capture and engineering-review loop:

```text
Customer app
  -> hosted widget.js
  -> hosted API
  -> report store
  -> GBrain memory
  -> code-context worker
  -> engineering diagnosis
  -> optional GitHub PR
```

The product should lead with triage and engineering review. PR creation is the magic moment, but it should not be the only thing that proves value.

## Current Validation Summary

The latest local validation proved:

- GBrain CLI installs and runs locally.
- GBrain can store bug reports as pages.
- GBrain keyword search can retrieve similar bug memory.
- GBrain can import a local repo with `sync --strategy code`.
- `code_refs` can retrieve a useful code snippet from the indexed repo.
- GBrain HTTP MCP can run locally and accept authenticated `search` / `code_refs` tool calls.

The validation also showed these limits:

- Embeddings did not run without an embedding provider key.
- `code_def` did not reliably find JavaScript function definitions in the demo repo.
- PGLite is fine for local validation, but it is not the right shared hosted backend because the local DB lock can block concurrent CLI/admin operations.
- Hosted native GBrain is now running on Railway Postgres. The remaining GBrain gap is semantic retrieval quality without an embedding provider key.

See [GBRAIN_VALIDATION.md](GBRAIN_VALIDATION.md) for details.

## What GBrain Does

GBrain is the memory and retrieval layer.

Use GBrain for:

- Bug report memory.
- Prior bug retrieval.
- Diagnosis and PR outcome memory.
- Code-context retrieval where the indexed operations work, especially `search` and `code_refs`.

Show GBrain's demo impact as a contrast:

```text
Cold agent: browser breadcrumbs -> repo scan -> rediscover the failure pattern
Memory agent: prior bug memory -> known fix strategy -> evidence-backed diagnosis
```

The report view should make this visible through a Memory Impact panel, a Cold Agent vs Memory Agent comparison, and Memory Receipts that cite current browser evidence, prior memory, code evidence, verification, and outcome memory.

Do not make the core demo depend on GBrain being a perfect code intelligence engine.

For the strong version:

```text
report submitted
  -> gbrain put / sync
  -> gbrain query for similar prior bugs
  -> gbrain code_refs / search for relevant symbols/files
```

For the hackathon fallback:

```text
report submitted
  -> markdown memory committed to GitHub under bugs/
  -> simple memory search over prior bug pages
```

If using the fallback, describe it as GBrain-compatible memory, not full native GBrain.

## What GStack Does

GStack is an optional AI-engineering workflow and skill pack. It is not a hosted SaaS API by itself, so Lite Annotate uses it through a separate GStack Runner server when real product-side GStack review is needed. The core demo should still work without that runner configured.

Use GStack around project work when its slash-command workflows add useful discipline:

```text
/office-hours or /autoplan
  -> /plan-eng-review
  -> implement the worker change
  -> /review
  -> /qa
  -> /ship
```

What GStack is great for here:

- Forcing product and engineering assumptions into the open before implementation.
- Reviewing the worker code and PR for bugs, architecture, and completeness.
- Running browser QA against the hosted dashboard or demo app.
- Shipping the PR with tests, docs, and release notes kept in sync.

High-fidelity, uncomplicated use in this repo:

```text
report needs external GStack review
  -> Lite Annotate POST /reports/:id/gstack-review
  -> remote GStack Runner API
  -> Claude Code headless with GStack installed
  -> callback stores GStack evidence on the report
```

Do not present Lite Annotate's own worker trace as "GStack" unless the remote runner actually used GStack commands or skills. The product UI can still show an "Engineering Review" trace for the worker, but that is Lite Annotate's artifact, not GStack evidence.

## Code Understanding Strategy

Do not dump the whole repo into an LLM.

Use a layered repo-context strategy:

```text
1. GBrain retrieves prior bug memory and any useful code refs.
2. The worker fetches actual source files from GitHub or a shallow clone.
3. The worker builds/runs a small code index for fallback ranking.
4. The fix worker receives only the top 3-5 candidate files.
```

The reliable product boundary is:

```text
GBrain = memory + retrieval
GitHub/source clone = source of truth for file contents
Worker index = fallback ranking and code map
GStack workflow = optional developer/agent process for plan/review/QA/ship
Claude = diagnosis and patch generation
```

Build a small code map first:

```text
repo connected
  -> clone or fetch source
  -> parse files with AST tooling where possible
  -> extract routes, imports, exports, functions, components, symbols
  -> store compact index in memory or worker storage
```

When a report comes in, rank candidate files using:

1. Stack trace file and line, if present.
2. URL or route match.
3. Symbol names from console errors.
4. File and component names.
5. Similar prior bugs from GBrain memory.
6. Semantic summaries of files/functions.

Then send only the top 3-5 files to the investigation worker.

Do not rely only on `gbrain code_def`. Local validation showed `code_refs` was useful, while `code_def` missed definitions in the demo JavaScript file.

## Fix Generation Flow

The worker should not jump straight to code.

The accuracy priority is:

```text
retrieve likely files
  -> diagnose with evidence
  -> patch only target files
  -> apply patch in temp clone
  -> run checks
  -> push branch and open PR only after checks pass
```

### Step 1: Diagnose

Return structured diagnosis:

```json
{
  "type": "bug",
  "severity": "medium",
  "rootCause": "The code assumes user lookup always returns a user.",
  "evidence": [
    "Console error says reading 'name' from undefined.",
    "Bug happened on /users.",
    "Candidate file src/users.js dereferences user.name without a guard."
  ],
  "targetFiles": ["src/users.js"],
  "fixStrategy": "Handle missing user before rendering the greeting."
}
```

If the worker cannot explain the root cause, it should return `needs_more_context` instead of editing code.

Minimum patch threshold:

```text
confidence >= 0.75
targetFiles <= 2
evidence includes exact code snippet or line reference
```

### Step 2: Patch

Generate a unified diff or a tightly scoped file edit. Prefer unified diff:

```diff
diff --git a/src/users.js b/src/users.js
--- a/src/users.js
+++ b/src/users.js
@@
 function formatUserGreeting(id) {
   const user = getUserById(id);
+  if (!user) {
+    return 'Welcome, Guest!';
+  }
   return `Welcome, ${user.name}`;
 }
```

Scope rule:

```text
Only modify targetFiles from the diagnosis step.
If another file is required, ask for more context.
```

### Step 3: Verify

Run the best available checks in the patched temp clone before pushing anything to GitHub:

```text
npm test
npm run typecheck
npm run build
```

If the repo has no tests, run syntax/build checks and a small smoke reproduction.

For the pinned demo repo, the minimum verification is:

```bash
node --check src/users.js
node -e "const { formatUserGreeting } = require('./src/users.js'); console.log(formatUserGreeting(999))"
```

Expected result:

```text
No crash. The missing-user case returns a fallback greeting.
```

### Step 4: Open PR

Open the PR only after the patch applies and verification passes.

PR body should include:

- Root cause.
- Evidence from the report.
- Relevant console, network, and session breadcrumbs.
- GBrain memory used.
- Files changed.
- Verification commands.

## Hosting Plan

Use separate hosting responsibilities:

```text
Static widget and demo page
  -> Vercel or Cloudflare Pages

API and worker
  -> Railway or Render

Memory
  -> native GBrain on Railway Postgres
  -> GitHub markdown fallback if time constrained

Code and PRs
  -> GitHub API / GitHub App
```

Railway is preferred for the API/worker because the worker may need a long-running process, repo clone, and background job execution.

Hosted GBrain should run as a separate service:

```text
gbrain serve --http --bind 0.0.0.0 --port $PORT --public-url <hosted-url>
```

Use Railway Postgres for the current hosted GBrain. Use PGLite only for local development.

## Phase Plan

### Phase 1: Hosted Capture Loop

Build:

- Hosted widget script.
- Hosted API endpoint.
- Report submission with annotation text, URL, browser info, console errors, network breadcrumbs, lightweight session breadcrumbs, and screenshot.
- Report visibility through logs or a simple report page.

Gate:

```text
A public demo page can submit feedback to a public API and show that the report was saved with annotation, console, network, session breadcrumbs, and screenshot.
```

### Phase 2: Durable Memory

Build:

- Store every report as a structured memory page.
- Query prior bug reports for similar context.
- Show memory entry during demo.
- Store final diagnosis and PR outcome back into memory.

Gate:

```text
Submit report -> memory entry appears -> related prior memory can be retrieved.
```

### Phase 3: Engineering Diagnosis

Build:

- GBrain memory retrieval using `search` / `query`.
- GBrain code retrieval using `code_refs` where possible.
- Worker fallback code index / candidate file selection.
- Investigation prompt using current report, prior memory, code refs, and top code files.
- Structured diagnosis output.

Gate:

```text
Pinned demo report -> worker names src/users.js, cites the user.name dereference, and explains the missing not-found guard.
```

### Phase 4: Fix PR

Build:

- Generate diff.
- Apply in temporary clone.
- Run syntax/build/test or bug-specific smoke checks.
- Push branch and open GitHub PR only after checks pass.

Gate:

```text
Report submitted -> scoped patch passes checks locally -> PR opens with verification evidence.
```

## Demo Script

1. Open public demo app.
2. Trigger a visible bug.
3. Submit feedback through the widget.
4. Show report saved with annotation, console, network breadcrumbs, session breadcrumbs, and screenshot.
5. Show GBrain memory entry or GitHub memory fallback.
6. Show engineering diagnosis.
7. Show GitHub PR if stable.

## Demo Reliability Rules

- Keep one known bug with a deterministic fix.
- Pinned demo expected file: `src/users.js`.
- Pinned demo expected diagnosis: missing not-found/null guard before reading `user.name`.
- Pinned demo expected modified file set: only `src/users.js`.
- Have one successful PR already open as backup.
- Do not rely on live PR generation unless it passed three rehearsals.
- If PR generation fails, demo the diagnosis and memory flow; it is still valuable.

## Open Questions

- Should this repo add optional team-mode GStack setup, or keep GStack as a manual developer workflow for the hackathon?
- Should code access use a GitHub App or a personal token for the prototype?
- Which embedding provider key will be used for hosted GBrain?

## Collaboration Tasks

Suggested parallel tracks:

1. Hosting: public API, env vars, health check.
2. Widget: annotation, console, network, session breadcrumbs, screenshot, and submit UX.
3. Memory: GBrain or GitHub markdown fallback.
4. Code intelligence: candidate file ranking.
5. Worker: diagnosis, patch, verification, PR.
6. Demo: planted bug, backup recording, pitch.

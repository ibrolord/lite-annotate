# Lite Annotate Hackathon Plan

## One-line Pitch

Lite Annotate turns customer bug reports into engineering memory, then uses a GStack-powered worker to review the report, find the likely code path, and open a fix PR.

## Product Shape

This is a hosted bug-capture and engineering-review loop:

```text
Customer app
  -> hosted widget.js
  -> hosted API
  -> report store
  -> GBrain memory
  -> code-context worker
  -> GStack-powered review workflow
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
- Hosted deployment still needs Railway/Render auth, a Postgres/Supabase database, and embedding provider env vars.

See [GBRAIN_VALIDATION.md](GBRAIN_VALIDATION.md) for details.

## What GBrain Does

GBrain is the memory and retrieval layer.

Use GBrain for:

- Bug report memory.
- Prior bug retrieval.
- Diagnosis and PR outcome memory.
- Code-context retrieval where the indexed operations work, especially `search` and `code_refs`.

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

GStack is the engineering workflow layer.

Minimum honest use:

```text
Use GStack to plan, review, QA, and ship the hackathon project.
```

Stronger product use:

```text
feedback submitted
  -> GStack-style investigate workflow
  -> diagnosis
  -> review
  -> optional ship / PR
```

Do not block the core demo on non-interactive hosted GStack invocation unless the capture loop is already stable.

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
GStack workflow = investigate/review/ship process
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

Run the best available checks:

```text
npm test
npm run typecheck
npm run build
```

If the repo has no tests, run syntax/build checks and a small smoke reproduction.

### Step 4: Open PR

PR body should include:

- Root cause.
- Evidence from the report.
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
  -> native GBrain with Supabase/Postgres if stable
  -> GitHub markdown fallback if time constrained

Code and PRs
  -> GitHub API / GitHub App
```

Railway is preferred for the API/worker because the worker may need a long-running process, repo clone, and background job execution.

Hosted GBrain should run as a separate service:

```text
gbrain serve --http --bind 0.0.0.0 --port $PORT --public-url <hosted-url>
```

Use Supabase/Postgres for hosted GBrain. Use PGLite only for local development.

## Phase Plan

### Phase 1: Hosted Capture Loop

Build:

- Hosted widget script.
- Hosted API endpoint.
- Report submission with URL, browser info, console errors, screenshot.
- Report visibility through logs or a simple report page.

Gate:

```text
A public demo page can submit feedback to a public API and show that the report was saved.
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
Report submitted -> worker produces useful root-cause diagnosis without manual explanation.
```

### Phase 4: Fix PR

Build:

- Generate diff.
- Apply in isolated clone.
- Run checks.
- Open GitHub PR.

Gate:

```text
Report submitted -> PR opens with a reasonable, scoped fix.
```

## Demo Script

1. Open public demo app.
2. Trigger a visible bug.
3. Submit feedback through the widget.
4. Show report saved.
5. Show GBrain memory entry or GitHub memory fallback.
6. Show engineering diagnosis.
7. Show GitHub PR if stable.

## Demo Reliability Rules

- Keep one known bug with a deterministic fix.
- Have one successful PR already open as backup.
- Do not rely on live PR generation unless it passed three rehearsals.
- If PR generation fails, demo the diagnosis and memory flow; it is still valuable.

## Open Questions

- Are hackathon judges requiring native GBrain usage, or is GBrain-compatible memory acceptable?
- Can hosted GStack be invoked safely, or should GStack be framed as the workflow used to build/review/ship?
- Which hosting path is fastest today: Railway, Render, or Fly.io?
- Should code access use a GitHub App or a personal token for the prototype?
- Which embedding provider key will be used for hosted GBrain?
- Will hosted GBrain run on Supabase Postgres or another Postgres provider?
- Should the first hosted demo use native GBrain MCP or the CLI bridge from the worker?

## Collaboration Tasks

Suggested parallel tracks:

1. Hosting: public API, env vars, health check.
2. Widget: capture and submit UX.
3. Memory: GBrain or GitHub markdown fallback.
4. Code intelligence: candidate file ranking.
5. Worker: diagnosis, patch, verification, PR.
6. Demo: planted bug, backup recording, pitch.

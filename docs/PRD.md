# Product Requirements Document: Lite Annotate

## Status

Draft for hackathon collaboration.

## Product Summary

Lite Annotate is a hosted bug-feedback and engineering-review loop for web apps.

It lets a developer install one widget script. When a user reports a bug, Lite Annotate captures the technical context, stores the report as long-term memory, retrieves similar prior bugs and relevant code context, produces an engineering diagnosis, and opens a scoped GitHub PR when the fix is clear and verifiable.

## One-line Pitch

Customer bug reports become engineering memory, diagnosis, and fix PRs.

## Problem

Bug reports from users are usually incomplete:

- The report says what felt broken, but not what actually happened.
- Developers have to reproduce the issue manually.
- Console errors, network failures, route context, session breadcrumbs, and browser state are often missing.
- AI coding agents start cold because they do not remember prior bugs and fixes.
- Auto-generated PRs are risky when the agent has weak repo context or edits too broadly.

## Target Users

### Primary User: Developer / Founder

The developer owns a web app and wants to turn user feedback into actionable engineering work without manually triaging every report.

### Secondary User: Bug Reporter

The app user experiences a bug and needs a low-friction way to report it from inside the product.

## Goals

1. Capture useful bug context from a web app with one script tag.
2. Store every bug report and engineering outcome as durable memory.
3. Retrieve similar prior bugs and code context before diagnosis.
4. Produce a clear engineering diagnosis before attempting a fix.
5. Open only scoped, evidence-backed PRs that pass local verification before push.
6. Keep the live demo reliable even if PR generation fails.

## Non-goals

- Full session replay.
- Multi-tenant billing/auth for the hackathon version.
- Perfect whole-repo semantic understanding.
- Fully autonomous merge.
- Running arbitrary commands from customer input.
- Supporting every programming language on day one.
- Production-grade abuse prevention and security hardening.

## User Journey

### Developer Setup

1. Developer connects a GitHub repo or configures a demo repo.
2. Developer installs:

```html
<script src="https://<hosted-widget>/widget.js"></script>
```

3. Lite Annotate indexes the repo enough to rank likely files for future bugs.

### Bug Reporter Flow

1. User sees something broken.
2. User clicks the Lite Annotate feedback widget.
3. User enters a short title and optional details.
4. Widget captures:
   - User annotation: title and description.
   - Current URL and route.
   - User agent and viewport.
   - Console logs/errors.
   - Network breadcrumbs.
   - Lightweight session breadcrumbs.
   - Screenshot, if available.
5. Widget submits the report.

### Developer Outcome

1. Report is saved.
2. GBrain memory entry is created.
3. Worker retrieves similar prior bugs.
4. Worker retrieves/ranks repo context.
5. GStack-style investigation produces diagnosis.
6. If confidence is high, worker generates a patch, verifies it, and opens a PR.
7. Diagnosis and PR outcome are written back to memory.

## Functional Requirements

### Widget

The widget must:

- Load from a hosted script URL.
- Render a small feedback button.
- Open a compact report form.
- Capture annotation text, URL, user agent, console logs, network breadcrumbs, lightweight session breadcrumbs, and screenshot.
- Submit to the hosted API.
- Show submit success or failure.

### Capture Payload

The widget capture payload must include:

```text
annotation:
  title
  description
  optional selected element / active target

browser:
  url
  route/pathname
  userAgent
  viewport
  timestamp

console:
  console.log/warn/error
  window.onerror
  unhandledrejection

network:
  fetch/XHR URL
  method
  status
  duration
  failed/error state
  redacted request/response metadata only

session:
  last N clicks
  last N route changes
  last N input focus/change events without raw typed values
  timestamped event timeline

visual:
  screenshot when available
```

The session capture is a technical breadcrumb trail, not full session replay.

For the hackathon, retain the last 50 console events, last 50 network events, and last 50 session events.

### API

The API must:

- Accept `POST /report`.
- Return quickly with a report ID.
- Persist the report.
- Enqueue async investigation work.
- Expose a health endpoint.

### Memory

The memory layer must:

- Store each bug report as a durable page.
- Store each diagnosis and PR outcome.
- Support search for similar prior bugs.
- Prefer native GBrain MCP where stable.
- Support a fallback GitHub markdown memory path if native hosted GBrain is blocked.

### Repo Context

The system must not dump the whole repo into the LLM.

It must build a hybrid code context:

```text
GBrain memory and code_refs/search
  + GitHub/source clone file contents
  + worker-side fallback index
```

The worker index must extract, where possible:

- File path.
- Language.
- Imports.
- Exports.
- Functions/classes/components.
- Route hints.
- Symbol references.
- Nearby tests.
- Package scripts.

For the hackathon version, support JavaScript/TypeScript first.

### Accuracy Requirements

Accuracy is the primary hackathon priority.

Every generated PR must pass these gates before the branch is pushed:

```text
1. Candidate retrieval found the likely file.
2. Diagnosis cites concrete evidence.
3. Patch modifies only target files.
4. Patch applies cleanly in a temp clone.
5. Syntax/build/test or bug-specific smoke check passes.
```

If any gate fails, the worker must return diagnosis-only output and skip PR creation.

### Candidate File Ranking

For each report, rank candidate files by:

1. Stack trace file/line.
2. URL and route match.
3. Symbol names in console errors.
4. Component/file name match.
5. Similar prior bug memory.
6. Import graph proximity.
7. Test proximity.

Only the top 3-5 files should be sent to the fix worker.

For the pinned demo bug, the expected gate is:

```text
Bug: user profile crashes reading name
Expected file: src/users.js
Pass: src/users.js appears in top 3 candidates
Strong pass: src/users.js is top 1
```

### Diagnosis

Before patching, the worker must produce structured diagnosis:

```json
{
  "type": "bug",
  "severity": "medium",
  "rootCause": "The code assumes user lookup always returns a user.",
  "evidence": [
    "Console error says reading 'name' from undefined.",
    "Candidate file src/users.js dereferences user.name without a guard."
  ],
  "targetFiles": ["src/users.js"],
  "fixStrategy": "Handle missing user before rendering the greeting.",
  "confidence": 0.82
}
```

If confidence is low or target files are unclear, the worker must return diagnosis only and skip PR creation.

Minimum patch threshold:

```text
confidence >= 0.75
targetFiles <= 2
evidence includes exact code snippet or line reference
```

### Patch Generation

The worker must:

- Prefer unified diff.
- Fall back to a structured search/replace patch if unified diff application fails.
- Modify only the diagnosis `targetFiles`.
- Refuse broad edits unless explicitly approved.
- Avoid secrets, `.env` files, lockfiles, generated files, and unrelated refactors.
- Apply the patch in a temporary clone before creating any branch on GitHub.

### Verification

Before pushing a branch or opening a PR, the worker must run the strongest available checks in the patched temp clone:

```text
npm test
npm run typecheck
npm run build
```

If no project checks exist, it must run:

- Syntax check for modified files.
- Any obvious smoke reproduction.
- A clear "verification limited" note in the PR body.

For the pinned demo repo, the minimum verification is:

```bash
node --check src/users.js
node -e "const { formatUserGreeting } = require('./src/users.js'); console.log(formatUserGreeting(999))"
```

Expected result:

```text
No crash. The missing-user case returns a fallback greeting.
```

Only after these checks pass should the worker create a branch, commit, push, and open a PR.

### PR Creation

PR creation happens after local verification, not before.

PR body must include:

- Bug report summary.
- Root cause.
- Evidence.
- Relevant console, network, and session breadcrumbs.
- GBrain memory used.
- Files changed.
- Verification commands and results.
- Residual risk.

## GBrain Usage

Use GBrain for:

- Bug report memory.
- Similar bug retrieval.
- Diagnosis and PR outcome memory.
- Code retrieval where validated operations work, especially `search` and `code_refs`.

Do not rely only on GBrain for:

- Perfect symbol definitions.
- Full semantic code understanding without embeddings.
- Hosted shared operation on PGLite.

Hosted GBrain should use:

```text
gbrain serve --http --bind 0.0.0.0 --port $PORT --public-url <hosted-url>
```

with Supabase/Postgres, not PGLite.

## GStack Usage

Use GStack as the engineering workflow layer:

```text
investigate -> review -> QA -> ship
```

For the hackathon, GStack can be:

- The workflow used by the team to build/review/ship.
- The visible framing for the review worker.
- A deeper hosted invocation only if the core capture and diagnosis loop is stable.

## Hosting Requirements

### Static Assets

Host:

- Widget script.
- Demo page.

Recommended:

- Vercel.
- Cloudflare Pages.

### API and Worker

Host:

- Report API.
- Background worker.
- Repo indexing and PR generation.

Recommended:

- Railway.
- Render.
- Fly.io.

### GBrain

Host as a separate service:

- HTTP MCP server.
- Supabase/Postgres database.
- OAuth client for `lite-annotate-worker`.
- Embedding provider key.

## Security Requirements Deferred For Hackathon

For the hackathon, accuracy and demo reliability are higher priority than production security.

The following are acknowledged but not gating Phase 1-4 unless they directly affect PR accuracy:

- No committed secrets.
- GitHub access through restricted token or GitHub App.
- No arbitrary command execution from customer input.
- Worker jobs must run with timeouts.
- Worker must isolate repo clones.
- PR generation must be scoped to selected files.
- User-provided text must never become shell input.

## Milestones

### Phase 1: Hosted Capture

Gate:

```text
Public demo page submits report to public API and report is saved.
```

### Phase 2: Memory

Gate:

```text
Report creates memory entry and similar bug search works.
```

### Phase 3: Code Context and Diagnosis

Gate:

```text
Pinned demo report produces diagnosis that names src/users.js, cites the user.name dereference, and explains the missing not-found guard.
```

### Phase 4: PR

Gate:

```text
Report produces a scoped patch, applies it in a temp clone, passes checks, then opens a PR with verification evidence.
```

## Demo Requirements

The demo must show:

1. Public app with a reproducible bug.
2. Widget submission.
3. Saved report with annotation, console, network, session breadcrumbs, and screenshot.
4. GBrain memory/retrieval.
5. Engineering diagnosis.
6. GitHub PR if stable.

The demo must have a backup:

- Pre-recorded successful run.
- Pre-opened PR.
- Diagnosis-only fallback path.

## Success Metrics

For the hackathon:

- Report submitted from public page.
- Report includes annotation, console, network, and lightweight session breadcrumbs.
- Memory entry created.
- Similar bug retrieval works.
- Candidate file ranking puts `src/users.js` in top 3 for the pinned demo bug.
- Diagnosis names the missing null/not-found guard.
- Patch modifies only `src/users.js`.
- Patch passes syntax and bug-specific smoke verification before push.
- PR opens only after verification, or diagnosis-only fallback is clear.

For product direction:

- Time from report to diagnosis under 90 seconds.
- Top-3 candidate file recall is measured on a growing bug fixture set.
- PRs are scoped and reviewable.
- No broad unrelated edits.

## Open Questions

- Which host will run the API/worker today?
- Which Postgres/Supabase project will host GBrain?
- Which embedding provider key will be used?
- Do judges require native GBrain, or is a validated GBrain-compatible fallback acceptable?
- Can hosted GStack invocation be made safe in time, or should it remain the workflow framing?

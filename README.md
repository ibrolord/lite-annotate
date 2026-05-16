# Lite Annotate

Lite Annotate turns in-app bug reports into engineering-ready fixes.

It gives a web app one feedback widget that captures the user report plus the technical context engineers usually have to reconstruct: route, browser state, console errors, network breadcrumbs, lightweight session events, and a screenshot. Each report becomes durable engineering memory, then flows through evidence-backed diagnosis, scoped patch generation, local verification, and optional GitHub PR creation.

```text
user report
  -> browser evidence
  -> durable memory
  -> repo-aware diagnosis
  -> verified patch
  -> guarded pull request
```

## Why It Exists

Most customer bug reports arrive without the facts needed to act on them. The reporter knows what felt broken; the engineering team still has to recover the route, reproduce the failure, find the likely file, remember whether this happened before, and decide whether an AI-generated fix is safe.

Lite Annotate is positioned around that missing handoff. It makes every report a structured engineering artifact with receipts:

- **Capture:** the widget records annotation text, URL, browser metadata, console errors, network breadcrumbs, session breadcrumbs, and screenshot status.
- **Memory:** reports, diagnoses, and outcomes are written to GBrain-compatible memory so future agents start with prior context instead of cold scans.
- **Diagnosis:** the worker ranks candidate files and explains the root cause with browser, memory, and code evidence before attempting a patch.
- **Verification:** patches are constrained to diagnosed target files and checked in a temp workspace before any public PR action.
- **Review:** report views expose Memory Impact, Cold Agent vs Memory Agent comparison, and Memory Receipts for engineering review.

## Product Surface

- Hosted demo app at `/demo`
- Hosted widget script at `/widget.js`
- Report intake API at `POST /report`
- Report dashboard at `/reports/dashboard`
- Report detail at `/reports/:id/view`
- Structured handoff payload at `/reports/:id/handoff`
- Dry-run analysis at `POST /reports/:id/autofix?dryRun=1`
- Verified PR path at `POST /reports/:id/autofix`

Dry run is the preferred review mode: it exercises diagnosis and verification without opening a PR. The normal autofix action is gated and should only open a PR after candidate ranking, diagnosis confidence, patch scope, patch application, and verification all pass.

## Current Proof

The current implementation includes the end-to-end product loop:

- Widget capture with annotation, console, network, session, browser, and screenshot fields.
- Hono API for report intake, report storage, dashboard, report detail, memory, handoff, and autofix routes.
- Native GBrain HTTP helper utilities plus GitHub markdown fallback memory.
- Repo indexing and candidate ranking for JavaScript/TypeScript projects.
- Structured diagnosis, scoped patch generation, patch verification, and PR eligibility gates.
- Dry-run analysis mode for safe demos and review.
- Hosted PR-opening proof against the demo repo, recorded in [docs/TRACKER.md](docs/TRACKER.md).

This is not production-hardened SaaS yet. Multi-tenant auth, billing, abuse controls, broad language support, and autonomous merge are intentionally outside the current boundary.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:3001/demo
```

Run checks:

```bash
npm test
npm run typecheck
```

## Configuration

The app can run with local/fallback memory, but these environment variables enable the full external integrations:

```text
MEMORY_PROVIDER=gbrain|github-markdown
GBRAIN_MCP_URL=https://<gbrain-service>/mcp
GBRAIN_MCP_TOKEN=<optional-static-token>
GBRAIN_CLIENT_ID=<optional-oauth-client-id>
GBRAIN_CLIENT_SECRET=<optional-oauth-client-secret>
GBRAIN_OAUTH_SCOPE="read write"

GITHUB_TOKEN=<token with repo access>
GITHUB_REPO=<owner/repo used for PR creation>
TARGET_REPO=<owner/repo or URL used for repo cloning>
TARGET_REPO_BRANCH=<optional branch>
REPO_WORKSPACE_ROOT=<optional clone/cache root>
```

The worker uses the target repository as the source of truth for file contents. Memory improves context and retrieval, but PR generation still depends on scoped diagnosis and local verification.

## Documentation

Start here:

- [PRODUCT.md](PRODUCT.md) - product positioning, users, tone, and principles.
- [DESIGN.md](DESIGN.md) - interface register and visual constraints.
- [docs/PRD.md](docs/PRD.md) - functional requirements and product boundaries.
- [docs/GBRAIN_DEMO_STORY.md](docs/GBRAIN_DEMO_STORY.md) - demo narrative for memory-assisted engineering review.
- [docs/TRACKER.md](docs/TRACKER.md) - implementation status, proof points, and commit ledger.

Internal planning history remains in:

- [docs/HACKATHON_PLAN.md](docs/HACKATHON_PLAN.md)
- [docs/AGENT_EXECUTION_PLAN.md](docs/AGENT_EXECUTION_PLAN.md)
- [docs/GBRAIN_VALIDATION.md](docs/GBRAIN_VALIDATION.md)

## Safety Model

- Do not commit API keys or tokens.
- Do not run arbitrary customer commands in the worker.
- Do not dump entire repositories into model context.
- Treat diagnosis as a required step before patching.
- Open PRs only after scoped patch application and verification pass.
- Label fallback memory honestly when native GBrain is not configured.

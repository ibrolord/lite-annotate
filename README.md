<p align="center">
  <a href="https://youtu.be/l-wpli3qX8k">
    <img src="https://img.youtube.com/vi/l-wpli3qX8k/hqdefault.jpg" alt="Lite Annotate demo video" width="720">
  </a>
</p>

<p align="center">
  <strong><a href="https://lite-annotate-commerce-demo.vercel.app/">Try the live commerce demo</a></strong>
</p>

# Lite Annotate

Lite Annotate turns in-product bug reports into engineering-ready work. Setup is one config block and one async script tag; no app package, framework adapter, build plugin, or SDK call is required for the capture path.

A small browser widget captures the user's report together with the technical context engineers usually have to reconstruct: route, browser metadata, console errors, network breadcrumbs, session breadcrumbs, selected element context, and screenshot status.

The backend stores each report as durable engineering memory, retrieves related prior context, runs repo-aware diagnosis, generates a scoped patch when the evidence supports it, verifies the patch locally, and can open a guarded GitHub pull request.

```text
+----------------------+
| Customer app         |
| script-tag widget    |
+----------+-----------+
           |
           | captured report
           v
+------------------------------+
| Lite Annotate                |
| intake | review UI | worker |
+------+-----------+-----------+
       |           |
       |           +----------------------+
       |                                  |
       v                                  v
+----------------------+        +----------------------+
| GBrain memory        |        | Target GitHub repo   |
| reports              |        | repo context         |
| diagnoses            |        | scoped patches       |
| outcomes             |        | guarded PRs          |
+----------------------+        +----------------------+

Optional from the report view:

+----------------------+
| GStack runner        |
| investigation        |
| QA, review, ship     |
| callback results     |
+----------------------+
```

## Why It Exists

Most customer bug reports are not actionable on arrival. They describe what felt broken, but they rarely include the route, browser state, console failure, network request, prior incidents, likely source file, or verification path.

Lite Annotate makes that handoff explicit. Each report becomes a structured engineering artifact with receipts:

- **Capture:** the widget records annotation text, route, browser metadata, console errors, network breadcrumbs, session breadcrumbs, selected element context, and screenshot status.
- **Memory:** reports, diagnoses, and outcomes are written to GBrain-compatible memory so future investigations start with prior context.
- **Diagnosis:** the worker ranks candidate files and explains the likely root cause with browser, memory, and code evidence before attempting a patch.
- **Verification:** generated patches are constrained to diagnosed target files and checked in a temporary workspace before any PR action.
- **Review:** report views expose memory impact, cold-agent versus memory-assisted comparison, verification output, and handoff payloads for engineering review.

## Setup in Minutes

Add the widget config and hosted script to any browser-based web app:

```html
<script>
  window.ANNOTATE_API_URL = "https://lite-annotate.example.com";
  window.ANNOTATE_PROJECT_ID = "my-app";
  window.ANNOTATE_REPO = "owner/repo";
</script>
<script async src="https://lite-annotate.example.com/widget.js"></script>
```

That is the customer-app integration. `ANNOTATE_REPO` connects each report to the GitHub repository Lite Annotate should analyze, while the widget itself runs outside the app bundle.

Fast capture path:

1. Paste the config block and script tag.
2. Set `ANNOTATE_API_URL`, `ANNOTATE_PROJECT_ID`, and `ANNOTATE_REPO`.
3. Open the app and submit a report from the widget.
4. Review captured reports at `/reports/dashboard` or `/reports/:id/view`.

Repo-aware analysis is the next step:

1. Run dry-run analysis with `POST /reports/:id/autofix?dryRun=1`.
2. Add GitHub credentials only when private repo access or verified PR creation is desired.
3. Use `POST /reports/:id/autofix` for the full gated PR path.

Dry-run analysis is the default review path. It exercises diagnosis and verification without opening a public branch or pull request.

## Product Surface

| Surface | Purpose |
| --- | --- |
| `GET /widget.js` | Hosted browser widget script. |
| `GET /demo` | Local validation page for the capture flow. |
| `POST /report` | Report intake endpoint. |
| `GET /reports` | JSON list of saved reports. |
| `GET /reports/dashboard` | Review queue for captured reports. |
| `GET /reports/:id/view` | Human-readable report detail with memory, diagnosis, and verification context. |
| `GET /reports/:id/handoff` | Structured handoff payload for downstream agents or review tooling. |
| `GET /reports/:id/memory` | Similar memory, memory impact, and receipt trail. |
| `GET /reports/:id/triage` | Current evidence-only bug triage result. |
| `POST /reports/:id/triage` | Fast LLM triage with deterministic fallback when model access is unavailable. |
| `POST /reports/:id/autofix?dryRun=1` | Diagnosis and verification without PR creation. |
| `POST /reports/:id/autofix` | Full autofix path with guarded PR creation when credentials and gates allow it. |
| `POST /reports/:id/gstack/investigate` | Optional protected GStack investigation trigger. |

## How the Pipeline Works

1. **Normalize the report.** `POST /report` validates and normalizes the widget payload into the `LiteReport` contract.
2. **Persist report and memory.** Reports are stored locally, with GBrain HTTP memory used when configured and markdown memory as a fallback.
3. **Triage the report.** A fast evidence-only Sonnet pass summarizes what the user reported, then writes Lite Annotate's own bug assessment from captured browser evidence. If model access is unavailable, Lite Annotate falls back to a deterministic browser-evidence heuristic.
4. **Build repo context.** The worker clones or opens the target repo, indexes JavaScript and TypeScript files, and ranks likely candidates from route, stack, symbol, annotation, and test proximity signals.
5. **Diagnose before patching.** Diagnosis records severity, root cause, evidence, target files, fix strategy, confidence, and whether a patch is justified.
6. **Generate a patchability artifact.** Confident reports get scoped product-code patches; weaker but supported reports fall back to regression-test, instrumentation, or setup artifacts instead of diagnosis-only output.
7. **Verify locally.** Patches are applied in a temporary workspace and must pass syntax checks, markdown/test sanity checks, package-script checks when enabled, and any supplied smoke commands.
8. **Open a PR only after gates pass.** GitHub PR creation is skipped unless verification succeeds and credentials are configured; external setup/trust failures return explicit blocker metadata.

## Current Scope

Implemented:

- Browser widget capture for annotation, console, network, session, browser, route, and screenshot fields.
- Hono API for report intake, report storage, dashboard, report detail, memory, handoff, autofix, and GStack review routes.
- GBrain-compatible memory with native HTTP integration and markdown fallback.
- Fast evidence-only report triage that stays separate from repo-aware Auto-Fix.
- JavaScript and TypeScript repo indexing with candidate ranking.
- Structured diagnosis, deterministic and model-backed patch generation, fallback patchability artifacts, local patch verification, and guarded GitHub PR creation.
- Dry-run analysis for review without external PR actions.
- Optional protected GStack runner integration for investigation, QA, review, and ship workflows.

Not yet in scope:

- Multi-tenant auth, billing, and tenant-level administration.
- Full session replay.
- Broad non-JavaScript language support.
- Autonomous merge.
- Production-grade abuse controls, retention policies, and compliance workflows.

## Run Locally

Install dependencies:

```bash
npm install
```

Start the API:

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

Lite Annotate runs with local report storage and markdown memory by default. These variables enable external services and stricter workflows:

```text
REPORT_STORE_DIR=<optional local report store path>
MEMORY_PROVIDER=gbrain|github-markdown
MEMORY_DIR=<optional markdown memory path>

GBRAIN_MCP_URL=https://<gbrain-service>/mcp
GBRAIN_MCP_TOKEN=<optional-static-token>
GBRAIN_CLIENT_ID=<optional-oauth-client-id>
GBRAIN_CLIENT_SECRET=<optional-oauth-client-secret>
GBRAIN_OAUTH_SCOPE="read write"

OPENAI_API_KEY=<token for model-backed patch generation>
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_API_KEY=<token for fast Sonnet triage>
ANTHROPIC_BASE_URL=https://api.anthropic.com/v1
TRIAGE_MODEL=claude-sonnet-4-6
TRIAGE_TIMEOUT_MS=8000
AUTOFIX_CODE_MODEL=gpt-5.3-codex-spark
AUTOFIX_DISABLE_LLM_PATCH=true|false
AUTOFIX_RUN_PACKAGE_SCRIPTS=true|false

GITHUB_TOKEN=<token with repo access>
GITHUB_REPO=<owner/repo used for PR creation>
TARGET_REPO=<owner/repo or URL used for repo cloning>
TARGET_REPO_BRANCH=<optional branch>
AUTOFIX_ALLOWED_REPOS=<comma-separated owner/repo allowlist for report-provided repos>
REPO_WORKSPACE_ROOT=<optional clone/cache root>

PUBLIC_BASE_URL=https://<lite-annotate-host>
GSTACK_UI_TRIGGER_ENABLED=1
GSTACK_TRIGGER_TOKEN=<product trigger token>
GSTACK_RUNNER_URL=https://<gstack-runner-host>
GSTACK_RUNNER_TOKEN=<runner token>
GSTACK_CALLBACK_TOKEN=<callback token expected by Lite Annotate>
GSTACK_CALLBACK_BASE_URL=https://<callback-host>
GSTACK_ALLOW_PR=1
```

The worker uses the target repository as the source of truth for file contents. Memory improves context and retrieval, but PR generation still depends on scoped diagnosis and local verification.
For hosted PR creation, report-provided repository values must match `AUTOFIX_ALLOWED_REPOS`, `TARGET_REPO`, or `GITHUB_REPO`; otherwise Auto-Fix fails closed instead of opening a PR against an untrusted repo.

## Documentation

- [PRODUCT.md](PRODUCT.md) - product positioning, users, tone, and boundaries.
- [DESIGN.md](DESIGN.md) - interface register and visual constraints.
- [docs/PRD.md](docs/PRD.md) - product requirements and operating constraints.
- [docs/INTEGRATION_AUDIT.md](docs/INTEGRATION_AUDIT.md) - integration effort and rollout levels.
- [docs/GSTACK_RUNNER.md](docs/GSTACK_RUNNER.md) - protected remote GStack runner setup.
- [docs/TRACKER.md](docs/TRACKER.md) - implementation status, validation notes, and commit ledger.

Historical planning notes live under `docs/` and are not required for product integration.

## Safety Model

- Do not commit API keys or tokens.
- Do not run arbitrary customer commands in the worker.
- Do not dump entire repositories into model context.
- Treat diagnosis as a required step before patching.
- Trust report-provided repositories only when they match the server-side allowlist.
- Open PRs only after scoped patch application and verification pass.
- Label fallback memory honestly when native GBrain is not configured.

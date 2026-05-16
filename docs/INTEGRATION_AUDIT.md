# Lite Annotate Integration Effort Audit

## Verdict

Lite Annotate can honestly be positioned as easy to integrate into any browser-based web repo for a hackathon demo.

The capture path is a drop-in script. The repo-aware analysis path only needs a GitHub `owner/repo` value for public repos, or a repo-scoped token for private repos and PR creation. The system is strongest today for JavaScript and TypeScript repos because the worker indexing and smoke checks are built around that ecosystem.

## Integration Levels

| Level | What the integrator does | Required config | Estimated effort | Current state |
| --- | --- | --- | --- | --- |
| Capture only | Add one config block and one widget script tag | `ANNOTATE_API_URL`, `ANNOTATE_PROJECT_ID`, `ANNOTATE_REPO` | 5 minutes | Implemented |
| Local evaluation | Run Lite Annotate locally and open `/demo` | `npm install`, `npm run dev` | 10 minutes | Implemented |
| Repo-aware dry run | Submit a report with a repo slug, then run dry-run analysis | Public `owner/repo` or read-capable `GITHUB_TOKEN` for private repos | 10-20 minutes | Implemented |
| Verified PR | Allow Lite Annotate to push a checked branch and open a PR | `GITHUB_TOKEN`, `GITHUB_REPO`, optional `TARGET_REPO_BRANCH` | 15-30 minutes | Implemented, gated |
| Production rollout | Add tenant auth, billing, abuse controls, and stricter data retention | Product-specific | More than a hackathon | Out of scope |

## Drop-In Snippet

```html
<script>
  window.ANNOTATE_API_URL = "https://lite-annotate.example.com";
  window.ANNOTATE_PROJECT_ID = "my-app";
  window.ANNOTATE_REPO = "owner/repo";
</script>
<script async src="https://lite-annotate.example.com/widget.js"></script>
```

That is enough for the widget to capture a user report, current route, browser metadata, console errors, network breadcrumbs, session breadcrumbs, and screenshot status.

## Why This Is Easy

- No package install is required in the customer repo.
- No framework adapter is required; the widget runs in plain browser JavaScript.
- The app repo does not need to call a Lite Annotate SDK.
- The report payload carries the target repo slug, so the backend can analyze different repos from the same hosted instance.
- Dry-run analysis is available before any branch or PR is created.
- Local/fallback memory works without native GBrain setup; native GBrain can be added when available.

## Honest Limits

- Repo indexing and fix verification are tuned for JavaScript and TypeScript first.
- Private repo analysis and PR creation require a GitHub token or future GitHub App installation.
- Full production onboarding needs auth, tenant isolation, retention controls, and abuse limits.
- The current hackathon path should lead with dry-run diagnosis and make PR creation the optional final gate.

## Recommended Hackathon Positioning

Lead with:

> Add one script tag to any web app, point it at a GitHub repo, and every bug report becomes captured browser evidence plus a repo-aware diagnosis. When the fix is clear, Lite Annotate verifies it locally and opens a guarded PR.

Avoid claiming:

> Fully autonomous production bug fixing for every stack.


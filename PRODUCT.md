# Lite Annotate Product Context

## Register

Product.

Lite Annotate should read as a focused engineering workflow product, not a thin wrapper around an AI agent. The core promise is practical: add one widget script to a web app, and customer bug reports become durable engineering memory, evidence-backed diagnosis, verified patches, and gated PRs.

## Product Purpose

Lite Annotate closes the gap between user-reported bugs and engineering action. It captures the report inside the product, preserves the technical context engineers need, retrieves relevant prior memory, and prepares a scoped fix only when the evidence supports it.

## Positioning

**One-line pitch:** add one script tag to any web app, and customer bug reports become engineering memory, diagnosis, and verified fix PRs.

**Category:** bug capture and engineering review automation for web apps.

**Point of view:** the useful AI workflow is not "open a PR from any complaint." It is a governed handoff: collect evidence, remember prior outcomes, explain the root cause, constrain the patch, verify locally, then make the PR reviewable.

## Primary Users

- Developer founders who need fast, trustworthy bug triage without manually reconstructing every report.
- Engineering teams reviewing captured reports, memory context, diagnosis evidence, verification output, and PR readiness.

## Secondary Users

- Product users reporting a bug from inside a customer app through the embedded widget.

## Brand Tone

Sharp, technical, evidence-led, calm. Lite Annotate should feel like an engineering command center: precise, credible, and careful about external actions.

Avoid novelty-first AI language. Lead with receipts, constraints, and reviewability.

## Strategic Principles

- **Evidence before action:** every diagnosis and PR must show browser, memory, code, and verification receipts.
- **Trust over spectacle:** risky actions are visible, labeled, and gated.
- **Memory is the differentiator:** each report and outcome should improve the next investigation.
- **Diagnosis is a product surface:** the root-cause explanation is valuable even when no PR is opened.
- **PRs are earned:** patch generation is downstream of confidence, scope, and verification.

## Product Boundaries

Current product boundary:

- Hosted drop-in widget and demo app.
- Report capture API and dashboard.
- GBrain-compatible report, diagnosis, and outcome memory.
- JavaScript/TypeScript repo indexing and candidate ranking.
- Structured diagnosis, scoped patch generation, verification, dry-run analysis, and gated PR creation.

Not yet in scope:

- Full session replay.
- Multi-tenant auth and billing.
- Broad language/runtime support.
- Fully autonomous merge.
- Production-grade abuse prevention and security hardening.

## Anti-References

- Generic SaaS landing pages with oversized hero metrics.
- AI dashboards filled with decorative gradients and repeated cards.
- "Agent magic" claims that hide evidence and gates.
- Dense raw JSON dumps as the first thing a reviewer sees.
- Unlabeled destructive or externally visible actions.

## Success Criteria

- A developer understands the capture-to-PR loop within one screen.
- A judge understands the integration story from the README or demo header without reading backend code.
- The dashboard makes report status and analysis state scannable.
- Report detail explains memory impact and analysis state before raw payloads.
- Dry-run analysis is clearly safer than PR-opening analysis.
- Every PR-ready result includes evidence, target files, verification output, and memory receipts.

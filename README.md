# Lite Annotate

Hackathon prototype for turning in-app customer bug reports into engineering review and fix PRs.

## Concept

Lite Annotate is the small version of AnnotateQA:

1. A customer installs one hosted widget script.
2. A user reports a bug from inside the app.
3. The widget captures context: URL, browser info, console errors, and screenshot.
4. The backend stores the report as durable product memory.
5. A GStack-powered review worker investigates the report with GBrain context.
6. The worker returns an engineering diagnosis and, when safe, opens a GitHub PR.

The goal is not to build the full AnnotateQA product in a day. The goal is to prove the loop:

```text
customer feedback -> memory -> engineering review -> fix PR
```

## Current Collaboration Doc

Read [docs/HACKATHON_PLAN.md](docs/HACKATHON_PLAN.md) first.

## Safety Notes

- Do not commit API keys or tokens.
- Do not run arbitrary customer commands in the worker.
- Treat PR generation as the final step after diagnosis and verification.
- If native GBrain integration is not stable in time, use GitHub markdown memory as the fallback and describe it honestly.

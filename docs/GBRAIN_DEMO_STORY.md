# GBrain Demo Story

## Judge-facing Pitch

Lite Annotate does not just capture bugs. It turns each report, diagnosis, fix attempt, and verification result into reusable engineering memory.

The demo contrast is:

```text
Cold agent
  -> starts from browser breadcrumbs
  -> scans the repo
  -> has to rediscover the same failure pattern

Memory agent
  -> retrieves a similar prior bug from GBrain-compatible memory
  -> starts with the previous diagnosis and fix strategy
  -> cites browser evidence, prior memory, code evidence, and verification
  -> writes the new outcome back to memory
```

The judge takeaway:

```text
Without GBrain, every AI agent starts cold.
With GBrain, every customer bug and verified fix becomes reusable engineering context.
```

## Demo Flow

1. Open the hosted dashboard:

```text
https://lite-annotate-production.up.railway.app/reports/dashboard
```

2. Open the pinned report view from the dashboard.

3. Point out **Memory Impact**:

- The report is written as durable bug memory.
- Similar prior bug memory is retrieved.
- The memory explains the same missing-user failure pattern.

4. Point out **Cold Agent vs Memory Agent**:

- The cold path starts with breadcrumbs and repo scan.
- The memory path starts from prior diagnosis and fix strategy.
- This shows how GBrain changes the agent's starting point, not just where data is stored.

5. Point out **Memory Receipts**:

- Current browser report: route, console error, network breadcrumb, annotation.
- Prior memory: similar bug and previous fix strategy.
- Code evidence: candidate and target file.
- Verification: checks that passed.
- Outcome memory: diagnosis and verification result written back.

6. Run analysis from the report view.

7. Refresh the same report view and show that receipts now include code evidence and verification.

## Honest Framing

Native GBrain should be used when `MEMORY_PROVIDER=gbrain` and `GBRAIN_MCP_URL` are configured.

When those env vars are not configured, the demo uses the GitHub markdown memory adapter and labels it honestly as GBrain-compatible fallback memory. The product flow is still the same:

```text
write memory -> retrieve similar memory -> use it in handoff -> write diagnosis/outcome memory
```

## What Is Implemented

- `/reports/:id/memory` returns `memoryImpact`, `agentComparison`, and `memoryReceipts`.
- `/reports/:id/handoff` returns the same structured demo context.
- `/reports/:id/view` renders Memory Impact, Cold Agent vs Memory Agent, and Memory Receipts.
- `POST /reports/:id/autofix` stores analysis output with memory impact, comparison, and receipts.
- The pinned demo has deterministic prior memory so the hackathon demo works even without hosted native GBrain.

## Next Upgrade

The next step is to pass retrieved memory directly into the diagnosis/patch prompt, then record whether memory changed the selected file, diagnosis confidence, or fix strategy.

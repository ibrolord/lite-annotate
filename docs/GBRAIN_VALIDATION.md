# GBrain Validation Notes

Date: 2026-05-16

## Purpose

Validate whether Lite Annotate can safely rely on GBrain for:

1. Bug memory.
2. Prior bug retrieval.
3. Repo code context.
4. Programmatic access from a hosted worker.
5. Hosted deployment readiness.

## What Was Installed

Installed the official GBrain repo locally:

```bash
git clone https://github.com/garrytan/gbrain.git ~/gbrain
cd ~/gbrain
bun install
bun link
```

Confirmed:

```text
gbrain 0.35.1.0
```

Initialized local PGLite brain:

```bash
gbrain init --pglite
```

Brain path:

```text
~/.gbrain/brain.pglite
```

## Local Memory Test

Created a test bug memory page:

```text
bugs/user-profile-crashes
```

Content described:

```text
URL: /users
Console: Cannot read properties of undefined reading name
Diagnosis: formatUserGreeting dereferences user.name after getUserById returns undefined.
```

Search test:

```bash
gbrain search "user name undefined"
```

Result:

```text
PASS: GBrain returned the bug memory page.
```

## Code Source Test

Registered the demo repo:

```bash
gbrain sources add demo --path /tmp/lite-annotate-demo
```

Synced it as code:

```bash
gbrain sync --source demo --strategy code
```

Result:

```text
PASS: GBrain imported src/users.js as a code page.
```

The sync reported embedding failures because no embedding provider key was configured:

```text
OpenAI embedding requires OPENAI_API_KEY.
```

That means local validation covered keyword/structural behavior, not full semantic retrieval quality.

## Code Retrieval Test

Tested:

```bash
gbrain code-refs getUserById --source demo
```

Result:

```text
PASS: Returned the relevant snippet from src/users.js.
```

The snippet included both:

```text
getUserById
formatUserGreeting
```

and the problematic dereference:

```text
user.name
```

Tested:

```bash
gbrain code-def formatUserGreeting --source demo
gbrain code-def getUserById --source demo
```

Result:

```text
PARTIAL/FAIL: code_def returned no definitions for the demo JavaScript functions.
```

Conclusion:

```text
Do not depend only on code_def for repo context.
Use code_refs/search plus a worker-side fallback index.
```

## HTTP MCP Test

Started local HTTP MCP:

```bash
gbrain serve --http --port 3131
```

Validated:

```bash
curl http://localhost:3131/health
```

Result:

```text
PASS: health returned ok.
```

Validated OAuth discovery:

```bash
curl http://localhost:3131/.well-known/oauth-authorization-server
```

Result:

```text
PASS: OAuth metadata was available.
```

Created temporary local OAuth clients for testing. They were revoked after validation.

Validated MCP operations over HTTP:

```text
tools/list
tools/call search
tools/call code_refs
```

Result:

```text
PASS: A backend worker can call GBrain over HTTP MCP with client credentials.
```

## Important Local Constraint

When using PGLite, the HTTP server can hold the local database lock. Separate CLI/admin commands can time out while the server is running.

Observed:

```text
Timed out waiting for PGLite lock.
```

Conclusion:

```text
PGLite is acceptable for local validation.
Hosted/shared GBrain should use Postgres/Supabase.
```

## Hosted Deployment Status

Railway check:

```bash
railway status
```

Result:

```text
PASS: Railway project `lite-annotate` is linked and authenticated.
PASS: GBrain is deployed as service `36bc49fe-6c1c-40b1-a34e-a752b2173934`.
PASS: GBrain uses Railway Postgres service `71fac79d-d73a-4fd8-a2a7-dbc55857547b`.
PASS: Lite Annotate is deployed as service `f314acf1-0e46-49a5-a107-9b57d016ae49`.
```

Environment check:

```text
PASS: GBrain has DATABASE_URL pointing to Railway Postgres.
PASS: Lite Annotate has MEMORY_PROVIDER=gbrain.
PASS: Lite Annotate has GBRAIN_MCP_URL=https://gbrain-production-9170.up.railway.app/mcp.
PASS: Lite Annotate has OAuth client credentials for the `lite-annotate-worker` client.
PASS: Lite Annotate has REPORT_STORE_DIR=/data/reports on a Railway volume.
PASS: GBrain has an OpenAI embedding provider key configured for hosted semantic embeddings.
```

Conclusion:

```text
Hosted native GBrain is validated for report, diagnosis, outcome, and search memory.
Search proof now includes hosted GBrain OpenAI embeddings plus Lite Annotate searchSimilar.
```

Hosted services:

```text
GBrain URL: https://gbrain-production-9170.up.railway.app
GBrain deployment: 90a86f74-48fd-43b5-b1c4-aec47372e6a8
Lite Annotate URL: https://lite-annotate-production.up.railway.app
Lite Annotate deployment: 9fa70a1f-2f32-4c89-bb60-484983efa6de
Lite Annotate report volume: 8e7c3c68-5da5-4004-905b-b19e125a0c2e mounted at /data
```

Hosted smoke reports:

```text
API fixture smoke: bug_81e3cf24-7343-4081-a618-c9a8372f7187
Hosted widget smoke: bug_59d14766-d51a-4c84-917a-146ffa4e7d1e
```

Hosted validation results:

```text
PASS: GET /health returns ok for Lite Annotate.
PASS: GET /health returns ok/version 0.35.1.0/engine postgres for GBrain.
PASS: GBrain OAuth metadata is available.
PASS: POST /report from hosted fixture returned provider=gbrain status=written.
PASS: GET /reports/:id returned full normalized report context.
PASS: GET /reports/:id/raw returned raw payload and gbrain memory receipt.
PASS: GET /reports/:id/memory returned provider=gbrain and a similar prior bug.
PASS: GET /reports/:id/handoff returned repo, normalized report JSON, memory search result, receipts, and agent comparison.
PASS: Direct `gbrain search` found the hosted report by title.
PASS: POST /reports/:id/diagnosis returned provider=gbrain status=written.
PASS: POST /reports/:id/outcome returned provider=gbrain status=written.
PASS: Direct `gbrain search` found the hosted diagnosis and outcome pages.
PASS: `gbrain providers list` reported `openai` ready on hosted GBrain.
PASS: `gbrain embed --stale` embedded 23 stale chunks across 15 pages.
PASS: Direct semantic search for "User profile crashes reading name" returned `bugs/bug_a6e7b9a7-4dd9-417d-bd2e-b692463c0430` at score `1.0000`.
PASS: Restarted Lite Annotate and retrieved the same hosted report from the /data volume.
PASS: Browser smoke submitted a report through the hosted widget and dashboard showed annotation, console, network, session, screenshot, memory, and handoff context.
```

## Revised Product Boundary

Use GBrain for:

```text
bug memory
prior bug retrieval
diagnosis and PR outcome memory
code_refs/search-based code context
HTTP MCP access from worker
```

Do not rely only on GBrain for:

```text
perfect symbol definitions
full semantic code understanding without embeddings
hosted shared operation on PGLite
```

Use the worker for:

```text
GitHub/source clone
fallback AST or file-ranking index
fetching source-of-truth file contents
verification commands
PR creation
```

## Recommended Hosted Architecture

```text
Customer app
  -> hosted widget.js
  -> Lite Annotate API/worker
  -> hosted GBrain HTTP MCP
  -> Supabase/Postgres
  -> GitHub source files
  -> diagnosis
  -> optional PR
```

Optional GStack review runs through a separate VM-hosted runner:

```text
Lite Annotate API
  -> GStack Runner API
  -> Claude Code headless with GStack installed
  -> authenticated callback with review evidence
```

## Lite Annotate Adapter Status

Implemented in the app:

```text
MEMORY_PROVIDER=gbrain
GBRAIN_MCP_URL=https://<gbrain-service>/mcp
GBRAIN_MCP_TOKEN=<static bearer token, optional>
GBRAIN_CLIENT_ID=<OAuth client id, optional>
GBRAIN_CLIENT_SECRET=<OAuth client secret, optional>
GBRAIN_OAUTH_SCOPE="read write"
```

The native adapter now writes reports, diagnoses, and outcomes through GBrain
HTTP MCP `put_page` using the real `slug` + markdown frontmatter `content`
contract. It reads similar memory through GBrain MCP `search`, parses normal
JSON-RPC and SSE-style MCP responses, and falls back to markdown memory if the
GBrain call fails.

## Next Validation Needed

Before improving retrieval quality beyond the hackathon proof:

1. Add hosted repo/code source sync if Person B should query GBrain code refs remotely.
2. Keep worker-side repo clone/index as the source-of-truth code path until GBrain code-def behavior is reliable for the demo repo.

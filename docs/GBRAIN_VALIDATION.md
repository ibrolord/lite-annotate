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
BLOCKED: Railway auth refresh failed with invalid_grant.
BLOCKED: No linked Railway project found.
```

Environment check:

```text
No DATABASE_URL found.
No SUPABASE env found.
No OPENAI_API_KEY found in the shell.
No GBRAIN env found.
```

Conclusion:

```text
Hosted GBrain is feasible, but not validated yet from this machine.
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
  -> GStack-style investigate/review workflow
  -> diagnosis
  -> optional PR
```

## Next Validation Needed

Before betting the live demo on hosted native GBrain:

1. Re-auth Railway or choose Render/Fly.
2. Provision Supabase/Postgres.
3. Set an embedding provider key.
4. Run hosted:

```bash
gbrain serve --http --bind 0.0.0.0 --port $PORT --public-url <hosted-url>
```

5. Register a `lite-annotate-worker` OAuth client.
6. From Lite Annotate worker, call:

```text
put_page
search
code_refs
```

7. Confirm one hosted bug report can retrieve prior memory and code context.

# GStack Runner Deployment

Lite Annotate calls a separate remote runner when a report needs a real GStack-assisted review.

Use this split:

```text
Railway / Lite Annotate API
  -> POST https://gstack-runner.example.com/jobs

Ubuntu VM / GStack Runner
  -> git clone target repo
  -> claude -p with installed GStack skills
  -> POST /internal/gstack-callback back to Lite Annotate
```

## Chosen Environment

Use a small Ubuntu 24.04 VM first. DigitalOcean, Hetzner, or Linode are all fine.

Minimum useful size:

```text
2 vCPU
4 GB RAM
40 GB disk
Ubuntu 24.04 LTS
```

Do not run this inside the Lite Annotate web API. The runner needs shell tools, temp clones, Claude Code auth/config, GStack skills, and longer job timeouts.

## VM Bootstrap

```bash
sudo apt update
sudo apt install -y git curl nodejs npm nginx certbot python3-certbot-nginx
npm install -g @anthropic-ai/claude-code
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack
cd ~/.claude/skills/gstack
./setup
```

Authenticate Claude Code on the VM before running the service. The same Unix user
that runs systemd, `ubuntu` in the example below, must be able to run
`claude -p` non-interactively; authenticating as a different shell user is not
enough.

## Install Runner

Clone this repo on the VM:

```bash
git clone https://github.com/<owner>/lite-annotate.git /opt/lite-annotate
cd /opt/lite-annotate
npm ci
```

Create `/etc/lite-annotate-gstack-runner.env`:

```bash
PORT=3015
GSTACK_RUNNER_ROOT=/var/lib/lite-annotate-gstack-runner
GSTACK_RUNNER_TOKEN=<shared-secret-lite-annotate-sends-to-runner>
LITE_ANNOTATE_CALLBACK_TOKEN=<shared-secret-runner-sends-to-lite-annotate>
LITE_ANNOTATE_CALLBACK_URL=https://lite-annotate-production.up.railway.app/internal/gstack-callback
GSTACK_REPO_ALLOWLIST=ibrolord/lite-annotate-demo,ibrolord/lite-annotate-commerce-demo
GITHUB_READ_TOKEN=<optional-read-only-token-for-private-non-pr-jobs>
GITHUB_TOKEN=<repo-scoped-write-token-only-if-pr-creation-is-needed>
CLAUDE_BIN=claude
CLAUDE_MAX_TURNS=8
GSTACK_JOB_TIMEOUT_MS=900000
GSTACK_KEEP_WORKDIR=0
```

Create `/etc/systemd/system/lite-annotate-gstack-runner.service`:

```ini
[Unit]
Description=Lite Annotate GStack Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/lite-annotate
EnvironmentFile=/etc/lite-annotate-gstack-runner.env
ExecStart=/usr/bin/npm run gstack:runner
Restart=always
RestartSec=5
User=ubuntu
Group=ubuntu

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo mkdir -p /var/lib/lite-annotate-gstack-runner
sudo chown -R ubuntu:ubuntu /var/lib/lite-annotate-gstack-runner /opt/lite-annotate
sudo systemctl daemon-reload
sudo systemctl enable --now lite-annotate-gstack-runner
sudo journalctl -u lite-annotate-gstack-runner -f
```

## HTTPS

Point DNS for `gstack-runner.<domain>` at the VM, then:

```bash
sudo certbot --nginx -d gstack-runner.<domain>
```

Nginx should proxy to `127.0.0.1:3015`.

## Lite Annotate Env

Set these on the Lite Annotate host:

```bash
PUBLIC_BASE_URL=https://lite-annotate-production.up.railway.app
GSTACK_RUNNER_URL=https://gstack-runner.<domain>
GSTACK_RUNNER_TOKEN=<same shared secret as runner GSTACK_RUNNER_TOKEN>
GSTACK_TRIGGER_TOKEN=<optional-internal-secret-for-api-only-job-starts>
GSTACK_CALLBACK_TOKEN=<same shared secret as runner LITE_ANNOTATE_CALLBACK_TOKEN>
GSTACK_ALLOW_PR=0
GSTACK_UI_TRIGGER_ENABLED=0
```

Set `GSTACK_ALLOW_PR=1` only when remote GStack jobs are allowed to open PRs.
The Lite Annotate trigger endpoint rejects `allowPr: true` unless that flag is
enabled.

Set `GSTACK_UI_TRIGGER_ENABLED=1` only when the report page should show and allow
the unauthenticated product UI button. Otherwise, product jobs can still be
started through `POST /reports/:id/gstack/investigate` with
`Authorization: Bearer $GSTACK_TRIGGER_TOKEN`.

Then the product flow is:

```text
POST /reports/:id/gstack/investigate
  -> remote runner /jobs
  -> runner executes Claude Code + GStack /investigate
  -> runner callback stores result
  -> GET /reports/:id/gstack/investigation returns clean UI-ready evidence
```

The legacy `POST /reports/:id/gstack-review` and `GET /reports/:id/gstack-review`
routes remain available for protected/internal callers that need raw runner
details. They accept `mode` or `workflow` values, but Lite Annotate normalizes the
product investigation path to `investigate` with `allowPr: false`.

## Safety Defaults

- Keep `GSTACK_REPO_ALLOWLIST` narrow.
- Use `GITHUB_READ_TOKEN` for private non-PR review jobs.
- Set `GITHUB_TOKEN` only for explicit PR-capable jobs; non-PR jobs strip write tokens from the Claude environment.
- Keep one temp checkout per job.
- Use `allowPr: false` unless the user explicitly requests PR creation.
- Raw runner logs stay runner-local; Lite Annotate callbacks strip `logs` before report storage/UI.

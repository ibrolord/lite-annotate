import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { GStackReviewRequest, GStackReviewResult, StoredGStackReviewRecord } from '../api/gstack_runner.js';

interface RunnerJob extends StoredGStackReviewRecord {
  request: GStackReviewRequest;
  workDir: string;
  logs?: string;
}

const app = new Hono();
const rootDir = process.env.GSTACK_RUNNER_ROOT || join(process.cwd(), '.lite-annotate', 'gstack-runner');
const jobsDir = join(rootDir, 'jobs');
const workDir = join(rootDir, 'work');

app.get('/health', (c) => c.json({ ok: true, service: 'gstack-runner' }));

app.post('/jobs', async (c) => {
  if (!authorized(c.req.raw, process.env.GSTACK_RUNNER_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let request: GStackReviewRequest;
  try {
    request = await c.req.json() as GStackReviewRequest;
  } catch {
    return c.json({ error: 'invalid_json', message: 'body must be valid JSON' }, 400);
  }
  const validation = validateRequest(request);
  if (validation) return c.json({ error: 'invalid_job', message: validation }, 400);

  const jobId = `gstack_${randomUUID()}`;
  const now = new Date().toISOString();
  const job: RunnerJob = {
    jobId,
    reportId: request.reportId,
    status: 'queued',
    mode: request.mode,
    request,
    workDir: join(workDir, jobId),
    createdAt: now,
    updatedAt: now,
  };
  await saveJob(job);

  void processJob(job).catch(async (err) => {
    const failed = await loadJob(jobId) ?? job;
    failed.status = 'failed';
    failed.error = redactSecrets(errorMessage(err));
    failed.result = {
      jobId,
      reportId: job.reportId,
      status: 'failed',
      mode: failed.mode,
      commandsRun: [],
      summary: `GStack runner failed: ${failed.error}`,
      completedAt: new Date().toISOString(),
    };
    failed.updatedAt = new Date().toISOString();
    await saveJob(failed);
    await callbackResultWithRetry(failed, failed.result);
  });

  return c.json({ jobId, status: 'queued' }, 202);
});

app.get('/jobs/:id', async (c) => {
  if (!authorized(c.req.raw, process.env.GSTACK_RUNNER_TOKEN)) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'not_found' }, 404);
  return c.json(safeJob(job));
});

async function processJob(job: RunnerJob): Promise<void> {
  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  await saveJob(job);

  await mkdir(job.workDir, { recursive: true });
  const checkoutDir = join(job.workDir, 'repo');
  await cloneRepo(job.request.repo, checkoutDir, job.request.allowPr);

  const prompt = buildClaudePrompt(job.request);
  const claude = await runCommand(
    process.env.CLAUDE_BIN || 'claude',
    ['-p', prompt, '--max-turns', process.env.CLAUDE_MAX_TURNS || '8'],
    checkoutDir,
    Number.parseInt(process.env.GSTACK_JOB_TIMEOUT_MS || '900000', 10),
    buildRunnerCommandEnv(job.request.allowPr)
  );

  job.logs = redactSecrets(claude.stdout + (claude.stderr ? `\n--- stderr ---\n${claude.stderr}` : ''));
  const parsed = parseClaudeResult(job, job.logs);
  job.status = parsed.status;
  job.result = parsed;
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
  await callbackResultWithRetry(job, parsed);

  if (process.env.GSTACK_KEEP_WORKDIR !== '1') {
    await rm(job.workDir, { recursive: true, force: true });
  }
}

async function cloneRepo(repo: string, checkoutDir: string, allowPr: boolean): Promise<void> {
  const url = repoUrl(repo, allowPr);
  await runCommand('git', ['clone', '--depth', '1', url, checkoutDir], process.cwd(), 120000);
  if (!allowPr) {
    await runCommand('git', ['remote', 'set-url', 'origin', publicRepoUrl(repo)], checkoutDir, 30000);
  }
}

function repoUrl(repo: string, allowPr: boolean): string {
  const trimmed = repo.trim().replace(/\.git$/i, '');
  if (/^https?:\/\//i.test(trimmed) || /^git@github\.com:/i.test(trimmed)) return trimmed;
  const token = allowPr ? process.env.GITHUB_TOKEN : process.env.GITHUB_READ_TOKEN;
  if (token) return `https://x-access-token:${encodeURIComponent(token)}@github.com/${trimmed}.git`;
  return publicRepoUrl(repo);
}

function publicRepoUrl(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/i, '');
  if (/^https?:\/\//i.test(trimmed) || /^git@github\.com:/i.test(trimmed)) return trimmed;
  return `https://github.com/${trimmed}.git`;
}

function buildClaudePrompt(request: GStackReviewRequest): string {
  return `Load gstack.

You are running a real remote GStack review for Lite Annotate.

Use the installed GStack workflow skills as applicable:
- /investigate to establish the root cause before proposing fixes.
- /plan-eng-review if code changes are required.
- /review after any patch or proposed patch.
- /qa if UI or runtime behavior changed.
- /ship only if verification passes and PR creation is explicitly allowed.

Rules:
- Do not invent GStack evidence. Only list commands or skills you actually used.
- Do not push or open a PR unless allowPr is true and verification passes.
- Keep changes scoped to the target repo and the report's likely files.
- Return a single JSON object between RESULT_JSON_START and RESULT_JSON_END.

Job:
${JSON.stringify({
    reportId: request.reportId,
    repo: request.repo,
    mode: request.mode,
    allowPr: request.allowPr,
    reportUrl: request.reportUrl,
    memoryUrl: request.memoryUrl,
    handoffUrl: request.handoffUrl,
    report: request.report,
  }, null, 2)}

Expected JSON shape:
{
  "status": "passed" | "failed" | "blocked",
  "commandsRun": ["/investigate", "/review"],
  "summary": "short plain-English result",
  "diagnosis": "root cause summary",
  "findings": [{"severity":"high|medium|low","message":"...","file":"optional","line":123}],
  "tests": [{"command":"npm test","status":"passed|failed|skipped","output":"short output"}],
  "prUrl": "optional",
  "commitSha": "optional"
}`;
}

function parseClaudeResult(job: RunnerJob, output: string): GStackReviewResult {
  const match = output.match(/RESULT_JSON_START\s*([\s\S]*?)\s*RESULT_JSON_END/);
  const parsed = match ? tryParseJson(match[1]) : null;
  const status = parsed?.status === 'passed' || parsed?.status === 'blocked' || parsed?.status === 'failed'
    ? parsed.status
    : 'blocked';

  return {
    jobId: job.jobId,
    reportId: job.reportId,
    status,
    mode: job.mode,
    commandsRun: Array.isArray(parsed?.commandsRun) ? parsed.commandsRun.filter((item): item is string => typeof item === 'string') : [],
    summary: typeof parsed?.summary === 'string' ? parsed.summary : 'Claude completed without a parseable GStack result.',
    diagnosis: typeof parsed?.diagnosis === 'string' ? parsed.diagnosis : undefined,
    findings: Array.isArray(parsed?.findings) ? parsed.findings : [],
    tests: Array.isArray(parsed?.tests) ? parsed.tests : [],
    prUrl: typeof parsed?.prUrl === 'string' ? parsed.prUrl : undefined,
    commitSha: typeof parsed?.commitSha === 'string' ? parsed.commitSha : undefined,
    completedAt: new Date().toISOString(),
  };
}

async function callbackResult(job: RunnerJob, result: GStackReviewResult): Promise<void> {
  const response = await fetch(callbackUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(process.env.LITE_ANNOTATE_CALLBACK_TOKEN),
    },
    body: JSON.stringify(result),
  });
  if (!response.ok) {
    throw new Error(`Lite Annotate callback failed: ${response.status} ${await response.text()}`);
  }
}

async function callbackResultWithRetry(job: RunnerJob, result: GStackReviewResult): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await callbackResult(job, result);
      return;
    } catch (err) {
      lastError = err;
      await delay(attempt * 2000);
    }
  }
  job.error = `Lite Annotate callback failed after retries: ${redactSecrets(errorMessage(lastError))}`;
  job.updatedAt = new Date().toISOString();
  await saveJob(job);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveJob(job: RunnerJob): Promise<void> {
  await mkdir(jobsDir, { recursive: true });
  await writeFile(join(jobsDir, `${job.jobId}.json`), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
}

async function loadJob(jobId: string): Promise<RunnerJob | null> {
  try {
    const content = await readFile(join(jobsDir, `${safeId(jobId)}.json`), 'utf8');
    return JSON.parse(content) as RunnerJob;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function safeJob(job: RunnerJob): Record<string, unknown> {
  return {
    jobId: job.jobId,
    reportId: job.reportId,
    status: job.status,
    mode: job.mode,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
  };
}

function validateRequest(request: GStackReviewRequest): string | null {
  if (!request || typeof request !== 'object') return 'body must be JSON';
  if (!request.reportId) return 'reportId is required';
  if (!request.repo) return 'repo is required';
  if (!request.report || typeof request.report !== 'object') return 'report is required';
  const allowed = process.env.GSTACK_REPO_ALLOWLIST?.split(',').map((item) => item.trim()).filter(Boolean);
  if (!allowed?.length) return 'GSTACK_REPO_ALLOWLIST is required';
  if (!allowed.includes(request.repo)) return `repo is not allowlisted: ${request.repo}`;
  if (!process.env.LITE_ANNOTATE_CALLBACK_URL) return 'LITE_ANNOTATE_CALLBACK_URL is required';
  return null;
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const actual = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  return actual === token;
}

function authHeader(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function callbackUrl(): string {
  const url = process.env.LITE_ANNOTATE_CALLBACK_URL;
  if (!url) throw new Error('LITE_ANNOTATE_CALLBACK_URL is required');
  return url;
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  return runCommandWithEnv(command, args, cwd, timeoutMs, env);
}

async function runCommandWithEnv(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(redactSecrets(`${command} exited ${code}: ${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`)));
    });
  });
}

function buildRunnerCommandEnv(allowPr: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!allowPr) {
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_PAT',
      'GIT_TOKEN',
      'GITHUB_READ_TOKEN',
      'GIT_ASKPASS',
      'SSH_AUTH_SOCK',
    ]) {
      delete env[key];
    }
  }
  return env;
}

function redactSecrets(value: string): string {
  let redacted = value
    .replace(/https:\/\/x-access-token:[^@\s]+@github\.com/gi, 'https://x-access-token:[REDACTED]@github.com')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
  for (const secret of [
    process.env.GITHUB_TOKEN,
    process.env.GH_TOKEN,
    process.env.GITHUB_PAT,
    process.env.GIT_TOKEN,
    process.env.GITHUB_READ_TOKEN,
    process.env.GSTACK_RUNNER_TOKEN,
    process.env.LITE_ANNOTATE_CALLBACK_TOKEN,
  ]) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error(`Invalid id: ${value}`);
  return safe;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const directRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directRun) {
  const port = Number.parseInt(process.env.PORT || '3015', 10);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`gstack-runner API running on http://localhost:${port}`);
  });
}

export { app, buildRunnerCommandEnv, repoUrl as buildCloneUrl, redactSecrets };

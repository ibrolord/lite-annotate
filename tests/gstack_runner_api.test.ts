import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../api/index.js';
import { createMemoryAdapter } from '../api/gbrain.js';
import { ReportStore } from '../api/report_store.js';
import { app as runnerApp, buildClaudeInvocation, buildClaudePrompt, buildCloneUrl, buildRunnerCommandEnv, runCommand } from '../gstack-runner/server.js';

test('GStack review endpoint creates remote job and callback stores result', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-api-'));
  const oldEnv = snapshotEnv([
    'MEMORY_DIR',
    'MEMORY_PROVIDER',
    'GSTACK_RUNNER_URL',
    'GSTACK_RUNNER_TOKEN',
    'GSTACK_CALLBACK_TOKEN',
    'GSTACK_REPO_ALLOWLIST',
    'GSTACK_TRIGGER_TOKEN',
    'GSTACK_UI_TRIGGER_ENABLED',
    'GSTACK_QA_UI_TRIGGER_ENABLED',
    'GSTACK_QA_ALLOW_PR',
    'GSTACK_ALLOW_PR',
    'PUBLIC_BASE_URL',
  ]);
  const oldFetch = globalThis.fetch;
  const runnerRequests: Array<{ url: string; auth: string | null; body: unknown }> = [];

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_RUNNER_URL = 'https://gstack-runner.example.com';
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';
  process.env.GSTACK_REPO_ALLOWLIST = 'ibrolord/lite-annotate-demo';
  process.env.GSTACK_TRIGGER_TOKEN = 'trigger-secret';
  process.env.GSTACK_UI_TRIGGER_ENABLED = '1';
  process.env.GSTACK_QA_UI_TRIGGER_ENABLED = '1';
  process.env.GSTACK_ALLOW_PR = '1';
  process.env.PUBLIC_BASE_URL = 'https://lite-annotate.example.com';

  globalThis.fetch = async (input, init) => {
    runnerRequests.push({
      url: String(input),
      auth: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ jobId: 'gstack_job_123', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const rejected = await app.request(`/reports/${posted.reportId}/gstack-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'review_fix', allowPr: true }),
    });
    assert.equal(rejected.status, 401);

    const create = await app.request(`/reports/${posted.reportId}/gstack/investigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.investigation.runner.jobId, 'gstack_job_123');
    assert.equal(created.investigation.status, 'queued');
    assert.equal(created.investigation.runner.workflow, 'investigate');
    assert.equal(runnerRequests.length, 1);
    assert.equal(runnerRequests[0].url, 'https://gstack-runner.example.com/jobs');
    assert.equal(runnerRequests[0].auth, 'Bearer runner-secret');
    assert.equal((runnerRequests[0].body as { callbackUrl: string }).callbackUrl, 'https://lite-annotate.example.com/internal/gstack-callback');
    assert.equal((runnerRequests[0].body as { allowPr: boolean }).allowPr, false);
    assert.equal((runnerRequests[0].body as { mode: string }).mode, 'investigate');
    assert.equal((runnerRequests[0].body as { repo: string }).repo, fixture.repo);
    assert.equal((runnerRequests[0].body as { reportUrl: string }).reportUrl, `https://lite-annotate.example.com/reports/${posted.reportId}`);
    assert.equal((runnerRequests[0].body as { memoryUrl: string }).memoryUrl, `https://lite-annotate.example.com/reports/${posted.reportId}/memory`);
    assert.equal((runnerRequests[0].body as { handoffUrl: string }).handoffUrl, `https://lite-annotate.example.com/reports/${posted.reportId}/handoff`);
    assert.equal((runnerRequests[0].body as { report: { id: string; annotation: { target: string } } }).report.id, posted.reportId);
    assert.equal((runnerRequests[0].body as { report: { annotation: { target: string } } }).report.annotation.target, fixture.annotation.target);

    const browserClick = await app.request(`/reports/${posted.reportId}/gstack/investigate`, {
      method: 'POST',
      headers: { Accept: 'text/html' },
    });
    assert.equal(browserClick.status, 303);
    assert.equal(browserClick.headers.get('location'), `/reports/${posted.reportId}/view#gstack-review`);
    assert.equal(runnerRequests.length, 1);

    const callback = await app.request('/internal/gstack-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer callback-secret',
      },
      body: JSON.stringify({
        jobId: 'gstack_job_123',
        reportId: posted.reportId,
        status: 'passed',
        mode: 'investigate',
        commandsRun: ['/investigate', '/review'],
        headline: 'Missing-user path crashes after a 404.',
        summary: 'GStack investigation passed',
        rootCause: 'The UI reads user.name after /api/users/999 returns 404.',
        confidence: 'high',
        evidence: [{ label: 'Code', value: 'src/users.js reads user.name without a guard' }],
        recommendedAction: { type: 'autofix', label: 'Run Auto-Fix with this investigation' },
        diagnosis: 'Missing user guard',
        tests: [{ command: 'npm test', status: 'passed' }],
        logs: 'raw runner output with runner-secret and callback-secret',
        completedAt: '2026-05-16T12:00:00.000Z',
      }),
    });
    assert.equal(callback.status, 200);

    const get = await app.request(`/reports/${posted.reportId}/gstack-review`);
    const getBody = await get.json();
    assert.equal(getBody.gstackReview.status, 'passed');
    assert.equal(getBody.gstackReview.mode, 'investigate');
    assert.equal(getBody.gstackReview.result.mode, 'investigate');
    assert.equal(getBody.gstackReview.result.summary, 'GStack investigation passed');
    assert.equal('logs' in getBody.gstackReview.result, false);

    const investigation = await app.request(`/reports/${posted.reportId}/gstack/investigation`);
    assert.equal(investigation.status, 200);
    const investigationBody = await investigation.json();
    assert.equal(investigationBody.investigation.status, 'passed');
    assert.equal(investigationBody.investigation.headline, 'Missing-user path crashes after a 404.');
    assert.equal(investigationBody.investigation.rootCause, 'The UI reads user.name after /api/users/999 returns 404.');
    assert.equal(investigationBody.investigation.confidence, 'high');
    assert.equal(investigationBody.investigation.recommendedAction.type, 'autofix');
    assert.equal(investigationBody.investigation.evidence.some((item: { label: string }) => item.label === 'Browser console'), true);
    assert.equal(investigationBody.investigation.evidence.some((item: { label: string }) => item.label === 'Code'), true);

    const view = await app.request(`/reports/${posted.reportId}/view`);
    const html = await view.text();
    assert.match(html, /GStack Review/);
    assert.match(html, /Missing-user path crashes after a 404/);
    assert.match(html, /Run Auto-Fix with this investigation/);
    assert.match(html, /id="gstack-review"/);
    assert.match(html, /Runner response/);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(oldEnv);
  }
});

test('GStack investigation button redirects back to the report and shows queued response', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-ui-'));
  const oldEnv = snapshotEnv([
    'MEMORY_DIR',
    'MEMORY_PROVIDER',
    'GSTACK_RUNNER_URL',
    'GSTACK_RUNNER_TOKEN',
    'GSTACK_CALLBACK_TOKEN',
    'GSTACK_UI_TRIGGER_ENABLED',
    'PUBLIC_BASE_URL',
  ]);
  const oldFetch = globalThis.fetch;
  const runnerRequests: Array<{ url: string; body: unknown }> = [];

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_RUNNER_URL = 'https://gstack-runner.example.com';
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';
  process.env.GSTACK_UI_TRIGGER_ENABLED = '1';
  process.env.PUBLIC_BASE_URL = 'https://lite-annotate.example.com';

  globalThis.fetch = async (input, init) => {
    runnerRequests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ jobId: 'gstack_job_ui_123', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const initialView = await app.request(`/reports/${posted.reportId}/view`);
    const initialHtml = await initialView.text();
    assert.match(initialHtml, /data-gstack-live/);
    assert.match(initialHtml, /data-gstack-src="\/reports\/[^"]+\/gstack\/investigation"/);
    assert.match(initialHtml, /data-gstack-form data-gstack-workflow="investigate"/);
    assert.match(initialHtml, /<button class="quiet" type="submit">Run GStack Review<\/button>/);
    assert.doesNotMatch(initialHtml, /GStack investigation is available through the protected API/);
    assert.doesNotMatch(initialHtml, /<button class="safe" type="submit">Investigate with GStack<\/button>/);

    const create = await app.request(`/reports/${posted.reportId}/gstack/investigate`, {
      method: 'POST',
      headers: { Accept: 'text/html' },
    });

    assert.equal(create.status, 303);
    assert.equal(create.headers.get('location'), `/reports/${posted.reportId}/view#gstack-review`);
    assert.equal(runnerRequests.length, 1);
    assert.equal(runnerRequests[0].url, 'https://gstack-runner.example.com/jobs');
    assert.equal((runnerRequests[0].body as { mode: string }).mode, 'investigate');
    assert.equal((runnerRequests[0].body as { allowPr: boolean }).allowPr, false);
    assert.equal((runnerRequests[0].body as { report: { id: string } }).report.id, posted.reportId);

    const view = await app.request(`/reports/${posted.reportId}/view`);
    const html = await view.text();
    assert.match(html, /data-gstack-active="true"/);
    assert.match(html, /Runner console/);
    assert.match(html, /GStack investigation is queued/);
    assert.match(html, /gstack_job_ui_123/);
    assert.match(html, /Runner response/);
    assert.doesNotMatch(html, /<button class="quiet" type="submit">Run GStack Review<\/button>/);
    assert.match(html, /Wait for the runner callback/);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(oldEnv);
  }
});

test('GStack QA button creates a qa job without PR permissions by default', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-qa-ui-'));
  const oldEnv = snapshotEnv([
    'MEMORY_DIR',
    'MEMORY_PROVIDER',
    'GSTACK_RUNNER_URL',
    'GSTACK_RUNNER_TOKEN',
    'GSTACK_CALLBACK_TOKEN',
    'GSTACK_UI_TRIGGER_ENABLED',
    'GSTACK_QA_UI_TRIGGER_ENABLED',
    'GSTACK_ALLOW_PR',
    'PUBLIC_BASE_URL',
  ]);
  const oldFetch = globalThis.fetch;
  const runnerRequests: Array<{ url: string; body: unknown }> = [];

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_RUNNER_URL = 'https://gstack-runner.example.com';
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';
  process.env.GSTACK_UI_TRIGGER_ENABLED = '1';
  process.env.GSTACK_QA_UI_TRIGGER_ENABLED = '1';
  delete process.env.GSTACK_QA_ALLOW_PR;
  process.env.GSTACK_ALLOW_PR = '1';
  process.env.PUBLIC_BASE_URL = 'https://lite-annotate.example.com';

  globalThis.fetch = async (input, init) => {
    runnerRequests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ jobId: 'gstack_job_qa_123', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const initialView = await app.request(`/reports/${posted.reportId}/view`);
    const initialHtml = await initialView.text();
    assert.match(initialHtml, /data-gstack-form data-gstack-workflow="qa"/);
    assert.match(initialHtml, /<button class="quiet" type="submit">Run GStack QA<\/button>/);

    const create = await app.request(`/reports/${posted.reportId}/gstack/qa`, {
      method: 'POST',
      headers: { Accept: 'text/html' },
    });

    assert.equal(create.status, 303);
    assert.equal(create.headers.get('location'), `/reports/${posted.reportId}/view#gstack-review`);
    assert.equal(runnerRequests.length, 1);
    assert.equal(runnerRequests[0].url, 'https://gstack-runner.example.com/jobs');
    assert.equal((runnerRequests[0].body as { mode: string }).mode, 'qa');
    assert.equal((runnerRequests[0].body as { allowPr: boolean }).allowPr, false);
    assert.equal((runnerRequests[0].body as { callbackUrl: string }).callbackUrl, 'https://lite-annotate.example.com/internal/gstack-callback');
    assert.equal((runnerRequests[0].body as { report: { id: string } }).report.id, posted.reportId);

    const view = await app.request(`/reports/${posted.reportId}/view`);
    const html = await view.text();
    assert.match(html, /Runner console/);
    assert.match(html, /\$ workflow: qa/);
    assert.match(html, /GStack QA is queued/);
    assert.match(html, /gstack_job_qa_123/);

    const investigation = await app.request(`/reports/${posted.reportId}/gstack/investigation`);
    assert.equal(investigation.status, 200);
    const investigationBody = await investigation.json();
    assert.equal(investigationBody.investigation.runner.workflow, 'qa');
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(oldEnv);
  }
});

test('GStack QA can request PR permissions only with explicit QA and global PR flags', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-qa-pr-ui-'));
  const oldEnv = snapshotEnv([
    'MEMORY_DIR',
    'MEMORY_PROVIDER',
    'GSTACK_RUNNER_URL',
    'GSTACK_RUNNER_TOKEN',
    'GSTACK_CALLBACK_TOKEN',
    'GSTACK_UI_TRIGGER_ENABLED',
    'GSTACK_QA_UI_TRIGGER_ENABLED',
    'GSTACK_QA_ALLOW_PR',
    'GSTACK_ALLOW_PR',
    'PUBLIC_BASE_URL',
  ]);
  const oldFetch = globalThis.fetch;
  const runnerRequests: Array<{ body: unknown }> = [];

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_RUNNER_URL = 'https://gstack-runner.example.com';
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';
  process.env.GSTACK_UI_TRIGGER_ENABLED = '1';
  process.env.GSTACK_QA_UI_TRIGGER_ENABLED = '1';
  process.env.GSTACK_QA_ALLOW_PR = '1';
  process.env.GSTACK_ALLOW_PR = '1';
  process.env.PUBLIC_BASE_URL = 'https://lite-annotate.example.com';

  globalThis.fetch = async (_input, init) => {
    runnerRequests.push({ body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ jobId: 'gstack_job_qa_pr_123', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const create = await app.request(`/reports/${posted.reportId}/gstack/qa`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });

    assert.equal(create.status, 202);
    assert.equal(runnerRequests.length, 1);
    assert.equal((runnerRequests[0].body as { mode: string }).mode, 'qa');
    assert.equal((runnerRequests[0].body as { allowPr: boolean }).allowPr, true);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(oldEnv);
  }
});

test('GStack investigation reuses an active job instead of replacing it', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-dedupe-'));
  const oldEnv = snapshotEnv([
    'MEMORY_DIR',
    'MEMORY_PROVIDER',
    'GSTACK_RUNNER_URL',
    'GSTACK_RUNNER_TOKEN',
    'GSTACK_CALLBACK_TOKEN',
    'GSTACK_UI_TRIGGER_ENABLED',
    'PUBLIC_BASE_URL',
  ]);
  const oldFetch = globalThis.fetch;
  const runnerRequests: unknown[] = [];

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_RUNNER_URL = 'https://gstack-runner.example.com';
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';
  process.env.GSTACK_UI_TRIGGER_ENABLED = '1';
  process.env.PUBLIC_BASE_URL = 'https://lite-annotate.example.com';

  globalThis.fetch = async (_input, init) => {
    runnerRequests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ jobId: 'gstack_active_123', status: 'queued' }), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const first = await app.request(`/reports/${posted.reportId}/gstack/investigate`, { method: 'POST' });
    const second = await app.request(`/reports/${posted.reportId}/gstack/investigate`, { method: 'POST' });
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(runnerRequests.length, 1);
    assert.equal((await first.json()).investigation.runner.jobId, 'gstack_active_123');
    assert.equal((await second.json()).investigation.runner.jobId, 'gstack_active_123');
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(oldEnv);
  }
});

test('GStack callback rejects unqueued jobs and acknowledges stale callbacks', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-callback-state-'));
  const oldEnv = snapshotEnv(['MEMORY_DIR', 'MEMORY_PROVIDER', 'GSTACK_CALLBACK_TOKEN']);

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const unqueued = await app.request('/internal/gstack-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer callback-secret',
      },
      body: JSON.stringify({
        jobId: 'gstack_unqueued',
        reportId: posted.reportId,
        status: 'passed',
        commandsRun: ['/investigate'],
        summary: 'should not store',
        completedAt: '2026-05-16T12:00:00.000Z',
      }),
    });
    assert.equal(unqueued.status, 409);
    assert.equal((await unqueued.json()).error, 'job_not_queued');

    await store.update(posted.reportId, (record) => ({
      ...record,
      gstackReview: {
        jobId: 'gstack_current',
        reportId: posted.reportId,
        status: 'queued',
        mode: 'investigate',
        createdAt: '2026-05-16T12:00:00.000Z',
        updatedAt: '2026-05-16T12:00:00.000Z',
      },
    }));

    const stale = await app.request('/internal/gstack-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer callback-secret',
      },
      body: JSON.stringify({
        jobId: 'gstack_old',
        reportId: posted.reportId,
        status: 'passed',
        commandsRun: ['/investigate'],
        summary: 'stale result',
        completedAt: '2026-05-16T12:01:00.000Z',
      }),
    });
    assert.equal(stale.status, 200);
    assert.deepEqual(await stale.json(), {
      ok: true,
      ignored: true,
      reason: 'stale_job_callback',
      expectedJobId: 'gstack_current',
      receivedJobId: 'gstack_old',
    });
    assert.equal((await store.get(posted.reportId))?.gstackReview?.jobId, 'gstack_current');
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack evidence prioritizes error console and failed network breadcrumbs', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-evidence-'));
  const oldEnv = snapshotEnv(['MEMORY_DIR', 'MEMORY_PROVIDER']);

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  fixture.console = [
    { level: 'log', message: 'startup log', timestamp: '2026-05-16T12:00:00.000Z' },
    { level: 'error', message: 'login failed: invalid session', timestamp: '2026-05-16T12:00:01.000Z' },
  ];
  fixture.network = [
    { type: 'fetch', method: 'GET', url: '/api/session', status: 200, durationMs: 20, failed: false },
    { type: 'fetch', method: 'POST', url: '/api/login', status: 401, durationMs: 35, failed: true },
  ];

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();
    const response = await app.request(`/reports/${posted.reportId}/gstack/investigation`);
    const body = await response.json();
    const browserEvidence = body.investigation.evidence.find((item: { label: string }) => item.label === 'Browser console');
    const networkEvidence = body.investigation.evidence.find((item: { label: string }) => item.label === 'Network');
    assert.equal(browserEvidence.value, 'login failed: invalid session');
    assert.equal(networkEvidence.value, 'POST /api/login returned 401 (failed)');
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack review trigger fails closed when trigger token is not configured', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-trigger-token-'));
  const oldEnv = snapshotEnv([
    'MEMORY_DIR',
    'MEMORY_PROVIDER',
    'GSTACK_TRIGGER_TOKEN',
    'GSTACK_UI_TRIGGER_ENABLED',
    'GSTACK_QA_UI_TRIGGER_ENABLED',
  ]);

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  delete process.env.GSTACK_TRIGGER_TOKEN;
  delete process.env.GSTACK_UI_TRIGGER_ENABLED;
  delete process.env.GSTACK_QA_UI_TRIGGER_ENABLED;

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const posted = await post.json();

    const response = await app.request(`/reports/${posted.reportId}/gstack-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'review_fix', allowPr: false }),
    });

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error, 'gstack_not_configured');
    assert.equal(body.message, 'GSTACK_TRIGGER_TOKEN is not configured');

    const productTrigger = await app.request(`/reports/${posted.reportId}/gstack/investigate`, {
      method: 'POST',
    });
    assert.equal(productTrigger.status, 503);
    const productBody = await productTrigger.json();
    assert.equal(productBody.error, 'gstack_not_configured');
    assert.equal(productBody.message, 'GSTACK_UI_TRIGGER_ENABLED=1 or GSTACK_TRIGGER_TOKEN is required');

    const qaTrigger = await app.request(`/reports/${posted.reportId}/gstack/qa`, {
      method: 'POST',
    });
    assert.equal(qaTrigger.status, 503);
    const qaBody = await qaTrigger.json();
    assert.equal(qaBody.error, 'gstack_not_configured');
    assert.equal(qaBody.message, 'GSTACK_QA_UI_TRIGGER_ENABLED=1 or GSTACK_TRIGGER_TOKEN is required');

    const view = await app.request(`/reports/${posted.reportId}/view`);
    const html = await view.text();
    assert.match(html, /GStack investigation is available through the protected API/);
    assert.doesNotMatch(html, /<button class="safe" type="submit">Investigate with GStack<\/button>/);
    assert.match(html, /Run a GStack investigation first/);
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack callback rejects invalid JSON without changing report state', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-callback-json-'));
  const oldEnv = snapshotEnv(['MEMORY_DIR', 'MEMORY_PROVIDER', 'GSTACK_CALLBACK_TOKEN']);

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  process.env.GSTACK_CALLBACK_TOKEN = 'callback-secret';

  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });

    const callback = await app.request('/internal/gstack-callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer callback-secret',
      },
      body: '{',
    });
    assert.equal(callback.status, 400);
    assert.deepEqual(await callback.json(), { error: 'invalid_json', message: 'body must be valid JSON' });
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack runner strips write credentials from non-PR jobs', () => {
  const oldEnv = snapshotEnv(['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_READ_TOKEN']);
  process.env.GITHUB_TOKEN = 'write-secret';
  process.env.GH_TOKEN = 'gh-write-secret';
  process.env.GITHUB_READ_TOKEN = 'read-secret';

  try {
    const nonPrEnv = buildRunnerCommandEnv(false);
    assert.equal(nonPrEnv.GITHUB_TOKEN, undefined);
    assert.equal(nonPrEnv.GH_TOKEN, undefined);
    assert.equal(nonPrEnv.GITHUB_READ_TOKEN, undefined);
    assert.equal(buildCloneUrl('ibrolord/lite-annotate-demo', false).includes('write-secret'), false);

    const prEnv = buildRunnerCommandEnv(true);
    assert.equal(prEnv.GITHUB_TOKEN, 'write-secret');
    assert.equal(prEnv.GH_TOKEN, 'gh-write-secret');
    assert.equal(buildCloneUrl('ibrolord/lite-annotate-demo', true).includes('write-secret'), true);
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack QA prompt is bounded to one QA pass and no ship loop', () => {
  const prompt = buildClaudePrompt({
    reportId: 'bug_123',
    repo: 'ibrolord/lite-annotate-demo',
    mode: 'qa',
    allowPr: true,
    report: {
      id: 'bug_123',
      projectId: 'demo',
      repo: 'ibrolord/lite-annotate-demo',
      title: 'Logout keeps profile panel visible',
      description: 'Profile panel is still visible after logout',
      url: 'https://example.com/account',
      route: '/account',
      userAgent: 'node-test',
      viewport: { width: 1280, height: 720 },
      annotation: {
        title: 'Logout keeps profile panel visible',
        description: 'Profile panel is still visible after logout',
      },
      console: [],
      network: [],
      session: [],
      screenshot: { type: 'failure', reason: 'not captured in unit test' },
      createdAt: '2026-05-16T00:00:00.000Z',
    },
    callbackUrl: 'https://lite-annotate.example.com/internal/gstack-callback',
  });

  assert.match(prompt, /run \/qa exactly once/i);
  assert.match(prompt, /Do not run \/ship/i);
  assert.match(prompt, /Stop and return the RESULT_JSON after \/qa/i);
  assert.match(prompt, /"commandsRun": \["\/investigate", "\/qa"\]/);
});

test('GStack runner sends bounded Claude prompts over stdin instead of argv', async () => {
  const marker = 'E2BIG_REGRESSION_MARKER';
  const largeDescription = `${marker}\n${'Large browser report payload. '.repeat(16000)}`;
  const invocation = buildClaudeInvocation({
    reportId: 'bug_339938bf-9d03-4b33-b19a-d00d998f21ed',
    repo: 'ibrolord/lite-annotate-demo',
    mode: 'investigate',
    allowPr: false,
    report: {
      id: 'bug_339938bf-9d03-4b33-b19a-d00d998f21ed',
      projectId: 'demo',
      repo: 'ibrolord/lite-annotate-demo',
      title: 'Large payload should not break the GStack runner',
      description: largeDescription,
      url: 'https://example.com/account',
      route: '/account',
      userAgent: 'node-test',
      viewport: { width: 1280, height: 720 },
      annotation: {
        title: 'Large payload should not break the GStack runner',
        description: largeDescription,
      },
      console: [{ level: 'error', message: largeDescription, timestamp: '2026-05-16T00:00:00.000Z' }],
      network: [],
      session: [],
      screenshot: { type: 'failure', reason: largeDescription },
      createdAt: '2026-05-16T00:00:00.000Z',
    },
    callbackUrl: 'https://lite-annotate.example.com/internal/gstack-callback',
  });

  const argv = invocation.args.join('\0');
  assert.equal(invocation.args[0], '-p');
  assert.equal(argv.includes(marker), false);
  assert.ok(argv.length < 1000);
  assert.ok(invocation.stdin.length < 30000);
  assert.ok(invocation.stdin.includes(marker));
  assert.ok(invocation.stdin.includes('[truncated '));
  assert.equal(invocation.stdin.includes('Large browser report payload. '.repeat(500)), false);

  const echoed = await runCommand(
    process.execPath,
    ['-e', 'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => console.log(JSON.stringify({ length: input.length, hasMarker: input.includes(process.argv[1]) })));', marker],
    process.cwd(),
    5000,
    process.env,
    invocation.stdin
  );
  assert.deepEqual(JSON.parse(echoed.stdout.trim()), {
    length: invocation.stdin.length,
    hasMarker: true,
  });
});

test('GStack runner rejects invalid job JSON', async () => {
  const oldEnv = snapshotEnv(['GSTACK_RUNNER_TOKEN']);
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';

  try {
    const response = await runnerApp.request('/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer runner-secret',
      },
      body: '{',
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid_json', message: 'body must be valid JSON' });
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack runner rejects jobs when repo allowlist is not configured', async () => {
  const oldEnv = snapshotEnv(['GSTACK_RUNNER_TOKEN', 'GSTACK_REPO_ALLOWLIST', 'LITE_ANNOTATE_CALLBACK_URL']);
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  delete process.env.GSTACK_REPO_ALLOWLIST;
  delete process.env.LITE_ANNOTATE_CALLBACK_URL;

  try {
    const response = await runnerApp.request('/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer runner-secret',
      },
      body: JSON.stringify({
        reportId: 'bug_123',
        repo: 'ibrolord/lite-annotate-demo',
        mode: 'review_fix',
        allowPr: false,
        report: { id: 'bug_123' },
        callbackUrl: 'https://lite-annotate.example.com/internal/gstack-callback',
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, 'GSTACK_REPO_ALLOWLIST is required');
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack runner requires trusted Lite Annotate callback URL from env', async () => {
  const oldEnv = snapshotEnv(['GSTACK_RUNNER_TOKEN', 'GSTACK_REPO_ALLOWLIST', 'LITE_ANNOTATE_CALLBACK_URL']);
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_REPO_ALLOWLIST = 'ibrolord/lite-annotate-demo';
  delete process.env.LITE_ANNOTATE_CALLBACK_URL;

  try {
    const response = await runnerApp.request('/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer runner-secret',
      },
      body: JSON.stringify({
        reportId: 'bug_123',
        repo: 'ibrolord/lite-annotate-demo',
        mode: 'review_fix',
        allowPr: false,
        report: { id: 'bug_123' },
        callbackUrl: 'https://attacker.example.com/callback',
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, 'LITE_ANNOTATE_CALLBACK_URL is required');
  } finally {
    restoreEnv(oldEnv);
  }
});

test('GStack runner rejects jobs with an untrusted callback URL', async () => {
  const oldEnv = snapshotEnv(['GSTACK_RUNNER_TOKEN', 'GSTACK_REPO_ALLOWLIST', 'LITE_ANNOTATE_CALLBACK_URL']);
  process.env.GSTACK_RUNNER_TOKEN = 'runner-secret';
  process.env.GSTACK_REPO_ALLOWLIST = 'ibrolord/lite-annotate-demo';
  process.env.LITE_ANNOTATE_CALLBACK_URL = 'https://lite-annotate.example.com/internal/gstack-callback';

  try {
    const response = await runnerApp.request('/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer runner-secret',
      },
      body: JSON.stringify({
        reportId: 'bug_123',
        repo: 'ibrolord/lite-annotate-demo',
        mode: 'review_fix',
        allowPr: false,
        report: { id: 'bug_123' },
        callbackUrl: 'https://attacker.example.com/callback',
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.message, 'callbackUrl must match LITE_ANNOTATE_CALLBACK_URL');
  } finally {
    restoreEnv(oldEnv);
  }
});

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

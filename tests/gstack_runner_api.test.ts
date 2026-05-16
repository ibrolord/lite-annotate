import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../api/index.js';
import { createMemoryAdapter } from '../api/gbrain.js';
import { ReportStore } from '../api/report_store.js';
import { app as runnerApp, buildCloneUrl, buildRunnerCommandEnv } from '../gstack-runner/server.js';

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

    const create = await app.request(`/reports/${posted.reportId}/gstack-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer trigger-secret' },
      body: JSON.stringify({ mode: 'review_fix', allowPr: true }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.gstackReview.jobId, 'gstack_job_123');
    assert.equal(created.gstackReview.status, 'queued');
    assert.equal(runnerRequests.length, 1);
    assert.equal(runnerRequests[0].url, 'https://gstack-runner.example.com/jobs');
    assert.equal(runnerRequests[0].auth, 'Bearer runner-secret');
    assert.equal((runnerRequests[0].body as { callbackUrl: string }).callbackUrl, 'https://lite-annotate.example.com/internal/gstack-callback');
    assert.equal((runnerRequests[0].body as { allowPr: boolean }).allowPr, true);

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
        commandsRun: ['/investigate', '/review'],
        summary: 'GStack review passed',
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
    assert.equal(getBody.gstackReview.result.summary, 'GStack review passed');
    assert.equal('logs' in getBody.gstackReview.result, false);

    const view = await app.request(`/reports/${posted.reportId}/view`);
    const html = await view.text();
    assert.match(html, /GStack Review/);
    assert.match(html, /GStack review passed/);
  } finally {
    globalThis.fetch = oldFetch;
    restoreEnv(oldEnv);
  }
});

test('GStack review trigger fails closed when trigger token is not configured', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gstack-trigger-token-'));
  const oldEnv = snapshotEnv(['MEMORY_DIR', 'MEMORY_PROVIDER', 'GSTACK_TRIGGER_TOKEN']);

  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  delete process.env.GSTACK_TRIGGER_TOKEN;

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

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

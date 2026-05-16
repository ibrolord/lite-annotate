import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../api/index.js';
import { createMemoryAdapter } from '../api/gbrain.js';
import { ReportStore } from '../api/report_store.js';

test('POST /report persists, GET /reports/:id returns normalized JSON, and handoff is complete', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-api-'));
  const oldMemoryDir = process.env.MEMORY_DIR;
  const oldProvider = process.env.MEMORY_PROVIDER;
  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    assert.equal(post.status, 201);
    const postBody = await post.json();
    assert.match(postBody.reportId, /^bug_/);

    const get = await app.request(`/reports/${postBody.reportId}`);
    assert.equal(get.status, 200);
    const report = await get.json();
    assert.equal(report.id, postBody.reportId);
    assert.equal(report.title, fixture.title);
    assert.equal(report.annotation.target, fixture.annotation.target);
    assert.equal(report.console[0].source, 'window.onerror');
    assert.equal(report.network[0].method, 'GET');
    assert.equal(report.session[0].type, 'click');

    const restartedStore = new ReportStore(join(root, 'reports'));
    const persisted = await restartedStore.get(postBody.reportId);
    assert.equal(persisted?.report.id, postBody.reportId);

    const dashboard = await app.request('/reports/dashboard');
    assert.equal(dashboard.status, 200);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /Lite Annotate Reports/);
    assert.match(dashboardHtml, /Review queue/);
    assert.match(dashboardHtml, /Open report/);
    assert.match(dashboardHtml, new RegExp(postBody.reportId));
    assert.match(dashboardHtml, /User profile crashes reading name/);
    assert.match(dashboardHtml, /button:Load User Profile/);
    assert.match(dashboardHtml, /button#load-profile/);
    assert.match(dashboardHtml, new RegExp(`/reports/${postBody.reportId}/handoff`));
    assert.match(dashboardHtml, /github-markdown: written/);

    const handoff = await app.request(`/reports/${postBody.reportId}/handoff`);
    assert.equal(handoff.status, 200);
    const handoffBody = await handoff.json();
    assert.equal(handoffBody.reportId, postBody.reportId);
    assert.equal(handoffBody.repo, fixture.repo);
    assert.equal(handoffBody.normalizedReport.id, postBody.reportId);
    assert.ok(Array.isArray(handoffBody.memorySearchResult));
    assert.ok(handoffBody.memorySearchResult.some((result: { reportId?: string }) => result.reportId === postBody.reportId));
    assert.equal(handoffBody.memoryImpact.headline, 'Similar bug memory found');
    assert.equal(handoffBody.memoryImpact.similarCount >= 1, true);
    assert.match(handoffBody.memoryImpact.topMemory.title, /missing user fallback/i);
    assert.ok(handoffBody.memoryImpact.impact.some((line: string) => /Reusable evidence cue/i.test(line)));
    assert.equal(handoffBody.agentComparison.cold.label, 'Cold agent');
    assert.equal(handoffBody.agentComparison.memory.label, 'Memory agent');
    assert.match(handoffBody.agentComparison.memory.advantage, /starts from prior/i);
    assert.ok(handoffBody.memoryReceipts.some((receipt: { source: string }) => receipt.source === 'prior_memory'));
    assert.ok(handoffBody.memoryReceipts.some((receipt: { source: string }) => receipt.source === 'current_browser_report'));
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
    if (oldProvider === undefined) delete process.env.MEMORY_PROVIDER;
    else process.env.MEMORY_PROVIDER = oldProvider;
  }
});

test('POST /reports/:id/autofix stores and exposes analysis results', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-autofix-api-'));
  const oldMemoryDir = process.env.MEMORY_DIR;
  const oldProvider = process.env.MEMORY_PROVIDER;
  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  const store = new ReportStore(join(root, 'reports'));
  const dryRunCalls: boolean[] = [];
  const app = createApp({
    store,
    memory: createMemoryAdapter(),
    autofixRunner: async (reportId, report, options) => ({
      dryRunCalls: dryRunCalls.push(options.dryRun),
      status: 'verified_no_pr',
      pr: null,
      pipeline: {
        candidates: [{ path: 'src/users.js', score: 900, reasons: ['route match'] }],
        diagnosis: {
          type: 'bug',
          severity: 'medium',
          rootCause: 'src/users.js dereferences user.name when the user is missing.',
          evidence: ["Console: Cannot read properties of undefined reading 'name'"],
          targetFiles: ['src/users.js'],
          fixStrategy: 'Add a missing-user fallback.',
          confidence: 0.82,
          shouldPatch: true,
        },
        patch: {
          ok: true,
          files: [{
            path: 'src/users.js',
            content: 'THIS_ANALYSIS_BODY_SHOULD_NOT_BE_INLINE '.repeat(400),
          }],
        },
        verification: {
          ok: true,
          modifiedFiles: ['src/users.js'],
          commands: [{ name: 'node --check src/users.js', ok: true, stdout: '', stderr: '' }],
        },
      },
      meta: { reportId, title: report.title },
    }),
  });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const postBody = await post.json();

    const viewBefore = await app.request(`/reports/${postBody.reportId}/view`);
    assert.equal(viewBefore.status, 200);
    const viewBeforeHtml = await viewBefore.text();
    assert.match(viewBeforeHtml, /Open PR with Auto-Fix/);
    assert.doesNotMatch(viewBeforeHtml, /Run analysis/);
    assert.match(viewBeforeHtml, /Preview Auto-Fix/);
    assert.match(viewBeforeHtml, /Captured screen/);
    assert.match(viewBeforeHtml, /Interaction summary/);
    assert.match(viewBeforeHtml, /Evidence brief/);
    assert.match(viewBeforeHtml, /Target repo/);
    assert.match(viewBeforeHtml, new RegExp(`action="/reports/${postBody.reportId}/repo"`));
    assert.match(viewBeforeHtml, /ibrolord\/lite-annotate-demo/);
    assert.match(viewBeforeHtml, /Safe validation/);
    assert.match(viewBeforeHtml, /PR-opening action/);
    assert.match(viewBeforeHtml, /Debug payloads/);
    assert.match(viewBeforeHtml, new RegExp(`/reports/${postBody.reportId}/autofix`));
    assert.doesNotMatch(viewBeforeHtml, /Person B/);
    assert.match(viewBeforeHtml, /Cold Agent vs Memory Agent/);
    assert.match(viewBeforeHtml, /Cold agent/);
    assert.match(viewBeforeHtml, /Memory agent/);
    assert.match(viewBeforeHtml, /Memory Receipts/);

    const autofix = await app.request(`/reports/${postBody.reportId}/autofix?dryRun=1`, { method: 'POST' });
    assert.equal(autofix.status, 200);
    assert.deepEqual(dryRunCalls, [true]);
    const autofixBody = await autofix.json();
    assert.equal(autofixBody.reportId, postBody.reportId);
    assert.equal(autofixBody.autofix.status, 'verified_no_pr');
    assert.equal(autofixBody.autofix.candidates[0].path, 'src/users.js');
    assert.equal(autofixBody.autofix.diagnosis.targetFiles[0], 'src/users.js');
    assert.equal(autofixBody.autofix.verification.ok, true);
    assert.equal(autofixBody.autofix.memoryImpact.outcomeMemory, 'diagnosis and outcome written');
    assert.ok(autofixBody.autofix.memoryReceipts.some((receipt: { source: string }) => receipt.source === 'code_evidence'));
    assert.ok(autofixBody.autofix.memoryReceipts.some((receipt: { source: string }) => receipt.source === 'verification'));

    const get = await app.request(`/reports/${postBody.reportId}/autofix`);
    assert.equal(get.status, 200);
    const getBody = await get.json();
    assert.equal(getBody.autofix.status, 'verified_no_pr');

    const htmlAutofix = await app.request(`/reports/${postBody.reportId}/autofix`, {
      method: 'POST',
      headers: { Accept: 'text/html' },
    });
    assert.equal(htmlAutofix.status, 303);
    assert.equal(
      htmlAutofix.headers.get('location'),
      `/reports/${postBody.reportId}/view#autofix-result`
    );
    assert.deepEqual(dryRunCalls, [true, false]);

    const handoff = await app.request(`/reports/${postBody.reportId}/handoff`);
    const handoffBody = await handoff.json();
    assert.equal(handoffBody.autofix.status, 'verified_no_pr');
    assert.match(handoffBody.agentComparison.memory.outcome, /verified/i);

    const viewAfter = await app.request(`/reports/${postBody.reportId}/view`);
    const viewAfterHtml = await viewAfter.text();
    assert.match(viewAfterHtml, /Auto-Fix Result/);
    assert.match(viewAfterHtml, /Verified patch ready/);
    assert.match(viewAfterHtml, /verified_no_pr/);
    assert.match(viewAfterHtml, /src\/users\.js/);
    assert.match(viewAfterHtml, new RegExp(`data-analysis-src="/reports/${postBody.reportId}/autofix"`));
    assert.doesNotMatch(viewAfterHtml, /THIS_ANALYSIS_BODY_SHOULD_NOT_BE_INLINE/);
    assert.match(viewAfterHtml, /Memory Impact/);
    assert.match(viewAfterHtml, /Similar bug memory found/);
    assert.match(viewAfterHtml, /Reusable evidence cue/i);
    assert.match(viewAfterHtml, /Current browser report/);
    assert.match(viewAfterHtml, /Prior memory/);
    assert.match(viewAfterHtml, /Verification/);

    const record = await store.get(postBody.reportId);
    assert.equal(record?.autofix?.status, 'verified_no_pr');
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
    if (oldProvider === undefined) delete process.env.MEMORY_PROVIDER;
    else process.env.MEMORY_PROVIDER = oldProvider;
  }
});

test('POST /reports/:id/repo updates the Auto-Fix target repo shown on the report page', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-repo-api-'));
  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({ store, memory: createMemoryAdapter() });

  const post = await app.request('/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixture),
  });
  const postBody = await post.json();

  const update = await app.request(`/reports/${postBody.reportId}/repo`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ repo: 'https://github.com/ibrolord/custom-shop.git' }).toString(),
  });
  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), {
    reportId: postBody.reportId,
    repo: 'ibrolord/custom-shop',
  });

  const get = await app.request(`/reports/${postBody.reportId}`);
  const report = await get.json();
  assert.equal(report.repo, 'ibrolord/custom-shop');

  const view = await app.request(`/reports/${postBody.reportId}/view`);
  const html = await view.text();
  assert.match(html, /Target repo/);
  assert.match(html, /ibrolord\/custom-shop/);

  const invalid = await app.request(`/reports/${postBody.reportId}/repo`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ repo: 'not a repo' }).toString(),
  });
  assert.equal(invalid.status, 400);
});

test('report view shows the first error-level console event instead of startup logs', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  fixture.console = [
    {
      level: 'log',
      message: '[cedar-and-sail] Lite Annotate widget loaded http://localhost:3002/widget.js',
      timestamp: '2026-05-16T12:00:00.000Z',
      source: 'console',
    },
    {
      level: 'error',
      message: "[cedar-and-sail] loyalty profile crashed TypeError: Cannot read properties of undefined (reading 'name')",
      timestamp: '2026-05-16T12:00:01.000Z',
      source: 'console',
    },
  ];
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-view-error-'));
  const oldMemoryDir = process.env.MEMORY_DIR;
  const oldProvider = process.env.MEMORY_PROVIDER;
  process.env.MEMORY_DIR = join(root, 'memory');
  process.env.MEMORY_PROVIDER = 'github-markdown';
  const app = createApp({
    store: new ReportStore(join(root, 'reports')),
    memory: createMemoryAdapter(),
  });

  try {
    const post = await app.request('/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fixture),
    });
    const postBody = await post.json();

    const view = await app.request(`/reports/${postBody.reportId}/view`);
    const html = await view.text();
    assert.match(html, /Browser error<\/span><strong>\[cedar-and-sail\] loyalty profile crashed TypeError/);
    assert.doesNotMatch(html, /Browser error<\/span><strong>\[cedar-and-sail\] Lite Annotate widget loaded/);
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
    if (oldProvider === undefined) delete process.env.MEMORY_PROVIDER;
    else process.env.MEMORY_PROVIDER = oldProvider;
  }
});

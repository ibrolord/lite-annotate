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
  process.env.MEMORY_DIR = join(root, 'memory');
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
    assert.ok(handoffBody.memoryImpact.impact.some((line: string) => /guard missing user/i.test(line)));
    assert.equal(handoffBody.agentComparison.cold.label, 'Cold agent');
    assert.equal(handoffBody.agentComparison.memory.label, 'Memory agent');
    assert.match(handoffBody.agentComparison.memory.advantage, /starts from prior/i);
    assert.ok(handoffBody.memoryReceipts.some((receipt: { source: string }) => receipt.source === 'prior_memory'));
    assert.ok(handoffBody.memoryReceipts.some((receipt: { source: string }) => receipt.source === 'current_browser_report'));
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
  }
});

test('POST /reports/:id/autofix stores and exposes analysis results', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-autofix-api-'));
  const oldMemoryDir = process.env.MEMORY_DIR;
  process.env.MEMORY_DIR = join(root, 'memory');
  const store = new ReportStore(join(root, 'reports'));
  const app = createApp({
    store,
    memory: createMemoryAdapter(),
    autofixRunner: async (reportId, report) => ({
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
        patch: { ok: true, files: [{ path: 'src/users.js', content: 'patched' }] },
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
    assert.match(viewBeforeHtml, /Run analysis/);
    assert.match(viewBeforeHtml, new RegExp(`/reports/${postBody.reportId}/autofix`));
    assert.doesNotMatch(viewBeforeHtml, /Person B/);
    assert.match(viewBeforeHtml, /Cold Agent vs Memory Agent/);
    assert.match(viewBeforeHtml, /Cold agent/);
    assert.match(viewBeforeHtml, /Memory agent/);
    assert.match(viewBeforeHtml, /Memory Receipts/);

    const autofix = await app.request(`/reports/${postBody.reportId}/autofix`, { method: 'POST' });
    assert.equal(autofix.status, 200);
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

    const handoff = await app.request(`/reports/${postBody.reportId}/handoff`);
    const handoffBody = await handoff.json();
    assert.equal(handoffBody.autofix.status, 'verified_no_pr');
    assert.match(handoffBody.agentComparison.memory.outcome, /verified/i);

    const viewAfter = await app.request(`/reports/${postBody.reportId}/view`);
    const viewAfterHtml = await viewAfter.text();
    assert.match(viewAfterHtml, /Analysis Result/);
    assert.match(viewAfterHtml, /verified_no_pr/);
    assert.match(viewAfterHtml, /src\/users\.js/);
    assert.match(viewAfterHtml, /Memory Impact/);
    assert.match(viewAfterHtml, /Similar bug memory found/);
    assert.match(viewAfterHtml, /guard missing user/i);
    assert.match(viewAfterHtml, /Current browser report/);
    assert.match(viewAfterHtml, /Prior memory/);
    assert.match(viewAfterHtml, /Verification/);

    const record = await store.get(postBody.reportId);
    assert.equal(record?.autofix?.status, 'verified_no_pr');
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
  }
});

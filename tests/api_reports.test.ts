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
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
  }
});

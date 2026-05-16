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

test('POST /reports/:id/autofix stores and exposes Person B job results', async () => {
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

    const autofix = await app.request(`/reports/${postBody.reportId}/autofix`, { method: 'POST' });
    assert.equal(autofix.status, 200);
    const autofixBody = await autofix.json();
    assert.equal(autofixBody.reportId, postBody.reportId);
    assert.equal(autofixBody.autofix.status, 'verified_no_pr');
    assert.equal(autofixBody.autofix.candidates[0].path, 'src/users.js');
    assert.equal(autofixBody.autofix.diagnosis.targetFiles[0], 'src/users.js');
    assert.equal(autofixBody.autofix.verification.ok, true);

    const get = await app.request(`/reports/${postBody.reportId}/autofix`);
    assert.equal(get.status, 200);
    const getBody = await get.json();
    assert.equal(getBody.autofix.status, 'verified_no_pr');

    const handoff = await app.request(`/reports/${postBody.reportId}/handoff`);
    const handoffBody = await handoff.json();
    assert.equal(handoffBody.autofix.status, 'verified_no_pr');

    const record = await store.get(postBody.reportId);
    assert.equal(record?.autofix?.status, 'verified_no_pr');
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
  }
});

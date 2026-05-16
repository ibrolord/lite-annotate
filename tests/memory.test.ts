import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemoryAdapter } from '../api/gbrain.js';
import { normalizeReportPayload } from '../api/report_contract.js';

test('memory adapter writes reports, searches similar reports, and stores diagnosis/outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-memory-'));
  const oldMemoryDir = process.env.MEMORY_DIR;
  const oldProvider = process.env.MEMORY_PROVIDER;
  process.env.MEMORY_DIR = root;
  process.env.MEMORY_PROVIDER = 'github-markdown';

  try {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
    const report = normalizeReportPayload(fixture, { id: 'bug_memory', createdAt: fixture.createdAt });
    const memory = createMemoryAdapter();

    const entry = await memory.putReport(report);
    assert.equal(entry.provider, 'github-markdown');
    assert.equal(entry.status, 'written');
    await stat(join(root, 'bugs', 'bug_memory.md'));

    const similar = await memory.searchSimilar(report);
    assert.ok(similar.some((result) => result.reportId === 'bug_memory'));

    await memory.putDiagnosis(report.id, { rootCause: 'user.name dereference', confidence: 0.82 });
    await memory.putOutcome(report.id, { pr: 'https://github.com/example/repo/pull/1', status: 'opened' });
    await stat(join(root, 'diagnosis', 'bug_memory.md'));
    await stat(join(root, 'outcomes', 'bug_memory.md'));
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
    if (oldProvider === undefined) delete process.env.MEMORY_PROVIDER;
    else process.env.MEMORY_PROVIDER = oldProvider;
  }
});

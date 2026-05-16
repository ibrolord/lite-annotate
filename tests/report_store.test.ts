import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ReportStore } from '../api/report_store.js';
import type { LiteReport } from '../api/report_contract.js';

test('ReportStore serializes concurrent updates for the same report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-report-store-'));
  const store = new ReportStore(root);
  const report = makeReport();

  await store.put({
    report,
    raw: { title: report.title },
    memory: { provider: 'github-markdown', status: 'written' },
    updatedAt: report.createdAt,
  });

  await Promise.all([
    store.update(report.id, async (current) => {
      await delay(20);
      return {
        ...current,
        autofix: { status: 'verified_no_pr' },
        updatedAt: '2026-05-16T12:00:01.000Z',
      };
    }),
    store.update(report.id, async (current) => ({
      ...current,
      gstackReview: {
        jobId: 'gstack_job_123',
        reportId: report.id,
        status: 'passed',
        mode: 'review_fix',
        createdAt: '2026-05-16T12:00:00.000Z',
        updatedAt: '2026-05-16T12:00:02.000Z',
      },
      updatedAt: '2026-05-16T12:00:02.000Z',
    })),
  ]);

  const final = await store.get(report.id);
  assert.equal(final?.autofix?.status, 'verified_no_pr');
  assert.equal(final?.gstackReview?.status, 'passed');
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeReport(): LiteReport {
  return {
    id: 'bug_store_race',
    projectId: 'demo',
    repo: 'ibrolord/lite-annotate-demo',
    title: 'User profile crashes reading name',
    description: 'Clicking load profile crashes.',
    url: 'https://demo.example.com/users',
    route: '/users',
    userAgent: 'test',
    viewport: { width: 1280, height: 720 },
    annotation: {
      title: 'User profile crashes reading name',
      description: 'Clicking load profile crashes.',
      route: '/users',
    },
    console: [],
    network: [],
    session: [],
    screenshot: { type: 'failure', reason: 'not captured in store unit test' },
    createdAt: '2026-05-16T12:00:00.000Z',
  };
}

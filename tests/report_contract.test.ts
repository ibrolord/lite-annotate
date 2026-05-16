import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { normalizeReportPayload, ReportValidationError } from '../api/report_contract.js';

test('normalizes the Lite Annotate report contract', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
  const report = normalizeReportPayload(fixture, {
    id: 'bug_schema',
    createdAt: '2026-05-16T12:10:00.000Z',
  });

  assert.equal(report.id, 'bug_schema');
  assert.equal(report.projectId, 'demo');
  assert.equal(report.repo, 'ibrolord/lite-annotate-demo');
  assert.equal(report.title, 'User profile crashes reading name');
  assert.equal(report.route, '/users');
  assert.equal(report.annotation.target, 'button:Load User Profile');
  assert.equal(report.annotation.selector, 'button#load-profile');
  assert.equal(report.annotation.x, 128);
  assert.deepEqual(report.viewport, { width: 1440, height: 900 });
  assert.equal(report.console[0].message, "Cannot read properties of undefined reading 'name'");
  assert.equal(report.network[0].status, 404);
  assert.equal(report.session[0].target, 'button:Load User Profile');
  assert.equal(report.screenshot.type, 'data-url-or-url');
});

test('rejects payloads that cannot satisfy the shared contract', () => {
  assert.throws(
    () => normalizeReportPayload({ title: '' }, { id: 'bug_bad' }),
    (err) => {
      assert.ok(err instanceof ReportValidationError);
      assert.ok(err.issues.includes('title is required'));
      assert.ok(err.issues.includes('repo is required'));
      assert.ok(err.issues.includes('url is required'));
      assert.ok(err.issues.includes('userAgent is required'));
      return true;
    }
  );
});

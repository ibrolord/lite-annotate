import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('demo page presents the evidence workflow without stale lane labels', async () => {
  const html = await readFile(new URL('../demo-app/index.html', import.meta.url), 'utf8');

  assert.match(html, /Evidence pipeline/);
  assert.match(html, /Capture lab/);
  assert.match(html, /Analysis handoff/);
  assert.doesNotMatch(html, /Person B/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCodeIndex, rankCandidateFiles } from '../../../api/indexing/code_index.ts';
import { diagnoseReport } from '../../../api/worker/diagnosis/diagnosis.ts';
import { generatePatchFromDiagnosis } from '../../../api/worker/patch/generate.ts';
import { verifyStructuredPatch } from '../../../api/worker/patch/verification.ts';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-generate-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'users.js'),
    `function getUserById(id) {
  if (id === 1) return { id, name: 'Ada' };
  return undefined;
}

function formatUserGreeting(id) {
  const user = getUserById(id);
  return 'Hello ' + user.name;
}

module.exports = { formatUserGreeting };
`
  );
  return root;
}

const report = {
  title: 'User profile crashes reading name',
  description: 'Clicking load profile crashes',
  url: 'https://demo.example.com/users',
  route: '/users',
  console: [{ level: 'error', message: "Cannot read properties of undefined reading 'name'" }],
  network: [{ method: 'GET', url: '/api/users/999', status: 404 }],
};

test('generatePatchFromDiagnosis creates a scoped missing-user guard patch that verifies', () => {
  const root = makeRepo();
  try {
    const index = buildCodeIndex(root);
    const candidates = rankCandidateFiles(index, report);
    const diagnosis = diagnoseReport(report, candidates);

    const patch = generatePatchFromDiagnosis(diagnosis, candidates);

    assert.equal(patch.ok, true);
    assert.deepEqual(patch.files.map((file) => file.path), ['src/users.js']);
    assert.match(patch.files[0]?.content ?? '', /if \(!user\) return 'User not found';/);

    const verification = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: diagnosis.targetFiles,
      files: patch.files,
      smokeCommands: [
        {
          command: process.execPath,
          args: [
            '-e',
            "const { formatUserGreeting } = require('./src/users.js'); console.log(formatUserGreeting(999))",
          ],
        },
      ],
    });

    assert.equal(verification.ok, true);
    assert.ok(verification.commands.some((command) => command.stdout.includes('User not found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generatePatchFromDiagnosis refuses when diagnosis patch gate is closed', () => {
  const patch = generatePatchFromDiagnosis(
    {
      type: 'bug',
      severity: 'low',
      rootCause: 'No safe target.',
      evidence: ['No code evidence.'],
      targetFiles: ['src/users.js'],
      fixStrategy: 'Collect more context.',
      confidence: 0.2,
      shouldPatch: false,
    },
    []
  );

  assert.equal(patch.ok, false);
  assert.match(patch.error ?? '', /shouldPatch is false/);
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCodeIndex, rankCandidateFiles } from '../../../api/indexing/code_index.ts';
import {
  diagnoseReport,
  shouldPatchDiagnosis,
  validateDiagnosis,
} from '../../../api/worker/diagnosis/diagnosis.ts';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-diagnosis-'));
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
  writeFileSync(join(root, 'src', 'profile.js'), `export const route = '/profile';\n`);
  return root;
}

const pinnedReport = {
  title: 'User profile crashes reading name',
  description: 'Clicking load profile crashes',
  url: 'https://demo.example.com/users',
  route: '/users',
  console: [
    {
      level: 'error',
      message: "Cannot read properties of undefined reading 'name'",
    },
  ],
  network: [
    {
      method: 'GET',
      url: '/api/users/999',
      status: 404,
    },
  ],
  session: [
    {
      type: 'click',
      target: 'button:Load User Profile',
    },
  ],
};

test('diagnoseReport returns structured pinned demo diagnosis with evidence and patch gate', () => {
  const root = makeRepo();
  try {
    const index = buildCodeIndex(root);
    const candidates = rankCandidateFiles(index, pinnedReport);

    const diagnosis = diagnoseReport(pinnedReport, candidates);

    assert.equal(diagnosis.type, 'bug');
    assert.equal(diagnosis.severity, 'medium');
    assert.deepEqual(diagnosis.targetFiles, ['src/users.js']);
    assert.match(diagnosis.rootCause, /user\.name/);
    assert.match(diagnosis.rootCause, /undefined|missing|not found/i);
    assert.match(diagnosis.fixStrategy, /fallback|guard|missing/i);
    assert.ok(diagnosis.confidence >= 0.75);
    assert.equal(diagnosis.shouldPatch, true);
    assert.ok(diagnosis.evidence.some((item) => item.includes("reading 'name'")));
    assert.ok(diagnosis.evidence.some((item) => item.includes('src/users.js')));
    assert.equal(shouldPatchDiagnosis(diagnosis).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validateDiagnosis rejects low-confidence or broad target output', () => {
  const valid = validateDiagnosis({
    type: 'bug',
    severity: 'medium',
    rootCause: 'src/users.js dereferences user.name when the user is missing.',
    evidence: ['Code: src/users.js line reads user.name'],
    targetFiles: ['src/users.js'],
    fixStrategy: 'Add a missing-user guard.',
    confidence: 0.82,
    shouldPatch: true,
  });

  assert.equal(valid.ok, true);

  const invalid = validateDiagnosis({
    type: 'bug',
    severity: 'medium',
    rootCause: 'Maybe something is wrong.',
    evidence: [],
    targetFiles: ['src/users.js', 'src/a.js', 'src/b.js'],
    fixStrategy: 'Change many files.',
    confidence: 0.2,
    shouldPatch: true,
  });

  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some((error) => error.includes('confidence')));
  assert.ok(invalid.errors.some((error) => error.includes('targetFiles')));
  assert.ok(invalid.errors.some((error) => error.includes('evidence')));
});

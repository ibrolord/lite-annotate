import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runPersonBPipeline } from '../../api/worker/person_b_pipeline.ts';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-person-b-'));
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
  writeFileSync(join(root, 'src', 'home.js'), `export const route = '/';\n`);
  return root;
}

test('runPersonBPipeline ranks, diagnoses, patches, and verifies the pinned demo bug', async () => {
  const root = makeRepo();
  try {
    const result = await runPersonBPipeline({
      workspacePath: root,
      report: {
        title: 'User profile crashes reading name',
        description: 'Clicking load profile crashes',
        url: 'https://demo.example.com/users',
        route: '/users',
        console: [{ level: 'error', message: "Cannot read properties of undefined reading 'name'" }],
        network: [{ method: 'GET', url: '/api/users/999', status: 404 }],
      },
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

    assert.equal(result.candidates[0]?.path, 'src/users.js');
    assert.equal(result.diagnosis.targetFiles[0], 'src/users.js');
    assert.equal(result.patch.ok, true);
    assert.equal(result.verification?.ok, true);
    assert.deepEqual(result.verification?.modifiedFiles, ['src/users.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

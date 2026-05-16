import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCodeIndex, rankCandidateFiles } from '../../api/indexing/code_index.ts';

function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-index-'));

  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'src', 'components'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });

  writeFileSync(
    join(root, 'src', 'users.js'),
    `export function getUserById(id) {
  if (id === 1) return { id, name: 'Ada' };
  return undefined;
}

export function formatUserGreeting(id) {
  const user = getUserById(id);
  return 'Hello ' + user.name;
}
`
  );

  writeFileSync(
    join(root, 'src', 'components', 'Dashboard.tsx'),
    `export function Dashboard() {
  return <main>Dashboard</main>;
}
`
  );

  writeFileSync(join(root, 'src', 'users.test.js'), `import { formatUserGreeting } from './users.js';\n`);
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, '.env'), 'TOKEN=secret');
  writeFileSync(join(root, 'node_modules', 'ignored', 'users.js'), 'export const ignored = true;');
  writeFileSync(join(root, 'dist', 'users.js'), 'export const ignored = true;');

  return root;
}

test('buildCodeIndex extracts JS/TS files and ignores dependencies, build outputs, lockfiles, and env files', () => {
  const root = makeFixtureRepo();
  try {
    const index = buildCodeIndex(root);
    const paths = index.files.map((file) => file.path).sort();

    assert.deepEqual(paths, [
      'src/components/Dashboard.tsx',
      'src/users.js',
      'src/users.test.js',
    ]);

    const users = index.files.find((file) => file.path === 'src/users.js');
    assert.ok(users);
    assert.deepEqual(users.exports.sort(), ['formatUserGreeting', 'getUserById']);
    assert.deepEqual(users.functions.sort(), ['formatUserGreeting', 'getUserById']);
    assert.deepEqual(users.nearbyTests, ['src/users.test.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rankCandidateFiles ranks src/users.js first for the pinned demo report', () => {
  const root = makeFixtureRepo();
  try {
    const index = buildCodeIndex(root);
    const ranked = rankCandidateFiles(index, {
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
    });

    assert.equal(ranked[0]?.path, 'src/users.js');
    assert.ok(
      ranked.slice(0, 3).some((candidate) => candidate.path === 'src/users.js'),
      'src/users.js should be in top 3 candidates'
    );
    assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('/users')));
    assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('name')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

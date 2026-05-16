import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { verifyStructuredPatch } from '../../../api/worker/patch/verification.ts';

function makeBrokenUsersWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-verify-'));
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

const fixedUsersJs = `function getUserById(id) {
  if (id === 1) return { id, name: 'Ada' };
  return undefined;
}

function formatUserGreeting(id) {
  const user = getUserById(id);
  if (!user) return 'User not found';
  return 'Hello ' + user.name;
}

module.exports = { formatUserGreeting };
`;

test('verifyStructuredPatch applies scoped patch and runs syntax plus smoke checks', () => {
  const root = makeBrokenUsersWorkspace();
  try {
    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/users.js'],
      files: [{ path: 'src/users.js', content: fixedUsersJs }],
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

    assert.equal(result.ok, true);
    assert.deepEqual(result.modifiedFiles, ['src/users.js']);
    assert.ok(result.commands.some((command) => command.name.includes('node --check src/users.js')));
    assert.ok(result.commands.some((command) => command.stdout.includes('User not found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStructuredPatch rejects files outside diagnosis targetFiles before writing', () => {
  const root = makeBrokenUsersWorkspace();
  try {
    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/users.js'],
      files: [
        { path: 'src/users.js', content: fixedUsersJs },
        { path: 'src/admin.js', content: 'module.exports = {};\n' },
      ],
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /outside targetFiles/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStructuredPatch runs available package scripts before smoke checks', () => {
  const root = makeBrokenUsersWorkspace();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'commonjs',
        scripts: {
          typecheck: "node -e \"require('fs').writeFileSync('typecheck-ran.txt', 'yes')\"",
          build: "node -e \"require('fs').writeFileSync('build-ran.txt', 'yes')\"",
        },
      })
    );

    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/users.js'],
      files: [{ path: 'src/users.js', content: fixedUsersJs }],
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

    assert.equal(result.ok, true);
    assert.ok(existsSync(join(root, 'typecheck-ran.txt')));
    assert.ok(existsSync(join(root, 'build-ran.txt')));
    assert.deepEqual(
      result.commands.map((command) => command.name),
      [
        'npm run typecheck',
        'npm run build',
        'node --check src/users.js',
        `${process.execPath} -e const { formatUserGreeting } = require('./src/users.js'); console.log(formatUserGreeting(999))`,
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

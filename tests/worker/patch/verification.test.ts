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

test('verifyStructuredPatch can skip package scripts for focused hosted autofix smoke checks', () => {
  const root = makeBrokenUsersWorkspace();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'commonjs',
        scripts: {
          test: "node -e \"throw new Error('planted bug test should not run')\"",
        },
      })
    );

    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/users.js'],
      files: [{ path: 'src/users.js', content: fixedUsersJs }],
      runPackageScripts: false,
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
    assert.equal(result.commands.some((command) => command.name === 'npm run test'), false);
    assert.ok(result.commands.some((command) => command.stdout.includes('User not found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStructuredPatch runs generic CSS sanity checks for stylesheet patches', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-css-verify-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'styles.css'), '.hero { line-height: 1; }\n');

    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/styles.css'],
      files: [{ path: 'src/styles.css', content: '.hero { line-height: 1.08; }\n' }],
      runPackageScripts: false,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.modifiedFiles, ['src/styles.css']);
    assert.ok(result.commands.some((command) => command.name === 'css sanity src/styles.css'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStructuredPatch rejects malformed CSS before PR creation', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-css-verify-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'styles.css'), '.hero { line-height: 1; }\n');

    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/styles.css'],
      files: [{ path: 'src/styles.css', content: '.hero { line-height: 1.08;\n' }],
      runPackageScripts: false,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /css sanity src\/styles\.css failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStructuredPatch records sanity checks for TypeScript patches', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-ts-verify-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'App.tsx'), 'export function App() { return <main />; }\n');

    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/App.tsx'],
      files: [{ path: 'src/App.tsx', content: 'export function App() { return <main><h1>Fixed</h1></main>; }\n' }],
      runPackageScripts: false,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.modifiedFiles, ['src/App.tsx']);
    assert.ok(result.commands.some((command) => command.name === 'typescript sanity src/App.tsx'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyStructuredPatch rejects malformed TypeScript before PR creation', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-ts-verify-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'App.tsx'), 'export function App() { return <main />; }\n');

    const result = verifyStructuredPatch({
      workspacePath: root,
      targetFiles: ['src/App.tsx'],
      files: [{ path: 'src/App.tsx', content: 'export function App() { return (<main>; }\n' }],
      runPackageScripts: false,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /typescript sanity src\/App\.tsx failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

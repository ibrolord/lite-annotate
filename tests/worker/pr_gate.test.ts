import assert from 'node:assert/strict';
import { test } from 'node:test';

import { openVerifiedPR } from '../../api/worker/pr_gate.ts';
import type { PersonBPipelineResult } from '../../api/worker/person_b_pipeline.ts';

function basePipelineResult(): PersonBPipelineResult {
  return {
    workspacePath: '/tmp/repo',
    index: { root: '/tmp/repo', files: [], packageScripts: {} },
    candidates: [
      {
        path: 'src/users.js',
        score: 500,
        reasons: ['file name matches route token "users"', 'code references console symbol "name"'],
        file: {
          path: 'src/users.js',
          language: 'javascript',
          imports: [],
          exports: ['formatUserGreeting'],
          functions: ['formatUserGreeting'],
          classes: [],
          components: [],
          routeHints: ['/users'],
          symbolReferences: ['user', 'name'],
          nearbyTests: [],
          content: 'function formatUserGreeting(id) {}\n',
        },
      },
    ],
    diagnosis: {
      type: 'bug',
      severity: 'medium',
      rootCause: 'src/users.js dereferences user.name when the user is missing.',
      evidence: [
        "Console: Cannot read properties of undefined reading 'name'",
        'Code: src/users.js reads return user.name',
      ],
      targetFiles: ['src/users.js'],
      fixStrategy: 'Add a missing-user fallback before reading name.',
      confidence: 0.82,
      shouldPatch: true,
    },
    patch: {
      ok: true,
      files: [
        {
          path: 'src/users.js',
          content: "function formatUserGreeting() { return 'User not found'; }\n",
        },
      ],
    },
    verification: {
      ok: true,
      modifiedFiles: ['src/users.js'],
      commands: [
        { name: 'node --check src/users.js', ok: true, stdout: '', stderr: '' },
        {
          name: "node -e const { formatUserGreeting } = require('./src/users.js')",
          ok: true,
          stdout: 'User not found\n',
          stderr: '',
        },
      ],
    },
  };
}

test('openVerifiedPR opens PR only after all Person B gates pass and includes evidence', async () => {
  const calls: unknown[] = [];
  const result = await openVerifiedPR({
    pipeline: basePipelineResult(),
    report: {
      id: 'bug_123',
      title: 'User profile crashes reading name',
      url: 'https://demo.example.com/users',
      route: '/users',
    },
    repoUrl: 'https://github.com/ibrolord/lite-annotate-demo',
    token: 'ghs_test',
    createPR: async (input) => {
      calls.push(input);
      return {
        pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/1',
        branch: input.payload.branch,
        files: input.payload.files.map((file) => file.path),
        write_mode: 'direct_files',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.pr?.pr_url, 'https://github.com/ibrolord/lite-annotate-demo/pull/1');
  assert.equal(calls.length, 1);

  const payload = (calls[0] as { payload: { title: string; body: string; files: Array<{ path: string }> } }).payload;
  assert.match(payload.title, /^fix:/);
  assert.deepEqual(payload.files.map((file) => file.path), ['src/users.js']);
  assert.match(payload.body, /Root cause/);
  assert.match(payload.body, /Cannot read properties of undefined/);
  assert.match(payload.body, /node --check src\/users\.js/);
  assert.match(payload.body, /User not found/);
});

test('openVerifiedPR refuses to call GitHub when verification failed', async () => {
  const pipeline = basePipelineResult();
  pipeline.verification = {
    ok: false,
    modifiedFiles: ['src/users.js'],
    commands: [{ name: 'node --check src/users.js', ok: false, stdout: '', stderr: 'SyntaxError' }],
    error: 'node --check src/users.js failed',
  };

  let called = false;
  const result = await openVerifiedPR({
    pipeline,
    report: { id: 'bug_123', title: 'User profile crashes reading name' },
    repoUrl: 'https://github.com/ibrolord/lite-annotate-demo',
    token: 'ghs_test',
    createPR: async () => {
      called = true;
      throw new Error('should not call GitHub');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(called, false);
  assert.match(result.error ?? '', /verification failed/i);
});

test('openVerifiedPR refuses when target file is not in top 3 candidates', async () => {
  const pipeline = basePipelineResult();
  pipeline.candidates = [
    { ...pipeline.candidates[0], path: 'src/a.js' },
    { ...pipeline.candidates[0], path: 'src/b.js' },
    { ...pipeline.candidates[0], path: 'src/c.js' },
    { ...pipeline.candidates[0], path: 'src/users.js' },
  ];

  let called = false;
  const result = await openVerifiedPR({
    pipeline,
    report: { id: 'bug_123', title: 'User profile crashes reading name' },
    repoUrl: 'https://github.com/ibrolord/lite-annotate-demo',
    token: 'ghs_test',
    createPR: async () => {
      called = true;
      throw new Error('should not call GitHub');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(called, false);
  assert.match(result.error ?? '', /top 3/i);
});

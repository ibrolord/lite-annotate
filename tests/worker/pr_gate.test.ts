import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDirectGitHubPR, openVerifiedPR } from '../../api/worker/pr_gate.ts';
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
    artifact: {
      type: 'fix_pr',
      reportClass: 'runtime_or_ui_fix',
      reason: 'Diagnosis is confident enough for a scoped product-code patch.',
      targetFiles: ['src/users.js'],
      verificationPlan: ['Run syntax checks.'],
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

test('openVerifiedPR carries the verified base branch into PR creation', async () => {
  let payloadBaseBranch: string | undefined;
  const result = await openVerifiedPR({
    pipeline: basePipelineResult(),
    report: { id: 'bug_123', title: 'User profile crashes reading name' },
    repoUrl: 'https://github.com/ibrolord/lite-annotate-demo',
    token: 'ghs_test',
    baseBranch: 'release/candidate',
    createPR: async (input) => {
      payloadBaseBranch = input.payload.baseBranch;
      return {
        pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/2',
        branch: input.payload.branch,
        files: input.payload.files.map((file) => file.path),
        write_mode: 'direct_files',
      };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(payloadBaseBranch, 'release/candidate');
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

test('openVerifiedPR refuses when no verification checks were recorded', async () => {
  const pipeline = basePipelineResult();
  pipeline.verification = {
    ok: true,
    modifiedFiles: ['src/users.js'],
    commands: [],
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
  assert.match(result.error ?? '', /no verification checks/i);
});

test('createDirectGitHubPR creates new artifact files without an existing content sha', async () => {
  const originalFetch = globalThis.fetch;
  const putBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';
    if (method === 'GET' && /\/repos\/ibrolord\/lite-annotate-demo$/.test(url)) {
      return Response.json({ default_branch: 'main' });
    }
    if (method === 'GET' && /\/git\/ref\/heads\/main$/.test(url)) {
      return Response.json({ object: { sha: 'base-sha' } });
    }
    if (method === 'POST' && /\/git\/refs$/.test(url)) {
      return Response.json({ ref: 'refs/heads/chore/artifact-test' });
    }
    if (method === 'GET' && /\/contents\/\.lite-annotate\/autofix\/new\.md\?ref=main$/.test(url)) {
      return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    }
    if (method === 'PUT' && /\/contents\/\.lite-annotate\/autofix\/new\.md$/.test(url)) {
      putBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ content: { path: '.lite-annotate/autofix/new.md' } });
    }
    if (method === 'POST' && /\/pulls$/.test(url)) {
      return Response.json({ html_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/3' });
    }
    return new Response(`unexpected ${method} ${url}`, { status: 500 });
  }) as typeof fetch;

  try {
    const result = await createDirectGitHubPR({
      repoUrl: 'https://github.com/ibrolord/lite-annotate-demo',
      token: 'ghs_test',
      payload: {
        title: 'chore: add autofix artifact',
        body: 'artifact',
        branch: 'chore/artifact-test',
        files: [{
          path: '.lite-annotate/autofix/new.md',
          content: '# New artifact\n',
          explanation: 'Add fallback artifact.',
        }],
      },
    });

    assert.equal(result.pr_url, 'https://github.com/ibrolord/lite-annotate-demo/pull/3');
    assert.deepEqual(result.files, ['.lite-annotate/autofix/new.md']);
    assert.equal(putBodies.length, 1);
    assert.equal(Object.hasOwn(putBodies[0], 'sha'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

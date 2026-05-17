import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runAutofix } from '../../api/autofix.ts';

type ArtifactKind = 'fix_pr' | 'regression_test_pr' | 'instrumentation_pr' | 'setup_pr' | 'external_blocker';

interface ArtifactContract {
  type: ArtifactKind;
  targetFiles?: string[];
  reason?: string;
  reportClass?: string;
  blocker?: string;
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-autofix-always-runs-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'profile.js'),
    `const users = [{ id: 'ada', name: 'Ada Lovelace' }];

export function getUserById(id) {
  return users.find((user) => user.id === id);
}

export function greetingForUser(id) {
  const user = getUserById(id);
  return 'Hello ' + user.name;
}
`
  );
  writeFileSync(
    join(root, 'src', 'app.js'),
    `import { greetingForUser } from './profile.js';

const banner = document.getElementById('profile-banner');

export function loadProfile(id) {
  banner.textContent = greetingForUser(id);
}

export function trackBugReportOpen() {
  window.dispatchEvent(new CustomEvent('lite-annotate:report-opened'));
}
`
  );
  return root;
}

function addFailingPackageTest(root: string): void {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        test: "node -e \"throw new Error('existing app test failure')\"",
      },
    })
  );
}

function makeGitRepo(): string {
  const root = makeRepo();
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'lite-annotate@example.test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Lite Annotate Test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root, stdio: 'ignore' });
  return root;
}

function artifactsFrom(result: unknown): ArtifactContract[] {
  const value = result as {
    artifacts?: ArtifactContract[];
    artifact?: ArtifactContract;
    pipeline?: { artifacts?: ArtifactContract[]; artifact?: ArtifactContract };
    pr?: { artifact?: ArtifactContract; artifacts?: ArtifactContract[]; artifact_metadata?: Record<string, unknown> };
  };
  return [
    ...(Array.isArray(value.artifacts) ? value.artifacts : []),
    ...(value.artifact ? [value.artifact] : []),
    ...(Array.isArray(value.pipeline?.artifacts) ? value.pipeline.artifacts : []),
    ...(value.pipeline?.artifact ? [value.pipeline.artifact] : []),
    ...(Array.isArray(value.pr?.artifacts) ? value.pr.artifacts : []),
    ...(value.pr?.artifact ? [value.pr.artifact] : []),
    ...(value.pr?.artifact_metadata && typeof value.pr.artifact_metadata.type === 'string'
      ? [{
          type: value.pr.artifact_metadata.type as ArtifactKind,
          targetFiles: value.pr.artifact_metadata.target_files as string[] | undefined,
          reason: value.pr.artifact_metadata.reason as string | undefined,
        }]
      : []),
  ];
}

function requireArtifact(result: unknown, kinds: ArtifactKind | ArtifactKind[]): ArtifactContract {
  const expected = Array.isArray(kinds) ? kinds : [kinds];
  const artifact = artifactsFrom(result).find((item) => expected.includes(item.type));
  assert.ok(
    artifact,
    `expected artifact kind ${expected.join(' or ')}; got ${JSON.stringify(artifactsFrom(result))}`
  );
  return artifact;
}

test('weak or unknown reports open a verified instrumentation artifact PR instead of diagnosis-only output', async () => {
  const root = makeRepo();
  try {
    let prTitle = '';
    let prFiles: string[] = [];
    const result = await runAutofix('bug_unknown_weak_report', {
      title: 'Something feels off',
      description: 'The page looks weird but I do not have a console error or exact component.',
      url: 'https://demo.example.test/mystery',
      route: '/mystery',
      console: [],
      network: [],
      session: [{ type: 'click', target: 'button:Report a bug' }],
    }, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      runPackageScripts: false,
      createPR: async (input) => {
        prTitle = input.payload.title;
        prFiles = input.payload.files.map((file) => file.path);
        return {
          pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/43',
          branch: input.payload.branch,
          files: prFiles,
          write_mode: 'direct_files',
        };
      },
    });

    assert.equal(result.status, 'pr_opened');
    assert.equal(result.pipeline.verification?.ok, true);
    const artifact = requireArtifact(result, 'instrumentation_pr');
    assert.deepEqual(artifact.targetFiles, result.pipeline.diagnosis.targetFiles);
    assert.match(artifact.targetFiles?.[0] ?? '', /^\.lite-annotate\/autofix\//);
    assert.match(artifact.reason ?? '', /artifact|source candidates|product-code fix/i);
    assert.match(prTitle, /^chore:/);
    assert.deepEqual(prFiles, artifact.targetFiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('low-confidence code-indexed reports open a verified regression-test artifact PR', async () => {
  const root = makeRepo();
  addFailingPackageTest(root);
  try {
    let prTitle = '';
    let prFiles: string[] = [];
    const result = await runAutofix('bug_profile_banner_unclear', {
      title: 'Profile banner text is confusing',
      description: 'On the profile route, the banner needs a future regression check because the repro is low confidence.',
      url: 'https://demo.example.test/profile',
      route: '/profile',
      annotation: {
        target: '#profile-banner',
        selector: '#profile-banner',
        route: '/profile',
      },
      console: [],
      network: [],
      session: [{ type: 'click', target: 'div#profile-banner' }],
    }, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      runPackageScripts: false,
      createPR: async (input) => {
        prTitle = input.payload.title;
        prFiles = input.payload.files.map((file) => file.path);
        return {
          pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/44',
          branch: input.payload.branch,
          files: prFiles,
          write_mode: 'direct_files',
        };
      },
    });

    assert.equal(result.status, 'pr_opened');
    assert.equal(result.pipeline.index.files.length > 0, true);
    assert.equal(result.pipeline.verification?.ok, true);
    const artifact = requireArtifact(result, 'regression_test_pr');
    assert.match(artifact.targetFiles?.[0] ?? '', /^tests\/lite-annotate-autofix\//);
    assert.match(artifact.reason ?? '', /regression test artifact/i);
    assert.equal(result.pipeline.verification?.commands.some((command) => command.name === 'npm run test'), false);
    assert.match(prTitle, /^test:/);
    assert.deepEqual(prFiles, artifact.targetFiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup-blocked cases expose setup_pr and external_blocker metadata clearly', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-empty-setup-'));
  try {
    let setupPrTitle = '';
    let setupPrFiles: string[] = [];
    const setupResult = await runAutofix('bug_empty_repo_setup_artifact', {
      title: 'Checkout button is broken but no source files are indexed',
      description: 'The report is actionable, but the connected repository has no source files for Auto-Fix to inspect.',
      route: '/checkout',
      console: [],
      network: [],
    }, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      runPackageScripts: false,
      createPR: async (input) => {
        setupPrTitle = input.payload.title;
        setupPrFiles = input.payload.files.map((file) => file.path);
        return {
          pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/45',
          branch: input.payload.branch,
          files: setupPrFiles,
          write_mode: 'direct_files',
        };
      },
    });

    assert.equal(setupResult.status, 'pr_opened');
    assert.equal(setupResult.pipeline.verification?.ok, true);
    const setupArtifact = requireArtifact(setupResult, 'setup_pr');
    assert.match(setupArtifact.targetFiles?.[0] ?? '', /^\.lite-annotate\/autofix\//);
    assert.match(setupArtifact.reason ?? '', /source candidates|repo\/index prerequisite/i);
    assert.match(setupPrTitle, /^chore:/);
    assert.deepEqual(setupPrFiles, setupArtifact.targetFiles);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const result = await runAutofix('bug_missing_workspace_setup', {
    title: 'Cannot run Auto-Fix until the repository is connected',
    description: 'The report is actionable but no workspace or trusted repo is configured.',
    route: '/profile',
    console: [],
    network: [],
  }, {
    githubToken: undefined,
    githubRepo: undefined,
    runPackageScripts: false,
  } as never);

  assert.equal((result as { status?: string }).status, 'external_blocker');
  const artifact = requireArtifact(result, 'external_blocker');
  assert.match(artifact.blocker ?? artifact.reason ?? '', /workspacePath|repo|repository/i);
});

test('existing verified fix PR path carries artifact metadata', async () => {
  const root = makeGitRepo();
  try {
    const result = await runAutofix('bug_profile_missing_user', {
      title: 'Profile crashes when user is missing',
      description: 'Loading a missing profile crashes while reading name.',
      url: 'https://demo.example.test/profile',
      route: '/profile',
      console: [{
        level: 'error',
        message: "TypeError: Cannot read properties of undefined (reading 'name')",
        stack: 'TypeError: Cannot read properties of undefined (reading \'name\')\n    at greetingForUser (https://demo.example.test/src/profile.js:8:26)',
      }],
      network: [{ method: 'GET', url: '/api/users/missing', status: 404, failed: true }],
    }, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      runPackageScripts: false,
      createPR: async (input) => ({
        pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/42',
        branch: input.payload.branch,
        files: input.payload.files.map((file) => file.path),
        write_mode: 'direct_files',
      }),
    });

    assert.equal(result.status, 'pr_opened');
    assert.equal(result.pr?.pr_url, 'https://github.com/ibrolord/lite-annotate-demo/pull/42');
    const artifact = requireArtifact(result, 'fix_pr');
    assert.deepEqual(artifact.targetFiles, ['src/profile.js']);
    assert.equal(result.pr?.artifact_metadata?.pr_url, result.pr?.pr_url);
    assert.deepEqual(result.pr?.artifact_metadata?.modified_files, ['src/profile.js']);
    assert.equal(result.pr?.artifact_metadata?.verification_ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

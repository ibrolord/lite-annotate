import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runAutofix } from '../../api/autofix.ts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-autofix-'));
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

function makeGitRepo(): string {
  const root = makeRepo();
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });
  return root;
}

function makeCommerceRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-commerce-autofix-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'api', 'customers'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'customer.js'),
    `const customers = [
  {
    id: 'jord-2025',
    name: 'Jordan Lee',
    tier: 'Trail Club',
    credits: 24
  }
];

export function getCustomerById(customerId) {
  return customers.find((customer) => customer.id === customerId);
}

export function formatLoyaltyGreeting(customerId) {
  const customer = getCustomerById(customerId);
  return \`Welcome back, \${customer.name}. Your \${customer.tier} credit is $\${customer.credits}.\`;
}
`
  );
  writeFileSync(
    join(root, 'src', 'app.js'),
    `import { formatLoyaltyGreeting } from './customer.js';

async function loadLoyaltyProfile() {
  const response = await fetch('/api/customers/vip-404');
  if (!response.ok) console.warn('[cedar-and-sail] loyalty profile lookup returned', response.status);
  return formatLoyaltyGreeting('vip-404');
}

export { loadLoyaltyProfile };
`
  );
  writeFileSync(
    join(root, 'src', 'styles.css'),
    `.button {
  min-height: 44px;
}

.button-primary {
  background: var(--accent);
  color: white;
}

.button-primary:hover {
  background: var(--accent-strong);
}

.checkout-form {
  display: grid;
}
`
  );
  writeFileSync(
    join(root, 'api', 'customers', 'vip-404.js'),
    `export default function handler(_req, res) {
  res.status(404).json({
    error: 'customer_not_found',
    id: 'vip-404',
    message: 'No loyalty profile exists for this customer.'
  });
}
`
  );
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      scripts: {
        test: "node -e \"throw new Error('planted bug test should not run')\"",
      },
    })
  );
  return root;
}

function initGitRepo(root: string): string {
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'lite-annotate@example.test']);
  git(root, ['config', 'user.name', 'Lite Annotate Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial fixture']);
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

test('runAutofix runs Person B pipeline and skips PR without GitHub credentials', async () => {
  const root = makeRepo();
  try {
    const result = await runAutofix('bug_123', report, {
      workspacePath: root,
      githubToken: undefined,
      githubRepo: undefined,
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/users.js');
    assert.equal(result.pipeline.diagnosis.targetFiles[0], 'src/users.js');
    assert.equal(result.pipeline.verification?.ok, true);
    assert.equal(result.pr, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix opens PR through verified gate when GitHub credentials are configured', async () => {
  const root = makeRepo();
  try {
    let calls = 0;
    const result = await runAutofix('bug_123', report, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      createPR: async (input) => {
        calls += 1;
        return {
          pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/7',
          branch: input.payload.branch,
          files: input.payload.files.map((file) => file.path),
          write_mode: 'direct_files',
        };
      },
    });

    assert.equal(result.status, 'pr_opened');
    assert.equal(calls, 1);
    assert.equal(result.pr?.pr_url, 'https://github.com/ibrolord/lite-annotate-demo/pull/7');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix dry run verifies but does not call GitHub PR creation', async () => {
  const root = makeRepo();
  try {
    let calls = 0;
    const result = await runAutofix('bug_123', report, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      skipPR: true,
      createPR: async () => {
        calls += 1;
        throw new Error('dry run should not create PR');
      },
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.verification?.ok, true);
    assert.equal(result.pr, null);
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix falls back to the report repo when env repo is not configured', async () => {
  const origin = makeGitRepo();
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'lite-annotate-autofix-workspace-'));
  try {
    const result = await runAutofix('bug_123', { ...report, repo: origin }, {
      workspaceRoot,
      githubToken: undefined,
      githubRepo: undefined,
      skipPR: true,
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/users.js');
    assert.equal(result.pipeline.verification?.ok, true);
    assert.notEqual(result.pipeline.workspacePath, origin);
  } finally {
    rmSync(origin, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runAutofix fixes the Cedar & Sail loyalty crash with focused verification', async () => {
  const root = makeCommerceRepo();
  try {
    const result = await runAutofix('bug_cedar_account', {
      title: 'Account loyalty profile crashes',
      description: 'Clicked Load loyalty profile on /account.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/account',
      route: '/account',
      console: [
        {
          level: 'error',
          message: "[cedar-and-sail] loyalty profile crashed TypeError: Cannot read properties of undefined (reading 'name')",
          stack: "TypeError: Cannot read properties of undefined (reading 'name')\n    at formatLoyaltyGreeting (https://lite-annotate-commerce-demo.vercel.app/src/customer.js:16:36)\n    at HTMLButtonElement.loadLoyaltyProfile (https://lite-annotate-commerce-demo.vercel.app/src/app.js:137:22)",
        },
      ],
      network: [{ method: 'GET', url: '/api/customers/vip-404', status: 404, failed: true }],
      session: [{ type: 'click', target: 'button:Load loyalty profile' }],
    }, {
      workspacePath: root,
      githubToken: undefined,
      githubRepo: undefined,
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/customer.js');
    assert.equal(result.pipeline.diagnosis.targetFiles[0], 'src/customer.js');
    assert.equal(result.pipeline.patch.ok, true);
    assert.equal(result.pipeline.verification?.ok, true);
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, ['src/customer.js']);
    assert.ok(result.pipeline.verification?.commands.some((command) => command.stdout.includes('Customer not found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix uses the report repo before hosted env repo defaults', async () => {
  const wrongRepo = initGitRepo(makeRepo());
  const commerceRepo = initGitRepo(makeCommerceRepo());
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'lite-annotate-report-repo-workspace-'));
  const oldRepoPath = process.env.REPO_PATH;
  const oldTargetRepo = process.env.TARGET_REPO;
  const oldGithubRepo = process.env.GITHUB_REPO;

  process.env.REPO_PATH = wrongRepo;
  process.env.TARGET_REPO = wrongRepo;
  process.env.GITHUB_REPO = wrongRepo;

  try {
    const result = await runAutofix('bug_cedar_report_repo', {
      repo: commerceRepo,
      title: 'Account loyalty profile crashes',
      description: 'Clicked Load loyalty profile on /account.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/account',
      route: '/account',
      console: [
        {
          level: 'error',
          message: "[cedar-and-sail] loyalty profile crashed TypeError: Cannot read properties of undefined (reading 'name')",
          stack: "TypeError: Cannot read properties of undefined (reading 'name')\n    at formatLoyaltyGreeting (https://lite-annotate-commerce-demo.vercel.app/src/customer.js:16:36)\n    at HTMLButtonElement.loadLoyaltyProfile (https://lite-annotate-commerce-demo.vercel.app/src/app.js:137:22)",
        },
      ],
      network: [{ method: 'GET', url: '/api/customers/vip-404', status: 404, failed: true }],
      session: [{ type: 'click', target: 'button:Load loyalty profile' }],
    }, {
      workspaceRoot,
      githubToken: undefined,
      githubRepo: undefined,
      runPackageScripts: false,
    });

    assert.equal(result.pipeline.candidates[0]?.path, 'src/customer.js');
    assert.equal(result.pipeline.diagnosis.targetFiles[0], 'src/customer.js');
    assert.notEqual(result.pipeline.candidates[0]?.path, 'src/users.js');
  } finally {
    if (oldRepoPath === undefined) delete process.env.REPO_PATH;
    else process.env.REPO_PATH = oldRepoPath;
    if (oldTargetRepo === undefined) delete process.env.TARGET_REPO;
    else process.env.TARGET_REPO = oldTargetRepo;
    if (oldGithubRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = oldGithubRepo;
    rmSync(wrongRepo, { recursive: true, force: true });
    rmSync(commerceRepo, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('runAutofix fixes the Cedar & Sail checkout button color report with focused verification', async () => {
  const root = makeCommerceRepo();
  try {
    const result = await runAutofix('bug_checkout_button_blue', {
      title: 'Checkout button should be blue',
      description: 'On /checkout, the Place demo order primary button should use a blue background so the checkout CTA stands out from the rest of the page.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/checkout',
      route: '/checkout',
      annotation: {
        target: 'form#checkout-form:Email Name Address Place demo order',
        selector: 'form#checkout-form',
        route: '/checkout',
      },
      console: [],
      network: [],
      session: [{ type: 'click', target: 'button:Report a bug with technical context' }],
    }, {
      workspacePath: root,
      githubToken: undefined,
      githubRepo: undefined,
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/styles.css');
    assert.deepEqual(result.pipeline.diagnosis.targetFiles, ['src/styles.css']);
    assert.equal(result.pipeline.patch.ok, true);
    assert.deepEqual(result.pipeline.patch.files.map((file) => file.path), ['src/styles.css']);
    assert.match(result.pipeline.patch.files[0]?.content ?? '', /\.checkout-form \.button-primary/);
    assert.match(result.pipeline.patch.files[0]?.content ?? '', /#2563eb/);
    assert.equal(result.pipeline.verification?.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

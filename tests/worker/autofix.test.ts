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

function makeCommerceRepo(options: { alreadyGuarded?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-commerce-autofix-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'api', 'customers'), { recursive: true });
  const guard = options.alreadyGuarded ? "  if (!customer) return 'Customer not found';\n" : '';
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
${guard}  return \`Welcome back, \${customer.name}. Your \${customer.tier} credit is $\${customer.credits}.\`;
}
`
  );
  writeFileSync(
    join(root, 'src', 'app.js'),
    `import { formatLoyaltyGreeting } from './customer.js';

const navCartCount = document.getElementById('nav-cart-count');
const cart = new Map();

function renderCart() {
  const itemCount = Array.from(cart.values()).reduce((total, quantity) => total + quantity, 0);
  navCartCount.textContent = String(itemCount);
}

async function loadLoyaltyProfile() {
  const response = await fetch('/api/customers/vip-404');
  if (!response.ok) console.warn('[cedar-and-sail] loyalty profile lookup returned', response.status);
  return formatLoyaltyGreeting('vip-404');
}

export { loadLoyaltyProfile, renderCart };
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

.hero-copy h1 {
  font-size: clamp(44px, 7vw, 86px);
  line-height: 0.95;
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

test('runAutofix skips PR with a clear no-change reason when patch content already matches', async () => {
  const root = makeCommerceRepo();
  try {
    let calls = 0;
    const prStages: string[] = [];
    const result = await runAutofix('bug_checkout_button_already_blue', {
      title: 'Checkout button should be blue',
      description: 'On /checkout, the Place demo order primary button should use a blue background.',
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
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      runPackageScripts: false,
      codePatchGenerator: async ({ candidates, diagnosis }) => {
        const styles = candidates.find((candidate) => candidate.path === 'src/styles.css');
        assert.ok(styles);
        assert.deepEqual(diagnosis.targetFiles, ['src/styles.css']);
        return {
          ok: true,
          source: 'llm',
          model: 'test-model',
          files: [{ path: 'src/styles.css', content: styles.file.content }],
        };
      },
      createPR: async () => {
        calls += 1;
        throw new Error('no-change patch should not create PR');
      },
      onStage: async (stage) => {
        if (stage.key === 'pr' && stage.detail) prStages.push(stage.detail);
      },
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(calls, 0);
    assert.equal(result.pr, null);
    assert.equal(result.prError, undefined);
    assert.equal(result.pipeline.verification?.ok, true);
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, []);
    assert.ok(prStages.some((detail) => /No repository changes were produced/.test(detail)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix opens PR with only verified modified files when model returns a partial no-op patch', async () => {
  const root = makeCommerceRepo();
  try {
    let prFiles: string[] = [];
    const prStageLogs: string[] = [];
    const result = await runAutofix('bug_checkout_partial_noop', {
      title: 'Checkout button should be blue',
      description: 'On /checkout, the checkout CTA style and supporting script should be updated.',
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
      githubToken: 'ghs_test',
      githubRepo: 'ibrolord/lite-annotate-demo',
      runPackageScripts: false,
      codePatchGenerator: async ({ candidates }) => {
        const styles = candidates.find((candidate) => candidate.path === 'src/styles.css');
        const app = candidates.find((candidate) => candidate.path === 'src/app.js');
        assert.ok(styles);
        assert.ok(app);
        return {
          ok: true,
          source: 'llm',
          model: 'test-model',
          files: [
            { path: 'src/styles.css', content: styles.file.content },
            { path: 'src/app.js', content: `${app.file.content}\nexport const __annotateAutofixMarker = true;\n` },
          ],
        };
      },
      createPR: async (input) => {
        prFiles = input.payload.files.map((file) => file.path);
        return {
          pr_url: 'https://github.com/ibrolord/lite-annotate-demo/pull/9',
          branch: input.payload.branch,
          files: prFiles,
          write_mode: 'direct_files',
        };
      },
      onStage: async (stage) => {
        if (stage.key === 'pr' && stage.logs) prStageLogs.push(...stage.logs);
      },
    });

    assert.equal(result.status, 'pr_opened');
    assert.deepEqual(prFiles, ['src/app.js']);
    assert.deepEqual(result.pipeline.patch.files.map((file) => file.path), ['src/styles.css', 'src/app.js']);
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, ['src/app.js']);
    assert.ok(prStageLogs.some((line) => /skipped no-op patch files: src\/styles\.css/.test(line)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix targets the DOM state owner for a stray cart count report', async () => {
  const root = makeCommerceRepo();
  try {
    const result = await runAutofix('bug_stray_cart_zero', {
      title: 'Theres a stray 0 here',
      url: 'https://lite-annotate-commerce-demo.vercel.app/checkout/confirmation',
      route: '/checkout/confirmation',
      annotation: {
        target: 'a:Cart 0',
        selector: 'body > header.site-header > nav.main-nav > a',
        route: '/checkout/confirmation',
      },
      console: [{
        level: 'warn',
        message: '[cedar-and-sail] checkout redirect target is not registered /checkout/confirmation',
      }],
      network: [{ method: 'GET', url: '/api/checkout/quote', status: 200, failed: false }],
      session: [
        { type: 'click', target: 'button:Report a bug with technical context' },
        { type: 'click', target: 'a:Cart 0' },
      ],
    }, {
      workspacePath: root,
      githubToken: undefined,
      githubRepo: undefined,
      runPackageScripts: false,
      codePatchGenerator: async ({ candidates, diagnosis }) => {
        const app = candidates.find((candidate) => candidate.path === 'src/app.js');
        assert.ok(app);
        assert.equal(candidates[0]?.path, 'src/app.js');
        assert.deepEqual(diagnosis.targetFiles, ['src/app.js']);
        return {
          ok: true,
          source: 'llm',
          model: 'test-model',
          summary: 'Hide the cart count when it is zero.',
          files: [{
            path: 'src/app.js',
            content: app.file.content.replace(
              '  navCartCount.textContent = String(itemCount);',
              "  navCartCount.textContent = itemCount === 0 ? '' : String(itemCount);"
            ),
          }],
        };
      },
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/app.js');
    assert.deepEqual(result.pipeline.diagnosis.targetFiles, ['src/app.js']);
    assert.equal(result.pipeline.diagnosis.shouldPatch, true);
    assert.match(result.pipeline.diagnosis.rootCause, /displayed value/);
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, ['src/app.js']);
    assert.ok(result.pipeline.verification?.commands.some((command) => command.name === 'node --check src/app.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix rejects report-provided repos when PR credentials lack a trusted repo', async () => {
  await assert.rejects(
    () => runAutofix('bug_untrusted_repo', { ...report, repo: 'ibrolord/untrusted-demo' }, {
      githubToken: 'ghs_test',
      githubRepo: undefined,
    }),
    /AUTOFIX_ALLOWED_REPOS|TARGET_REPO\/GITHUB_REPO/
  );
});

test('runAutofix allows report-provided repos that match the server allowlist', async () => {
  const root = makeRepo();
  try {
    const result = await runAutofix('bug_trusted_repo', {
      ...report,
      repo: 'https://github.com/ibrolord/lite-annotate-demo.git',
    }, {
      workspacePath: root,
      githubToken: 'ghs_test',
      githubRepo: undefined,
      skipPR: true,
      allowedRepos: ['ibrolord/lite-annotate-demo'],
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.verification?.ok, true);
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
      runPackageScripts: false,
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/customer.js');
    assert.equal(result.pipeline.diagnosis.targetFiles[0], 'src/customer.js');
    assert.equal(result.pipeline.patch.ok, true);
    assert.equal(result.pipeline.verification?.ok, true);
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, ['src/customer.js']);
    assert.ok(result.pipeline.verification?.commands.some((command) => command.name === 'node --check src/customer.js'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix verifies the Cedar & Sail loyalty crash when repo HEAD is already guarded', async () => {
  const root = makeCommerceRepo({ alreadyGuarded: true });
  try {
    const result = await runAutofix('bug_cedar_account_already_fixed', {
      title: 'Account loyalty profile crashes',
      description: 'Clicked Load loyalty profile on /account.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/account',
      route: '/account',
      console: [
        {
          level: 'error',
          message: "[cedar-and-sail] loyalty profile crashed TypeError: Cannot read properties of undefined (reading 'name')",
          stack: [
            "TypeError: Cannot read properties of undefined (reading 'name')",
            '    at formatLoyaltyGreeting (http://localhost:4174/src/customer.js:16:36)',
            '    at HTMLButtonElement.loadLoyaltyProfile (http://localhost:4174/src/app.js:137:22)',
          ].join('\n'),
        },
      ],
      network: [{ method: 'GET', url: '/api/customers/vip-404', status: 404, failed: true }],
      session: [{ type: 'click', target: 'button:Load loyalty profile' }],
    }, {
      workspacePath: root,
      githubToken: undefined,
      githubRepo: undefined,
      runPackageScripts: false,
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/customer.js');
    assert.equal(result.pipeline.diagnosis.targetFiles[0], 'src/customer.js');
    assert.equal(result.pipeline.patch.ok, true);
    assert.deepEqual(result.pipeline.patch.files, []);
    assert.match(result.pipeline.patch.error ?? '', /already contains/i);
    assert.equal(result.pipeline.verification?.ok, true);
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, []);
    assert.deepEqual(result.pipeline.verification?.commands, []);
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
      runPackageScripts: false,
      codePatchGenerator: async ({ candidates, diagnosis }) => {
        const styles = candidates.find((candidate) => candidate.path === 'src/styles.css');
        assert.ok(styles);
        assert.deepEqual(diagnosis.targetFiles, ['src/styles.css']);
        return {
          ok: true,
          source: 'llm',
          model: 'test-model',
          files: [
            {
              path: 'src/styles.css',
              content: `${styles.file.content}\n.checkout-form .button-primary {\n  background: #2563eb;\n}\n`,
            },
          ],
        };
      },
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.candidates[0]?.path, 'src/styles.css');
    assert.deepEqual(result.pipeline.diagnosis.targetFiles, ['src/styles.css']);
    assert.equal(result.pipeline.patch.ok, true);
    assert.equal(result.pipeline.patch.source, 'llm');
    assert.deepEqual(result.pipeline.patch.files.map((file) => file.path), ['src/styles.css']);
    assert.match(result.pipeline.patch.files[0]?.content ?? '', /\.checkout-form \.button-primary/);
    assert.match(result.pipeline.patch.files[0]?.content ?? '', /#2563eb/);
    assert.equal(result.pipeline.verification?.ok, true);
    assert.ok(result.pipeline.verification?.commands.some((command) => command.name === 'css sanity src/styles.css'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runAutofix does not run the profile smoke command for visual ecommerce reports', async () => {
  const root = makeCommerceRepo();
  try {
    const result = await runAutofix('bug_ecommerce_wrapping', {
      title: 'this text is wrapping weirdly',
      description: 'The homepage hero headline wraps awkwardly.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/',
      route: '/',
      annotation: {
        target: 'h1: Travel-ready home and carry essentials.',
        selector: '.hero-copy h1',
        route: '/',
      },
      console: [],
      network: [],
      session: [{ type: 'click', target: 'h1: Travel-ready home and carry essentials.' }],
    }, {
      workspacePath: root,
      githubToken: undefined,
      githubRepo: undefined,
      runPackageScripts: false,
      codePatchGenerator: async ({ candidates, diagnosis }) => {
        const styles = candidates.find((candidate) => candidate.path === 'src/styles.css');
        assert.ok(styles);
        assert.ok(diagnosis.targetFiles.includes('src/styles.css'));
        return {
          ok: true,
          source: 'llm',
          model: 'test-model',
          files: [
            {
              path: 'src/styles.css',
              content: `${styles.file.content}\n.hero-copy h1 {\n  line-height: 1.08;\n}\n`,
            },
          ],
        };
      },
    });

    assert.equal(result.status, 'verified_no_pr');
    assert.equal(result.pipeline.patch.source, 'llm');
    assert.equal(result.pipeline.verification?.ok, true);
    assert.ok(result.pipeline.verification?.commands.some((command) => command.name === 'css sanity src/styles.css'));
    assert.deepEqual(result.pipeline.verification?.modifiedFiles, ['src/styles.css']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

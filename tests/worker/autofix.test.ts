import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runAutofix } from '../../api/autofix.ts';

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

function makeCommerceRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-commerce-autofix-'));
  mkdirSync(join(root, 'src'), { recursive: true });
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
          message: "[cedar-and-sail] loyalty profile crashed TypeError: Cannot read properties of undefined (reading 'name') at formatLoyaltyGreeting (src/customer.js:16:36)",
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
    assert.ok(result.pipeline.verification?.commands.some((command) => command.stdout.includes('Customer not found')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

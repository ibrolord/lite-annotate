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
  writeFileSync(
    join(root, 'index.html'),
    `<section class="hero" data-view="home">
  <div class="hero-copy">
    <h1>Travel-ready home and carry essentials.</h1>
  </div>
</section>
`
  );
  writeFileSync(
    join(root, 'src', 'styles.css'),
    `.hero {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.hero-copy h1 {
  font-size: clamp(44px, 7vw, 86px);
  line-height: 0.95;
}
`
  );
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, '.env'), 'TOKEN=secret');
  writeFileSync(join(root, 'node_modules', 'ignored', 'users.js'), 'export const ignored = true;');
  writeFileSync(join(root, 'dist', 'users.js'), 'export const ignored = true;');

  return root;
}

test('buildCodeIndex extracts app code files and ignores dependencies, build outputs, lockfiles, and env files', () => {
  const root = makeFixtureRepo();
  try {
    const index = buildCodeIndex(root);
    const paths = index.files.map((file) => file.path).sort();

    assert.deepEqual(paths, [
      'index.html',
      'src/components/Dashboard.tsx',
      'src/styles.css',
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

test('rankCandidateFiles uses pinned visual evidence to rank ecommerce HTML and CSS', () => {
  const root = makeFixtureRepo();
  try {
    const index = buildCodeIndex(root);
    const ranked = rankCandidateFiles(index, {
      title: 'this text is wrapping weirdly',
      description: 'The hero headline wraps badly on the ecommerce homepage.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/',
      route: '/',
      annotation: {
        target: 'h1: Travel-ready home and carry essentials.',
        selector: '.hero-copy h1',
      },
      session: [{ type: 'click', target: 'h1: Travel-ready home and carry essentials.' }],
    });

    const topPaths = ranked.slice(0, 3).map((candidate) => candidate.path);
    assert.ok(topPaths.includes('index.html'), `expected index.html in top 3, got ${topPaths.join(', ')}`);
    assert.ok(topPaths.includes('src/styles.css'), `expected src/styles.css in top 3, got ${topPaths.join(', ')}`);
    assert.ok(
      ranked.some((candidate) => candidate.path === 'src/styles.css' && candidate.reasons.some((reason) => /selector|stylesheet|visual/i.test(reason)))
    );
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

test('rankCandidateFiles trusts stack-frame source paths over noisy network routes', () => {
  const root = makeFixtureRepo();
  try {
    mkdirSync(join(root, 'api', 'users'), { recursive: true });
    writeFileSync(join(root, 'api', 'users', '999.js'), `export default function handler() {}\n`);

    const index = buildCodeIndex(root);
    const ranked = rankCandidateFiles(index, {
      title: 'User profile crashes reading name',
      description: 'API returned 404, then the UI crashed.',
      url: 'https://demo.example.com/account',
      route: '/account',
      console: [
        {
          level: 'error',
          message: "TypeError: Cannot read properties of undefined (reading 'name') at formatUserGreeting (src/users.js:16:36)",
        },
      ],
      network: [
        {
          method: 'GET',
          url: '/api/users/999',
          status: 404,
        },
      ],
    });

    assert.equal(ranked[0]?.path, 'src/users.js');
    assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('stack frame references src/users.js')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rankCandidateFiles uses console stack fields to rank the crashing commerce module first', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-commerce-index-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'api', 'customers'), { recursive: true });

    writeFileSync(
      join(root, 'src', 'app.js'),
      `import { formatLoyaltyGreeting } from './customer.js';

const productGrid = document.getElementById('product-grid');
productGrid.innerHTML = '<h3>\${product.name}</h3>';

async function loadLoyaltyProfile() {
  const response = await fetch('/api/customers/vip-404');
  if (!response.ok) console.warn('loyalty profile lookup returned', response.status);
  const greeting = formatLoyaltyGreeting('vip-404');
  document.getElementById('loyalty-status').textContent = greeting;
}
`
    );
    writeFileSync(
      join(root, 'src', 'customer.js'),
      `const customers = [{ id: 'jord-2025', name: 'Jordan Lee' }];

export function getCustomerById(customerId) {
  return customers.find((customer) => customer.id === customerId);
}

export function formatLoyaltyGreeting(customerId) {
  const customer = getCustomerById(customerId);
  return \`Welcome back, \${customer.name}.\`;
}
`
    );
    writeFileSync(join(root, 'api', 'customers', 'vip-404.js'), `export default function handler() {}\n`);

    const index = buildCodeIndex(root);
    const ranked = rankCandidateFiles(index, {
      title: 'Loyalty profile crashes',
      description: 'Loading my loyalty profile crashes after the missing customer request.',
      url: 'https://lite-annotate-commerce-demo.vercel.app/account',
      route: '/account',
      console: [
        {
          level: 'log',
          message: '[cedar-and-sail] Lite Annotate widget loaded',
        },
        {
          level: 'warn',
          message: '[cedar-and-sail] loyalty profile lookup returned 404',
        },
        {
          level: 'error',
          message: "[cedar-and-sail] loyalty profile crashed TypeError: Cannot read properties of undefined (reading 'name')",
          stack: [
            "TypeError: Cannot read properties of undefined (reading 'name')",
            '    at formatLoyaltyGreeting (http://localhost:4174/src/customer.js:16:36)',
            '    at HTMLButtonElement.loadLoyaltyProfile (http://localhost:4174/src/app.js:137:22)',
          ].join('\n'),
        } as any,
      ],
      network: [{ method: 'GET', url: '/api/customers/vip-404', status: 404, failed: true }],
      session: [{ type: 'click', target: 'button#load-loyalty-profile:Load loyalty profile' }],
    });

    assert.equal(ranked[0]?.path, 'src/customer.js');
    assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('top stack frame references src/customer.js')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rankCandidateFiles reads stack-frame source paths from console stack fields', () => {
  const root = makeFixtureRepo();
  try {
    mkdirSync(join(root, 'api', 'users'), { recursive: true });
    writeFileSync(join(root, 'api', 'users', '999.js'), `export default function handler() {}\n`);

    const index = buildCodeIndex(root);
    const ranked = rankCandidateFiles(index, {
      title: 'User profile crashes after API failure',
      description: 'A noisy API route is present, but the console stack points at the UI code.',
      url: 'https://demo.example.com/account',
      route: '/account',
      consoleLogs: [
        {
          level: 'error',
          message: "Cannot read properties of undefined (reading 'name')",
          stack: 'TypeError: Cannot read properties of undefined\n    at formatUserGreeting (https://demo.example.com/src/users.js:16:36)',
        },
      ],
      network: [
        {
          method: 'GET',
          url: '/api/users/999',
          status: 404,
        },
      ],
    });

    assert.equal(ranked[0]?.path, 'src/users.js');
    assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('stack trace references src/users.js')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rankCandidateFiles prioritizes the first console stack frame', () => {
  const root = makeFixtureRepo();
  try {
    mkdirSync(join(root, 'api', 'users'), { recursive: true });
    writeFileSync(join(root, 'api', 'users', '999.js'), `export default function handler() {}\n`);

    const index = buildCodeIndex(root);
    const ranked = rankCandidateFiles(index, {
      title: 'User profile crashes after dashboard render',
      description: 'The route and later stack frame mention users, but the top frame is the component that threw.',
      url: 'https://demo.example.com/users',
      route: '/users',
      console: [
        {
          level: 'error',
          message: "Cannot read properties of undefined (reading 'name')",
          stack: [
            "TypeError: Cannot read properties of undefined (reading 'name')",
            '    at Dashboard (src/components/Dashboard.tsx:2:15)',
            '    at formatUserGreeting (src/users.js:16:36)',
          ].join('\n'),
        },
      ],
      network: [
        {
          method: 'GET',
          url: '/api/users/999',
          status: 404,
        },
      ],
    });

    assert.equal(ranked[0]?.path, 'src/components/Dashboard.tsx');
    assert.ok(ranked[0]?.reasons.some((reason) => reason.includes('stack trace references src/components/Dashboard.tsx')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

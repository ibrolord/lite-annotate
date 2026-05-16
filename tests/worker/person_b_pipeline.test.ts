import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runPersonBPipeline } from '../../api/worker/person_b_pipeline.ts';

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-person-b-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'src', 'api', 'checkout'), { recursive: true });
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
  writeFileSync(join(root, 'src', 'home.js'), `export const route = '/';\n`);
  writeFileSync(
    join(root, 'src', 'api', 'checkout', 'quote.js'),
    `export function quoteCheckoutButton() {
  return { label: 'Place demo order', total: 42 };
}
`
  );
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
}

.hero-copy h1 {
  font-size: clamp(44px, 7vw, 86px);
  line-height: 0.95;
}

.button-primary {
  background: #111827;
}
`
  );
  return root;
}

test('runPersonBPipeline ranks, diagnoses, patches, and verifies the pinned demo bug', async () => {
  const root = makeRepo();
  try {
    const result = await runPersonBPipeline({
      workspacePath: root,
      report: {
        title: 'User profile crashes reading name',
        description: 'Clicking load profile crashes',
        url: 'https://demo.example.com/users',
        route: '/users',
        console: [{ level: 'error', message: "Cannot read properties of undefined reading 'name'" }],
        network: [{ method: 'GET', url: '/api/users/999', status: 404 }],
      },
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

    assert.equal(result.candidates[0]?.path, 'src/users.js');
    assert.equal(result.diagnosis.targetFiles[0], 'src/users.js');
    assert.equal(result.patch.ok, true);
    assert.equal(result.verification?.ok, true);
    assert.deepEqual(result.verification?.modifiedFiles, ['src/users.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPersonBPipeline can use a model patch generator for visual UI fixes', async () => {
  const root = makeRepo();
  try {
    const result = await runPersonBPipeline({
      workspacePath: root,
      report: {
        title: 'this text is wrapping weirdly',
        description: 'The hero headline wraps badly on the ecommerce homepage.',
        url: 'https://lite-annotate-commerce-demo.vercel.app/',
        route: '/',
        annotation: {
          target: 'h1: Travel-ready home and carry essentials.',
          selector: '.hero-copy h1',
        },
      },
      runPackageScripts: false,
      codePatchGenerator: async ({ diagnosis, candidates }) => {
        const styles = candidates.find((candidate) => candidate.path === 'src/styles.css');
        assert.ok(styles);
        assert.ok(diagnosis.targetFiles.includes('src/styles.css'));
        return {
          ok: true,
          source: 'llm',
          model: 'test-coding-model',
          summary: 'Relaxed the hero headline line height and font scale.',
          files: [
            {
              path: 'src/styles.css',
              content: styles.file.content.replace(
                'font-size: clamp(44px, 7vw, 86px);\n  line-height: 0.95;',
                'font-size: clamp(38px, 6vw, 72px);\n  line-height: 1.08;'
              ),
            },
          ],
        };
      },
    });

    assert.equal(result.patch.ok, true);
    assert.equal(result.patch.source, 'llm');
    assert.equal(result.patch.model, 'test-coding-model');
    assert.equal(result.verification?.ok, true);
    assert.deepEqual(result.verification?.modifiedFiles, ['src/styles.css']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPersonBPipeline does not let the model upgrade an unpatchable diagnosis', async () => {
  const root = makeRepo();
  try {
    let called = false;
    const result = await runPersonBPipeline({
      workspacePath: root,
      report: {
        title: 'Checkout page should mention pickup window',
        description: 'The checkout page should mention that pickup is ready within two hours.',
        url: 'https://lite-annotate-commerce-demo.vercel.app/checkout',
        route: '/checkout',
        annotation: {
          target: 'section: Shipping details',
          selector: '.checkout-form',
        },
        console: [{
          level: 'error',
          message: 'Non-blocking checkout quote warning',
          stack: 'ReferenceError: quote warning\n    at quoteCheckoutButton (src/api/checkout/quote.js:1:1)',
        }],
      },
      runPackageScripts: false,
      smokeCommands: [
        {
          command: process.execPath,
          args: [
            '-e',
            "const fs = require('fs'); const html = fs.readFileSync('index.html', 'utf8'); if (!html.includes('Pickup is ready within two hours')) process.exit(1);",
          ],
        },
      ],
      codePatchGenerator: async ({ diagnosis, index, allowRepoFileSelection }) => {
        called = true;
        assert.equal(allowRepoFileSelection, true);
        assert.ok(index?.files.some((file) => file.path === 'src/api/checkout/quote.js'));
        assert.ok(index?.files.some((file) => file.path === 'index.html'));
        const html = index?.files.find((file) => file.path === 'index.html');
        assert.ok(html);
        return {
          ok: true,
          source: 'llm',
          model: 'test-repo-selector',
          summary: 'Added pickup timing copy to checkout.',
          files: [
            {
              path: 'index.html',
              content: html.content.replace('</section>', '<p>Pickup is ready within two hours.</p>\n</section>'),
            },
          ],
        };
      },
    });

    assert.equal(called, false);
    assert.equal(result.diagnosis.shouldPatch, false);
    assert.equal(result.patch.ok, false);
    assert.equal(result.verification, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runPersonBPipeline does not fast-patch noisy color reports without patchable diagnosis', async () => {
  const root = makeRepo();
  try {
    let called = false;
    const result = await runPersonBPipeline({
      workspacePath: root,
      report: {
        title: 'Checkout button should be purple',
        description: 'The Place demo order button should use a purple background.',
        url: 'https://lite-annotate-commerce-demo.vercel.app/checkout',
        route: '/checkout',
        annotation: {
          target: 'button: Place demo order',
          selector: '.button-primary',
        },
        console: [{
          level: 'error',
          message: 'Non-blocking checkout quote warning',
          stack: 'ReferenceError: quote warning\n    at quoteCheckoutButton (src/api/checkout/quote.js:1:1)',
        }],
      },
      runPackageScripts: false,
      smokeCommands: [
        {
          command: process.execPath,
          args: [
            '-e',
            "const fs = require('fs'); const css = fs.readFileSync('src/styles.css', 'utf8'); if (!css.includes('#7c3aed')) process.exit(1);",
          ],
        },
      ],
      codePatchGenerator: async () => {
        called = true;
        return { ok: false, source: 'llm', files: [], error: 'should not be called for bounded color patch' };
      },
    });

    assert.equal(called, false);
    assert.equal(result.diagnosis.shouldPatch, false);
    assert.equal(result.patch.ok, false);
    assert.equal(result.verification, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

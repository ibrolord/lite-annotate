import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureRepoWorkspace } from '../../api/repo/workspace.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=Lite Annotate Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
}

test('ensureRepoWorkspace clones a configured repo and fetches later origin updates', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-workspace-'));
  try {
    const origin = join(root, 'origin');
    const workspaceRoot = join(root, 'workspaces');
    mkdirSync(join(origin, 'src'), { recursive: true });
    git(origin, ['init', '-b', 'main']);
    writeFileSync(join(origin, 'src', 'users.js'), 'export const version = 1;\n');
    commitAll(origin, 'initial');

    const first = ensureRepoWorkspace({ repo: origin, workspaceRoot });
    assert.equal(readFileSync(join(first.path, 'src', 'users.js'), 'utf8'), 'export const version = 1;\n');
    assert.equal(first.fetched, false);

    writeFileSync(join(origin, 'src', 'users.js'), 'export const version = 2;\n');
    commitAll(origin, 'update users');

    const second = ensureRepoWorkspace({ repo: origin, workspaceRoot });
    assert.equal(second.path, first.path);
    assert.equal(readFileSync(join(second.path, 'src', 'users.js'), 'utf8'), 'export const version = 2;\n');
    assert.equal(second.fetched, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { ensureRepoWorkspace, extractTarGzArchive } from '../../api/repo/workspace.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=Lite Annotate Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
}

test('ensureRepoWorkspace clones a configured repo and fetches later origin updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-workspace-'));
  try {
    const origin = join(root, 'origin');
    const workspaceRoot = join(root, 'workspaces');
    mkdirSync(join(origin, 'src'), { recursive: true });
    git(origin, ['init', '-b', 'main']);
    writeFileSync(join(origin, 'src', 'users.js'), 'export const version = 1;\n');
    commitAll(origin, 'initial');

    const first = await ensureRepoWorkspace({ repo: origin, workspaceRoot });
    assert.equal(readFileSync(join(first.path, 'src', 'users.js'), 'utf8'), 'export const version = 1;\n');
    assert.equal(first.fetched, false);

    writeFileSync(join(origin, 'src', 'users.js'), 'export const version = 2;\n');
    commitAll(origin, 'update users');

    const second = await ensureRepoWorkspace({ repo: origin, workspaceRoot });
    assert.equal(second.path, first.path);
    assert.equal(readFileSync(join(second.path, 'src', 'users.js'), 'utf8'), 'export const version = 2;\n');
    assert.equal(second.fetched, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function tarEntry(name: string, content: string): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

test('extractTarGzArchive strips the GitHub archive root folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'lite-annotate-tarball-'));
  try {
    const archive = gzipSync(Buffer.concat([
      tarEntry('owner-repo-sha/src/customer.js', 'export const ok = true;\n'),
      Buffer.alloc(1024),
    ]));

    extractTarGzArchive(archive, root);

    assert.equal(readFileSync(join(root, 'src', 'customer.js'), 'utf8'), 'export const ok = true;\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

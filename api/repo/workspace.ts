import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';

export interface RepoWorkspaceOptions {
  repo: string;
  workspaceRoot?: string;
  branch?: string;
  githubToken?: string;
}

export interface RepoWorkspace {
  path: string;
  remote: string;
  branch: string;
  fetched: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function normalizeRepoRemote(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) throw new Error('repo is required');
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return trimmed;
}

function workspaceName(remote: string): string {
  const slug = remote
    .replace(/\.git$/i, '')
    .split(/[/:\\]/)
    .filter(Boolean)
    .slice(-2)
    .join('-')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .slice(0, 80) || 'repo';
  const digest = createHash('sha256').update(remote).digest('hex').slice(0, 12);
  return `${slug}-${digest}`;
}

function githubRepoFromRemote(remote: string): { owner: string; repo: string } | null {
  const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function currentRemoteBranch(path: string): string {
  const ref = git(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return ref.replace(/^origin\//, '');
}

function checkoutRemoteBranch(path: string, branch: string): void {
  git(path, ['checkout', '-B', branch, `origin/${branch}`]);
  git(path, ['reset', '--hard', `origin/${branch}`]);
}

function readTarString(buffer: Buffer, start: number, length: number): string {
  const raw = buffer.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').trim();
}

function readTarOctal(buffer: Buffer, start: number, length: number): number {
  const raw = readTarString(buffer, start, length).replace(/\0/g, '').trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroBlock(buffer: Buffer, offset: number): boolean {
  for (let index = 0; index < 512; index += 1) {
    if (buffer[offset + index] !== 0) return false;
  }
  return true;
}

function safeArchivePath(path: string): string | null {
  const parts = path.split('/').filter(Boolean).slice(1);
  if (!parts.length || parts.includes('..')) return null;
  return parts.join('/');
}

export function extractTarGzArchive(archive: Buffer, target: string): void {
  const buffer = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= buffer.length;) {
    if (isZeroBlock(buffer, offset)) break;

    const name = readTarString(buffer, offset, 100);
    const prefix = readTarString(buffer, offset + 345, 155);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    const relativePath = safeArchivePath(fullPath);
    const size = readTarOctal(buffer, offset + 124, 12);
    const typeflag = String.fromCharCode(buffer[offset + 156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (relativePath && (typeflag === '0' || typeflag === '\0' || typeflag === '')) {
      const destination = join(target, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, buffer.subarray(dataStart, dataEnd));
    } else if (relativePath && typeflag === '5') {
      mkdirSync(join(target, relativePath), { recursive: true });
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

async function downloadGithubTarball(remote: string, branch: string, token?: string): Promise<Buffer> {
  const repo = githubRepoFromRemote(remote);
  if (!repo) {
    throw new Error(`git is unavailable and ${remote} is not a supported GitHub repo URL`);
  }

  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/tarball/${encodeURIComponent(branch)}`;
  const response = await fetch(url, {
    headers: {
      'user-agent': 'lite-annotate-autofix',
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`failed to download ${repo.owner}/${repo.repo}@${branch}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function ensureGithubTarballWorkspace(
  remote: string,
  options: RepoWorkspaceOptions,
  target: string
): Promise<RepoWorkspace> {
  const branch = options.branch ?? 'main';
  const existed = existsSync(target);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const archive = await downloadGithubTarball(remote, branch, options.githubToken);
  extractTarGzArchive(archive, target);
  return { path: target, remote, branch, fetched: existed };
}

export async function ensureRepoWorkspace(options: RepoWorkspaceOptions): Promise<RepoWorkspace> {
  const remote = normalizeRepoRemote(options.repo);
  const workspaceRoot = options.workspaceRoot ?? join(tmpdir(), 'lite-annotate-repos');
  const target = join(workspaceRoot, workspaceName(remote));
  mkdirSync(workspaceRoot, { recursive: true });

  const fetchMode = process.env.AUTOFIX_REPO_FETCH ?? 'auto';
  if (fetchMode === 'tarball' || (fetchMode === 'auto' && !gitAvailable())) {
    return ensureGithubTarballWorkspace(remote, options, target);
  }

  if (!existsSync(join(target, '.git'))) {
    git(workspaceRoot, ['clone', remote, target]);
    const branch = options.branch ?? currentRemoteBranch(target);
    checkoutRemoteBranch(target, branch);
    return { path: target, remote, branch, fetched: false };
  }

  git(target, ['fetch', 'origin', '--prune']);
  const branch = options.branch ?? currentRemoteBranch(target);
  checkoutRemoteBranch(target, branch);
  return { path: target, remote, branch, fetched: true };
}

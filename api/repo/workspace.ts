import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface RepoWorkspaceOptions {
  repo: string;
  workspaceRoot?: string;
  branch?: string;
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

function currentRemoteBranch(path: string): string {
  const ref = git(path, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  return ref.replace(/^origin\//, '');
}

function checkoutRemoteBranch(path: string, branch: string): void {
  git(path, ['checkout', '-B', branch, `origin/${branch}`]);
  git(path, ['reset', '--hard', `origin/${branch}`]);
}

export function ensureRepoWorkspace(options: RepoWorkspaceOptions): RepoWorkspace {
  const remote = normalizeRepoRemote(options.repo);
  const workspaceRoot = options.workspaceRoot ?? join(tmpdir(), 'lite-annotate-repos');
  const target = join(workspaceRoot, workspaceName(remote));
  mkdirSync(workspaceRoot, { recursive: true });

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

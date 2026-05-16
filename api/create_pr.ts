import type { AiProviderConfig } from './ai_provider.js';
import { AiOutputTruncatedError, createAiJson, DEFAULT_ANTHROPIC_MODEL, getSystemAiProvider } from './ai_provider.js';
import { redactDiagnosticText } from './redaction.js';

const PR_MAX_SUSPECTED_FILES = 8;
const PR_MAX_CONSOLE_CHARS = 4_000;
const PR_MAX_FIELD_CHARS = 4_000;
const PR_CONTEXT_MAX_FILES = 4;
const PR_CONTEXT_MAX_FILE_BYTES = 18_000;
const PR_CONTEXT_RETRY_FILE_LIMITS = [4, 2, 1] as const;

export interface PatchFile {
  path: string;
  content: string;
  explanation: string;
}

export interface PRPayload {
  title: string;
  body: string;
  branch: string;
  files: PatchFile[];
}

export interface GitHubPRResult {
  pr_url: string;
  branch: string;
  files: string[];
  write_mode: 'direct_files';
}

export interface RepoFileContext {
  path: string;
  content: string;
}

interface ExistingRepoFile extends RepoFileContext {
  sha: string;
}

interface GitHubRepo {
  default_branch: string;
}

interface GitHubRef {
  object: { sha: string };
}

interface GitHubCommit {
  tree: { sha: string };
}

interface GitHubTree {
  tree: Array<{ path: string; type: string; size?: number }>;
  truncated?: boolean;
}

interface GitHubContentFile {
  type?: string;
  sha: string;
  content?: string;
  encoding?: string;
}

export class GitHubPRValidationError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 422,
    public readonly code = 'invalid_generated_pr'
  ) {
    super(message);
    this.name = 'GitHubPRValidationError';
  }
}

export type GitHubPRWriteMode = 'direct_files';

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (!match) throw new Error(`Cannot parse GitHub repo from URL: ${repoUrl}`);
  const [, owner, rawRepo] = match;
  const repo = rawRepo.replace(/\.git$/i, '');
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (
    !safeSegment.test(owner) ||
    !safeSegment.test(repo) ||
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..'
  ) {
    throw new Error(`Invalid GitHub repo path: ${repoUrl}`);
  }
  return { owner, repo };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'annotate-app',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function envFlagDefaultTrue(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

export function aiPrFileWritesEnabled(): boolean {
  return envFlagDefaultTrue('ANNOTATE_AI_PR_WRITE_FILES');
}

function encodeContentPath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function normalizeBase64(value: string): string {
  return value.replace(/\s+/g, '');
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated by Annotate to keep AI PR generation bounded]`;
}

function contextAttempts(repoContext: RepoFileContext[]): RepoFileContext[][] {
  const eligible = repoContext
    .filter((file) => Buffer.byteLength(file.content, 'utf8') <= PR_CONTEXT_MAX_FILE_BYTES)
    .slice(0, PR_CONTEXT_MAX_FILES);
  if (eligible.length === 0) return [[]];

  const attempts: RepoFileContext[][] = [];
  let previousKey = '';
  for (const limit of PR_CONTEXT_RETRY_FILE_LIMITS) {
    const attempt = eligible.slice(0, limit);
    const key = attempt.map((file) => file.path).join('\n');
    if (attempt.length > 0 && key !== previousKey) {
      attempts.push(attempt);
      previousKey = key;
    }
  }
  return attempts;
}

/**
 * generatePRPayload — asks Claude to produce file patches based on triage output.
 * Returns structured PR metadata + per-file patches.
 */
export async function generatePRPayload(params: {
  reportComment: string;
  pageUrl: string;
  suggestedFix: string;
  rootCause: string;
  suspectedFiles: string[];
  consoleErrors: string;
  severityScore: number;
}, aiConfig: AiProviderConfig | null = getSystemAiProvider(), repoContext: RepoFileContext[] = []): Promise<PRPayload> {
  if (!aiConfig) {
    throw new Error('AI provider is not configured');
  }

  const { reportComment, pageUrl, suggestedFix, rootCause, suspectedFiles, consoleErrors, severityScore } = params;
  const safeReportComment = truncateForPrompt(redactDiagnosticText(reportComment), PR_MAX_FIELD_CHARS);
  const safePageUrl = truncateForPrompt(redactDiagnosticText(pageUrl), PR_MAX_FIELD_CHARS);
  const safeSuggestedFix = truncateForPrompt(redactDiagnosticText(suggestedFix), PR_MAX_FIELD_CHARS);
  const safeRootCause = truncateForPrompt(redactDiagnosticText(rootCause), PR_MAX_FIELD_CHARS);
  const safeSuspectedFiles = suspectedFiles
    .slice(0, PR_MAX_SUSPECTED_FILES)
    .map((file) => redactDiagnosticText(file));
  const safeConsoleErrors = consoleErrors
    ? truncateForPrompt(redactDiagnosticText(consoleErrors), PR_MAX_CONSOLE_CHARS)
    : 'None';

  const schema = {
    type: 'object' as const,
    required: ['title', 'body', 'branch', 'files'],
    properties: {
      title: { type: 'string', description: 'PR title under 72 chars, prefixed with fix:' },
      body: { type: 'string', description: 'PR description: what broke, root cause, what changed' },
      branch: { type: 'string', description: 'Branch name in kebab-case, prefixed with fix/' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          required: ['path', 'content', 'explanation'],
          properties: {
            path: { type: 'string', description: 'Relative file path' },
            content: { type: 'string', description: 'Full corrected file content' },
            explanation: { type: 'string', description: 'One-line description of what changed' },
          },
        },
      },
    },
  };

  let truncated = false;
  for (const attemptContext of contextAttempts(repoContext)) {
    const editableFiles = attemptContext
      .map((file) => {
        const safePath = redactDiagnosticText(file.path);
        return `### ${safePath}\n\`\`\`text\n${file.content}\n\`\`\``;
      })
      .join('\n\n');

    const prompt = `You are a senior software engineer generating a GitHub pull request to fix a bug.

## Bug Report
**User reported**: ${safeReportComment}
**Page**: ${safePageUrl}
**Severity**: ${severityScore}/100

## Root Cause (from AI triage)
${safeRootCause}

## Suggested Fix (from AI triage)
${safeSuggestedFix}

## Suspected Files
${safeSuspectedFiles.join(', ')}
${suspectedFiles.length > PR_MAX_SUSPECTED_FILES ? `\nAnnotate omitted ${suspectedFiles.length - PR_MAX_SUSPECTED_FILES} lower-priority suspected files to keep this PR attempt bounded.` : ''}

## Console Errors
${safeConsoleErrors}

## Editable Existing Files
You may ONLY patch the exact paths listed below. These are real files from the connected repository.
Return the full replacement content for each patched file.
If none of these files can be meaningfully changed to address the bug, return "files": [] and explain why in the PR body.
Never invent a path. Never create .annotate metadata files. Never create plan-only files.
Prefer a one-file patch. Use at most two files. If the required replacement would be too large to return safely, return "files": [] and explain that the fix needs a more targeted repo context.

${editableFiles || 'No editable repository files were provided. Return "files": [] and explain that no safe repository context was available.'}

---

Generate a pull request with REAL file patches against existing application files. Make minimal, targeted changes.

Respond in this EXACT JSON format (no markdown, no backticks, raw JSON only):

{
  "title": "fix: <concise title under 72 chars>",
  "body": "<PR description with: what broke, root cause, what was changed>",
  "branch": "fix/<kebab-case-branch-name>",
  "files": [
    {
      "path": "relative/path/to/file.js",
      "content": "<full corrected file content — write realistic plausible code>",
      "explanation": "<one line: what changed in this file>"
    }
  ]
}

Only include files you can meaningfully patch from the Editable Existing Files list. Write realistic, production-quality code.`;

    try {
      const input = await createAiJson(aiConfig, prompt, schema);
      const result: PRPayload = {
        title: String(input['title'] ?? ''),
        body: String(input['body'] ?? ''),
        branch: String(input['branch'] ?? `fix/auto-generated-${aiConfig.provider}-${aiConfig.model || DEFAULT_ANTHROPIC_MODEL}`),
        files: Array.isArray(input['files']) ? (input['files'] as PatchFile[]) : [],
      };

      return result;
    } catch (err) {
      if (err instanceof AiOutputTruncatedError) {
        truncated = true;
        continue;
      }
      throw err;
    }
  }

  if (truncated) {
    throw new GitHubPRValidationError(
      'AI output was too large to create a safe pull request. No pull request was created. Rerun triage or retry after narrowing the report to the smallest reproducible issue.',
      422,
      'ai_output_truncated'
    );
  }

  throw new GitHubPRValidationError('AI could not generate a safe pull request payload. No pull request was created.');
}

function safeBranchName(branch: string): string {
  const normalized = branch.trim().replace(/^refs\/heads\//, '').replace(/[^A-Za-z0-9._/-]+/g, '-');
  const branchName = normalized.startsWith('fix/') ? normalized : `fix/${normalized || 'annotate-triage'}`;
  if (
    branchName.includes('..') ||
    branchName.startsWith('/') ||
    branchName.endsWith('/') ||
    branchName.length > 120
  ) {
    return `fix/annotate-triage-${Date.now()}`;
  }
  return branchName;
}

function uniqueBranchName(branch: string): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const maxBaseLength = 120 - suffix.length - 1;
  const trimmed = branch.length > maxBaseLength ? branch.slice(0, maxBaseLength).replace(/[/.-]+$/, '') : branch;
  return `${trimmed}-${suffix}`;
}

function safeRepoPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('..') ||
    normalized.includes('\0') ||
    normalized.length > 240
  ) {
    return null;
  }
  return normalized;
}

function isReservedGeneratedPath(path: string): boolean {
  return path === '.annotate' || path.startsWith('.annotate/');
}

function isIgnoredRepoPath(path: string): boolean {
  return /(^|\/)(node_modules|dist|build|coverage|\.next|\.git|vendor)\//.test(path);
}

function isLikelyTextRepoPath(path: string): boolean {
  if (isIgnoredRepoPath(path)) return false;
  return /\.(tsx?|jsx?|mjs|cjs|html?|css|scss|json|ya?ml|toml|md|mdx|txt|xml|svg)$/i.test(path);
}

function repoContextPriority(path: string, suspectedFiles: string[]): number {
  const exactSuspects = new Set(suspectedFiles.map((file) => safeRepoPath(file)).filter(Boolean));
  const basenames = new Set(
    [...exactSuspects].map((file) => String(file).split('/').at(-1)).filter(Boolean)
  );
  if (exactSuspects.has(path)) return 1000;
  if (basenames.has(path.split('/').at(-1))) return 800;

  const entrypoints = [
    'public/index.html',
    'index.html',
    'public/annotate-loader.js',
    'annotate-loader.js',
    'src/App.tsx',
    'src/App.jsx',
    'src/main.tsx',
    'src/main.jsx',
    'src/index.tsx',
    'src/index.jsx',
    'app/layout.tsx',
    'pages/_app.tsx',
    'package.json',
  ];
  const entryIndex = entrypoints.indexOf(path);
  if (entryIndex >= 0) return 700 - entryIndex;
  if (/\/(App|main|index)\.(tsx?|jsx?|html?)$/i.test(path)) return 500;
  if (/annotate|widget|analytics|tracking/i.test(path)) return 450;
  if (path.startsWith('public/') && /\.(html?|js|css)$/i.test(path)) return 300;
  return 0;
}

async function fetchExistingRepoFile(params: {
  base: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  path: string;
  ref: string;
}): Promise<ExistingRepoFile | null> {
  const { base, owner, repo, headers, path, ref } = params;
  const res = await fetch(
    `${base}/repos/${owner}/${repo}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(ref)}`,
    { headers }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub file fetch failed for ${path}: ${res.status}`);
  const body = await res.json() as GitHubContentFile | GitHubContentFile[];
  if (Array.isArray(body) || (body.type && body.type !== 'file') || !body.content) return null;
  if (body.encoding && body.encoding !== 'base64') {
    throw new GitHubPRValidationError(`Cannot safely patch ${path}: unsupported GitHub content encoding ${body.encoding}.`);
  }
  return {
    path,
    sha: body.sha,
    content: Buffer.from(normalizeBase64(body.content), 'base64').toString('utf8'),
  };
}

export async function getGitHubEditableContext(params: {
  repoUrl: string;
  token: string;
  suspectedFiles?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
}): Promise<RepoFileContext[]> {
  const { repoUrl, token, suspectedFiles = [], maxFiles = PR_CONTEXT_MAX_FILES, maxFileBytes = PR_CONTEXT_MAX_FILE_BYTES } = params;
  const { owner, repo } = parseGitHubRepo(repoUrl);
  const headers = githubHeaders(token);
  const base = 'https://api.github.com';

  const repoRes = await fetch(`${base}/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub repo fetch failed: ${repoRes.status}`);
  const repoData = await repoRes.json() as GitHubRepo;
  const defaultBranch = repoData.default_branch;

  const refRes = await fetch(`${base}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { headers });
  if (!refRes.ok) throw new Error(`GitHub ref fetch failed: ${refRes.status}`);
  const refData = await refRes.json() as GitHubRef;

  const commitRes = await fetch(`${base}/repos/${owner}/${repo}/git/commits/${refData.object.sha}`, { headers });
  if (!commitRes.ok) throw new Error(`GitHub commit fetch failed: ${commitRes.status}`);
  const commitData = await commitRes.json() as GitHubCommit;

  const treeRes = await fetch(`${base}/repos/${owner}/${repo}/git/trees/${commitData.tree.sha}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`GitHub tree fetch failed: ${treeRes.status}`);
  const treeData = await treeRes.json() as GitHubTree;

  const candidates = treeData.tree
    .filter((item) => item.type === 'blob' && item.path && isLikelyTextRepoPath(item.path) && !isReservedGeneratedPath(item.path))
    .filter((item) => (item.size ?? 0) <= maxFileBytes)
    .map((item) => ({ path: item.path, score: repoContextPriority(item.path, suspectedFiles) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles);

  const files: RepoFileContext[] = [];
  for (const candidate of candidates) {
    const file = await fetchExistingRepoFile({ base, owner, repo, headers, path: candidate.path, ref: defaultBranch });
    if (file) files.push({ path: file.path, content: file.content });
  }
  return files;
}

async function validateDirectFilePatches(params: {
  base: string;
  owner: string;
  repo: string;
  headers: Record<string, string>;
  defaultBranch: string;
  files: PatchFile[];
}): Promise<ExistingRepoFile[]> {
  const { base, owner, repo, headers, defaultBranch, files } = params;
  if (files.length === 0) {
    throw new GitHubPRValidationError(
      'No verified source-file patch was produced. Annotate opens fix PRs only after Auto-Fix inspects the connected repository and verifies real file changes.',
      422,
      'no_generated_changes'
    );
  }

  const normalizedPaths = files.map((file) => safeRepoPath(file.path));
  if (normalizedPaths.some((path) => path === null)) {
    throw new GitHubPRValidationError('AI produced an unsafe file path. No pull request was created.');
  }
  const paths = normalizedPaths as string[];
  const duplicate = paths.find((path, index) => paths.indexOf(path) !== index);
  if (duplicate) {
    throw new GitHubPRValidationError(`AI produced duplicate changes for ${duplicate}. No pull request was created.`);
  }
  const reserved = paths.find(isReservedGeneratedPath);
  if (reserved) {
    throw new GitHubPRValidationError(`AI attempted to create an Annotate metadata file (${reserved}) instead of editing application code. No pull request was created.`);
  }

  const existingFiles: ExistingRepoFile[] = [];
  for (const path of paths) {
    const existing = await fetchExistingRepoFile({ base, owner, repo, headers, path, ref: defaultBranch });
    if (!existing) {
      throw new GitHubPRValidationError(`AI targeted ${path}, but that file does not exist in the connected repository. No pull request was created.`);
    }
    existingFiles.push(existing);
  }

  const changedFiles = existingFiles.filter((existing, index) => files[index].content !== existing.content);
  if (changedFiles.length === 0) {
    throw new GitHubPRValidationError('AI produced a no-op patch. No pull request was created.');
  }

  return existingFiles;
}

/**
 * createGitHubPR — uses the GitHub REST API to create a branch, commit files, and open a PR.
 */
export async function createGitHubPR(params: {
  repoUrl: string;
  token: string;
  payload: PRPayload;
  draft?: boolean;
  writeMode?: GitHubPRWriteMode;
}): Promise<GitHubPRResult> {
  const { repoUrl, token, payload, draft = false } = params;
  const branch = uniqueBranchName(safeBranchName(payload.branch));
  const committedFiles: string[] = [];

  if (!aiPrFileWritesEnabled()) {
    throw new GitHubPRValidationError(
      'AI PR file writes are disabled on this server. No pull request was created.',
      409,
      'file_writes_disabled'
    );
  }

  const { owner, repo } = parseGitHubRepo(repoUrl);
  const headers = githubHeaders(token);
  const base = 'https://api.github.com';
  let branchCreated = false;

  async function cleanupBranchAfterFailure(): Promise<void> {
    if (!branchCreated) return;
    try {
      await fetch(`${base}/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: 'DELETE',
        headers,
      });
    } catch {
      // Best-effort cleanup only. The caller receives the original GitHub failure below.
    }
  }

  // 1. Get default branch SHA
  const repoRes = await fetch(`${base}/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub repo fetch failed: ${repoRes.status}`);
  const repoData = await repoRes.json() as GitHubRepo;
  const defaultBranch = repoData.default_branch;

  const refRes = await fetch(`${base}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, { headers });
  if (!refRes.ok) throw new Error(`GitHub ref fetch failed: ${refRes.status}`);
  const refData = await refRes.json() as GitHubRef;
  const baseSha = refData.object.sha;
  const existingFiles = await validateDirectFilePatches({
    base,
    owner,
    repo,
    headers,
    defaultBranch,
    files: payload.files,
  });
  const existingByPath = new Map(existingFiles.map((file) => [file.path, file]));

  // 2. Create branch
  const branchRes = await fetch(`${base}/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!branchRes.ok) {
    throw new Error(`GitHub branch creation failed: ${branchRes.status}`);
  }
  branchCreated = true;

  try {
    // 3. Commit each file
    for (const file of payload.files) {
      const safePath = safeRepoPath(file.path);
      if (!safePath) throw new Error(`Unsafe generated file path: ${file.path}`);
      const existingFile = existingByPath.get(safePath);
      if (!existingFile) throw new GitHubPRValidationError(`AI targeted ${safePath}, but that file does not exist in the connected repository. No pull request was created.`);
      if (file.content === existingFile.content) continue;

      const commitBody: Record<string, unknown> = {
        message: `fix: ${file.explanation}`,
        content: Buffer.from(file.content).toString('base64'),
        branch,
        sha: existingFile.sha,
      };

      const commitRes = await fetch(`${base}/repos/${owner}/${repo}/contents/${encodeContentPath(safePath)}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(commitBody),
      });
      if (!commitRes.ok) {
        const err = await commitRes.text();
        throw new Error(`GitHub file commit failed for ${safePath}: ${commitRes.status} ${err}`);
      }
      committedFiles.push(safePath);
    }

    // 4. Open PR
    const prRes = await fetch(`${base}/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        head: branch,
        base: defaultBranch,
        draft,
      }),
    });
    if (!prRes.ok) {
      const err = await prRes.text();
      throw new Error(`GitHub PR creation failed: ${prRes.status} ${err}`);
    }
    const prData = await prRes.json() as { html_url: string };
    return {
      pr_url: prData.html_url,
      branch,
      files: committedFiles,
      write_mode: 'direct_files',
    };
  } catch (err) {
    await cleanupBranchAfterFailure();
    throw err;
  }
}

/**
 * createGitHubIssue — opens a GitHub Issue from a report without requiring AI triage.
 */
export async function createGitHubIssue(params: {
  repoUrl: string;
  token: string;
  title: string;
  body: string;
  labels?: string[];
}): Promise<string> {
  const { repoUrl, token, title, body, labels } = params;
  const { owner, repo } = parseGitHubRepo(repoUrl);

  const issueRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({ title, body, labels }),
  });

  if (!issueRes.ok) {
    const err = await issueRes.text();
    throw new Error(`GitHub issue creation failed: ${issueRes.status} ${err}`);
  }

  const issueData = await issueRes.json() as { html_url: string };
  return issueData.html_url;
}

export async function createGitHubIssueComment(params: {
  issueUrl: string;
  token: string;
  body: string;
}): Promise<string> {
  const match = params.issueUrl.trim().match(/github\.com\/([^/\s]+)\/([^/\s#?]+)\/issues\/(\d+)/i);
  if (!match) throw new Error(`Cannot parse GitHub issue URL: ${params.issueUrl}`);
  const [, owner, rawRepo, issueNumber] = match;
  const repo = rawRepo.replace(/\.git$/i, '');
  const safeSegment = /^[A-Za-z0-9_.-]+$/;
  if (!safeSegment.test(owner) || !safeSegment.test(repo)) {
    throw new Error(`Invalid GitHub issue URL: ${params.issueUrl}`);
  }

  const commentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    headers: githubHeaders(params.token),
    body: JSON.stringify({ body: params.body }),
  });

  if (!commentRes.ok) {
    const err = await commentRes.text();
    throw new Error(`GitHub issue comment failed: ${commentRes.status} ${err}`);
  }

  const commentData = await commentRes.json() as { html_url: string };
  return commentData.html_url;
}

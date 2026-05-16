import type { PersonBPipelineResult } from './person_b_pipeline.js';

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

export interface PRGateReport {
  id?: string;
  title?: string;
  description?: string;
  url?: string;
  route?: string;
}

export type CreatePRFunction = (params: {
  repoUrl: string;
  token: string;
  payload: PRPayload;
}) => Promise<GitHubPRResult>;

export interface OpenVerifiedPROptions {
  pipeline: PersonBPipelineResult;
  report: PRGateReport;
  repoUrl: string;
  token: string;
  createPR?: CreatePRFunction;
}

export interface OpenVerifiedPRResult {
  ok: boolean;
  pr: GitHubPRResult | null;
  payload?: PRPayload;
  error?: string;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return normalized || 'verified-fix';
}

function titleFor(report: PRGateReport): string {
  const title = report.title?.trim() || 'verified bug fix';
  const concise = title.length > 58 ? title.slice(0, 55).replace(/\s+\S*$/, '') : title;
  return `fix: ${concise}`;
}

function commandBlock(pipeline: PersonBPipelineResult): string {
  const commands = pipeline.verification?.commands ?? [];
  if (commands.length === 0) return 'No verification commands were recorded.';

  return commands
    .map((command) => {
      const status = command.ok ? 'PASS' : 'FAIL';
      const output = [command.stdout.trim(), command.stderr.trim()].filter(Boolean).join('\n');
      return `- ${status}: \`${command.name}\`${output ? `\n  Output: ${output}` : ''}`;
    })
    .join('\n');
}

function buildPRBody(options: OpenVerifiedPROptions): string {
  const { pipeline, report } = options;
  const topCandidates = pipeline.candidates
    .slice(0, 3)
    .map((candidate, index) => `${index + 1}. ${candidate.path} (${candidate.reasons.slice(0, 2).join('; ')})`)
    .join('\n');

  return `## Bug report
${report.title ?? 'Untitled bug report'}${report.id ? `\n\nBug ID: \`${report.id}\`` : ''}
${report.url ? `\nURL: ${report.url}` : ''}
${report.route ? `\nRoute: ${report.route}` : ''}
${report.description ? `\n\n${report.description}` : ''}

## Root cause
${pipeline.diagnosis.rootCause}

## Evidence
${pipeline.diagnosis.evidence.map((item) => `- ${item}`).join('\n')}

## Candidate files
${topCandidates || 'No ranked candidates recorded.'}

## Files changed
${pipeline.verification?.modifiedFiles.map((file) => `- ${file}`).join('\n') || 'No files changed.'}

## Verification
${commandBlock(pipeline)}

## Residual risk
This PR was opened only after the local Person B verification gate passed. Review the fallback behavior for product copy before merging.`;
}

function buildPayload(options: OpenVerifiedPROptions): PRPayload {
  const { pipeline, report } = options;
  return {
    title: titleFor(report),
    body: buildPRBody(options),
    branch: `fix/${slug(report.title ?? pipeline.diagnosis.targetFiles.join('-'))}`,
    files: pipeline.patch.files.map((file) => ({
      path: file.path,
      content: file.content,
      explanation: pipeline.diagnosis.fixStrategy,
    })),
  };
}

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } {
  const match = repoUrl.trim().match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (!match) throw new Error(`Cannot parse GitHub repo from URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'lite-annotate',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function encodePath(path: string): string {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function uniqueBranch(branch: string): string {
  return `${branch}-${Date.now().toString(36)}`;
}

async function githubJson<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub request failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function createDirectGitHubPR(params: {
  repoUrl: string;
  token: string;
  payload: PRPayload;
}): Promise<GitHubPRResult> {
  const { owner, repo } = parseGitHubRepo(params.repoUrl);
  const headers = githubHeaders(params.token);
  const base = `https://api.github.com/repos/${owner}/${repo}`;

  const repoInfo = await githubJson<{ default_branch: string }>(base, { headers });
  const baseBranch = repoInfo.default_branch;
  const ref = await githubJson<{ object: { sha: string } }>(
    `${base}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    { headers }
  );
  const branch = uniqueBranch(params.payload.branch);

  await githubJson(`${base}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: ref.object.sha }),
  });

  const committedFiles: string[] = [];
  for (const file of params.payload.files) {
    const existing = await githubJson<{ sha: string }>(
      `${base}/contents/${encodePath(file.path)}?ref=${encodeURIComponent(baseBranch)}`,
      { headers }
    );
    await githubJson(`${base}/contents/${encodePath(file.path)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: params.payload.title,
        content: Buffer.from(file.content).toString('base64'),
        sha: existing.sha,
        branch,
      }),
    });
    committedFiles.push(file.path);
  }

  const pr = await githubJson<{ html_url: string }>(`${base}/pulls`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: params.payload.title,
      body: params.payload.body,
      head: branch,
      base: baseBranch,
    }),
  });

  return {
    pr_url: pr.html_url,
    branch,
    files: committedFiles,
    write_mode: 'direct_files',
  };
}

function validatePRGate(pipeline: PersonBPipelineResult): string | null {
  const topThree = new Set(pipeline.candidates.slice(0, 3).map((candidate) => candidate.path));
  const targetInTopThree = pipeline.diagnosis.targetFiles.every((file) => topThree.has(file));
  if (!targetInTopThree) return 'PR gate failed: every target file must be in the top 3 candidates.';

  if (pipeline.diagnosis.confidence < 0.75) {
    return 'PR gate failed: diagnosis confidence is below 0.75.';
  }
  if (pipeline.diagnosis.targetFiles.length > 2) {
    return 'PR gate failed: diagnosis targets more than 2 files.';
  }
  if (!pipeline.patch.ok || pipeline.patch.files.length === 0) {
    return `PR gate failed: patch generation failed${pipeline.patch.error ? ` (${pipeline.patch.error})` : ''}.`;
  }
  const targetFiles = new Set(pipeline.diagnosis.targetFiles);
  const outsideTarget = pipeline.patch.files.find((file) => !targetFiles.has(file.path));
  if (outsideTarget) {
    return `PR gate failed: patch modifies ${outsideTarget.path} outside targetFiles.`;
  }
  if (!pipeline.verification?.ok) {
    return `PR gate failed: verification failed${pipeline.verification?.error ? ` (${pipeline.verification.error})` : ''}.`;
  }
  if (pipeline.verification.commands.length === 0) {
    return 'PR gate failed: no verification checks were recorded.';
  }
  const modified = new Set(pipeline.verification.modifiedFiles);
  const unverifiedPatch = pipeline.patch.files.find((file) => !modified.has(file.path));
  if (unverifiedPatch) {
    return `PR gate failed: ${unverifiedPatch.path} was patched but not verified as modified.`;
  }

  return null;
}

export async function openVerifiedPR(options: OpenVerifiedPROptions): Promise<OpenVerifiedPRResult> {
  const gateError = validatePRGate(options.pipeline);
  if (gateError) return { ok: false, pr: null, error: gateError };

  const payload = buildPayload(options);
  const createPR = options.createPR ?? createDirectGitHubPR;
  const pr = await createPR({
    repoUrl: options.repoUrl,
    token: options.token,
    payload,
  });

  return { ok: true, pr, payload };
}

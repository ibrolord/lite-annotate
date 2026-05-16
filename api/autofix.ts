import { runPersonBPipeline } from './worker/person_b_pipeline.js';
import type { AutofixStageReporter, PersonBPipelineInput, PersonBPipelineResult } from './worker/person_b_pipeline.js';
import { createOpenAICodePatchGeneratorFromEnv } from './worker/patch/model_generate.js';
import type { CodePatchGenerator } from './worker/patch/model_generate.js';
import { openVerifiedPR } from './worker/pr_gate.js';
import type { CreatePRFunction, GitHubPRResult } from './worker/pr_gate.js';

export type AutofixStatus = 'diagnosis_only' | 'verified_no_pr' | 'pr_opened' | 'pr_skipped';

export interface AutofixOptions {
  workspacePath?: string;
  repo?: string;
  workspaceRoot?: string;
  branch?: string;
  allowedRepos?: string[];
  githubToken?: string;
  githubRepo?: string;
  createPR?: CreatePRFunction;
  skipPR?: boolean;
  runPackageScripts?: boolean;
  codePatchGenerator?: CodePatchGenerator;
  onStage?: AutofixStageReporter;
}

export interface AutofixResult {
  status: AutofixStatus;
  pipeline: PersonBPipelineResult;
  pr: GitHubPRResult | null;
  prError?: string;
}

function repoUrl(repo: string): string {
  const trimmed = repo.trim();
  if (/^https?:\/\//i.test(trimmed) || /^git@github\.com:/i.test(trimmed)) return trimmed;
  return `https://github.com/${trimmed.replace(/\.git$/i, '')}`;
}

function normalizeGitHubRepo(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (urlMatch) return `${urlMatch[1]}/${urlMatch[2].replace(/\.git$/i, '')}`.toLowerCase();

  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (shorthandMatch) return `${shorthandMatch[1]}/${shorthandMatch[2].replace(/\.git$/i, '')}`.toLowerCase();

  return null;
}

function envList(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function envOptions(): AutofixOptions {
  const runPackageScripts = process.env.AUTOFIX_RUN_PACKAGE_SCRIPTS;
  return {
    workspacePath: process.env.REPO_PATH,
    repo: process.env.TARGET_REPO || process.env.GITHUB_REPO,
    workspaceRoot: process.env.REPO_WORKSPACE_ROOT,
    branch: process.env.TARGET_REPO_BRANCH,
    allowedRepos: envList('AUTOFIX_ALLOWED_REPOS'),
    githubToken: process.env.GITHUB_TOKEN,
    githubRepo: process.env.GITHUB_REPO,
    runPackageScripts: runPackageScripts === 'true' ? true : runPackageScripts === 'false' ? false : undefined,
  };
}

function reportRepo(report: PersonBPipelineInput['report']): string | undefined {
  return typeof report.repo === 'string' && report.repo.trim() ? report.repo.trim() : undefined;
}

function trustedReportRepo(
  embeddedRepo: string | undefined,
  env: AutofixOptions,
  options: AutofixOptions
): string | undefined {
  if (!embeddedRepo) return undefined;

  const normalized = normalizeGitHubRepo(embeddedRepo);
  const trusted = new Set(
    [
      ...(options.allowedRepos ?? env.allowedRepos ?? []),
      options.repo,
      options.githubRepo,
      env.repo,
      env.githubRepo,
    ]
      .map(normalizeGitHubRepo)
      .filter((value): value is string => Boolean(value))
  );

  if (trusted.size > 0) {
    if (!normalized || !trusted.has(normalized)) {
      throw new Error(`Report repo is not trusted for Auto-Fix PRs: ${embeddedRepo}`);
    }
    return normalized;
  }

  if (options.githubToken ?? env.githubToken) {
    throw new Error('Auto-Fix PRs require AUTOFIX_ALLOWED_REPOS or TARGET_REPO/GITHUB_REPO before trusting report-provided repos.');
  }

  return embeddedRepo;
}

export async function runAutofix(
  bugId: string,
  report: PersonBPipelineInput['report'],
  options: AutofixOptions = {}
): Promise<AutofixResult> {
  const embeddedRepo = reportRepo(report);
  const env = envOptions();
  const trustedEmbeddedRepo = trustedReportRepo(embeddedRepo, env, options);
  const resolvedOptions = {
    ...env,
    ...options,
    workspacePath: options.workspacePath ?? (trustedEmbeddedRepo ? undefined : env.workspacePath),
    repo: options.repo ?? trustedEmbeddedRepo ?? env.repo,
    githubRepo: options.githubRepo ?? trustedEmbeddedRepo ?? env.githubRepo,
  };
  console.log(`[autofix] starting Person B pipeline for bug ${bugId}`);

  const pipeline = await runPersonBPipeline({
    report,
    workspacePath: resolvedOptions.workspacePath,
    repo: resolvedOptions.repo,
    workspaceRoot: resolvedOptions.workspaceRoot,
    branch: resolvedOptions.branch,
    githubToken: resolvedOptions.githubToken,
    smokeCommands: [],
    runPackageScripts: resolvedOptions.runPackageScripts,
    codePatchGenerator: resolvedOptions.codePatchGenerator ?? createOpenAICodePatchGeneratorFromEnv(),
    onStage: resolvedOptions.onStage,
  });

  console.log(
    `[autofix] diagnosis confidence=${pipeline.diagnosis.confidence} targets=${pipeline.diagnosis.targetFiles.join(',') || 'none'}`
  );

  if (!pipeline.verification?.ok) {
    console.log(`[autofix] verification did not pass; skipping PR`);
    await resolvedOptions.onStage?.({
      key: 'verification',
      label: 'Verify patch',
      status: 'failed',
      detail: pipeline.verification?.error ?? 'verification did not pass',
      at: new Date().toISOString(),
    });
    return { status: 'diagnosis_only', pipeline, pr: null };
  }

  if (resolvedOptions.skipPR) {
    console.log('[autofix] verified locally; dry run requested, skipping PR');
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'skipped',
      detail: 'Preview mode requested; PR creation suppressed.',
      at: new Date().toISOString(),
    });
    return { status: 'verified_no_pr', pipeline, pr: null };
  }

  const githubRepo = resolvedOptions.githubRepo || resolvedOptions.repo;
  if (!resolvedOptions.githubToken || !githubRepo) {
    console.log('[autofix] verified locally; no GitHub credentials configured, skipping PR');
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'skipped',
      detail: 'GitHub credentials or repository are not configured.',
      at: new Date().toISOString(),
    });
    return { status: 'verified_no_pr', pipeline, pr: null };
  }

  await resolvedOptions.onStage?.({
    key: 'pr',
    label: 'PR gate',
    status: 'running',
    detail: githubRepo,
    at: new Date().toISOString(),
  });
  const prResult = await openVerifiedPR({
    pipeline,
    report: {
      id: bugId,
      title: typeof report.title === 'string' ? report.title : undefined,
      description: typeof report.description === 'string' ? report.description : undefined,
      url: typeof report.url === 'string' ? report.url : undefined,
      route: typeof report.route === 'string' ? report.route : undefined,
    },
    repoUrl: repoUrl(githubRepo),
    token: resolvedOptions.githubToken,
    baseBranch: resolvedOptions.branch,
    createPR: resolvedOptions.createPR,
  });

  if (!prResult.ok) {
    console.log(`[autofix] PR gate skipped: ${prResult.error}`);
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'skipped',
      detail: prResult.error,
      at: new Date().toISOString(),
    });
    return { status: 'pr_skipped', pipeline, pr: null, prError: prResult.error };
  }

  console.log(`[autofix] PR opened: ${prResult.pr?.pr_url}`);
  await resolvedOptions.onStage?.({
    key: 'pr',
    label: 'PR gate',
    status: 'completed',
    detail: prResult.pr?.pr_url,
    at: new Date().toISOString(),
  });
  return { status: 'pr_opened', pipeline, pr: prResult.pr };
}

export async function triggerAutofix(bugId: string, report: PersonBPipelineInput['report']): Promise<AutofixResult> {
  return runAutofix(bugId, report);
}

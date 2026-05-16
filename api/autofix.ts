import { runPersonBPipeline } from './worker/person_b_pipeline.ts';
import type { PersonBPipelineInput, PersonBPipelineResult } from './worker/person_b_pipeline.ts';
import { openVerifiedPR } from './worker/pr_gate.ts';
import type { CreatePRFunction, GitHubPRResult } from './worker/pr_gate.ts';

export type AutofixStatus = 'diagnosis_only' | 'verified_no_pr' | 'pr_opened' | 'pr_skipped';

export interface AutofixOptions {
  workspacePath?: string;
  repo?: string;
  workspaceRoot?: string;
  branch?: string;
  githubToken?: string;
  githubRepo?: string;
  createPR?: CreatePRFunction;
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

function defaultSmokeCommands(): PersonBPipelineInput['smokeCommands'] {
  return [
    {
      command: process.execPath,
      args: [
        '-e',
        "const { formatUserGreeting } = require('./src/users.js'); console.log(formatUserGreeting(999))",
      ],
    },
  ];
}

function envOptions(): AutofixOptions {
  return {
    workspacePath: process.env.REPO_PATH,
    repo: process.env.TARGET_REPO || process.env.GITHUB_REPO,
    workspaceRoot: process.env.REPO_WORKSPACE_ROOT,
    branch: process.env.TARGET_REPO_BRANCH,
    githubToken: process.env.GITHUB_TOKEN,
    githubRepo: process.env.GITHUB_REPO,
  };
}

export async function runAutofix(
  bugId: string,
  report: PersonBPipelineInput['report'],
  options: AutofixOptions = envOptions()
): Promise<AutofixResult> {
  console.log(`[autofix] starting Person B pipeline for bug ${bugId}`);

  const pipeline = runPersonBPipeline({
    report,
    workspacePath: options.workspacePath,
    repo: options.repo,
    workspaceRoot: options.workspaceRoot,
    branch: options.branch,
    smokeCommands: defaultSmokeCommands(),
  });

  console.log(
    `[autofix] diagnosis confidence=${pipeline.diagnosis.confidence} targets=${pipeline.diagnosis.targetFiles.join(',') || 'none'}`
  );

  if (!pipeline.verification?.ok) {
    console.log(`[autofix] verification did not pass; skipping PR`);
    return { status: 'diagnosis_only', pipeline, pr: null };
  }

  const githubRepo = options.githubRepo || options.repo;
  if (!options.githubToken || !githubRepo) {
    console.log('[autofix] verified locally; no GitHub credentials configured, skipping PR');
    return { status: 'verified_no_pr', pipeline, pr: null };
  }

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
    token: options.githubToken,
    createPR: options.createPR,
  });

  if (!prResult.ok) {
    console.log(`[autofix] PR gate skipped: ${prResult.error}`);
    return { status: 'pr_skipped', pipeline, pr: null, prError: prResult.error };
  }

  console.log(`[autofix] PR opened: ${prResult.pr?.pr_url}`);
  return { status: 'pr_opened', pipeline, pr: prResult.pr };
}

export async function triggerAutofix(bugId: string, report: PersonBPipelineInput['report']): Promise<AutofixResult> {
  return runAutofix(bugId, report);
}

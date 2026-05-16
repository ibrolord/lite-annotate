import { runPersonBPipeline } from './worker/person_b_pipeline.js';
import type { PersonBPipelineInput, PersonBPipelineResult } from './worker/person_b_pipeline.js';
import { openVerifiedPR } from './worker/pr_gate.js';
import type { CreatePRFunction, GitHubPRResult } from './worker/pr_gate.js';

export type AutofixStatus = 'diagnosis_only' | 'verified_no_pr' | 'pr_opened' | 'pr_skipped';

export interface AutofixOptions {
  workspacePath?: string;
  repo?: string;
  workspaceRoot?: string;
  branch?: string;
  githubToken?: string;
  githubRepo?: string;
  createPR?: CreatePRFunction;
  skipPR?: boolean;
  runPackageScripts?: boolean;
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

function reportText(report: PersonBPipelineInput['report']): string {
  const consoleText = [...(report.console ?? []), ...(report.consoleLogs ?? [])]
    .map((entry) => `${entry.level ?? ''} ${entry.message ?? entry.msg ?? ''}`)
    .join('\n');
  const networkText = (report.network ?? [])
    .map((entry) => `${entry.method ?? ''} ${entry.url ?? ''} ${entry.status ?? ''}`)
    .join('\n');
  return [report.title, report.description, report.url, report.route, consoleText, networkText].join('\n');
}

function defaultSmokeCommands(report: PersonBPipelineInput['report']): PersonBPipelineInput['smokeCommands'] {
  const text = reportText(report);
  if (/loyalty|customer|formatLoyaltyGreeting|vip-404/i.test(text)) {
    return [
      {
        command: process.execPath,
        args: [
          '--input-type=module',
          '-e',
          [
            "import { formatLoyaltyGreeting } from './src/customer.js';",
            "const result = formatLoyaltyGreeting('vip-404');",
            "if (!/not found|unavailable|missing/i.test(result)) throw new Error(`Unexpected fallback: ${result}`);",
            'console.log(result);',
          ].join(' '),
        ],
      },
    ];
  }

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
    runPackageScripts: process.env.AUTOFIX_RUN_PACKAGE_SCRIPTS === 'false' ? false : undefined,
  };
}

function reportRepo(report: PersonBPipelineInput['report']): string | undefined {
  return typeof report.repo === 'string' && report.repo.trim() ? report.repo.trim() : undefined;
}

export async function runAutofix(
  bugId: string,
  report: PersonBPipelineInput['report'],
  options: AutofixOptions = {}
): Promise<AutofixResult> {
  const embeddedRepo = reportRepo(report);
  const env = envOptions();
  const resolvedOptions = {
    ...env,
    ...options,
    workspacePath: options.workspacePath ?? (embeddedRepo ? undefined : env.workspacePath),
    repo: options.repo ?? embeddedRepo ?? env.repo,
    githubRepo: options.githubRepo ?? embeddedRepo ?? env.githubRepo,
  };
  console.log(`[autofix] starting Person B pipeline for bug ${bugId}`);

  const pipeline = await runPersonBPipeline({
    report,
    workspacePath: resolvedOptions.workspacePath,
    repo: resolvedOptions.repo,
    workspaceRoot: resolvedOptions.workspaceRoot,
    branch: resolvedOptions.branch,
    githubToken: resolvedOptions.githubToken,
    smokeCommands: defaultSmokeCommands(report),
    runPackageScripts: resolvedOptions.runPackageScripts,
  });

  console.log(
    `[autofix] diagnosis confidence=${pipeline.diagnosis.confidence} targets=${pipeline.diagnosis.targetFiles.join(',') || 'none'}`
  );

  if (!pipeline.verification?.ok) {
    console.log(`[autofix] verification did not pass; skipping PR`);
    return { status: 'diagnosis_only', pipeline, pr: null };
  }

  if (resolvedOptions.skipPR) {
    console.log('[autofix] verified locally; dry run requested, skipping PR');
    return { status: 'verified_no_pr', pipeline, pr: null };
  }

  const githubRepo = resolvedOptions.githubRepo || resolvedOptions.repo;
  if (!resolvedOptions.githubToken || !githubRepo) {
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
    token: resolvedOptions.githubToken,
    createPR: resolvedOptions.createPR,
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

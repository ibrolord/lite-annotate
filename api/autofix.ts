import { runPersonBPipeline } from './worker/person_b_pipeline.js';
import type { AutofixStageReporter, PersonBPipelineInput, PersonBPipelineResult } from './worker/person_b_pipeline.js';
import { createOpenAICodePatchGeneratorFromEnv } from './worker/patch/model_generate.js';
import type { CodePatchGenerator } from './worker/patch/model_generate.js';
import { verifyStructuredPatch } from './worker/patch/verification.js';
import { openVerifiedPR } from './worker/pr_gate.js';
import type { CreatePRFunction, GitHubPRResult, OpenVerifiedPRResult } from './worker/pr_gate.js';
import { externalBlockerArtifact, fallbackPatchabilityArtifact } from './worker/patchability.js';

export type AutofixStatus = 'diagnosis_only' | 'verified_no_pr' | 'pr_opened' | 'pr_skipped' | 'external_blocker';

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
  customInstructions?: string;
  onStage?: AutofixStageReporter;
}

export interface AutofixResult {
  status: AutofixStatus;
  pipeline: PersonBPipelineResult;
  artifact: PersonBPipelineResult['artifact'];
  pr: GitHubPRResult | null;
  prError?: string;
}

function externalBlockerPipeline(message: string): PersonBPipelineResult {
  return {
    workspacePath: '',
    index: { root: '', files: [], packageScripts: {} },
    candidates: [],
    diagnosis: {
      type: 'bug',
      severity: 'low',
      rootCause: message,
      evidence: [message],
      targetFiles: [],
      fixStrategy: 'Resolve the external blocker before running repository patch generation.',
      confidence: 0,
      shouldPatch: false,
    },
    patch: {
      ok: false,
      files: [],
      error: message,
      artifactType: 'external_blocker',
    },
    verification: null,
    artifact: externalBlockerArtifact(message),
  };
}

function artifactMetadata(pipeline: PersonBPipelineResult, prUrl?: string): Record<string, unknown> {
  return {
    type: pipeline.artifact.type,
    report_class: pipeline.artifact.reportClass,
    reason: pipeline.artifact.reason,
    target_files: pipeline.artifact.targetFiles,
    modified_files: pipeline.verification?.modifiedFiles ?? [],
    verification_ok: pipeline.verification?.ok ?? false,
    pr_url: prUrl,
  };
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

function pipelineForModifiedPrFiles(pipeline: PersonBPipelineResult): {
  pipeline: PersonBPipelineResult;
  skippedFiles: string[];
} {
  if (!pipeline.patch.ok || !pipeline.verification?.ok) return { pipeline, skippedFiles: [] };

  const modifiedFiles = new Set(pipeline.verification.modifiedFiles);
  const prFiles = pipeline.patch.files.filter((file) => modifiedFiles.has(file.path));
  const skippedFiles = pipeline.patch.files
    .map((file) => file.path)
    .filter((path) => !modifiedFiles.has(path));

  if (skippedFiles.length === 0) return { pipeline, skippedFiles };
  return {
    pipeline: {
      ...pipeline,
      diagnosis: {
        ...pipeline.diagnosis,
        targetFiles: pipeline.diagnosis.targetFiles.filter((file) => modifiedFiles.has(file)),
      },
      patch: {
        ...pipeline.patch,
        files: prFiles,
      },
      artifact: {
        ...pipeline.artifact,
        targetFiles: pipeline.artifact.targetFiles.filter((file) => modifiedFiles.has(file)),
      },
    },
    skippedFiles,
  };
}

function pipelineForFallbackArtifact(
  pipeline: PersonBPipelineResult,
  report: PersonBPipelineInput['report'],
  previousPatchError: string
): PersonBPipelineResult {
  const fallback = fallbackPatchabilityArtifact({
    report,
    diagnosis: pipeline.diagnosis,
    candidates: pipeline.candidates,
    previousPatchError,
  });
  return {
    ...pipeline,
    diagnosis: fallback.diagnosis,
    patch: fallback.patch,
    verification: verifyStructuredPatch({
      workspacePath: pipeline.workspacePath,
      targetFiles: fallback.diagnosis.targetFiles,
      files: fallback.patch.files,
      smokeCommands: [],
      runPackageScripts: false,
    }),
    artifact: fallback.artifact,
  };
}

export async function runAutofix(
  bugId: string,
  report: PersonBPipelineInput['report'],
  options: AutofixOptions = {}
): Promise<AutofixResult> {
  const embeddedRepo = reportRepo(report);
  const env = envOptions();
  let trustedEmbeddedRepo: string | undefined;
  try {
    trustedEmbeddedRepo = trustedReportRepo(embeddedRepo, env, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.onStage?.({
      key: 'request',
      label: 'Request received',
      status: 'failed',
      detail: message,
      at: new Date().toISOString(),
    });
    const pipeline = externalBlockerPipeline(message);
    return { status: 'external_blocker', pipeline, artifact: pipeline.artifact, pr: null, prError: message };
  }
  const resolvedOptions = {
    ...env,
    ...options,
    workspacePath: options.workspacePath ?? (trustedEmbeddedRepo ? undefined : env.workspacePath),
    repo: options.repo ?? trustedEmbeddedRepo ?? env.repo,
    githubRepo: options.githubRepo ?? trustedEmbeddedRepo ?? env.githubRepo,
  };
  console.log(`[autofix] starting Person B pipeline for bug ${bugId}`);

  let pipeline: PersonBPipelineResult;
  try {
    pipeline = await runPersonBPipeline({
      report,
      workspacePath: resolvedOptions.workspacePath,
      repo: resolvedOptions.repo,
      workspaceRoot: resolvedOptions.workspaceRoot,
      branch: resolvedOptions.branch,
      githubToken: resolvedOptions.githubToken,
      smokeCommands: [],
      runPackageScripts: resolvedOptions.runPackageScripts,
      codePatchGenerator: resolvedOptions.codePatchGenerator ?? createOpenAICodePatchGeneratorFromEnv(),
      customInstructions: resolvedOptions.customInstructions,
      onStage: resolvedOptions.onStage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await resolvedOptions.onStage?.({
      key: 'workspace',
      label: 'Load repository',
      status: 'failed',
      detail: message,
      at: new Date().toISOString(),
    });
    const blockerPipeline = externalBlockerPipeline(message);
    return { status: 'external_blocker', pipeline: blockerPipeline, artifact: blockerPipeline.artifact, pr: null, prError: message };
  }

  console.log(
    `[autofix] diagnosis confidence=${pipeline.diagnosis.confidence} targets=${pipeline.diagnosis.targetFiles.join(',') || 'none'}`
  );

  if (!pipeline.verification?.ok) {
    console.log(`[autofix] verification did not pass; skipping PR`);
    const message = pipeline.verification?.error ?? 'verification did not pass';
    await resolvedOptions.onStage?.({
      key: 'verification',
      label: 'Verify patch',
      status: 'failed',
      detail: message,
      at: new Date().toISOString(),
    });
    return { status: 'external_blocker', pipeline, artifact: pipeline.artifact, pr: null, prError: message };
  }

  if (pipeline.verification.modifiedFiles.length === 0) {
    const message = 'No repository changes were produced; the target may already match the requested fix.';
    if (resolvedOptions.skipPR) {
      console.log('[autofix] verified locally; no repository changes produced, skipping PR');
      await resolvedOptions.onStage?.({
        key: 'pr',
        label: 'PR gate',
        status: 'skipped',
        detail: message,
        at: new Date().toISOString(),
      });
      return { status: 'verified_no_pr', pipeline, artifact: pipeline.artifact, pr: null };
    }

    console.log('[autofix] verified locally with no repository changes; generating fallback artifact for PR');
    pipeline = pipelineForFallbackArtifact(pipeline, report, message);
    await resolvedOptions.onStage?.({
      key: 'patch',
      label: 'Generate fallback artifact',
      status: pipeline.verification?.ok ? 'completed' : 'failed',
      detail: pipeline.patch.files.map((file) => file.path).join(', ') || pipeline.verification?.error,
      logs: [
        `artifact type: ${pipeline.artifact.type}`,
        `previous patch result: ${message}`,
        `files: ${pipeline.patch.files.map((file) => file.path).join(', ') || 'none'}`,
      ],
      at: new Date().toISOString(),
    });
    if (!pipeline.verification?.ok) {
      const error = pipeline.verification?.error ?? 'fallback artifact verification did not pass';
      return { status: 'external_blocker', pipeline, artifact: pipeline.artifact, pr: null, prError: error };
    }
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
    return { status: 'verified_no_pr', pipeline, artifact: pipeline.artifact, pr: null };
  }

  const githubRepo = resolvedOptions.githubRepo || resolvedOptions.repo;
  if (!resolvedOptions.githubToken || !githubRepo) {
    console.log('[autofix] verified locally; no GitHub credentials configured, skipping PR');
    const message = 'GitHub credentials or repository are not configured for PR creation.';
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'failed',
      detail: message,
      at: new Date().toISOString(),
    });
    return { status: 'external_blocker', pipeline, artifact: pipeline.artifact, pr: null, prError: message };
  }

  await resolvedOptions.onStage?.({
    key: 'pr',
    label: 'PR gate',
    status: 'running',
    detail: githubRepo,
    logs: [
      `verified modified files: ${pipeline.verification.modifiedFiles.join(', ') || 'none'}`,
      `patch files: ${pipeline.patch.files.map((file) => file.path).join(', ') || 'none'}`,
    ],
    at: new Date().toISOString(),
  });
  const { pipeline: prPipeline, skippedFiles } = pipelineForModifiedPrFiles(pipeline);
  if (skippedFiles.length > 0) {
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'running',
      detail: githubRepo,
      logs: [
        `verified modified files: ${pipeline.verification.modifiedFiles.join(', ') || 'none'}`,
        `patch files: ${pipeline.patch.files.map((file) => file.path).join(', ') || 'none'}`,
        `skipping no-op patch files: ${skippedFiles.join(', ')}`,
      ],
      at: new Date().toISOString(),
    });
  }
  let prResult: OpenVerifiedPRResult;
  try {
    prResult = await openVerifiedPR({
      pipeline: prPipeline,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'failed',
      detail: message,
      logs: [
        `verified modified files: ${pipeline.verification.modifiedFiles.join(', ') || 'none'}`,
        `patch files: ${pipeline.patch.files.map((file) => file.path).join(', ') || 'none'}`,
        ...(skippedFiles.length ? [`skipped no-op patch files: ${skippedFiles.join(', ')}`] : []),
        message,
      ],
      at: new Date().toISOString(),
    });
    return { status: 'external_blocker', pipeline: prPipeline, artifact: prPipeline.artifact, pr: null, prError: message };
  }

  if (!prResult.ok) {
    console.log(`[autofix] PR gate skipped: ${prResult.error}`);
    const message = prResult.error ?? 'PR gate skipped.';
    await resolvedOptions.onStage?.({
      key: 'pr',
      label: 'PR gate',
      status: 'failed',
      detail: message,
      logs: [
        `verified modified files: ${pipeline.verification.modifiedFiles.join(', ') || 'none'}`,
        `patch files: ${pipeline.patch.files.map((file) => file.path).join(', ') || 'none'}`,
        ...(skippedFiles.length ? [`skipped no-op patch files: ${skippedFiles.join(', ')}`] : []),
        message,
      ],
      at: new Date().toISOString(),
    });
    return { status: 'external_blocker', pipeline: prPipeline, artifact: prPipeline.artifact, pr: null, prError: message };
  }

  console.log(`[autofix] PR opened: ${prResult.pr?.pr_url}`);
  await resolvedOptions.onStage?.({
    key: 'pr',
    label: 'PR gate',
    status: 'completed',
    detail: prResult.pr?.pr_url,
    logs: [
      `verified modified files: ${pipeline.verification.modifiedFiles.join(', ') || 'none'}`,
      `patch files: ${pipeline.patch.files.map((file) => file.path).join(', ') || 'none'}`,
      ...(skippedFiles.length ? [`skipped no-op patch files: ${skippedFiles.join(', ')}`] : []),
      `opened PR: ${prResult.pr?.pr_url ?? 'unknown'}`,
    ],
    at: new Date().toISOString(),
  });
  const pr = prResult.pr ? { ...prResult.pr, artifact_metadata: artifactMetadata(prPipeline, prResult.pr.pr_url) } : null;
  return { status: 'pr_opened', pipeline, artifact: prPipeline.artifact, pr };
}

export async function triggerAutofix(bugId: string, report: PersonBPipelineInput['report']): Promise<AutofixResult> {
  return runAutofix(bugId, report);
}

import { buildCodeIndex, rankCandidateFiles } from '../indexing/code_index.js';
import type { CodeIndex, RankedCandidateFile, ReportLike } from '../indexing/code_index.js';
import { ensureRepoWorkspace } from '../repo/workspace.js';
import { diagnoseReport } from './diagnosis/diagnosis.js';
import type { Diagnosis } from './diagnosis/diagnosis.js';
import { generatePatchFromDiagnosis } from './patch/generate.js';
import type { GeneratedPatch } from './patch/generate.js';
import type { CodePatchGenerator } from './patch/model_generate.js';
import { verifyStructuredPatch } from './patch/verification.js';
import type { PatchVerificationResult, VerificationCommandInput } from './patch/verification.js';
import { fallbackPatchabilityArtifact, fixArtifact } from './patchability.js';
import type { PatchabilityArtifact } from './patchability.js';

export type AutofixStageKey =
  | 'request'
  | 'workspace'
  | 'index'
  | 'ranking'
  | 'diagnosis'
  | 'patch'
  | 'verification'
  | 'memory'
  | 'pr';
export type AutofixStageStatus = 'pending' | 'running' | 'completed' | 'skipped' | 'failed';

export interface AutofixStageEvent {
  key: AutofixStageKey;
  label: string;
  status: AutofixStageStatus;
  detail?: string;
  logs?: string[];
  at: string;
}

export type AutofixStageReporter = (event: AutofixStageEvent) => void | Promise<void>;

export interface PersonBPipelineInput {
  report: ReportLike;
  workspacePath?: string;
  repo?: string;
  workspaceRoot?: string;
  branch?: string;
  githubToken?: string;
  smokeCommands?: VerificationCommandInput[];
  runPackageScripts?: boolean;
  codePatchGenerator?: CodePatchGenerator;
  customInstructions?: string;
  repoWideModelSelection?: boolean;
  onStage?: AutofixStageReporter;
}

export interface PersonBPipelineResult {
  workspacePath: string;
  index: CodeIndex;
  candidates: RankedCandidateFile[];
  diagnosis: Diagnosis;
  patch: GeneratedPatch;
  verification: PatchVerificationResult | null;
  artifact: PatchabilityArtifact;
}

async function reportStage(
  input: PersonBPipelineInput,
  key: AutofixStageKey,
  label: string,
  status: AutofixStageStatus,
  detail?: string,
  logs?: string[]
): Promise<void> {
  if (!input.onStage) return;
  await input.onStage({ key, label, status, detail, logs, at: new Date().toISOString() });
}

function verificationLogs(verification: PatchVerificationResult): string[] {
  const logs = [
    `modified files: ${verification.modifiedFiles.join(', ') || 'none'}`,
    ...verification.commands.map((command) => {
      const parts = [`${command.name}: ${command.ok ? 'pass' : 'fail'}`];
      if (command.stdout.trim()) parts.push(`stdout: ${command.stdout.trim()}`);
      if (command.stderr.trim()) parts.push(`stderr: ${command.stderr.trim()}`);
      return parts.join('\n');
    }),
  ];
  if (verification.error) logs.push(`error: ${verification.error}`);
  return logs;
}

function reportText(report: ReportLike): string {
  return [
    report.title,
    report.description,
    report.annotation?.target,
    report.annotation?.description,
  ].filter(Boolean).join('\n');
}

function requiresStrictModelTargets(report: ReportLike, diagnosis: Diagnosis): boolean {
  const text = reportText(report);
  return diagnosis.targetFiles.some((file) => /\.(?:[cm]?[jt]sx?)$/i.test(file)) &&
    /displayed value|count\/text|DOM state/i.test(diagnosis.rootCause) &&
    /\b(stray|extra|wrong|incorrect|unexpected|unwanted|shows?|display(?:ed|ing)?|count|badge|number|zero)\b|(?:^|[^A-Za-z0-9])0(?:[^A-Za-z0-9]|$)/i.test(text);
}

function modelPatchTargetError(modelPatch: GeneratedPatch, diagnosis: Diagnosis, report: ReportLike): string | null {
  if (!modelPatch.ok) return null;
  if (!requiresStrictModelTargets(report, diagnosis)) return null;
  const allowedTargets = new Set(diagnosis.targetFiles);
  const outsideTargets = modelPatch.files
    .map((file) => file.path)
    .filter((path) => !allowedTargets.has(path));
  if (outsideTargets.length === 0) return null;

  return [
    `Model patch target drift: diagnosis targetFiles=${diagnosis.targetFiles.join(', ') || 'none'}`,
    `but model attempted to modify ${outsideTargets.join(', ')}.`,
  ].join(' ');
}

export async function runPersonBPipeline(input: PersonBPipelineInput): Promise<PersonBPipelineResult> {
  if (!input.workspacePath && !input.repo) {
    throw new Error('runPersonBPipeline requires workspacePath or repo');
  }

  await reportStage(input, 'workspace', 'Load repository', 'running', input.workspacePath ?? input.repo);
  const workspacePath = input.workspacePath ?? (await ensureRepoWorkspace({
    repo: input.repo as string,
    workspaceRoot: input.workspaceRoot,
    branch: input.branch,
    githubToken: input.githubToken,
  })).path;
  await reportStage(input, 'workspace', 'Load repository', 'completed', workspacePath);

  await reportStage(input, 'index', 'Build code index', 'running');
  const index = buildCodeIndex(workspacePath);
  await reportStage(input, 'index', 'Build code index', 'completed', `${index.files.length} source files indexed`);

  await reportStage(input, 'ranking', 'Rank candidate files', 'running');
  const candidates = rankCandidateFiles(index, input.report);
  await reportStage(
    input,
    'ranking',
    'Rank candidate files',
    'completed',
    candidates.slice(0, 3).map((candidate) => candidate.path).join(', ') || 'no candidates'
  );

  await reportStage(input, 'diagnosis', 'Diagnose root cause', 'running');
  let diagnosis = diagnoseReport(input.report, candidates);
  await reportStage(
    input,
    'diagnosis',
    'Diagnose root cause',
    'completed',
    diagnosis.targetFiles.join(', ') || 'no target files'
  );

  await reportStage(input, 'patch', 'Generate scoped patch', 'running');
  let patch = generatePatchFromDiagnosis(diagnosis, candidates);
  let artifact: PatchabilityArtifact = fixArtifact(diagnosis);
  const repoWideModelSelection = input.repoWideModelSelection ?? Boolean(input.codePatchGenerator);
  const shouldAskModel = input.codePatchGenerator && !patch.ok && diagnosis.shouldPatch;
  if (input.codePatchGenerator && shouldAskModel) {
    const deterministicPatch = patch;
    try {
      const modelPatch = await input.codePatchGenerator({
        report: input.report,
        diagnosis,
        candidates,
        index,
        allowRepoFileSelection: repoWideModelSelection,
        customInstructions: input.customInstructions,
      });
      let acceptedModelPatch = modelPatch;
      if (acceptedModelPatch.ok) {
        const targetFiles = acceptedModelPatch.files.map((file) => file.path);
        const targetError = modelPatchTargetError(acceptedModelPatch, diagnosis, input.report);
        if (targetError) {
          acceptedModelPatch = {
            ok: false,
            files: [],
            source: 'llm',
            model: acceptedModelPatch.model,
            error: targetError,
          };
          await reportStage(input, 'patch', 'Generate scoped patch', 'skipped', targetError, [
            `diagnosis target files: ${diagnosis.targetFiles.join(', ') || 'none'}`,
            `model patch files: ${targetFiles.join(', ') || 'none'}`,
          ]);
        } else {
          diagnosis = {
            ...diagnosis,
            rootCause: `${diagnosis.rootCause} Model generated a patch for ${targetFiles.join(', ') || 'no file changes'} within the diagnosed target files.`,
            evidence: [
              ...diagnosis.evidence,
              `Model patch stayed within diagnosis target files: ${targetFiles.join(', ') || 'no file changes'}`,
            ],
            confidence: Math.max(diagnosis.confidence, 0.82),
            shouldPatch: true,
            severity: diagnosis.severity === 'low' ? 'medium' : diagnosis.severity,
          };
        }
      }
      patch = acceptedModelPatch.ok || !deterministicPatch.ok
        ? { ...acceptedModelPatch, artifactType: acceptedModelPatch.artifactType ?? 'fix_pr' }
        : {
            ...deterministicPatch,
            error: acceptedModelPatch.error ? `Model patch declined: ${acceptedModelPatch.error}` : deterministicPatch.error,
          };
    } catch (error) {
      patch = deterministicPatch.ok
        ? deterministicPatch
        : {
            ok: false,
            files: [],
            source: 'llm',
            error: `Model patch generation threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (!patch.ok) {
    const fallback = fallbackPatchabilityArtifact({
      report: input.report,
      diagnosis,
      candidates,
      previousPatchError: patch.error,
    });
    diagnosis = fallback.diagnosis;
    patch = fallback.patch;
    artifact = fallback.artifact;
  } else {
    artifact = {
      ...fixArtifact(diagnosis),
      type: patch.artifactType ?? 'fix_pr',
      targetFiles: diagnosis.targetFiles,
    };
  }
  await reportStage(
    input,
    'patch',
    'Generate scoped patch',
    patch.ok ? 'completed' : 'skipped',
    patch.ok ? patch.files.map((file) => file.path).join(', ') : patch.error,
    patch.ok
      ? [
          `artifact type: ${artifact.type}`,
          `patch source: ${patch.source ?? 'deterministic'}`,
          `files: ${patch.files.map((file) => file.path).join(', ') || 'none'}`,
        ]
      : [patch.error ?? 'No patch generated.']
  );

  await reportStage(input, 'verification', 'Verify patch', patch.ok ? 'running' : 'skipped');
  let verification = patch.ok
    ? verifyStructuredPatch({
        workspacePath,
        targetFiles: diagnosis.targetFiles,
        files: patch.files,
        smokeCommands: artifact.type === 'fix_pr' ? input.smokeCommands : [],
        runPackageScripts: artifact.type === 'fix_pr' ? input.runPackageScripts : false,
      })
    : null;
  if (verification && !verification.ok && artifact.type === 'fix_pr') {
    await reportStage(
      input,
      'verification',
      'Verify patch',
      'failed',
      verification.commands.map((command) => `${command.name}: ${command.ok ? 'pass' : 'fail'}`).join(', ') || verification.error,
      verificationLogs(verification)
    );
    const fallback = fallbackPatchabilityArtifact({
      report: input.report,
      diagnosis,
      candidates,
      previousPatchError: verification.error ?? 'Direct product-code patch verification failed.',
    });
    diagnosis = fallback.diagnosis;
    patch = fallback.patch;
    artifact = fallback.artifact;
    await reportStage(
      input,
      'patch',
      'Generate fallback artifact',
      'completed',
      patch.files.map((file) => file.path).join(', '),
      [
        `artifact type: ${artifact.type}`,
        `previous verification error: ${verification.error ?? 'unknown'}`,
        `files: ${patch.files.map((file) => file.path).join(', ') || 'none'}`,
      ]
    );
    await reportStage(input, 'verification', 'Verify fallback artifact', 'running');
    verification = verifyStructuredPatch({
      workspacePath,
      targetFiles: diagnosis.targetFiles,
      files: patch.files,
      smokeCommands: [],
      runPackageScripts: false,
    });
  }
  if (verification) {
    await reportStage(
      input,
      'verification',
      artifact.type === 'fix_pr' ? 'Verify patch' : 'Verify fallback artifact',
      verification.ok ? 'completed' : 'failed',
      verification.commands.map((command) => `${command.name}: ${command.ok ? 'pass' : 'fail'}`).join(', ') || 'generic verification',
      verificationLogs(verification)
    );
  }

  return {
    workspacePath,
    index,
    candidates,
    diagnosis,
    patch,
    verification,
    artifact,
  };
}

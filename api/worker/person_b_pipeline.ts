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
      });
      if (modelPatch.ok) {
        const targetFiles = modelPatch.files.map((file) => file.path);
        diagnosis = {
          ...diagnosis,
          rootCause: `${diagnosis.rootCause} Model repo-wide file selection chose ${targetFiles.join(', ') || 'no file changes'} for the final patch.`,
          evidence: [
            ...diagnosis.evidence,
            `Model repo-wide file selection chose: ${targetFiles.join(', ') || 'no file changes'}`,
          ],
          targetFiles,
          confidence: Math.max(diagnosis.confidence, 0.82),
          shouldPatch: true,
          severity: diagnosis.severity === 'low' ? 'medium' : diagnosis.severity,
        };
      }
      patch = modelPatch.ok || !deterministicPatch.ok
        ? modelPatch
        : {
            ...deterministicPatch,
            error: modelPatch.error ? `Model patch declined: ${modelPatch.error}` : deterministicPatch.error,
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
  await reportStage(
    input,
    'patch',
    'Generate scoped patch',
    patch.ok ? 'completed' : 'skipped',
    patch.ok ? patch.files.map((file) => file.path).join(', ') : patch.error,
    patch.ok
      ? [`patch source: ${patch.source ?? 'deterministic'}`, `files: ${patch.files.map((file) => file.path).join(', ') || 'none'}`]
      : [patch.error ?? 'No patch generated.']
  );

  await reportStage(input, 'verification', 'Verify patch', patch.ok ? 'running' : 'skipped');
  const verification = patch.ok
    ? verifyStructuredPatch({
        workspacePath,
        targetFiles: diagnosis.targetFiles,
        files: patch.files,
        smokeCommands: input.smokeCommands,
        runPackageScripts: input.runPackageScripts,
      })
    : null;
  if (verification) {
    await reportStage(
      input,
      'verification',
      'Verify patch',
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
  };
}

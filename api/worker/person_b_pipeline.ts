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
}

export interface PersonBPipelineResult {
  workspacePath: string;
  index: CodeIndex;
  candidates: RankedCandidateFile[];
  diagnosis: Diagnosis;
  patch: GeneratedPatch;
  verification: PatchVerificationResult | null;
}

function canRetryDeterministicVisualPatch(diagnosis: Diagnosis): boolean {
  return diagnosis.targetFiles.length > 0 &&
    diagnosis.targetFiles.every((file) => /\.(?:s?css)$/i.test(file)) &&
    /button|background|color|colour|cta|primary/i.test(diagnosis.fixStrategy);
}

export async function runPersonBPipeline(input: PersonBPipelineInput): Promise<PersonBPipelineResult> {
  if (!input.workspacePath && !input.repo) {
    throw new Error('runPersonBPipeline requires workspacePath or repo');
  }

  const workspacePath = input.workspacePath ?? (await ensureRepoWorkspace({
    repo: input.repo as string,
    workspaceRoot: input.workspaceRoot,
    branch: input.branch,
    githubToken: input.githubToken,
  })).path;

  const index = buildCodeIndex(workspacePath);
  const candidates = rankCandidateFiles(index, input.report);
  let diagnosis = diagnoseReport(input.report, candidates);
  let patch = generatePatchFromDiagnosis(diagnosis, candidates);
  const repoWideModelSelection = input.repoWideModelSelection ?? Boolean(input.codePatchGenerator);
  if (!patch.ok && repoWideModelSelection && canRetryDeterministicVisualPatch(diagnosis)) {
    const deterministicDiagnosis: Diagnosis = {
      ...diagnosis,
      evidence: [
        ...diagnosis.evidence,
        'Deterministic visual patch allowed because the report targets a bounded stylesheet color change.',
      ],
      confidence: Math.max(diagnosis.confidence, 0.75),
      shouldPatch: true,
      severity: diagnosis.severity === 'low' ? 'medium' : diagnosis.severity,
    };
    const deterministicPatch = generatePatchFromDiagnosis(deterministicDiagnosis, candidates);
    if (deterministicPatch.ok) {
      diagnosis = deterministicDiagnosis;
      patch = deterministicPatch;
    }
  }
  const shouldAskModel = input.codePatchGenerator && !patch.ok && (repoWideModelSelection || diagnosis.shouldPatch);
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
  const verification = patch.ok
    ? verifyStructuredPatch({
        workspacePath,
        targetFiles: diagnosis.targetFiles,
        files: patch.files,
        smokeCommands: input.smokeCommands,
        runPackageScripts: input.runPackageScripts,
      })
    : null;

  return {
    workspacePath,
    index,
    candidates,
    diagnosis,
    patch,
    verification,
  };
}

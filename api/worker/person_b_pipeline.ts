import { buildCodeIndex, rankCandidateFiles } from '../indexing/code_index.ts';
import type { CodeIndex, RankedCandidateFile, ReportLike } from '../indexing/code_index.ts';
import { ensureRepoWorkspace } from '../repo/workspace.ts';
import { diagnoseReport } from './diagnosis/diagnosis.ts';
import type { Diagnosis } from './diagnosis/diagnosis.ts';
import { generatePatchFromDiagnosis } from './patch/generate.ts';
import type { GeneratedPatch } from './patch/generate.ts';
import { verifyStructuredPatch } from './patch/verification.ts';
import type { PatchVerificationResult, VerificationCommandInput } from './patch/verification.ts';

export interface PersonBPipelineInput {
  report: ReportLike;
  workspacePath?: string;
  repo?: string;
  workspaceRoot?: string;
  branch?: string;
  smokeCommands?: VerificationCommandInput[];
}

export interface PersonBPipelineResult {
  workspacePath: string;
  index: CodeIndex;
  candidates: RankedCandidateFile[];
  diagnosis: Diagnosis;
  patch: GeneratedPatch;
  verification: PatchVerificationResult | null;
}

export function runPersonBPipeline(input: PersonBPipelineInput): PersonBPipelineResult {
  if (!input.workspacePath && !input.repo) {
    throw new Error('runPersonBPipeline requires workspacePath or repo');
  }

  const workspacePath = input.workspacePath ?? ensureRepoWorkspace({
    repo: input.repo as string,
    workspaceRoot: input.workspaceRoot,
    branch: input.branch,
  }).path;

  const index = buildCodeIndex(workspacePath);
  const candidates = rankCandidateFiles(index, input.report);
  const diagnosis = diagnoseReport(input.report, candidates);
  const patch = generatePatchFromDiagnosis(diagnosis, candidates);
  const verification = patch.ok
    ? verifyStructuredPatch({
        workspacePath,
        targetFiles: diagnosis.targetFiles,
        files: patch.files,
        smokeCommands: input.smokeCommands,
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

import { buildCodeIndex, rankCandidateFiles } from '../indexing/code_index.js';
import type { CodeIndex, RankedCandidateFile, ReportLike } from '../indexing/code_index.js';
import { ensureRepoWorkspace } from '../repo/workspace.js';
import { diagnoseReport } from './diagnosis/diagnosis.js';
import type { Diagnosis } from './diagnosis/diagnosis.js';
import { generatePatchFromDiagnosis } from './patch/generate.js';
import type { GeneratedPatch } from './patch/generate.js';
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
}

export interface PersonBPipelineResult {
  workspacePath: string;
  index: CodeIndex;
  candidates: RankedCandidateFile[];
  diagnosis: Diagnosis;
  patch: GeneratedPatch;
  verification: PatchVerificationResult | null;
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
  const diagnosis = diagnoseReport(input.report, candidates);
  const patch = generatePatchFromDiagnosis(diagnosis, candidates);
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

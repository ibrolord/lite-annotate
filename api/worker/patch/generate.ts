import type { RankedCandidateFile } from '../../indexing/code_index.js';
import type { Diagnosis } from '../diagnosis/diagnosis.js';
import { shouldPatchDiagnosis } from '../diagnosis/diagnosis.js';
import type { PatchArtifactType } from '../patchability.js';
import type { StructuredPatchFile } from './verification.js';

export interface GeneratedPatch {
  ok: boolean;
  files: StructuredPatchFile[];
  error?: string;
  source?: 'deterministic' | 'llm';
  model?: string;
  summary?: string;
  risks?: string[];
  artifactType?: PatchArtifactType;
}

function targetCandidates(diagnosis: Diagnosis, candidates: RankedCandidateFile[]): RankedCandidateFile[] {
  const targets = new Set(diagnosis.targetFiles);
  return candidates.filter((candidate) => targets.has(candidate.path));
}

function guardAlreadyExists(content: string, variableName: string): boolean {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`if\\s*\\(\\s*!${escaped}\\s*\\)`).test(content);
}

function missingObjectFallback(variableName: string): string {
  const label = variableName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || 'Item';
  return `${label.charAt(0).toUpperCase()}${label.slice(1).toLowerCase()} not found`;
}

function generateMissingObjectGuard(content: string): { patched?: string; alreadyGuarded?: boolean } | null {
  const lines = content.split('\n');
  const lookupIndex = lines.findIndex((line) =>
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:get|find|load|fetch)[A-Za-z0-9_$]*\s*\(/.test(line)
  );
  if (lookupIndex < 0) return null;

  const lookupMatch = lines[lookupIndex]?.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
  const variableName = lookupMatch?.[1];
  if (!variableName) return null;
  if (guardAlreadyExists(content, variableName)) return { alreadyGuarded: true };

  const remainder = lines.slice(lookupIndex + 1).join('\n');
  const dereferencesVariable = new RegExp(`\\b${variableName}\\.[A-Za-z_$][\\w$]*\\b`).test(remainder);
  if (!dereferencesVariable) return null;

  const indent = lines[lookupIndex]?.match(/^(\s*)/)?.[1] ?? '';
  const patched = [
    ...lines.slice(0, lookupIndex + 1),
    `${indent}if (!${variableName}) return '${missingObjectFallback(variableName)}';`,
    ...lines.slice(lookupIndex + 1),
  ];
  return { patched: patched.join('\n') };
}

export function generatePatchFromDiagnosis(
  diagnosis: Diagnosis,
  candidates: RankedCandidateFile[]
): GeneratedPatch {
  const patchGate = shouldPatchDiagnosis(diagnosis);
  if (!patchGate.ok) {
    return { ok: false, files: [], error: patchGate.errors.join('; ') };
  }

  const files: StructuredPatchFile[] = [];
  const alreadyGuarded: string[] = [];
  for (const candidate of targetCandidates(diagnosis, candidates)) {
    const result = generateMissingObjectGuard(candidate.file.content);
    if (result?.alreadyGuarded) {
      alreadyGuarded.push(candidate.path);
      continue;
    }
    if (!result?.patched || result.patched === candidate.file.content) continue;
    files.push({ path: candidate.path, content: result.patched });
  }

  if (files.length === 0 && alreadyGuarded.length > 0) {
    return {
      ok: true,
      files: [],
      error: `No patch needed: ${alreadyGuarded.join(', ')} already contains a missing-object guard.`,
    };
  }

  if (files.length === 0) {
    return {
      ok: false,
      files: [],
      error: 'No safe structured patch could be generated from the diagnosis target files.',
    };
  }

  return {
    ok: true,
    files,
    source: 'deterministic',
    summary: 'Inserted a narrow missing-object fallback guard.',
    artifactType: 'fix_pr',
  };
}

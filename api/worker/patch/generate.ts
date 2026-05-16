import type { RankedCandidateFile } from '../../indexing/code_index.js';
import type { Diagnosis } from '../diagnosis/diagnosis.js';
import { shouldPatchDiagnosis } from '../diagnosis/diagnosis.js';
import type { StructuredPatchFile } from './verification.js';

export interface GeneratedPatch {
  ok: boolean;
  files: StructuredPatchFile[];
  error?: string;
  source?: 'deterministic' | 'llm';
  model?: string;
  summary?: string;
  risks?: string[];
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

function requestedButtonColor(diagnosis: Diagnosis): { value: string; hoverValue: string; label: string } | null {
  const text = [diagnosis.rootCause, diagnosis.fixStrategy, ...diagnosis.evidence].join('\n');
  const hex = text.match(/#[0-9a-f]{3,8}\b/i)?.[0];
  if (hex) return { value: hex, hoverValue: hex, label: hex };

  const color = text.match(/\b(blue|green|red|orange|purple|black|white|yellow)\b/i)?.[1]?.toLowerCase();
  switch (color) {
    case 'blue':
      return { value: '#2563eb', hoverValue: '#1d4ed8', label: 'blue' };
    case 'green':
      return { value: '#2f8f46', hoverValue: '#25733a', label: 'green' };
    case 'red':
      return { value: '#dc2626', hoverValue: '#b91c1c', label: 'red' };
    case 'orange':
      return { value: '#ea580c', hoverValue: '#c2410c', label: 'orange' };
    case 'purple':
      return { value: '#7c3aed', hoverValue: '#6d28d9', label: 'purple' };
    case 'black':
      return { value: '#111827', hoverValue: '#030712', label: 'black' };
    case 'white':
      return { value: '#ffffff', hoverValue: '#f8fafc', label: 'white' };
    case 'yellow':
      return { value: '#ca8a04', hoverValue: '#a16207', label: 'yellow' };
    default:
      return null;
  }
}

function upsertCssBackgroundRule(content: string, selector: string, value: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockPattern = new RegExp(`(${escaped}\\s*\\{)([^}]*)(\\})`, 'm');
  const match = content.match(blockPattern);
  if (!match) {
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    return `${content}${separator}${selector} {\n  background: ${value};\n}\n`;
  }

  const body = match[2] ?? '';
  const nextBody = /background\s*:/.test(body)
    ? body.replace(/background\s*:[^;]+;/, `background: ${value};`)
    : `${body.trimEnd()}\n  background: ${value};\n`;
  return content.replace(blockPattern, `$1${nextBody}$3`);
}

function generateButtonColorPatch(diagnosis: Diagnosis, content: string): string | null {
  const color = requestedButtonColor(diagnosis);
  if (!color || !/button|background|color/i.test(diagnosis.fixStrategy)) return null;

  const scopedToCheckout = diagnosis.evidence.some((item) => /route:\s*\/checkout/i.test(item));
  const selector = scopedToCheckout ? '.checkout-form .button-primary' : '.button-primary';
  const hoverSelector = `${selector}:hover`;

  let patched = upsertCssBackgroundRule(content, selector, color.value);
  patched = upsertCssBackgroundRule(patched, hoverSelector, color.hoverValue);
  return patched === content ? null : patched;
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
    if (/\.(?:s?css)$/i.test(candidate.path)) {
      const patched = generateButtonColorPatch(diagnosis, candidate.file.content);
      if (!patched || patched === candidate.file.content) continue;
      files.push({ path: candidate.path, content: patched });
      continue;
    }

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
    summary: files.some((file) => /\.(?:s?css)$/i.test(file.path))
      ? 'Applied a scoped button background color override.'
      : 'Inserted a narrow missing-object fallback guard.',
  };
}

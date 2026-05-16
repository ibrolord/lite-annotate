import type { RankedCandidateFile, ReportLike } from '../../indexing/code_index.js';

export type DiagnosisSeverity = 'low' | 'medium' | 'high';

export interface Diagnosis {
  type: 'bug';
  severity: DiagnosisSeverity;
  rootCause: string;
  evidence: string[];
  targetFiles: string[];
  fixStrategy: string;
  confidence: number;
  shouldPatch: boolean;
}

export interface DiagnosisValidation {
  ok: boolean;
  errors: string[];
}

const PATCH_CONFIDENCE_THRESHOLD = 0.75;
const MAX_TARGET_FILES = 2;

function consoleMessages(report: ReportLike): string[] {
  return [...(report.console ?? []), ...(report.consoleLogs ?? [])]
    .map((entry) => entry.message ?? entry.msg ?? '')
    .filter(Boolean);
}

function firstMeaningfulLine(content: string, pattern: RegExp): string | null {
  const line = content.split('\n').find((item) => pattern.test(item));
  return line?.trim() ?? null;
}

function hasMissingPropertyError(report: ReportLike): boolean {
  return consoleMessages(report).some((message) =>
    /cannot read properties? of undefined|cannot read property/i.test(message)
  );
}

function referencedProperty(report: ReportLike): string | null {
  for (const message of consoleMessages(report)) {
    const match = message.match(/reading ['"`]([A-Za-z_$][\w$]*)['"`]/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

export function validateDiagnosis(value: Partial<Diagnosis>): DiagnosisValidation {
  const errors: string[] = [];

  if (value.type !== 'bug') errors.push('type must be "bug"');
  if (!['low', 'medium', 'high'].includes(String(value.severity))) {
    errors.push('severity must be low, medium, or high');
  }
  if (!value.rootCause || value.rootCause.trim().length < 20) {
    errors.push('rootCause must explain the concrete failure');
  }
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    errors.push('evidence must include at least one concrete item');
  }
  if (!Array.isArray(value.targetFiles) || value.targetFiles.length === 0) {
    errors.push('targetFiles must include at least one file');
  } else if (value.targetFiles.length > MAX_TARGET_FILES) {
    errors.push(`targetFiles must include at most ${MAX_TARGET_FILES} files`);
  }
  if (!value.fixStrategy || value.fixStrategy.trim().length < 10) {
    errors.push('fixStrategy must describe the intended fix');
  }
  if (typeof value.confidence !== 'number' || Number.isNaN(value.confidence)) {
    errors.push('confidence must be a number');
  } else if (value.confidence < PATCH_CONFIDENCE_THRESHOLD && value.shouldPatch) {
    errors.push(`confidence must be >= ${PATCH_CONFIDENCE_THRESHOLD} when shouldPatch is true`);
  }

  return { ok: errors.length === 0, errors };
}

export function shouldPatchDiagnosis(diagnosis: Diagnosis): DiagnosisValidation {
  const validation = validateDiagnosis(diagnosis);
  const errors = [...validation.errors];

  if (!diagnosis.shouldPatch) errors.push('shouldPatch is false');
  if (diagnosis.confidence < PATCH_CONFIDENCE_THRESHOLD) {
    errors.push(`confidence below ${PATCH_CONFIDENCE_THRESHOLD}`);
  }
  if (diagnosis.targetFiles.length > MAX_TARGET_FILES) {
    errors.push(`targetFiles exceeds ${MAX_TARGET_FILES}`);
  }
  if (!diagnosis.evidence.some((item) => /code:|line|reads|dereference/i.test(item))) {
    errors.push('evidence must include code-specific support');
  }

  return { ok: errors.length === 0, errors };
}

export function diagnoseReport(report: ReportLike, candidates: RankedCandidateFile[]): Diagnosis {
  const top = candidates[0];
  if (!top) {
    return {
      type: 'bug',
      severity: 'low',
      rootCause: 'No candidate source file ranked highly enough to explain the report.',
      evidence: ['Candidate ranking returned no files.'],
      targetFiles: [],
      fixStrategy: 'Collect more report context before attempting a patch.',
      confidence: 0,
      shouldPatch: false,
    };
  }

  const property = referencedProperty(report);
  const missingProperty = hasMissingPropertyError(report);
  const propertyRead = property
    ? firstMeaningfulLine(top.file.content, new RegExp(`\\.${property}\\b`))
    : null;
  const lookupLine = firstMeaningfulLine(top.file.content, /\b(get|find|load|fetch)[A-Za-z0-9_$]*\s*\(/);

  const evidence = [
    ...consoleMessages(report).slice(0, 2).map((message) => `Console: ${message}`),
    `Candidate: ${top.path} ranked #1 (${top.reasons.slice(0, 3).join('; ')})`,
  ];
  if (propertyRead) evidence.push(`Code: ${top.path} reads ${propertyRead}`);
  if (lookupLine) evidence.push(`Code: ${top.path} depends on lookup ${lookupLine}`);
  if (report.route) evidence.push(`Route: ${report.route}`);

  const confidence = clampConfidence(
    0.45 +
      (top.score >= 300 ? 0.15 : 0) +
      (missingProperty ? 0.15 : 0) +
      (propertyRead ? 0.12 : 0) +
      (top.path.includes('users') || top.path.includes('profile') || top.path.includes('customer') ? 0.08 : 0)
  );

  const rootCause = property && propertyRead
    ? `${top.path} dereferences user.${property} when the lookup returns undefined or a missing user.`
    : `${top.path} is the highest-ranked source file for the report, but the exact failing dereference needs more evidence.`;

  const diagnosis: Diagnosis = {
    type: 'bug',
    severity: confidence >= 0.75 ? 'medium' : 'low',
    rootCause,
    evidence,
    targetFiles: [top.path],
    fixStrategy: property
      ? `Add a missing-user guard or fallback before reading ${property}.`
      : 'Add a narrow guard around the failing path identified by the report.',
    confidence,
    shouldPatch: confidence >= PATCH_CONFIDENCE_THRESHOLD,
  };

  const patchGate = shouldPatchDiagnosis(diagnosis);
  return {
    ...diagnosis,
    shouldPatch: patchGate.ok,
  };
}

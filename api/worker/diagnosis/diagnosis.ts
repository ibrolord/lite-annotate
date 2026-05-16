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
    .flatMap((entry) => [entry.message ?? entry.msg ?? '', entry.stack ?? ''])
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

function reportText(report: ReportLike): string {
  return [
    report.title,
    report.description,
    report.url,
    report.route,
    report.annotation?.target,
    report.annotation?.selector,
    report.annotation?.description,
    ...(report.session ?? []).map((entry) => entry.target),
    ...consoleMessages(report),
  ]
    .filter(Boolean)
    .join('\n');
}

function hasVisualLayoutSignal(report: ReportLike): boolean {
  const userIntentText = [
    report.title,
    report.description,
    report.annotation?.target,
    report.annotation?.selector,
    report.annotation?.description,
    ...(report.session ?? []).map((entry) => entry.target),
  ]
    .filter(Boolean)
    .join('\n');
  const visualSignal = /wrap|wrapping|overflow|overlap|layout|spacing|font|line-height|clipped|cut off|responsive|mobile|desktop|visual|text|button|color|colour|background|cta|primary/i;
  const strongVisualSignal = /wrap|wrapping|overflow|overlap|layout|spacing|font|line-height|clipped|cut off|responsive|mobile|desktop|visual|color|colour|background/i;
  return strongVisualSignal.test(userIntentText) || visualSignal.test(reportText(report));
}

function requestedColor(report: ReportLike): string | null {
  const text = reportText(report);
  const hex = text.match(/#[0-9a-f]{3,8}\b/i)?.[0];
  if (hex) return hex;
  const named = text.match(/\b(blue|green|red|orange|purple|black|white|yellow)\b/i)?.[1];
  return named?.toLowerCase() ?? null;
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

function hasGuardBeforePropertyRead(content: string, variableName: string, property: string): boolean {
  const lines = content.split('\n');
  const lookupIndex = lines.findIndex((line) =>
    new RegExp(`\\b(?:const|let|var)\\s+${variableName}\\s*=\\s*(?:get|find|load|fetch)[A-Za-z0-9_$]*\\s*\\(`).test(line)
  );
  if (lookupIndex < 0) return false;

  const propertyIndex = lines.findIndex((line, index) =>
    index > lookupIndex && new RegExp(`\\b${variableName}\\.${property}\\b`).test(line)
  );
  if (propertyIndex < 0) return false;

  return lines
    .slice(lookupIndex + 1, propertyIndex)
    .some((line) => new RegExp(`if\\s*\\(\\s*!${variableName}\\s*\\)`).test(line));
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
  if (!diagnosis.evidence.some((item) => /code:|line|reads|dereference|candidate|selector|style|markup|css|html/i.test(item))) {
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
  const visualLayout = !missingProperty && hasVisualLayoutSignal(report);
  const color = requestedColor(report);
  const propertyRead = property
    ? firstMeaningfulLine(top.file.content, new RegExp(`\\.${property}\\b`))
    : null;
  const lookupLine = firstMeaningfulLine(top.file.content, /\b(get|find|load|fetch)[A-Za-z0-9_$]*\s*\(/);
  const styleLine = firstMeaningfulLine(top.file.content, /font-size|line-height|max-width|min-width|white-space|overflow|flex|grid|word-break|text-wrap|background|color|\.button|class=|<h[1-6]\b/i);
  const guardedCurrentCode = property
    ? hasGuardBeforePropertyRead(top.file.content, 'user', property) || hasGuardBeforePropertyRead(top.file.content, 'customer', property)
    : false;

  const evidence = [
    ...consoleMessages(report).slice(0, 2).map((message) => `Console: ${message}`),
    `Candidate: ${top.path} ranked #1 (${top.reasons.slice(0, 3).join('; ')})`,
  ];
  if (propertyRead) evidence.push(`Code: ${top.path} reads ${propertyRead}`);
  if (lookupLine) evidence.push(`Code: ${top.path} depends on lookup ${lookupLine}`);
  if (styleLine) evidence.push(`Code: ${top.path} includes visual target ${styleLine}`);
  if (report.route) evidence.push(`Route: ${report.route}`);

  const targetFiles = visualLayout
    ? (color
        ? candidates.filter((candidate) => /\.(?:s?css)$/i.test(candidate.path)).slice(0, 1)
        : candidates.filter((candidate) => /\.(?:html|s?css|jsx|tsx)$/i.test(candidate.path)).slice(0, MAX_TARGET_FILES)
      ).map((candidate) => candidate.path)
    : [top.path];
  if (visualLayout && targetFiles.length > 0 && !targetFiles.includes(top.path)) {
    evidence.push(`Code: ${targetFiles.join(', ')} selected as the visual target file.`);
  }
  const hasVisualStyleTarget = visualLayout && targetFiles.some((path) => /\.(?:s?css)$/i.test(path));

  const confidence = clampConfidence(
    (visualLayout ? 0.52 : 0.45) +
      (top.score >= 300 ? 0.15 : 0) +
      (missingProperty ? 0.15 : 0) +
      (propertyRead ? 0.12 : 0) +
      (visualLayout && styleLine ? 0.11 : 0) +
      (color && hasVisualStyleTarget ? 0.21 : 0)
  );

  const rootCause = property && propertyRead && guardedCurrentCode
    ? `${top.path} is the stack-frame source for the reported missing-record crash, and the current repo already guards the missing record before reading ${property}.`
    : property && propertyRead
      ? `${top.path} dereferences a lookup result's ${property} property before confirming the record exists.`
      : visualLayout
        ? targetFiles.length > 0 && !targetFiles.includes(top.path)
          ? `${targetFiles.join(', ')} is the stylesheet target for the visual report. ${top.path} came from a noisy stack trace and is kept as context.`
          : `${top.path} is the highest-ranked UI file for a visual layout report, and the pinned page evidence points to nearby markup or styles.`
        : `${top.path} is the highest-ranked source file for the report, but the exact failing dereference needs more evidence.`;

  const diagnosis: Diagnosis = {
    type: 'bug',
    severity: confidence >= 0.75 ? 'medium' : 'low',
    rootCause,
    evidence,
    targetFiles,
    fixStrategy: property && guardedCurrentCode
      ? `Verify the existing missing-record guard before reading ${property}; patch only if the guard is absent.`
      : property
        ? `Add a missing-record guard or fallback before reading ${property}.`
        : visualLayout
          ? color
            ? `Make the smallest stylesheet change that sets the reported button background to ${color} without changing unrelated UI.`
            : 'Make the smallest markup or stylesheet change that fixes the reported visual layout issue without changing unrelated UI.'
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

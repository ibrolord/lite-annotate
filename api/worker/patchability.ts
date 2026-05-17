import type { RankedCandidateFile, ReportLike } from '../indexing/code_index.js';
import type { Diagnosis } from './diagnosis/diagnosis.js';
import type { GeneratedPatch } from './patch/generate.js';

export type PatchArtifactType =
  | 'fix_pr'
  | 'regression_test_pr'
  | 'instrumentation_pr'
  | 'setup_pr'
  | 'external_blocker';

export interface PatchabilityArtifact {
  type: PatchArtifactType;
  reportClass: string;
  reason: string;
  targetFiles: string[];
  verificationPlan: string[];
  blocker?: string;
}

function reportText(report: ReportLike): string {
  return [
    report.title,
    report.description,
    report.route,
    report.url,
    report.annotation?.target,
    report.annotation?.selector,
    report.annotation?.description,
    ...(report.console ?? []).map((entry) => `${entry.message ?? ''}\n${entry.stack ?? ''}`),
    ...(report.consoleLogs ?? []).map((entry) => `${entry.message ?? entry.msg ?? ''}\n${entry.stack ?? ''}`),
    ...(report.network ?? []).map((entry) => `${entry.method ?? ''} ${entry.url ?? ''} ${entry.status ?? ''}`),
  ].filter(Boolean).join('\n');
}

export function classifyReport(report: ReportLike): string {
  const text = reportText(report);
  if (/cannot read properties?|typeerror|referenceerror|uncaught|crash/i.test(text)) return 'runtime_crash';
  if (/wrap|overflow|overlap|layout|spacing|font|color|colour|background|visual|button|cta/i.test(text)) return 'visual_issue';
  if (/(?:api|fetch|xhr|network|404|500|timeout|failed)/i.test(text)) return 'api_network_failure';
  if (/(?:wrong|incorrect|copy|text|label|message|wording|content|typo|stray|count|badge|zero)/i.test(text)) return 'copy_content';
  if (/(?:slow|performance|lag|freeze|jank)/i.test(text)) return 'performance';
  return 'unknown';
}

function safeSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return slug || 'report';
}

function primaryEvidence(report: ReportLike): string[] {
  const evidence = [
    report.route ? `Route: ${report.route}` : undefined,
    report.url ? `URL: ${report.url}` : undefined,
    report.annotation?.target ? `Annotation target: ${report.annotation.target}` : undefined,
    ...(report.console ?? []).slice(0, 3).map((entry) => `Console: ${entry.message ?? entry.msg ?? ''}`),
    ...(report.network ?? []).slice(0, 3).map((entry) => `Network: ${entry.method ?? 'GET'} ${entry.url ?? ''} -> ${entry.status ?? 'n/a'}`),
  ].filter((item): item is string => Boolean(item && item.trim()));
  return evidence.length ? evidence : ['Report did not include strong browser evidence.'];
}

function fallbackPath(report: ReportLike, reportClass: string): string {
  const title = typeof report.title === 'string' ? report.title : '';
  return `.lite-annotate/autofix/${safeSlug(`${reportClass}-${title}`)}.md`;
}

function regressionTestPath(report: ReportLike, reportClass: string): string {
  const title = typeof report.title === 'string' ? report.title : '';
  return `tests/lite-annotate-autofix/${safeSlug(`${reportClass}-${title}`)}.test.js`;
}

function shouldCreateRegressionArtifact(report: ReportLike, reportClass: string): boolean {
  const text = reportText(report);
  if (reportClass === 'unknown') return false;
  return /regression|repro|expected|should|must|incorrect|wrong|confusing|broken|fails?|typo|stray|count|badge|zero/i.test(text);
}

function fallbackMarkdown(input: {
  artifactType: PatchArtifactType;
  reportClass: string;
  report: ReportLike;
  diagnosis: Diagnosis;
  candidates: RankedCandidateFile[];
  previousPatchError?: string;
}): string {
  const evidence = primaryEvidence(input.report).map((item) => `- ${item}`).join('\n');
  const candidates = input.candidates.slice(0, 5)
    .map((candidate, index) => `${index + 1}. ${candidate.path} (${candidate.reasons.slice(0, 2).join('; ') || 'ranked candidate'})`)
    .join('\n') || 'No code candidates were available.';

  return `# Lite Annotate Auto-Fix Artifact

Artifact type: ${input.artifactType}
Report class: ${input.reportClass}

## Report

${input.report.title ?? 'Untitled report'}

${input.report.description ?? ''}

## Why this artifact exists

Auto-Fix ran, but the available evidence was not strong enough for a direct product-code fix. This artifact keeps the report patchable by adding a reviewable engineering artifact inside the repository instead of stopping at diagnosis-only output.

${input.previousPatchError ? `Previous patch gate: ${input.previousPatchError}\n` : ''}

## Evidence captured

${evidence}

## Candidate files

${candidates}

## Current diagnosis

${input.diagnosis.rootCause}

## Required follow-up

- Add or confirm the missing reproduction evidence.
- Convert this artifact into a product fix, regression test, or targeted instrumentation once the owner confirms the intended behavior.
- Keep future Auto-Fix attempts scoped to the candidate files above unless new evidence changes ownership.
`;
}

function regressionTestContent(input: {
  reportClass: string;
  report: ReportLike;
  diagnosis: Diagnosis;
  candidates: RankedCandidateFile[];
}): string {
  const evidence = primaryEvidence(input.report);
  const candidates = input.candidates.slice(0, 5).map((candidate) => candidate.path);
  return `import assert from 'node:assert/strict';
import test from 'node:test';

const report = ${JSON.stringify({
    title: input.report.title ?? 'Untitled report',
    route: input.report.route ?? null,
    url: input.report.url ?? null,
    reportClass: input.reportClass,
    evidence,
    candidates,
    diagnosis: input.diagnosis.rootCause,
  }, null, 2)};

test('Lite Annotate captured regression report remains actionable', () => {
  assert.equal(typeof report.title, 'string');
  assert.ok(report.title.length > 0);
  assert.ok(report.evidence.length > 0);
  assert.ok(report.candidates.length > 0);
});
`;
}

export function fixArtifact(diagnosis: Diagnosis): PatchabilityArtifact {
  return {
    type: 'fix_pr',
    reportClass: 'runtime_or_ui_fix',
    reason: 'Diagnosis is confident enough for a scoped product-code patch.',
    targetFiles: diagnosis.targetFiles,
    verificationPlan: ['Run package checks when configured.', 'Run syntax or file-type sanity checks for modified files.'],
  };
}

export function fallbackPatchabilityArtifact(input: {
  report: ReportLike;
  diagnosis: Diagnosis;
  candidates: RankedCandidateFile[];
  previousPatchError?: string;
}): { diagnosis: Diagnosis; patch: GeneratedPatch; artifact: PatchabilityArtifact } {
  const reportClass = classifyReport(input.report);
  const artifactType: PatchArtifactType = input.candidates.length === 0
    ? 'setup_pr'
    : shouldCreateRegressionArtifact(input.report, reportClass) ? 'regression_test_pr' : 'instrumentation_pr';
  const path = artifactType === 'regression_test_pr'
    ? regressionTestPath(input.report, reportClass)
    : fallbackPath(input.report, reportClass);
  const reason = artifactType === 'setup_pr'
    ? 'Auto-Fix could not find source candidates, so it creates a setup artifact that records the missing repo/index prerequisite.'
    : artifactType === 'regression_test_pr'
      ? 'Auto-Fix could not safely produce a product-code fix, so it creates a regression test artifact that preserves the report behavior.'
    : 'Auto-Fix could not safely produce a product-code fix, so it creates an instrumentation artifact instead of stopping at diagnosis-only output.';
  const diagnosis: Diagnosis = {
    ...input.diagnosis,
    severity: input.diagnosis.severity === 'high' ? 'high' : 'medium',
    rootCause: `${input.diagnosis.rootCause} Auto-Fix generated a ${artifactType} fallback because a direct product-code fix was not yet proven.${input.previousPatchError ? ` Direct patch was blocked: ${input.previousPatchError}` : ''}`,
    evidence: [
      ...input.diagnosis.evidence,
      `Auto-Fix artifact: ${artifactType}`,
      `Fallback target: ${path}`,
      ...(input.previousPatchError ? [`Direct patch blocked: ${input.previousPatchError}`] : []),
    ],
    targetFiles: [path],
    fixStrategy: artifactType === 'setup_pr'
      ? 'Add a setup artifact that records the missing source-index prerequisite and the evidence needed for the next run.'
      : artifactType === 'regression_test_pr'
        ? 'Add a repo-local regression test artifact that keeps the reported behavior executable for review.'
        : 'Add a repo-local instrumentation artifact that preserves the report evidence and required follow-up instead of returning diagnosis-only output.',
    shouldPatch: true,
  };
  const patch: GeneratedPatch = {
    ok: true,
    files: [{
      path,
      content: artifactType === 'regression_test_pr'
        ? regressionTestContent({
            reportClass,
            report: input.report,
            diagnosis: input.diagnosis,
            candidates: input.candidates,
          })
        : fallbackMarkdown({
            artifactType,
            reportClass,
            report: input.report,
            diagnosis: input.diagnosis,
            candidates: input.candidates,
            previousPatchError: input.previousPatchError,
          }),
    }],
    source: 'deterministic',
    summary: artifactType === 'setup_pr'
      ? 'Created a setup artifact for missing repo/index prerequisites.'
      : artifactType === 'regression_test_pr'
        ? 'Created a regression test artifact for an under-specified report.'
      : 'Created an instrumentation artifact for an under-specified report.',
    artifactType,
    risks: ['This fallback artifact does not claim to fix product behavior; it prevents vague diagnosis-only output.'],
  };
  return {
    diagnosis,
    patch,
    artifact: {
      type: artifactType,
      reportClass,
      reason,
      targetFiles: [path],
      verificationPlan: [artifactType === 'regression_test_pr'
        ? 'JavaScript syntax check for the generated regression artifact.'
        : 'Markdown sanity check for the fallback artifact.'],
    },
  };
}

export function externalBlockerArtifact(message: string): PatchabilityArtifact {
  return {
    type: 'external_blocker',
    reportClass: 'external_blocker',
    reason: message,
    targetFiles: [],
    verificationPlan: [],
    blocker: message,
  };
}

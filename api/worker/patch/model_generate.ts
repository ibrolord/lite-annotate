import type { CodeIndex, IndexedCodeFile, RankedCandidateFile, ReportLike } from '../../indexing/code_index.js';
import type { Diagnosis } from '../diagnosis/diagnosis.js';
import type { GeneratedPatch } from './generate.js';

export interface CodePatchGeneratorInput {
  report: ReportLike;
  diagnosis: Diagnosis;
  candidates: RankedCandidateFile[];
  index?: CodeIndex;
  allowRepoFileSelection?: boolean;
  customInstructions?: string;
}

export type CodePatchGenerator = (input: CodePatchGeneratorInput) => Promise<GeneratedPatch>;

interface OpenAICodePatchGeneratorOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface ModelPatchFile {
  path?: unknown;
  content?: unknown;
}

interface ModelPatchResponse {
  ok?: unknown;
  summary?: unknown;
  files?: unknown;
  error?: unknown;
  risks?: unknown;
}

const DEFAULT_CODE_MODEL = 'gpt-5.3-codex-spark';
const MAX_CONTEXT_FILES = 4;
const MAX_FILE_CHARS = 18_000;
const MAX_REPO_CONTEXT_FILES = 16;
const MAX_REPO_CONTEXT_CHARS = 70_000;

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated by Lite Annotate]`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function compactReport(report: ReportLike): ReportLike {
  return {
    repo: report.repo,
    title: report.title,
    description: report.description,
    url: report.url,
    route: report.route,
    annotation: report.annotation,
    console: report.console?.slice(0, 8),
    consoleLogs: report.consoleLogs?.slice(0, 8),
    network: report.network?.slice(0, 12),
    session: report.session?.slice(0, 12),
  };
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function editableRepoFiles(input: CodePatchGeneratorInput): IndexedCodeFile[] {
  return (input.index?.files ?? []).filter((file) => !isTestPath(file.path));
}

function repoManifest(input: CodePatchGeneratorInput): string {
  const files = editableRepoFiles(input);
  if (files.length === 0) return 'No indexed repo files were available.';

  return files
    .map((file) => [
      `- ${file.path}`,
      `  language: ${file.language}`,
      file.routeHints.length > 0 ? `  routes: ${file.routeHints.slice(0, 8).join(', ')}` : '',
      file.exports.length > 0 ? `  exports: ${file.exports.slice(0, 8).join(', ')}` : '',
      file.functions.length > 0 ? `  functions: ${file.functions.slice(0, 8).join(', ')}` : '',
      file.components.length > 0 ? `  components: ${file.components.slice(0, 8).join(', ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n');
}

function rankedCandidatesByPath(input: CodePatchGeneratorInput): Map<string, RankedCandidateFile> {
  return new Map(input.candidates.map((candidate) => [candidate.path, candidate]));
}

function targetCandidates(input: CodePatchGeneratorInput): RankedCandidateFile[] {
  const targets = new Set(input.diagnosis.targetFiles);
  const rankedTargets = input.candidates.filter((candidate) => targets.has(candidate.path));
  const extras = input.candidates.filter((candidate) => !targets.has(candidate.path)).slice(0, MAX_CONTEXT_FILES);
  return [...rankedTargets, ...extras].slice(0, MAX_CONTEXT_FILES);
}

function repoContextFiles(input: CodePatchGeneratorInput): IndexedCodeFile[] {
  if (!input.allowRepoFileSelection || !input.index) {
    return targetCandidates(input).map((candidate) => candidate.file);
  }

  const rankedPaths = input.candidates.map((candidate) => candidate.path);
  const byPath = new Map(editableRepoFiles(input).map((file) => [file.path, file]));
  const ordered = [
    ...rankedPaths.map((path) => byPath.get(path)).filter((file): file is IndexedCodeFile => Boolean(file)),
    ...[...byPath.values()].filter((file) => !rankedPaths.includes(file.path)),
  ];

  const selected: IndexedCodeFile[] = [];
  let budget = 0;
  for (const file of ordered) {
    if (selected.length >= MAX_REPO_CONTEXT_FILES) break;
    const nextSize = Math.min(file.content.length, MAX_FILE_CHARS);
    if (selected.length > 0 && budget + nextSize > MAX_REPO_CONTEXT_CHARS) continue;
    selected.push(file);
    budget += nextSize;
  }
  return selected;
}

function promptFor(input: CodePatchGeneratorInput): string {
  const rankedByPath = rankedCandidatesByPath(input);
  const editableFiles = repoContextFiles(input)
    .map((file) => {
      const candidate = rankedByPath.get(file.path);
      return [
        `### ${file.path}`,
        `Reasons: ${candidate?.reasons.join('; ') || (input.allowRepoFileSelection ? 'repo file available for model selection' : 'ranked candidate')}`,
        '```text',
        truncate(file.content, MAX_FILE_CHARS),
        '```',
      ].join('\n');
    })
    .join('\n\n');

  return [
    'Generate a minimal production code patch for this browser bug report.',
    '',
    'Rules:',
    '- Return full replacement content only for files you actually change.',
    input.allowRepoFileSelection
      ? '- You may modify any provided editable repo file. Pick the correct file(s) yourself; local ranking is only a hint.'
      : '- You may only modify diagnosis.targetFiles.',
    '- Prefer one file; use at most two files.',
    '- Do not invent files, tests, metadata, or plan artifacts.',
    '- Preserve the app design and make the narrowest change that addresses the report.',
    '- If the provided files are insufficient, return ok=false with a short error.',
    '',
    'Bug report JSON:',
    safeJson(compactReport(input.report)),
    '',
    'Diagnosis JSON:',
    safeJson(input.diagnosis),
    '',
    'Custom Auto-Fix instructions:',
    input.customInstructions?.trim()
      ? truncate(input.customInstructions.trim(), 2_000)
      : 'None provided.',
    '',
    input.allowRepoFileSelection ? 'Whole repo manifest:' : 'Ranked context manifest:',
    input.allowRepoFileSelection ? repoManifest(input) : input.candidates.slice(0, MAX_CONTEXT_FILES).map((candidate) => `- ${candidate.path}: ${candidate.reasons.join('; ')}`).join('\n'),
    '',
    'Editable repo files and context:',
    editableFiles || 'No repo files were provided.',
  ].join('\n');
}

function responseText(data: unknown): string {
  const record = data as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === 'string') return record.output_text;

  if (Array.isArray(record.output)) {
    const chunks: string[] = [];
    for (const item of record.output) {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === 'string') chunks.push(text);
      }
    }
    return chunks.join('\n');
  }

  return '';
}

function parseModelPatch(text: string, model: string, allowedPaths: Set<string>): GeneratedPatch {
  let parsed: ModelPatchResponse;
  try {
    parsed = JSON.parse(text) as ModelPatchResponse;
  } catch {
    return { ok: false, files: [], source: 'llm', model, error: 'Model did not return valid JSON.' };
  }

  if (parsed.ok === false) {
    return {
      ok: false,
      files: [],
      source: 'llm',
      model,
      error: typeof parsed.error === 'string' ? parsed.error : 'Model declined to produce a patch.',
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    };
  }

  if (!Array.isArray(parsed.files)) {
    return { ok: false, files: [], source: 'llm', model, error: 'Model response did not include files[].' };
  }

  const files = parsed.files
    .map((file: ModelPatchFile) => ({
      path: typeof file.path === 'string' ? file.path : '',
      content: typeof file.content === 'string' ? file.content : '',
    }))
    .filter((file) => file.path && file.content);

  if (files.length === 0) {
    return { ok: false, files: [], source: 'llm', model, error: 'Model returned no changed file content.' };
  }

  if (files.length > 2) {
    return { ok: false, files: [], source: 'llm', model, error: 'Model attempted to modify more than two files.' };
  }

  const outsideScope = files.find((file) => !allowedPaths.has(file.path));
  if (outsideScope) {
    return {
      ok: false,
      files: [],
      source: 'llm',
      model,
      error: `Model attempted to modify ${outsideScope.path} outside diagnosis.targetFiles.`,
    };
  }

  return {
    ok: true,
    files,
    source: 'llm',
    model,
    summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
    risks: Array.isArray(parsed.risks) ? parsed.risks.filter((risk): risk is string => typeof risk === 'string') : undefined,
  };
}

export function createOpenAICodePatchGenerator(options: OpenAICodePatchGeneratorOptions): CodePatchGenerator {
  const model = options.model?.trim() || DEFAULT_CODE_MODEL;
  const baseUrl = (options.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/$/, '');

  return async (input) => {
    const allowedPaths = input.allowRepoFileSelection && input.index
      ? new Set(editableRepoFiles(input).map((file) => file.path))
      : new Set(input.diagnosis.targetFiles);
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'summary', 'error', 'risks', 'files'],
      properties: {
        ok: { type: 'boolean' },
        summary: { type: 'string' },
        error: { type: 'string' },
        risks: { type: 'array', items: { type: 'string' } },
        files: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'content'],
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
          },
        },
      },
    };

    const modelCandidates = model === DEFAULT_CODE_MODEL ? [model, 'gpt-5.3-codex'] : [model];
    let lastError = '';
    for (const candidateModel of modelCandidates) {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: candidateModel,
          input: [
            {
              role: 'system',
              content: 'You are a senior coding agent. Return only schema-valid JSON patches against the provided files.',
            },
            {
              role: 'user',
              content: promptFor(input),
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'lite_annotate_autofix_patch',
              strict: true,
              schema,
            },
          },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        lastError = `OpenAI patch generation failed with ${candidateModel}: ${response.status} ${truncate(errorText, 500)}`.trim();
        continue;
      }

      const data = await response.json() as unknown;
      return parseModelPatch(responseText(data), candidateModel, allowedPaths);
    }

    return {
      ok: false,
      files: [],
      source: 'llm',
      model,
      error: lastError || 'OpenAI patch generation failed before returning a response.',
    };
  };
}

export function createOpenAICodePatchGeneratorFromEnv(): CodePatchGenerator | undefined {
  if (process.env.AUTOFIX_DISABLE_LLM_PATCH === 'true') return undefined;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return createOpenAICodePatchGenerator({
    apiKey,
    model: process.env.AUTOFIX_CODE_MODEL || DEFAULT_CODE_MODEL,
    baseUrl: process.env.OPENAI_BASE_URL,
  });
}

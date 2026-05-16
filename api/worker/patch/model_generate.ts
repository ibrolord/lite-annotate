import type { RankedCandidateFile, ReportLike } from '../../indexing/code_index.js';
import type { Diagnosis } from '../diagnosis/diagnosis.js';
import type { GeneratedPatch } from './generate.js';

export interface CodePatchGeneratorInput {
  report: ReportLike;
  diagnosis: Diagnosis;
  candidates: RankedCandidateFile[];
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

const DEFAULT_CODE_MODEL = 'gpt-5.3-codex';
const MAX_CONTEXT_FILES = 4;
const MAX_FILE_CHARS = 18_000;

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

function targetCandidates(input: CodePatchGeneratorInput): RankedCandidateFile[] {
  const targets = new Set(input.diagnosis.targetFiles);
  const rankedTargets = input.candidates.filter((candidate) => targets.has(candidate.path));
  const extras = input.candidates.filter((candidate) => !targets.has(candidate.path)).slice(0, MAX_CONTEXT_FILES);
  return [...rankedTargets, ...extras].slice(0, MAX_CONTEXT_FILES);
}

function promptFor(input: CodePatchGeneratorInput): string {
  const editableFiles = targetCandidates(input)
    .map((candidate) => [
      `### ${candidate.path}`,
      `Reasons: ${candidate.reasons.join('; ') || 'ranked candidate'}`,
      '```text',
      truncate(candidate.file.content, MAX_FILE_CHARS),
      '```',
    ].join('\n'))
    .join('\n\n');

  return [
    'Generate a minimal production code patch for this browser bug report.',
    '',
    'Rules:',
    '- Return full replacement content only for files you actually change.',
    '- You may only modify diagnosis.targetFiles.',
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
    const allowedPaths = new Set(input.diagnosis.targetFiles);
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

    const response = await fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
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
      return {
        ok: false,
        files: [],
        source: 'llm',
        model,
        error: `OpenAI patch generation failed: ${response.status} ${truncate(errorText, 500)}`.trim(),
      };
    }

    const data = await response.json() as unknown;
    return parseModelPatch(responseText(data), model, allowedPaths);
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

import type { LiteReport } from './report_contract.js';

export type TriageVerdict = 'real_bug' | 'likely_bug' | 'needs_more_info' | 'not_a_bug';
export type TriageConfidence = 'low' | 'medium' | 'high';
export type TriageNextAction = 'run_autofix' | 'investigate' | 'ask_reporter' | 'ignore';

export interface ReportTriage {
  verdict: TriageVerdict;
  confidence: TriageConfidence;
  isRealBug: boolean;
  userSummary: string;
  agentReport: string;
  headline: string;
  rationale: string;
  evidence: string[];
  nextAction: TriageNextAction;
  source: 'llm' | 'heuristic';
  model: string;
  latencyMs: number;
  createdAt: string;
  error?: string;
}

interface TriageOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

interface ModelTriageResponse {
  verdict?: unknown;
  confidence?: unknown;
  isRealBug?: unknown;
  userSummary?: unknown;
  agentReport?: unknown;
  headline?: unknown;
  rationale?: unknown;
  evidence?: unknown;
  nextAction?: unknown;
}

const DEFAULT_TRIAGE_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TRIAGE_TIMEOUT_MS = 8000;

export async function runReportTriage(report: LiteReport, options: TriageOptions = {}): Promise<ReportTriage> {
  const started = Date.now();
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const model = options.model?.trim() || process.env.TRIAGE_MODEL?.trim() || DEFAULT_TRIAGE_MODEL;
  const baseUrl = (options.baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? readTimeoutMs();

  if (!apiKey) {
    return heuristicTriage(report, started, 'heuristic', 'No ANTHROPIC_API_KEY configured.');
  }

  try {
    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        temperature: 0,
        system: [
          'You triage browser bug reports for a lightweight QA tool.',
          'Decide whether the report describes a real product bug using only captured browser evidence.',
          'First summarize what the user said in plain language.',
          'Then write your own short triage report explaining what the browser evidence shows.',
          'Do not claim to inspect source code, repositories, or screenshots beyond the provided text fields.',
          'Optimize for speed and give one concrete next action.',
          'Return only compact JSON matching this schema:',
          JSON.stringify(triageSchema()),
        ].join(' '),
        messages: [
          {
            role: 'user',
            content: `Bug report JSON:\n${JSON.stringify(compactReport(report))}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return heuristicTriage(report, started, model, `LLM triage failed: ${response.status} ${truncate(body, 300)}`.trim());
    }

    const parsed = parseModelTriage(anthropicMessageText(await response.json()), model, Date.now() - started);
    return parsed ?? heuristicTriage(report, started, model, 'LLM triage returned invalid JSON.');
  } catch (err) {
    return heuristicTriage(report, started, model, `LLM triage unavailable: ${errorMessage(err)}`);
  }
}

function heuristicTriage(report: LiteReport, started: number, model: string, error?: string): ReportTriage {
  const consoleError = firstConsoleError(report);
  const failedNetwork = firstFailedNetwork(report);
  const hasUserClaim = Boolean(report.title.trim() || report.description.trim());
  const hasInteraction = report.session.length > 0 || Boolean(report.annotation.target);
  const userSummary = summarizeUserReport(report);
  const evidence: string[] = [];

  if (consoleError) evidence.push(`Console error: ${consoleError}`);
  if (failedNetwork) evidence.push(`Network failure: ${failedNetwork.method} ${failedNetwork.url} -> ${failedNetwork.status ?? failedNetwork.error ?? 'failed'}`);
  if (report.annotation.target) evidence.push(`Pinned target: ${report.annotation.target}`);
  if (report.route) evidence.push(`Route: ${report.route}`);

  if (consoleError || failedNetwork) {
    return {
      verdict: 'real_bug',
      confidence: consoleError && failedNetwork ? 'high' : 'medium',
      isRealBug: true,
      userSummary,
      agentReport: 'The captured browser evidence includes a runtime or request failure that lines up with the user report. This is strong enough to treat as a real bug before running repo-aware Auto-Fix.',
      headline: consoleError ? 'Captured runtime evidence supports a real bug' : 'Captured network evidence supports a real bug',
      rationale: 'The report includes browser-level failure evidence, so it is worth moving into investigation or Auto-Fix.',
      evidence: evidence.slice(0, 4),
      nextAction: 'run_autofix',
      source: 'heuristic',
      model,
      latencyMs: Date.now() - started,
      createdAt: new Date().toISOString(),
      error,
    };
  }

  if (hasUserClaim && hasInteraction) {
    return {
      verdict: 'likely_bug',
      confidence: 'low',
      isRealBug: true,
      userSummary,
      agentReport: 'The report describes a plausible user-visible issue, but the capture does not include a console error or failed network request. Treat it as a likely bug that needs a lightweight investigation before patching.',
      headline: 'User report is plausible but lacks hard failure evidence',
      rationale: 'The report has a user-visible complaint and interaction context, but no console or failed-network breadcrumb was captured.',
      evidence: evidence.length ? evidence.slice(0, 4) : ['User supplied a title or description and interaction context.'],
      nextAction: 'investigate',
      source: 'heuristic',
      model,
      latencyMs: Date.now() - started,
      createdAt: new Date().toISOString(),
      error,
    };
  }

  return {
    verdict: hasUserClaim ? 'needs_more_info' : 'not_a_bug',
    confidence: 'low',
    isRealBug: false,
    userSummary,
    agentReport: 'The capture does not include enough evidence to separate a product bug from feedback, unclear reproduction, or noise. Ask for a clearer reproduction before spending Auto-Fix time.',
    headline: hasUserClaim ? 'More evidence is needed before treating this as a bug' : 'No actionable bug report was captured',
    rationale: 'The captured report does not include enough browser evidence to distinguish a product bug from feedback or noise.',
    evidence: evidence.length ? evidence.slice(0, 4) : ['No console error, failed network request, or pinned interaction was captured.'],
    nextAction: hasUserClaim ? 'ask_reporter' : 'ignore',
    source: 'heuristic',
    model,
    latencyMs: Date.now() - started,
    createdAt: new Date().toISOString(),
    error,
  };
}

function compactReport(report: LiteReport): Record<string, unknown> {
  return {
    id: report.id,
    title: report.title,
    description: report.description,
    route: report.route,
    url: report.url,
    annotation: {
      target: report.annotation.target,
      selector: report.annotation.selector,
      description: report.annotation.description,
    },
    console: report.console.slice(-6).map((entry) => ({
      level: entry.level,
      message: truncate(entry.message, 500),
      source: entry.source,
      stack: entry.stack ? truncate(entry.stack, 800) : undefined,
    })),
    network: report.network.slice(-8).map((entry) => ({
      method: entry.method,
      url: entry.url,
      status: entry.status,
      failed: entry.failed,
      error: entry.error,
    })),
    session: report.session.slice(-8).map((entry) => ({
      type: entry.type,
      target: entry.target,
      route: entry.route,
    })),
    screenshot: report.screenshot.type === 'data-url-or-url' ? 'captured' : `missing: ${report.screenshot.reason ?? 'unknown'}`,
  };
}

function summarizeUserReport(report: LiteReport): string {
  const title = stripTrailingPunctuation(report.title.trim());
  const description = stripTrailingPunctuation(report.description.trim());
  const target = report.annotation.target?.trim();
  const route = report.route.trim();
  const parts = [
    title || 'The user submitted a report',
    description && description !== title ? description : '',
    target ? `They pinned ${target}` : '',
    route ? `on ${route}` : '',
  ].filter(Boolean);
  return parts.join('. ').replace(/\.\s+on /, ' on ').replace(/\.\s+\./g, '.');
}

function parseModelTriage(text: string, model: string, latencyMs: number): ReportTriage | null {
  let data: ModelTriageResponse;
  try {
    data = JSON.parse(extractJsonObject(text)) as ModelTriageResponse;
  } catch {
    return null;
  }

  const verdict = parseVerdict(data.verdict);
  const confidence = parseConfidence(data.confidence);
  const nextAction = parseNextAction(data.nextAction);
  const headline = typeof data.headline === 'string' ? data.headline.trim() : '';
  const rationale = typeof data.rationale === 'string' ? data.rationale.trim() : '';
  const userSummary = typeof data.userSummary === 'string' ? data.userSummary.trim() : '';
  const agentReport = typeof data.agentReport === 'string' ? data.agentReport.trim() : '';
  const evidence = Array.isArray(data.evidence)
    ? data.evidence.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 5)
    : [];
  if (!verdict || !confidence || !nextAction || !userSummary || !agentReport || !headline || !rationale || evidence.length === 0) return null;

  return {
    verdict,
    confidence,
    isRealBug: typeof data.isRealBug === 'boolean' ? data.isRealBug : verdict === 'real_bug' || verdict === 'likely_bug',
    userSummary,
    agentReport,
    headline,
    rationale,
    evidence,
    nextAction,
    source: 'llm',
    model,
    latencyMs,
    createdAt: new Date().toISOString(),
  };
}

function triageSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'confidence', 'isRealBug', 'userSummary', 'agentReport', 'headline', 'rationale', 'evidence', 'nextAction'],
    properties: {
      verdict: { type: 'string', enum: ['real_bug', 'likely_bug', 'needs_more_info', 'not_a_bug'] },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      isRealBug: { type: 'boolean' },
      userSummary: { type: 'string' },
      agentReport: { type: 'string' },
      headline: { type: 'string' },
      rationale: { type: 'string' },
      evidence: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
      nextAction: { type: 'string', enum: ['run_autofix', 'investigate', 'ask_reporter', 'ignore'] },
    },
  };
}

function anthropicMessageText(data: unknown): string {
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const item = part as { type?: unknown; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function firstConsoleError(report: LiteReport): string | null {
  const entry = report.console.find((item) => /error|exception|fatal/i.test(item.level) && item.message.trim())
    ?? report.console.find((item) => /error|exception|cannot read|failed|crash/i.test(item.message));
  return entry?.message ? truncate(entry.message, 240) : null;
}

function firstFailedNetwork(report: LiteReport): LiteReport['network'][number] | undefined {
  return report.network.find((entry) => entry.failed || (typeof entry.status === 'number' && entry.status >= 400));
}

function parseVerdict(value: unknown): TriageVerdict | null {
  return value === 'real_bug' || value === 'likely_bug' || value === 'needs_more_info' || value === 'not_a_bug'
    ? value
    : null;
}

function parseConfidence(value: unknown): TriageConfidence | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

function parseNextAction(value: unknown): TriageNextAction | null {
  return value === 'run_autofix' || value === 'investigate' || value === 'ask_reporter' || value === 'ignore'
    ? value
    : null;
}

function readTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.TRIAGE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRIAGE_TIMEOUT_MS;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.!?\s]+$/g, '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

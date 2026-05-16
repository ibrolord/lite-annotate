import type { LiteReport } from './report_contract.js';

export type GStackJobMode = 'investigate' | 'review_fix' | 'qa' | 'ship';

export interface GStackReviewRequest {
  reportId: string;
  repo: string;
  mode: GStackJobMode;
  allowPr: boolean;
  report: LiteReport;
  reportUrl?: string;
  memoryUrl?: string;
  handoffUrl?: string;
  callbackUrl: string;
}

export interface StoredGStackReviewRecord extends Record<string, unknown> {
  jobId: string;
  reportId: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'blocked';
  mode: GStackJobMode;
  runnerUrl?: string;
  createdAt: string;
  updatedAt: string;
  result?: GStackReviewResult;
  error?: string;
}

export interface GStackReviewResult extends Record<string, unknown> {
  jobId: string;
  reportId: string;
  status: StoredGStackReviewRecord['status'];
  mode?: GStackJobMode;
  commandsRun: string[];
  summary: string;
  diagnosis?: string;
  findings?: Array<{ severity: string; message: string; file?: string; line?: number }>;
  tests?: Array<{ command: string; status: 'passed' | 'failed' | 'skipped'; output?: string }>;
  prUrl?: string;
  commitSha?: string;
  logs?: string;
  completedAt: string;
}

export async function createRemoteGStackReview(input: GStackReviewRequest): Promise<StoredGStackReviewRecord> {
  const runnerUrl = process.env.GSTACK_RUNNER_URL?.replace(/\/+$/, '');
  if (!runnerUrl) {
    throw new Error('GSTACK_RUNNER_URL is not configured');
  }

  const response = await fetch(`${runnerUrl}/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(process.env.GSTACK_RUNNER_TOKEN),
    },
    body: JSON.stringify(input),
  });

  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`GStack runner rejected job: ${response.status} ${JSON.stringify(body)}`);
  }

  const jobId = typeof body.jobId === 'string' ? body.jobId : '';
  if (!jobId) throw new Error('GStack runner response did not include jobId');

  const now = new Date().toISOString();
  const status = typeof body.status === 'string' ? body.status : 'queued';
  return {
    jobId,
    reportId: input.reportId,
    status: normalizeRunnerStatus(status),
    mode: input.mode,
    runnerUrl,
    createdAt: now,
    updatedAt: now,
  };
}

export function requireInternalToken(request: Request): void {
  const expected = process.env.GSTACK_CALLBACK_TOKEN;
  if (!expected) throw new Error('GSTACK_CALLBACK_TOKEN is not configured');
  const actual = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (actual !== expected) throw new Error('invalid internal token');
}

function authHeader(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function normalizeRunnerStatus(value: string): StoredGStackReviewRecord['status'] {
  if (value === 'running' || value === 'passed' || value === 'failed' || value === 'blocked') return value;
  return 'queued';
}

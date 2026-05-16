import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryAdapter, type MemoryAdapter, type MemorySearchResult } from './gbrain.js';
import {
  createRemoteGStackReview,
  requireInternalToken,
  type GStackJobMode,
  type GStackReviewResult,
  type StoredGStackReviewRecord,
} from './gstack_runner.js';
import { normalizeReportPayload, ReportValidationError } from './report_contract.js';
import { ReportStore, type StoredReportRecord } from './report_store.js';
import type { LiteReport } from './report_contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

interface AutofixRunnerContext {
  dryRun: boolean;
}

export function createApp(deps: {
  store?: ReportStore;
  memory?: MemoryAdapter;
  autofixRunner?: (reportId: string, report: LiteReport, context: AutofixRunnerContext) => Promise<unknown>;
} = {}) {
  const app = new Hono();
  const store = deps.store ?? new ReportStore();
  const memory = deps.memory ?? createMemoryAdapter();
  const autofixRunner: (reportId: string, report: LiteReport, context: AutofixRunnerContext) => Promise<unknown> =
    deps.autofixRunner ??
    (async (reportId, report, context) => {
      const { runAutofix } = await import('./autofix.js');
      return runAutofix(reportId, report as unknown as Parameters<typeof runAutofix>[1], {
        skipPR: context.dryRun,
      });
    });

  app.use('*', cors());

  app.get('/', (c) => c.redirect('/demo'));
  app.get('/health', (c) => c.json({ ok: true }));

  app.get('/widget.js', async (c) => {
    const widget = await readFile(join(repoRoot, 'widget', 'index.js'), 'utf8');
    return c.body(widget, 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
  });

  app.get('/demo', async (c) => {
    const html = await readFile(join(repoRoot, 'demo-app', 'index.html'), 'utf8');
    return c.html(html);
  });

  app.post('/report', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', issues: ['body must be valid JSON'] }, 400);
    }

    const reportId = `bug_${randomUUID()}`;
    try {
      const report = normalizeReportPayload(body, { id: reportId, createdAt: new Date().toISOString() });
      const memoryEntry = await memory.putReport(report);
      await store.put({
        report,
        raw: body,
        memory: memoryEntry,
        updatedAt: new Date().toISOString(),
      });

      console.log(`[report] received ${report.id}: "${report.title}" from ${report.route}`);
      return c.json({
        reportId: report.id,
        id: report.id,
        status: 'received',
        memory: memoryEntry,
        reportUrl: `/reports/${report.id}`,
        handoffUrl: `/reports/${report.id}/handoff`,
      }, 201);
    } catch (err) {
      if (err instanceof ReportValidationError) {
        return c.json({ error: 'invalid_report', issues: err.issues }, err.statusCode);
      }
      console.error('[report] failed:', err);
      return c.json({ error: 'report_failed', message: errorMessage(err) }, 500);
    }
  });

  app.get('/reports', async (c) => {
    return c.json({ reports: await store.list() });
  });

  app.get('/reports/dashboard', async (c) => {
    return c.html(renderReportsDashboard(await store.listRecords()));
  });

  app.get('/reports/:id', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    return c.json(record.report);
  });

  app.get('/reports/:id/raw', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    return c.json({ report: record.report, raw: record.raw, memory: record.memory });
  });

  app.post('/reports/:id/repo', async (c) => {
    const reportId = c.req.param('id');
    const record = await store.get(reportId);
    if (!record) return c.json({ error: 'not_found' }, 404);

    const body = await c.req.parseBody();
    const repo = normalizeEditableRepo(body.repo);
    if (!repo) {
      return c.json({
        error: 'invalid_repo',
        message: 'Repo must be a GitHub owner/repo value, for example ibrolord/lite-annotate-commerce-demo.',
      }, 400);
    }

    const updated = await store.update(reportId, (current) => ({
      ...current,
      report: {
        ...current.report,
        repo,
      },
      raw: updateRawRepo(current.raw, repo),
      autofix: undefined,
      gstackReview: undefined,
      updatedAt: new Date().toISOString(),
    }));

    if (c.req.header('accept')?.includes('application/json')) {
      return c.json({ reportId: updated?.report.id ?? reportId, repo: updated?.report.repo ?? repo });
    }
    return c.redirect(`/reports/${encodeURIComponent(reportId)}/view`, 303);
  });

  app.get('/reports/:id/memory', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const similar = await memory.searchSimilar(record.report);
    const memoryImpact = buildMemoryImpact(record.report, record.memory, similar, record.autofix ?? null);
    const agentComparison = buildAgentComparison(memoryImpact, record.autofix ?? null);
    const memoryReceipts = buildMemoryReceipts(record.report, memoryImpact, record.autofix ?? null);
    return c.json({ reportId: record.report.id, memory: record.memory, similar, memoryImpact, agentComparison, memoryReceipts });
  });

  app.get('/reports/:id/handoff', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const similar = await memory.searchSimilar(record.report);
    const memoryImpact = buildMemoryImpact(record.report, record.memory, similar, record.autofix ?? null);
    const agentComparison = buildAgentComparison(memoryImpact, record.autofix ?? null);
    const memoryReceipts = buildMemoryReceipts(record.report, memoryImpact, record.autofix ?? null);
    return c.json({
      reportId: record.report.id,
      repo: record.report.repo,
      normalizedReport: record.report,
      memorySearchResult: similar,
      memoryImpact,
      agentComparison,
      memoryReceipts,
      autofix: record.autofix ?? null,
    });
  });

  app.get('/reports/:id/view', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.html('<h1>Report not found</h1>', 404);
    const similar = await memory.searchSimilar(record.report);
    const memoryImpact = buildMemoryImpact(record.report, record.memory, similar, record.autofix ?? null);
    const agentComparison = buildAgentComparison(memoryImpact, record.autofix ?? null);
    const memoryReceipts = buildMemoryReceipts(record.report, memoryImpact, record.autofix ?? null);
    return c.html(renderReportHtml(
      record.report.id,
      record.report,
      record.raw,
      record.memory,
      similar,
      memoryImpact,
      agentComparison,
      memoryReceipts,
      record.autofix ?? null,
      record.gstackReview ?? null
    ));
  });

  app.get('/reports/:id/autofix', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    return c.json({ reportId: record.report.id, autofix: record.autofix ?? null });
  });

  app.get('/reports/:id/gstack-review', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    return c.json({ reportId: record.report.id, gstackReview: record.gstackReview ?? null });
  });

  app.get('/reports/:id/gstack/investigation', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    return c.json({
      reportId: record.report.id,
      investigation: buildGStackInvestigation(record.report, record.gstackReview ?? null),
    });
  });

  app.post('/reports/:id/gstack/investigate', async (c) => {
    const auth = requireGStackProductTrigger(c.req.raw);
    if (!auth.ok) return c.json({ error: auth.error, message: auth.message }, auth.status);

    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);

    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
    const callbackBaseUrl = process.env.GSTACK_CALLBACK_BASE_URL?.replace(/\/+$/, '') ?? publicBaseUrl;
    if (!callbackBaseUrl) {
      return c.json({ error: 'gstack_not_configured', message: 'PUBLIC_BASE_URL or GSTACK_CALLBACK_BASE_URL is required' }, 503);
    }

    try {
      const job = await createRemoteGStackReview({
        reportId: record.report.id,
        repo: record.report.repo,
        mode: 'investigate',
        allowPr: false,
        report: record.report,
        reportUrl: publicBaseUrl ? `${publicBaseUrl}/reports/${encodeURIComponent(record.report.id)}` : undefined,
        memoryUrl: publicBaseUrl ? `${publicBaseUrl}/reports/${encodeURIComponent(record.report.id)}/memory` : undefined,
        handoffUrl: publicBaseUrl ? `${publicBaseUrl}/reports/${encodeURIComponent(record.report.id)}/handoff` : undefined,
        callbackUrl: `${callbackBaseUrl}/internal/gstack-callback`,
      });
      const updated = await store.update(record.report.id, (current) => ({
        ...current,
        gstackReview: mergeQueuedGStackReview(current.gstackReview, job),
        updatedAt: new Date().toISOString(),
      }));
      return c.json({
        reportId: record.report.id,
        investigation: buildGStackInvestigation(record.report, updated?.gstackReview ?? job),
      }, 202);
    } catch (err) {
      return c.json({ error: 'gstack_job_failed', message: errorMessage(err) }, 502);
    }
  });

  app.post('/reports/:id/gstack-review', async (c) => {
    const auth = requireConfiguredBearer(c.req.raw, 'GSTACK_TRIGGER_TOKEN');
    if (!auth.ok) return c.json({ error: auth.error, message: auth.message }, auth.status);

    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }

    const mode = parseGStackMode(body.workflow ?? body.mode);
    if (body.allowPr === true && process.env.GSTACK_ALLOW_PR !== '1') {
      return c.json({ error: 'pr_not_allowed', message: 'GSTACK_ALLOW_PR=1 is required before remote GStack jobs may open PRs' }, 403);
    }
    const allowPr = body.allowPr === true;
    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
    const callbackBaseUrl = process.env.GSTACK_CALLBACK_BASE_URL?.replace(/\/+$/, '') ?? publicBaseUrl;
    if (!callbackBaseUrl) {
      return c.json({ error: 'gstack_not_configured', message: 'PUBLIC_BASE_URL or GSTACK_CALLBACK_BASE_URL is required' }, 503);
    }

    try {
      const job = await createRemoteGStackReview({
        reportId: record.report.id,
        repo: record.report.repo,
        mode,
        allowPr,
        report: record.report,
        reportUrl: publicBaseUrl ? `${publicBaseUrl}/reports/${encodeURIComponent(record.report.id)}` : undefined,
        memoryUrl: publicBaseUrl ? `${publicBaseUrl}/reports/${encodeURIComponent(record.report.id)}/memory` : undefined,
        handoffUrl: publicBaseUrl ? `${publicBaseUrl}/reports/${encodeURIComponent(record.report.id)}/handoff` : undefined,
        callbackUrl: `${callbackBaseUrl}/internal/gstack-callback`,
      });
      const updated = await store.update(record.report.id, (current) => ({
        ...current,
        gstackReview: mergeQueuedGStackReview(current.gstackReview, job),
        updatedAt: new Date().toISOString(),
      }));
      return c.json({ reportId: record.report.id, gstackReview: updated?.gstackReview ?? job }, 202);
    } catch (err) {
      return c.json({ error: 'gstack_job_failed', message: errorMessage(err) }, 502);
    }
  });

  app.post('/internal/gstack-callback', async (c) => {
    try {
      requireInternalToken(c.req.raw);
    } catch (err) {
      return c.json({ error: 'unauthorized', message: errorMessage(err) }, 401);
    }

    let result: GStackReviewResult;
    try {
      result = sanitizeGStackResult(await c.req.json() as GStackReviewResult);
    } catch {
      return c.json({ error: 'invalid_json', message: 'body must be valid JSON' }, 400);
    }
    if (!result.reportId || !result.jobId) {
      return c.json({ error: 'invalid_gstack_result', message: 'reportId and jobId are required' }, 400);
    }

    const record = await store.get(result.reportId);
    if (!record) return c.json({ error: 'not_found' }, 404);
    if (record.gstackReview?.jobId && record.gstackReview.jobId !== result.jobId) {
      return c.json({ error: 'job_mismatch' }, 409);
    }

    const updated = await store.update(result.reportId, (current) => ({
      ...current,
      gstackReview: {
        jobId: result.jobId,
        reportId: result.reportId,
        status: result.status,
        mode: result.mode ?? current.gstackReview?.mode ?? 'review_fix',
        runnerUrl: current.gstackReview?.runnerUrl,
        createdAt: current.gstackReview?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        result,
      },
      updatedAt: new Date().toISOString(),
    }));
    return c.json({ ok: true, gstackReview: updated?.gstackReview });
  });

  app.post('/reports/:id/autofix', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);

    try {
      const dryRun = isTruthyFlag(c.req.query('dryRun'));
      const result = await autofixRunner(record.report.id, record.report, { dryRun });
      const autofixSummary = summarizeAutofixResult(result);
      await memory.putDiagnosis(record.report.id, autofixSummary.diagnosis);
      await memory.putOutcome(record.report.id, {
        status: autofixSummary.status,
        pr: autofixSummary.pr,
        verification: autofixSummary.verification,
      });
      const similar = await memory.searchSimilar(record.report);
      const autofix = {
        ...autofixSummary,
        memoryImpact: buildMemoryImpact(record.report, record.memory, similar, autofixSummary),
      };
      const autofixWithDemoContext = {
        ...autofix,
        agentComparison: buildAgentComparison(autofix.memoryImpact, autofix),
        memoryReceipts: buildMemoryReceipts(record.report, autofix.memoryImpact, autofix),
      };
      const updated = await store.update(record.report.id, (current) => ({
        ...current,
        autofix: autofixWithDemoContext,
        updatedAt: new Date().toISOString(),
      }));
      return c.json({ reportId: record.report.id, autofix: updated?.autofix ?? autofixWithDemoContext });
    } catch (err) {
      const autofix = {
        status: 'failed',
        error: errorMessage(err),
        updatedAt: new Date().toISOString(),
      };
      await store.update(record.report.id, (current) => ({
        ...current,
        autofix,
        updatedAt: new Date().toISOString(),
      }));
      return c.json({ reportId: record.report.id, autofix }, 500);
    }
  });

  app.post('/reports/:id/diagnosis', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const diagnosis = await c.req.json();
    const memoryEntry = await memory.putDiagnosis(record.report.id, diagnosis);
    return c.json({ reportId: record.report.id, memory: memoryEntry });
  });

  app.post('/reports/:id/outcome', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const outcome = await c.req.json();
    const memoryEntry = await memory.putOutcome(record.report.id, outcome);
    return c.json({ reportId: record.report.id, memory: memoryEntry });
  });

  return app;
}

export const app = createApp();

function renderReportsDashboard(records: StoredReportRecord[]): string {
  const rows = records.map((record) => renderReportRow(record)).join('');
  const empty = records.length === 0
    ? '<tr><td colspan="9" class="empty">No reports captured yet. Submit one from <a href="/demo">the demo</a>.</td></tr>'
    : '';
  const readyCount = records.filter((record) => record.memory).length;
  const analyzedCount = records.filter((record) => record.autofix).length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lite Annotate Reports</title>
  <style>
    :root {
      color-scheme: light;
      --ink: oklch(0.21 0.018 248);
      --muted: oklch(0.46 0.022 248);
      --canvas: oklch(0.985 0.006 248);
      --panel: oklch(0.998 0.004 248);
      --line: oklch(0.89 0.012 248);
      --soft: oklch(0.955 0.012 248);
      --accent: oklch(0.51 0.17 258);
      --success: oklch(0.48 0.13 152);
      --warn: oklch(0.64 0.13 70);
    }
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; color: var(--ink); background: var(--canvas); }
    main { max-width: 1240px; margin: 0 auto; padding: 28px 20px 64px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding-bottom: 20px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
    h1 { font-size: 26px; line-height: 1.1; margin: 0 0 7px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .button { display: inline-flex; min-height: 40px; align-items: center; border: 1px solid var(--line); border-radius: 6px; padding: 0 12px; background: var(--panel); color: var(--ink); font-size: 14px; font-weight: 650; }
    .button:hover { background: var(--soft); text-decoration: none; }
    .queue-summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 16px; }
    .summary-item { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 0 11px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 13px; font-weight: 650; }
    .summary-item strong { color: var(--ink); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 0 10px 30px oklch(0.45 0.05 248 / .08); }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 12px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; font-size: 13px; }
    th { color: var(--muted); font-weight: 700; background: var(--soft); }
    tr:last-child td { border-bottom: 0; }
    .title { font-weight: 700; color: var(--ink); }
    .muted { color: var(--muted); }
    .pill { display: inline-flex; border-radius: 999px; padding: 3px 8px; font-size: 12px; font-weight: 650; background: oklch(0.95 0.045 152); color: oklch(0.36 0.11 152); border: 1px solid oklch(0.83 0.09 152); white-space: nowrap; }
    .pill.warn { background: oklch(0.96 0.04 75); color: oklch(0.39 0.1 70); border-color: oklch(0.84 0.09 75); }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .links a:first-child { font-weight: 750; }
    .empty { text-align: center; padding: 32px; color: var(--muted); }
    code { background: var(--soft); border-radius: 4px; padding: 1px 4px; overflow-wrap: anywhere; }
    a:focus-visible, .button:focus-visible { outline: 3px solid oklch(0.72 0.13 258); outline-offset: 3px; }
    @media (max-width: 760px) {
      header { display: block; }
      .actions { margin-top: 14px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Review queue</h1>
        <p>${records.length} saved ${records.length === 1 ? 'report' : 'reports'} ready for memory-aware engineering review.</p>
      </div>
      <nav class="actions">
        <a class="button" href="/demo">Demo</a>
        <a class="button" href="/reports">JSON</a>
      </nav>
    </header>
    <section class="queue-summary" aria-label="Queue summary">
      <span class="summary-item"><strong>${records.length}</strong> captured</span>
      <span class="summary-item"><strong>${readyCount}</strong> memory ready</span>
      <span class="summary-item"><strong>${analyzedCount}</strong> analyzed</span>
    </section>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Created</th>
            <th>Report</th>
            <th>Route</th>
            <th>Annotation</th>
            <th>Context</th>
            <th>Memory</th>
            <th>Analysis</th>
            <th>GStack</th>
            <th>Links</th>
          </tr>
        </thead>
        <tbody>${rows}${empty}</tbody>
      </table>
    </div>
  </main>
</body>
</html>`;
}

function renderReportRow(record: StoredReportRecord): string {
  const report = record.report;
  const memory = memorySummary(record.memory);
  const context = [
    `${report.console.length} console`,
    `${report.network.length} network`,
    `${report.session.length} session`,
    report.screenshot.type === 'data-url-or-url' ? 'screenshot' : `no screenshot: ${report.screenshot.reason || 'unknown'}`,
  ].join(' · ');

  return `<tr>
    <td><span title="${escapeHtml(report.createdAt)}">${escapeHtml(formatDate(report.createdAt))}</span></td>
    <td>
      <div class="title">${escapeHtml(report.title)}</div>
      <div class="muted"><code>${escapeHtml(report.id)}</code></div>
      <div class="muted">${escapeHtml(report.repo)}</div>
    </td>
    <td>
      <div>${escapeHtml(report.route)}</div>
      <div class="muted">${escapeHtml(shortUrl(report.url))}</div>
    </td>
    <td>
      <div>${escapeHtml(report.annotation.target || 'No target pinned')}</div>
      <div class="muted">${escapeHtml(report.annotation.selector || 'No selector')}</div>
    </td>
    <td>${escapeHtml(context)}</td>
    <td><span class="${memory.ok ? 'pill' : 'pill warn'}">${escapeHtml(memory.label)}</span></td>
    <td><span class="pill">${escapeHtml(analysisStatus(record.autofix))}</span></td>
    <td><span class="pill">${escapeHtml(gstackStatus(record.gstackReview))}</span></td>
    <td>
      <div class="links">
        <a href="/reports/${encodeURIComponent(report.id)}/view">Open report</a>
        <a href="/reports/${encodeURIComponent(report.id)}">json</a>
        <a href="/reports/${encodeURIComponent(report.id)}/memory">memory</a>
        <a href="/reports/${encodeURIComponent(report.id)}/handoff">handoff</a>
      </div>
    </td>
  </tr>`;
}

function memorySummary(memory: unknown): { ok: boolean; label: string } {
  if (!memory || typeof memory !== 'object') return { ok: false, label: 'not written' };
  const record = memory as { provider?: unknown; status?: unknown };
  const provider = typeof record.provider === 'string' ? record.provider : 'memory';
  const status = typeof record.status === 'string' ? record.status : 'written';
  return { ok: true, label: `${provider}: ${status}` };
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

function normalizeEditableRepo(value: unknown): string | null {
  const repo = typeof value === 'string' ? value.trim() : '';
  if (!repo) return null;

  const ownerRepo = repo.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (ownerRepo) return safeRepoSegments(ownerRepo[1], ownerRepo[2]);

  const httpsRepo = repo.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (httpsRepo) return safeRepoSegments(httpsRepo[1], httpsRepo[2]);

  const sshRepo = repo.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/i);
  if (sshRepo) return safeRepoSegments(sshRepo[1], sshRepo[2]);

  return null;
}

function safeRepoSegments(owner: string, repo: string): string | null {
  if ([owner, repo].some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return `${owner}/${repo}`;
}

function updateRawRepo(raw: unknown, repo: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  return { ...raw, repo };
}

function renderReportHtml(
  reportId: string,
  report: LiteReport,
  raw: unknown,
  memory: unknown,
  similar: unknown,
  memoryImpact: MemoryImpactSummary,
  agentComparison: AgentComparison,
  memoryReceipts: MemoryReceipt[],
  autofix: unknown,
  gstackReview: unknown
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lite Annotate Report ${escapeHtml(reportId)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: oklch(0.21 0.018 248);
      --muted: oklch(0.46 0.022 248);
      --canvas: oklch(0.982 0.006 248);
      --panel: oklch(0.998 0.003 248);
      --line: oklch(0.88 0.012 248);
      --soft: oklch(0.952 0.01 248);
      --accent: oklch(0.51 0.17 258);
      --danger: oklch(0.52 0.19 28);
      --warn: oklch(0.64 0.13 70);
      --success: oklch(0.48 0.13 152);
      --code: oklch(0.19 0.025 248);
      --code-text: oklch(0.93 0.012 248);
    }
    * { box-sizing: border-box; }
    body {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      margin: 0;
      color: var(--ink);
      background: linear-gradient(180deg, oklch(0.995 0.004 248), var(--canvas) 360px);
    }
    main { max-width: 1240px; margin: 0 auto; padding: 26px 20px 72px; }
    h1 { font-size: 28px; line-height: 1.08; margin: 0 0 8px; letter-spacing: 0; max-width: 760px; }
    h2 { margin: 0; font-size: 15px; }
    h3 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    a { color: var(--accent); }
    a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible { outline: 3px solid oklch(0.72 0.13 258); outline-offset: 3px; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; padding-bottom: 18px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }
    .subnav { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; color: var(--muted); font-size: 13px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; }
    form { margin: 0; }
    button { min-height: 42px; border-radius: 6px; padding: 0 13px; font: 700 14px system-ui, sans-serif; cursor: pointer; }
    .safe { border: 1px solid var(--accent); background: var(--accent); color: oklch(0.98 0.006 248); }
    .danger { border: 1px solid oklch(0.78 0.1 28); background: oklch(0.985 0.015 28); color: var(--danger); }
    input {
      width: 100%;
      min-height: 42px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 11px;
      background: var(--panel);
      color: var(--ink);
      font: 650 14px system-ui, sans-serif;
    }
    .stage-layout { display: grid; grid-template-columns: minmax(0, .62fr) minmax(300px, .38fr); gap: 18px; align-items: start; margin-bottom: 18px; }
    .layout { display: grid; grid-template-columns: minmax(300px, .42fr) minmax(0, .58fr); gap: 18px; align-items: start; }
    .inspector { position: sticky; top: 18px; display: grid; gap: 12px; }
    .stack { display: grid; gap: 12px; min-width: 0; }
    .surface { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: 0 16px 34px oklch(0.42 0.04 248 / .07); }
    .surface-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .evidence-list, .safety-list { display: grid; }
    .evidence-row, .safety-row {
      display: grid;
      grid-template-columns: 132px 1fr;
      gap: 12px;
      padding: 13px 16px;
      border-bottom: 1px solid var(--line);
      align-items: baseline;
    }
    .evidence-row:last-child, .safety-row:last-child { border-bottom: 0; }
    .evidence-row span, .safety-row span, .memory-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .evidence-row strong, .safety-row strong {
      display: block;
      font-size: 14px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .safety-row p { margin-top: 3px; }
    .repo-form { display: grid; gap: 10px; padding: 14px 16px 16px; }
    .repo-form label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .repo-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
    .repo-form button { border: 1px solid var(--line); background: var(--soft); color: var(--ink); }
    .analysis-body { padding: 14px 16px 16px; }
    .screen-stage { padding: 16px; }
    .screen-frame {
      min-height: 380px;
      display: grid;
      place-items: center;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 7px;
      background:
        linear-gradient(45deg, oklch(0.95 0.008 248) 25%, transparent 25%),
        linear-gradient(-45deg, oklch(0.95 0.008 248) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, oklch(0.95 0.008 248) 75%),
        linear-gradient(-45deg, transparent 75%, oklch(0.95 0.008 248) 75%),
        var(--panel);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0;
    }
    .screen-frame img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 620px;
      object-fit: contain;
      background: var(--panel);
    }
    .screen-empty {
      display: grid;
      gap: 8px;
      justify-items: center;
      padding: 32px;
      text-align: center;
      color: var(--muted);
    }
    .screen-empty strong { color: var(--ink); }
    .screen-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .screen-meta span {
      display: inline-flex;
      min-height: 26px;
      align-items: center;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--soft);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .stage-note { padding: 16px; display: grid; gap: 12px; }
    .stage-note p { font-size: 14px; }
    .memory-impact { display: grid; gap: 14px; padding: 16px; }
    .memory-headline { display: grid; gap: 5px; }
    .memory-headline strong { font-size: 18px; line-height: 1.25; }
    .memory-headline small, .memory-meta { color: var(--muted); font-size: 13px; line-height: 1.45; }
    .memory-excerpt { max-width: 80ch; }
    .impact-list, .agent-list, .receipt-list { margin: 0; padding: 0; list-style: none; }
    .impact-list { display: grid; border-block: 1px solid var(--line); }
    .impact-list li { padding: 10px 0; border-bottom: 1px solid var(--line); color: var(--ink); line-height: 1.4; }
    .impact-list li:last-child { border-bottom: 0; }
    .comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .agent-column { padding: 16px; border-right: 1px solid var(--line); }
    .agent-column:last-child { border-right: 0; }
    .agent-list { counter-reset: step; display: grid; gap: 9px; margin: 12px 0; }
    .agent-list li {
      counter-increment: step;
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 8px;
      color: var(--ink);
      line-height: 1.35;
    }
    .agent-list li::before {
      content: counter(step);
      display: inline-flex;
      width: 20px;
      height: 20px;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      background: var(--soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 760;
    }
    .agent-column p + p { margin-top: 8px; }
    .receipt-list { counter-reset: receipt; display: grid; }
    .receipt-list li {
      counter-increment: receipt;
      display: grid;
      grid-template-columns: 32px 1fr;
      gap: 10px;
      padding: 13px 16px;
      border-bottom: 1px solid var(--line);
      line-height: 1.4;
    }
    .receipt-list li:last-child { border-bottom: 0; }
    .receipt-list li::before {
      content: counter(receipt, decimal-leading-zero);
      color: var(--muted);
      font: 760 12px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .receipt-list strong { display: block; margin-bottom: 3px; }
    .investigation-summary { display: grid; gap: 12px; padding: 14px 16px 16px; }
    .investigation-summary strong { display: block; line-height: 1.35; }
    .investigation-summary .root-cause { color: var(--ink); }
    .investigation-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .investigation-actions button { min-height: 38px; }
    .investigation-actions .quiet {
      border: 1px solid var(--line);
      background: var(--soft);
      color: var(--ink);
    }
    .investigation-evidence { display: grid; border-top: 1px solid var(--line); }
    .investigation-evidence li {
      display: grid;
      grid-template-columns: 112px 1fr;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
      line-height: 1.4;
    }
    .investigation-evidence li:last-child { border-bottom: 0; }
    .investigation-evidence span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 760;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .investigation-disabled { padding: 0 16px 14px; font-size: 13px; color: var(--muted); }
    details { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: hidden; }
    summary { cursor: pointer; padding: 14px 16px; font-weight: 700; }
    .raw-label { margin: 0 16px 8px; }
    pre { margin: 0 16px 16px; background: var(--code); color: var(--code-text); padding: 14px; border-radius: 8px; overflow: auto; font-size: 12px; line-height: 1.5; max-height: 420px; }
    code { background: var(--soft); border-radius: 4px; padding: 1px 4px; }
    .status-pill { display: inline-flex; border-radius: 999px; padding: 4px 9px; font-size: 12px; font-weight: 700; background: oklch(0.95 0.045 152); color: oklch(0.36 0.11 152); border: 1px solid oklch(0.83 0.09 152); }
    @media (max-width: 900px) {
      header { display: block; }
      .actions { justify-content: flex-start; margin-top: 14px; }
      .stage-layout,
      .layout { grid-template-columns: 1fr; }
      .inspector { position: static; }
      .comparison { grid-template-columns: 1fr; }
      .agent-column { border-right: 0; border-bottom: 1px solid var(--line); }
      .agent-column:last-child { border-bottom: 0; }
    }
    @media (max-width: 560px) {
      .evidence-row, .safety-row { grid-template-columns: 1fr; gap: 4px; }
      .investigation-evidence li { grid-template-columns: 1fr; gap: 4px; }
      .repo-control { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(report.title)}</h1>
        <div class="subnav">
          <a href="/reports/dashboard">Review queue</a>
          <span>Report <code>${escapeHtml(reportId)}</code></span>
          <a href="/reports/${encodeURIComponent(reportId)}/handoff">Analysis handoff</a>
        </div>
      </div>
      <div class="actions" aria-label="Analysis actions">
        <form method="post" action="/reports/${encodeURIComponent(reportId)}/autofix?dryRun=1">
          <button class="safe" type="submit">Dry run analysis</button>
        </form>
        <form method="post" action="/reports/${encodeURIComponent(reportId)}/autofix">
          <button class="danger" type="submit">Run analysis</button>
        </form>
      </div>
    </header>
    <section class="stage-layout" aria-label="Captured bug context">
      <section class="surface">
        <div class="surface-head">
          <h2>Captured screen</h2>
          <span class="status-pill">${escapeHtml(screenshotStatus(report))}</span>
        </div>
        ${renderScreenshotStage(report)}
      </section>
      <section class="surface">
        <div class="surface-head">
          <h2>Interaction summary</h2>
        </div>
        <div class="stage-note">
          <p><strong>${escapeHtml(report.annotation.target || 'No page target pinned')}</strong></p>
          <p>${escapeHtml(report.console[0]?.message || 'No console error captured')}</p>
          <p>${escapeHtml(report.network[0] ? `${report.network[0].method} ${report.network[0].url} returned ${report.network[0].status ?? 'n/a'}` : 'No network breadcrumb captured')}</p>
        </div>
      </section>
    </section>
    <div class="layout">
      <aside class="inspector">
        <section class="surface">
          <div class="surface-head">
            <h2>Evidence brief</h2>
          </div>
          <div class="evidence-list">
            <div class="evidence-row"><span>Route</span><strong>${escapeHtml(report.route)}</strong></div>
            <div class="evidence-row"><span>Target repo</span><strong>${escapeHtml(report.repo)}</strong></div>
            <div class="evidence-row"><span>Annotation</span><strong>${escapeHtml(report.annotation.target || 'No target pinned')}</strong></div>
            <div class="evidence-row"><span>Browser error</span><strong>${escapeHtml(report.console[0]?.message || 'No console error captured')}</strong></div>
            <div class="evidence-row"><span>Network</span><strong>${escapeHtml(report.network[0] ? `${report.network[0].method} ${report.network[0].url} -> ${report.network[0].status ?? 'n/a'}` : 'No network breadcrumb captured')}</strong></div>
          </div>
        </section>
        <section class="surface">
          <div class="surface-head">
            <h2>Target repo</h2>
            <span class="status-pill">Auto-Fix input</span>
          </div>
          <form class="repo-form" method="post" action="/reports/${encodeURIComponent(reportId)}/repo">
            <label for="target-repo">GitHub repository</label>
            <div class="repo-control">
              <input id="target-repo" name="repo" value="${escapeHtml(report.repo)}" autocomplete="off" spellcheck="false" />
              <button type="submit">Save repo</button>
            </div>
            <p>Dry run analysis and Run analysis use this repository for file ranking, patch verification, and PR creation.</p>
          </form>
        </section>
        <section class="surface">
          <div class="surface-head">
            <h2>Action safety</h2>
          </div>
          <div class="safety-list">
            <div class="safety-row"><span>Safe validation</span><div><strong>Dry run analysis</strong><p>Verifies diagnosis and patch gates without opening a public PR.</p></div></div>
            <div class="safety-row"><span>PR-opening action</span><div><strong>Run analysis</strong><p>Can open a GitHub PR when credentials and verification gates allow it.</p></div></div>
          </div>
        </section>
        <section class="surface">
          <div class="surface-head">
            <h2>Analysis Result</h2>
            <span class="status-pill">${escapeHtml(analysisStatus(autofix))}</span>
          </div>
          <div class="analysis-body">
            <pre>${escapeHtml(JSON.stringify(autofix, null, 2))}</pre>
          </div>
        </section>
        ${renderGStackInvestigationHtml(reportId, report, gstackReview)}
      </aside>
      <section class="stack">
        <section class="surface">
          <div class="surface-head">
            <h2>Memory Impact</h2>
          </div>
          ${renderMemoryImpactHtml(memoryImpact)}
        </section>
        <section class="surface">
          <div class="surface-head">
            <h2>Cold Agent vs Memory Agent</h2>
          </div>
          ${renderAgentComparisonHtml(agentComparison)}
        </section>
        <section class="surface">
          <div class="surface-head">
            <h2>Memory Receipts</h2>
          </div>
          ${renderMemoryReceiptsHtml(memoryReceipts)}
        </section>
        <details open>
          <summary>Raw payloads</summary>
          <h3 class="raw-label">Normalized Report</h3>
          <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
          <h3 class="raw-label">Raw Saved Payload</h3>
          <pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
          <h3 class="raw-label">Memory Entry</h3>
          <pre>${escapeHtml(JSON.stringify(memory, null, 2))}</pre>
          <h3 class="raw-label">Memory Search</h3>
          <pre>${escapeHtml(JSON.stringify(similar, null, 2))}</pre>
        </details>
      </section>
    </div>
  </main>
</body>
</html>`;
}

interface MemoryImpactSummary {
  headline: string;
  source: string;
  similarCount: number;
  topMemory: {
    provider: string;
    reportId?: string;
    title: string;
    score: number;
    excerpt: string;
    path?: string;
    url?: string;
  } | null;
  impact: string[];
  outcomeMemory: 'pending analysis' | 'diagnosis and outcome written';
}

interface AgentComparison {
  cold: {
    label: 'Cold agent';
    path: string[];
    limitation: string;
    outcome: string;
  };
  memory: {
    label: 'Memory agent';
    path: string[];
    advantage: string;
    outcome: string;
  };
}

interface MemoryReceipt {
  source: 'current_browser_report' | 'prior_memory' | 'code_evidence' | 'verification' | 'outcome_memory';
  label: string;
  detail: string;
}

type GStackInvestigationStatus = StoredGStackReviewRecord['status'] | 'not_run';

interface GStackInvestigationView {
  status: GStackInvestigationStatus;
  headline: string;
  rootCause: string;
  confidence: 'unknown' | 'low' | 'medium' | 'high';
  evidence: Array<{ label: string; value: string; source?: string }>;
  recommendedAction: { type: 'wait' | 'autofix' | 'manual' | 'none'; label: string };
  runner: {
    jobId?: string;
    workflow: 'investigate';
    commandsRun: string[];
  };
  raw: StoredGStackReviewRecord | null;
}

function buildMemoryImpact(
  report: LiteReport,
  memory: unknown,
  similar: MemorySearchResult[],
  autofix: unknown
): MemoryImpactSummary {
  const priorMemory = similar.filter((result) => result.reportId !== report.id);
  const topMemory = priorMemory[0] ?? similar[0] ?? null;
  const provider = memoryProviderLabel(memory, topMemory);
  const outcomeMemory = autofix && typeof autofix === 'object'
    ? 'diagnosis and outcome written'
    : 'pending analysis';

  if (!topMemory) {
    return {
      headline: 'No similar bug memory yet',
      source: provider,
      similarCount: 0,
      topMemory: null,
      impact: [
        'This report becomes the first memory for this failure pattern.',
        'The diagnosis and verification outcome will be written back for the next related report.',
      ],
      outcomeMemory,
    };
  }

  return {
    headline: 'Similar bug memory found',
    source: provider,
    similarCount: priorMemory.length || similar.length,
    topMemory: {
      provider: topMemory.provider,
      reportId: topMemory.reportId,
      title: topMemory.title,
      score: topMemory.score,
      excerpt: topMemory.excerpt,
      path: topMemory.path,
      url: topMemory.url,
    },
    impact: [
      `Matched prior memory: ${topMemory.title}.`,
      'Supports comparison against a prior report before patching.',
      topMemory.excerpt
        ? `Reusable evidence cue: ${topMemory.excerpt.slice(0, 180)}${topMemory.excerpt.length > 180 ? '...' : ''}`
        : 'Reusable evidence cue: inspect the prior diagnosis and verification outcome before changing code.',
    ],
    outcomeMemory,
  };
}

function memoryProviderLabel(memory: unknown, topMemory: MemorySearchResult | null): string {
  if (memory && typeof memory === 'object') {
    const provider = (memory as { provider?: unknown }).provider;
    if (typeof provider === 'string') return provider;
  }
  return topMemory?.provider ?? 'memory';
}

function buildAgentComparison(memoryImpact: MemoryImpactSummary, autofix: unknown): AgentComparison {
  const summary = summarizeStoredAutofix(autofix);
  const targetFile = summary.targetFiles[0] ?? summary.candidateFiles[0] ?? 'candidate files';
  const verified = summary.verificationOk === true;
  const analyzed = Boolean(autofix && typeof autofix === 'object');

  return {
    cold: {
      label: 'Cold agent',
      path: [
        'Start from browser breadcrumbs and repo scan.',
        'Rank likely files from route, console text, and network path.',
        analyzed ? `Inspect ${targetFile} after ranking.` : 'Wait for analysis before code evidence is available.',
      ],
      limitation: 'No memory of whether this product has seen the same failure pattern before.',
      outcome: analyzed
        ? `Can reach ${targetFile}, but must rediscover the failure pattern from scratch.`
        : 'Likely needs a full repo scan before it can propose a confident fix.',
    },
    memory: {
      label: 'Memory agent',
      path: [
        'Search durable bug and fix memory for similar failures.',
        memoryImpact.topMemory
          ? `Start from prior memory: ${memoryImpact.topMemory.title}.`
          : 'Store this report as the first memory for the pattern.',
        analyzed ? `Use code and verification receipts to close the loop on ${targetFile}.` : 'Carry prior evidence into the analysis handoff.',
      ],
      advantage: memoryImpact.topMemory
        ? 'Starts from prior diagnosis and fix strategy instead of a cold repo scan.'
        : 'Creates reusable memory so the next related report does not start cold.',
      outcome: analyzed
        ? (verified ? `Analysis verified against ${targetFile}; outcome written back to memory.` : 'Analysis recorded; outcome written back to memory.')
        : 'Ready to analyze with prior memory already attached to the handoff.',
    },
  };
}

function buildMemoryReceipts(report: LiteReport, memoryImpact: MemoryImpactSummary, autofix: unknown): MemoryReceipt[] {
  const summary = summarizeStoredAutofix(autofix);
  const receipts: MemoryReceipt[] = [
    {
      source: 'current_browser_report',
      label: 'Current browser report',
      detail: currentReportReceipt(report),
    },
  ];

  if (memoryImpact.topMemory) {
    receipts.push({
      source: 'prior_memory',
      label: 'Prior memory',
      detail: `${memoryImpact.topMemory.title}: ${memoryImpact.topMemory.excerpt}`,
    });
  }

  if (summary.targetFiles.length || summary.candidateFiles.length) {
    receipts.push({
      source: 'code_evidence',
      label: 'Code evidence',
      detail: `Candidate ${summary.candidateFiles[0] ?? 'n/a'}; target ${summary.targetFiles.join(', ') || 'n/a'}. ${summary.rootCause ?? ''}`.trim(),
    });
  }

  if (summary.verificationOk !== null) {
    receipts.push({
      source: 'verification',
      label: 'Verification',
      detail: summary.verificationOk
        ? `Patch verification passed${summary.verificationCommands.length ? `: ${summary.verificationCommands.join(', ')}` : ''}.`
        : 'Patch verification did not pass.',
    });
  }

  receipts.push({
    source: 'outcome_memory',
    label: 'Outcome memory',
    detail: memoryImpact.outcomeMemory === 'diagnosis and outcome written'
      ? 'Diagnosis and PR/verification outcome were written back for future reports.'
      : 'This report is stored; diagnosis and outcome memory will be added after analysis.',
  });

  return receipts;
}

function buildGStackInvestigation(
  report: LiteReport,
  gstackReview: StoredGStackReviewRecord | null
): GStackInvestigationView {
  const result = gstackReview?.result;
  const status = gstackReview?.status ?? 'not_run';
  const headline = result?.headline
    ?? (result?.summary
    ? firstSentence(result.summary)
    : status === 'queued'
      ? 'GStack investigation is queued.'
      : status === 'running'
        ? 'GStack is investigating this report against the repository.'
        : 'No GStack investigation has run yet.');
  const rootCause = result?.rootCause
    ?? result?.diagnosis
    ?? (result?.summary && status !== 'queued' && status !== 'running' ? result.summary : '')
    ?? 'Run the investigation to trace the browser evidence into the repository.';
  const evidence = buildGStackEvidence(report, result);
  const confidence = result?.confidence ?? gstackConfidence(status, result, evidence);

  return {
    status,
    headline,
    rootCause,
    confidence,
    evidence,
    recommendedAction: result?.recommendedAction ?? gstackRecommendedAction(status, result),
    runner: {
      jobId: gstackReview?.jobId,
      workflow: 'investigate',
      commandsRun: result?.commandsRun ?? [],
    },
    raw: gstackReview,
  };
}

function buildGStackEvidence(
  report: LiteReport,
  result: GStackReviewResult | undefined
): Array<{ label: string; value: string; source?: string }> {
  const evidence: Array<{ label: string; value: string; source?: string }> = [];
  const consoleMessage = report.console[0]?.message;
  if (consoleMessage) evidence.push({ label: 'Browser console', value: consoleMessage, source: 'report.console' });
  const network = report.network[0];
  if (network) {
    evidence.push({
      label: 'Network',
      value: `${network.method} ${network.url} returned ${network.status ?? 'n/a'}`,
      source: 'report.network',
    });
  }
  if (report.annotation.target) {
    evidence.push({ label: 'User action', value: report.annotation.target, source: 'report.annotation' });
  }
  for (const item of result?.evidence ?? []) {
    if (item.label && item.value) evidence.push(item);
  }
  for (const finding of result?.findings ?? []) {
    const location = finding.file ? `${finding.file}${typeof finding.line === 'number' ? `:${finding.line}` : ''}` : 'code';
    evidence.push({
      label: 'Code',
      value: `${location}: ${finding.message}`,
      source: finding.severity,
    });
  }
  for (const test of result?.tests ?? []) {
    evidence.push({
      label: test.status === 'passed' ? 'Verification' : 'Check',
      value: `${test.command}: ${test.status}${test.output ? ` - ${truncateText(test.output, 140)}` : ''}`,
      source: 'gstack',
    });
  }
  return evidence.slice(0, 7);
}

function gstackConfidence(
  status: GStackInvestigationStatus,
  result: GStackReviewResult | undefined,
  evidence: Array<{ label: string; value: string; source?: string }>
): GStackInvestigationView['confidence'] {
  if (!result || status === 'not_run' || status === 'queued' || status === 'running') return 'unknown';
  if (status === 'failed') return 'low';
  if (result.diagnosis && evidence.length >= 3) return 'high';
  if (result.summary || evidence.length >= 2) return 'medium';
  return 'low';
}

function gstackRecommendedAction(
  status: GStackInvestigationStatus,
  result: GStackReviewResult | undefined
): GStackInvestigationView['recommendedAction'] {
  if (status === 'queued' || status === 'running') return { type: 'wait', label: 'Wait for the runner callback' };
  if (!result) return { type: 'autofix', label: 'Investigate with GStack' };
  const text = `${result.summary} ${result.diagnosis ?? ''}`.toLowerCase();
  if (status === 'failed' || status === 'blocked') return { type: 'manual', label: 'Review raw GStack output' };
  if (text.includes('already fixed') || text.includes('no further code change') || text.includes('no code changes required')) {
    return { type: 'none', label: 'No code action needed' };
  }
  return { type: 'autofix', label: 'Run Auto-Fix with this investigation' };
}

function firstSentence(value: string): string {
  const sentence = value.match(/^(.+?[.!?])(\s|$)/)?.[1];
  return sentence ? truncateText(sentence, 180) : truncateText(value, 180);
}

function currentReportReceipt(report: LiteReport): string {
  const consoleMessage = report.console[0]?.message ?? 'no console error captured';
  const network = report.network[0]
    ? `${report.network[0].method} ${report.network[0].url} -> ${report.network[0].status ?? 'n/a'}`
    : 'no network breadcrumb captured';
  return `${report.route}; ${consoleMessage}; ${network}; annotation ${report.annotation.target || 'not selected'}.`;
}

function summarizeStoredAutofix(autofix: unknown): {
  candidateFiles: string[];
  targetFiles: string[];
  rootCause?: string;
  verificationOk: boolean | null;
  verificationCommands: string[];
} {
  if (!autofix || typeof autofix !== 'object') {
    return { candidateFiles: [], targetFiles: [], verificationOk: null, verificationCommands: [] };
  }

  const record = autofix as {
    candidates?: Array<{ path?: unknown }>;
    diagnosis?: { targetFiles?: unknown; rootCause?: unknown };
    verification?: { ok?: unknown; commands?: Array<{ name?: unknown }> };
  };

  const candidateFiles = Array.isArray(record.candidates)
    ? record.candidates.map((candidate) => candidate.path).filter((path): path is string => typeof path === 'string')
    : [];
  const targetFiles = Array.isArray(record.diagnosis?.targetFiles)
    ? record.diagnosis.targetFiles.filter((path): path is string => typeof path === 'string')
    : [];
  const verificationCommands = Array.isArray(record.verification?.commands)
    ? record.verification.commands.map((command) => command.name).filter((name): name is string => typeof name === 'string')
    : [];
  const verificationOk = typeof record.verification?.ok === 'boolean' ? record.verification.ok : null;
  const rootCause = typeof record.diagnosis?.rootCause === 'string' ? record.diagnosis.rootCause : undefined;

  return { candidateFiles, targetFiles, rootCause, verificationOk, verificationCommands };
}

function renderMemoryImpactHtml(summary: MemoryImpactSummary): string {
  const top = summary.topMemory
    ? `<div class="memory-headline">
        <strong>${escapeHtml(summary.headline)}</strong>
        <small>${escapeHtml(summary.topMemory.title)} (${escapeHtml(summary.topMemory.provider)}, score ${summary.topMemory.score})</small>
      </div>
      <p class="memory-excerpt">${escapeHtml(truncateText(summary.topMemory.excerpt, 220))}</p>`
    : `<div class="memory-headline"><strong>${escapeHtml(summary.headline)}</strong></div>`;
  const items = summary.impact.map((line) => `<li>${escapeHtml(line)}</li>`).join('');

  return `<section class="memory-impact">
    ${top}
    <ul class="impact-list">${items}</ul>
    <p class="memory-meta">Source: ${escapeHtml(summary.source)} · Similar memories: ${summary.similarCount} · Outcome memory: ${escapeHtml(summary.outcomeMemory)}</p>
  </section>`;
}

function renderGStackInvestigationHtml(
  reportId: string,
  report: LiteReport,
  gstackReview: unknown
): string {
  const investigation = buildGStackInvestigation(
    report,
    isStoredGStackReview(gstackReview) ? gstackReview : null
  );
  const evidence = investigation.evidence.length
    ? investigation.evidence.map((item) => (
      `<li><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></li>`
    )).join('')
    : '<li><span>Evidence</span><strong>Run the investigation to connect browser evidence to repo evidence.</strong></li>';
  const canTrigger = process.env.GSTACK_UI_TRIGGER_ENABLED === '1';
  const action = canTrigger
    ? `<form method="post" action="/reports/${encodeURIComponent(reportId)}/gstack/investigate">
        <button class="quiet" type="submit">Investigate with GStack</button>
      </form>`
    : '<p class="investigation-disabled">GStack investigation is available through the protected API on this deployment.</p>';
  const followup = investigation.recommendedAction.type === 'autofix'
    ? `<form method="post" action="/reports/${encodeURIComponent(reportId)}/autofix?dryRun=1">
        <button class="safe" type="submit">${escapeHtml(investigation.recommendedAction.label)}</button>
      </form>`
    : `<p>${escapeHtml(investigation.recommendedAction.label)}</p>`;

  return `<section class="surface">
    <div class="surface-head">
      <h2>GStack Investigation</h2>
      <span class="status-pill">${escapeHtml(investigation.status)}</span>
    </div>
    <div class="investigation-summary">
      <strong>${escapeHtml(investigation.headline)}</strong>
      <p class="root-cause">${escapeHtml(investigation.rootCause)}</p>
      <p>Confidence: ${escapeHtml(investigation.confidence)}${investigation.runner.jobId ? ` · Job ${escapeHtml(investigation.runner.jobId)}` : ''}</p>
      <div class="investigation-actions">
        ${action}
        ${followup}
      </div>
    </div>
    <ul class="investigation-evidence">${evidence}</ul>
    <details>
      <summary>Raw GStack output</summary>
      <pre>${escapeHtml(JSON.stringify(investigation.raw, null, 2))}</pre>
    </details>
  </section>`;
}

function isStoredGStackReview(value: unknown): value is StoredGStackReviewRecord {
  return Boolean(value && typeof value === 'object' && typeof (value as { jobId?: unknown }).jobId === 'string');
}

function renderAgentComparisonHtml(comparison: AgentComparison): string {
  return `<section class="comparison">
    <div class="agent-column">
      <h3>${escapeHtml(comparison.cold.label)}</h3>
      <ol class="agent-list">${comparison.cold.path.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      <p>${escapeHtml(comparison.cold.limitation)}</p>
      <p>${escapeHtml(comparison.cold.outcome)}</p>
    </div>
    <div class="agent-column">
      <h3>${escapeHtml(comparison.memory.label)}</h3>
      <ol class="agent-list">${comparison.memory.path.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      <p>${escapeHtml(comparison.memory.advantage)}</p>
      <p>${escapeHtml(comparison.memory.outcome)}</p>
    </div>
  </section>`;
}

function renderMemoryReceiptsHtml(receipts: MemoryReceipt[]): string {
  return `<section>
    <ul class="receipt-list">${receipts.map((receipt) => (
      `<li><div><strong>${escapeHtml(receipt.label)}</strong><span>${escapeHtml(truncateText(receipt.detail, 220))}</span></div></li>`
    )).join('')}</ul>
  </section>`;
}

function renderScreenshotStage(report: LiteReport): string {
  const viewport = `${report.viewport.width} x ${report.viewport.height}`;
  const annotation = report.annotation.viewportX !== undefined && report.annotation.viewportY !== undefined
    ? `pin ${report.annotation.viewportX}, ${report.annotation.viewportY}`
    : 'no pin';
  const frame = isRenderableScreenshot(report)
    ? `<img src="${escapeHtml(report.screenshot.value)}" alt="Captured screenshot for ${escapeHtml(report.title)}" />`
    : `<div class="screen-empty"><strong>Screenshot not available</strong><span>${escapeHtml(report.screenshot.reason || 'Capture was missing or too small to render.')}</span></div>`;

  return `<div class="screen-stage">
    <div class="screen-frame">${frame}</div>
    <div class="screen-meta">
      <span>${escapeHtml(viewport)}</span>
      <span>${escapeHtml(annotation)}</span>
      <span>${escapeHtml(report.route)}</span>
    </div>
  </div>`;
}

function screenshotStatus(report: LiteReport): string {
  return isRenderableScreenshot(report) ? 'screenshot' : 'not available';
}

function isRenderableScreenshot(report: LiteReport): report is LiteReport & { screenshot: { type: 'data-url-or-url'; value: string } } {
  const value = report.screenshot.value;
  if (report.screenshot.type !== 'data-url-or-url' || !value) return false;
  if (/^https?:\/\//.test(value)) return true;
  return value.startsWith('data:image/') && value.length > 120;
}

function analysisStatus(autofix: unknown): string {
  if (!autofix || typeof autofix !== 'object') return 'not run';
  const status = (autofix as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'recorded';
}

function gstackStatus(gstackReview: unknown): string {
  if (!gstackReview || typeof gstackReview !== 'object') return 'not run';
  const status = (gstackReview as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'recorded';
}

function parseGStackMode(value: unknown): GStackJobMode {
  if (value === 'investigate' || value === 'qa' || value === 'ship') return value;
  if (value === 'review' || value === 'review_fix') return 'review_fix';
  if (value === 'plan_eng_review') return 'review_fix';
  return 'investigate';
}

function requireGStackProductTrigger(
  request: Request
): { ok: true } | { ok: false; status: 401 | 403 | 503; error: string; message: string } {
  if (process.env.GSTACK_UI_TRIGGER_ENABLED === '1') return { ok: true };
  const configured = requireConfiguredBearer(request, 'GSTACK_TRIGGER_TOKEN');
  if (configured.ok) return configured;
  if (configured.status === 401) return configured;
  return {
    ok: false,
    status: 503,
    error: 'gstack_not_configured',
    message: 'GSTACK_UI_TRIGGER_ENABLED=1 or GSTACK_TRIGGER_TOKEN is required',
  };
}

function requireConfiguredBearer(
  request: Request,
  envName: string
): { ok: true } | { ok: false; status: 401 | 503; error: string; message: string } {
  const expected = process.env[envName];
  if (!expected) {
    return { ok: false, status: 503, error: 'gstack_not_configured', message: `${envName} is not configured` };
  }
  const actual = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (actual !== expected) {
    return { ok: false, status: 401, error: 'unauthorized', message: 'invalid internal token' };
  }
  return { ok: true };
}

function mergeQueuedGStackReview(
  existing: StoredGStackReviewRecord | undefined,
  queued: StoredGStackReviewRecord
): StoredGStackReviewRecord {
  if (existing?.jobId === queued.jobId && isTerminalGStackReview(existing)) return existing;
  return queued;
}

function isTerminalGStackReview(review: StoredGStackReviewRecord): boolean {
  return Boolean(review.result) || review.status === 'passed' || review.status === 'failed' || review.status === 'blocked';
}

function sanitizeGStackResult(result: GStackReviewResult): GStackReviewResult {
  const { logs: _logs, ...safeResult } = result;
  return safeResult;
}

interface StoredAutofixSummary extends Record<string, unknown> {
  status: string;
  candidates: unknown[];
  diagnosis: unknown;
  patch: unknown;
  verification: unknown;
  pr: unknown;
  prError?: string;
  meta?: unknown;
  updatedAt: string;
}

interface AutofixRunnerResult {
  status?: string;
  pipeline?: {
    candidates?: Array<{ path: string; score: number; reasons: string[] }>;
    diagnosis?: unknown;
    patch?: unknown;
    verification?: unknown;
  };
  pr?: unknown;
  prError?: string;
  meta?: unknown;
}

function summarizeAutofixResult(result: unknown): StoredAutofixSummary {
  const typed = result as AutofixRunnerResult;
  return {
    status: typed.status ?? 'unknown',
    candidates: typed.pipeline?.candidates?.slice(0, 5) ?? [],
    diagnosis: typed.pipeline?.diagnosis ?? null,
    patch: typed.pipeline?.patch ?? null,
    verification: typed.pipeline?.verification ?? null,
    pr: typed.pr ?? null,
    prError: typed.prError,
    meta: typed.meta,
    updatedAt: new Date().toISOString(),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTruthyFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes';
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

const directRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directRun) {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`lite-annotate API running on http://localhost:${port}`);
  });
}

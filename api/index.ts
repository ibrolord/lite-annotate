import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryAdapter, type MemoryAdapter } from './gbrain.js';
import { normalizeReportPayload, ReportValidationError } from './report_contract.js';
import { ReportStore, type StoredReportRecord } from './report_store.js';
import { runAutofix, type AutofixResult } from './autofix.js';
import type { LiteReport } from './report_contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

export function createApp(deps: {
  store?: ReportStore;
  memory?: MemoryAdapter;
  autofixRunner?: (reportId: string, report: LiteReport) => Promise<unknown>;
} = {}) {
  const app = new Hono();
  const store = deps.store ?? new ReportStore();
  const memory = deps.memory ?? createMemoryAdapter();
  const autofixRunner: (reportId: string, report: LiteReport) => Promise<unknown> =
    deps.autofixRunner ??
    ((reportId, report) => runAutofix(reportId, report as unknown as Parameters<typeof runAutofix>[1]));

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

  app.get('/reports/:id/memory', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const similar = await memory.searchSimilar(record.report);
    return c.json({ reportId: record.report.id, memory: record.memory, similar });
  });

  app.get('/reports/:id/handoff', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    const similar = await memory.searchSimilar(record.report);
    return c.json({
      reportId: record.report.id,
      repo: record.report.repo,
      normalizedReport: record.report,
      memorySearchResult: similar,
      autofix: record.autofix ?? null,
    });
  });

  app.get('/reports/:id/view', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.html('<h1>Report not found</h1>', 404);
    const similar = await memory.searchSimilar(record.report);
    return c.html(renderReportHtml(record.report.id, record.report, record.raw, record.memory, similar, record.autofix ?? null));
  });

  app.get('/reports/:id/autofix', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);
    return c.json({ reportId: record.report.id, autofix: record.autofix ?? null });
  });

  app.post('/reports/:id/autofix', async (c) => {
    const record = await store.get(c.req.param('id'));
    if (!record) return c.json({ error: 'not_found' }, 404);

    try {
      const result = await autofixRunner(record.report.id, record.report);
      const autofix = summarizeAutofixResult(result);
      await memory.putDiagnosis(record.report.id, autofix.diagnosis);
      await memory.putOutcome(record.report.id, {
        status: autofix.status,
        pr: autofix.pr,
        verification: autofix.verification,
      });
      const updated = await store.update(record.report.id, (current) => ({
        ...current,
        autofix,
        updatedAt: new Date().toISOString(),
      }));
      return c.json({ reportId: record.report.id, autofix: updated?.autofix ?? autofix });
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
    ? '<tr><td colspan="8" class="empty">No reports captured yet. Submit one from <a href="/demo">the demo</a>.</td></tr>'
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lite Annotate Reports</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; color: #111827; background: #f8fafc; }
    main { max-width: 1240px; margin: 0 auto; padding: 32px 20px 64px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 20px; }
    h1 { font-size: 24px; margin: 0 0 6px; }
    p { margin: 0; color: #4b5563; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .button { display: inline-flex; align-items: center; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 10px; background: #fff; color: #111827; font-size: 14px; }
    .table-wrap { overflow-x: auto; border: 1px solid #e5e7eb; border-radius: 8px; background: #fff; }
    table { width: 100%; border-collapse: collapse; min-width: 980px; }
    th, td { padding: 11px 12px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; font-size: 13px; }
    th { color: #6b7280; font-weight: 600; background: #f9fafb; }
    tr:last-child td { border-bottom: 0; }
    .title { font-weight: 600; color: #111827; }
    .muted { color: #6b7280; }
    .pill { display: inline-flex; border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; white-space: nowrap; }
    .pill.warn { background: #fffbeb; color: #92400e; border-color: #fde68a; }
    .links { display: flex; gap: 8px; flex-wrap: wrap; }
    .empty { text-align: center; padding: 32px; color: #6b7280; }
    code { background: #f3f4f6; border-radius: 4px; padding: 1px 4px; }
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
        <h1>Reports</h1>
        <p>${records.length} saved ${records.length === 1 ? 'report' : 'reports'} ready for review and analysis handoff.</p>
      </div>
      <nav class="actions">
        <a class="button" href="/demo">Demo</a>
        <a class="button" href="/reports">JSON</a>
      </nav>
    </header>
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
    <td>
      <div class="links">
        <a href="/reports/${encodeURIComponent(report.id)}/view">view</a>
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

function renderReportHtml(
  reportId: string,
  report: unknown,
  raw: unknown,
  memory: unknown,
  similar: unknown,
  autofix: unknown
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lite Annotate Report ${escapeHtml(reportId)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 1100px; margin: 32px auto; padding: 0 20px; color: #111827; }
    h1 { font-size: 24px; }
    h2 { margin-top: 28px; font-size: 16px; }
    pre { background: #0f172a; color: #e5e7eb; padding: 16px; border-radius: 8px; overflow: auto; font-size: 12px; line-height: 1.5; }
    a { color: #2563eb; }
  </style>
</head>
<body>
  <h1>Report ${escapeHtml(reportId)}</h1>
  <p><a href="/reports/${encodeURIComponent(reportId)}">Normalized JSON</a> · <a href="/reports/${encodeURIComponent(reportId)}/handoff">Analysis handoff</a></p>
  <form method="post" action="/reports/${encodeURIComponent(reportId)}/autofix">
    <button type="submit">Run analysis</button>
  </form>
  <h2>Normalized Report</h2>
  <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
  <h2>Raw Saved Payload</h2>
  <pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
  <h2>Memory Entry</h2>
  <pre>${escapeHtml(JSON.stringify(memory, null, 2))}</pre>
  <h2>Memory Search</h2>
  <pre>${escapeHtml(JSON.stringify(similar, null, 2))}</pre>
  <h2>Analysis Result</h2>
  <pre>${escapeHtml(JSON.stringify(autofix, null, 2))}</pre>
</body>
</html>`;
}

function analysisStatus(autofix: unknown): string {
  if (!autofix || typeof autofix !== 'object') return 'not run';
  const status = (autofix as { status?: unknown }).status;
  return typeof status === 'string' ? status : 'recorded';
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

function summarizeAutofixResult(result: unknown): StoredAutofixSummary {
  const typed = result as Partial<AutofixResult> & {
    pipeline?: {
      candidates?: Array<{ path: string; score: number; reasons: string[] }>;
      diagnosis?: unknown;
      patch?: unknown;
      verification?: unknown;
    };
    meta?: unknown;
  };
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

const directRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directRun) {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`lite-annotate API running on http://localhost:${port}`);
  });
}

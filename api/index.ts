import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryAdapter, type MemoryAdapter } from './gbrain.js';
import { normalizeReportPayload, ReportValidationError } from './report_contract.js';
import { ReportStore } from './report_store.js';
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
  <p><a href="/reports/${encodeURIComponent(reportId)}">Normalized JSON</a> · <a href="/reports/${encodeURIComponent(reportId)}/handoff">Person B handoff</a></p>
  <h2>Normalized Report</h2>
  <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
  <h2>Raw Saved Payload</h2>
  <pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
  <h2>Memory Entry</h2>
  <pre>${escapeHtml(JSON.stringify(memory, null, 2))}</pre>
  <h2>Memory Search</h2>
  <pre>${escapeHtml(JSON.stringify(similar, null, 2))}</pre>
  <h2>Person B Autofix</h2>
  <pre>${escapeHtml(JSON.stringify(autofix, null, 2))}</pre>
</body>
</html>`;
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

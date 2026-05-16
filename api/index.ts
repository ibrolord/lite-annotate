import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoryAdapter, type MemoryAdapter, type MemorySearchResult } from './gbrain.js';
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
      record.autofix ?? null
    ));
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
  memoryImpact: MemoryImpactSummary,
  agentComparison: AgentComparison,
  memoryReceipts: MemoryReceipt[],
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
  <form method="post" action="/reports/${encodeURIComponent(reportId)}/autofix?dryRun=1">
    <button type="submit">Dry run analysis</button>
  </form>
  <h2>Normalized Report</h2>
  <pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre>
  <h2>Raw Saved Payload</h2>
  <pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre>
  <h2>Memory Entry</h2>
  <pre>${escapeHtml(JSON.stringify(memory, null, 2))}</pre>
  <h2>Memory Search</h2>
  <pre>${escapeHtml(JSON.stringify(similar, null, 2))}</pre>
  <h2>Memory Impact</h2>
  ${renderMemoryImpactHtml(memoryImpact)}
  <h2>Cold Agent vs Memory Agent</h2>
  ${renderAgentComparisonHtml(agentComparison)}
  <h2>Memory Receipts</h2>
  ${renderMemoryReceiptsHtml(memoryReceipts)}
  <h2>Analysis Result</h2>
  <pre>${escapeHtml(JSON.stringify(autofix, null, 2))}</pre>
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
      'Supports the same failure pattern before patching: profile code reads a missing user.',
      'Fix strategy cue: guard missing user before reading name and return a fallback.',
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
        ? `Can reach ${targetFile}, but must rediscover the missing-user failure pattern from scratch.`
        : 'Likely needs a full repo scan before it can propose a confident fix.',
    },
    memory: {
      label: 'Memory agent',
      path: [
        'Search durable bug and fix memory for similar failures.',
        memoryImpact.topMemory
          ? `Start from prior memory: ${memoryImpact.topMemory.title}.`
          : 'Store this report as the first memory for the pattern.',
        analyzed ? `Use code and verification receipts to close the loop on ${targetFile}.` : 'Carry prior fix strategy into the analysis handoff.',
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
    ? `<p><strong>${escapeHtml(summary.headline)}</strong>: ${escapeHtml(summary.topMemory.title)} <span>(${escapeHtml(summary.topMemory.provider)}, score ${summary.topMemory.score})</span></p>
       <p>${escapeHtml(summary.topMemory.excerpt)}</p>`
    : `<p><strong>${escapeHtml(summary.headline)}</strong></p>`;
  const items = summary.impact.map((line) => `<li>${escapeHtml(line)}</li>`).join('');

  return `<section class="memory-impact">
    ${top}
    <ul>${items}</ul>
    <p>Source: ${escapeHtml(summary.source)} · Similar memories: ${summary.similarCount} · Outcome memory: ${escapeHtml(summary.outcomeMemory)}</p>
  </section>`;
}

function renderAgentComparisonHtml(comparison: AgentComparison): string {
  return `<section>
    <div>
      <h3>${escapeHtml(comparison.cold.label)}</h3>
      <ol>${comparison.cold.path.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      <p>${escapeHtml(comparison.cold.limitation)}</p>
      <p>${escapeHtml(comparison.cold.outcome)}</p>
    </div>
    <div>
      <h3>${escapeHtml(comparison.memory.label)}</h3>
      <ol>${comparison.memory.path.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      <p>${escapeHtml(comparison.memory.advantage)}</p>
      <p>${escapeHtml(comparison.memory.outcome)}</p>
    </div>
  </section>`;
}

function renderMemoryReceiptsHtml(receipts: MemoryReceipt[]): string {
  return `<section>
    <ul>${receipts.map((receipt) => (
      `<li><strong>${escapeHtml(receipt.label)}</strong>: ${escapeHtml(receipt.detail)}</li>`
    )).join('')}</ul>
  </section>`;
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

const directRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directRun) {
  const port = Number.parseInt(process.env.PORT || '3001', 10);
  serve({ fetch: app.fetch, port }, () => {
    console.log(`lite-annotate API running on http://localhost:${port}`);
  });
}

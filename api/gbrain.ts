import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LiteReport } from './report_contract.js';
import { reportToSearchText } from './report_contract.js';
import { defaultWritableRootDir, safeReportId } from './report_store.js';

export interface MemoryEntry {
  provider: 'gbrain' | 'github-markdown';
  reportId: string;
  path?: string;
  url?: string;
  status: 'written' | 'fallback-written';
  fallbackReason?: string;
}

export interface MemorySearchResult {
  provider: 'gbrain' | 'github-markdown';
  reportId?: string;
  score: number;
  title: string;
  excerpt: string;
  path?: string;
  url?: string;
}

export interface MemoryAdapter {
  putReport(report: LiteReport): Promise<MemoryEntry>;
  searchSimilar(report: LiteReport): Promise<MemorySearchResult[]>;
  putDiagnosis(reportId: string, diagnosis: unknown): Promise<MemoryEntry>;
  putOutcome(reportId: string, outcome: unknown): Promise<MemoryEntry>;
}

export function createMemoryAdapter(): MemoryAdapter {
  const provider = (process.env.MEMORY_PROVIDER || 'github-markdown').toLowerCase();
  const markdown = new MarkdownMemoryAdapter();
  if (provider === 'gbrain' && process.env.GBRAIN_MCP_URL) {
    return new GBrainWithMarkdownFallback(new GBrainHttpMemoryAdapter(), markdown);
  }
  return markdown;
}

export async function writeBugToGBrain(report: LiteReport): Promise<MemoryEntry> {
  return createMemoryAdapter().putReport(report);
}

export async function searchGBrainBugs(query: string, excludeId?: string): Promise<string> {
  return new MarkdownMemoryAdapter().searchText(query, excludeId);
}

class GBrainWithMarkdownFallback implements MemoryAdapter {
  constructor(
    private readonly primary: GBrainHttpMemoryAdapter,
    private readonly fallback: MarkdownMemoryAdapter
  ) {}

  async putReport(report: LiteReport): Promise<MemoryEntry> {
    try {
      return await this.primary.putReport(report);
    } catch (err) {
      const entry = await this.fallback.putReport(report);
      return { ...entry, status: 'fallback-written', fallbackReason: errorMessage(err) };
    }
  }

  async searchSimilar(report: LiteReport): Promise<MemorySearchResult[]> {
    try {
      const results = await this.primary.searchSimilar(report);
      if (results.length) return results;
    } catch {
      // Fallback below keeps demo search deterministic when hosted GBrain is not available.
    }
    return this.fallback.searchSimilar(report);
  }

  async putDiagnosis(reportId: string, diagnosis: unknown): Promise<MemoryEntry> {
    try {
      return await this.primary.putDiagnosis(reportId, diagnosis);
    } catch (err) {
      const entry = await this.fallback.putDiagnosis(reportId, diagnosis);
      return { ...entry, status: 'fallback-written', fallbackReason: errorMessage(err) };
    }
  }

  async putOutcome(reportId: string, outcome: unknown): Promise<MemoryEntry> {
    try {
      return await this.primary.putOutcome(reportId, outcome);
    } catch (err) {
      const entry = await this.fallback.putOutcome(reportId, outcome);
      return { ...entry, status: 'fallback-written', fallbackReason: errorMessage(err) };
    }
  }
}

class GBrainHttpMemoryAdapter implements MemoryAdapter {
  private readonly endpoint = process.env.GBRAIN_MCP_URL!;
  private readonly token = process.env.GBRAIN_MCP_TOKEN || process.env.GBRAIN_ACCESS_TOKEN;

  async putReport(report: LiteReport): Promise<MemoryEntry> {
    await this.callTool('put_page', {
      path: `bugs/${report.id}.md`,
      title: `Bug: ${report.title}`,
      content: renderReportMarkdown(report),
      tags: ['lite-annotate', 'bug-report', report.projectId],
    });
    return { provider: 'gbrain', reportId: report.id, path: `bugs/${report.id}.md`, status: 'written' };
  }

  async searchSimilar(report: LiteReport): Promise<MemorySearchResult[]> {
    const response = await this.callTool('search', {
      query: reportToSearchText(report),
      limit: 5,
    });
    const items = Array.isArray(response?.content) ? response.content : Array.isArray(response?.results) ? response.results : [];
    return items.slice(0, 5).map((item: unknown, index: number) => {
      const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {};
      return {
        provider: 'gbrain' as const,
        reportId: typeof record.reportId === 'string' ? record.reportId : undefined,
        score: Number(record.score ?? (5 - index)),
        title: String(record.title ?? record.name ?? `GBrain result ${index + 1}`),
        excerpt: String(record.excerpt ?? record.text ?? record.content ?? '').slice(0, 800),
        path: typeof record.path === 'string' ? record.path : undefined,
        url: typeof record.url === 'string' ? record.url : undefined,
      };
    });
  }

  async putDiagnosis(reportId: string, diagnosis: unknown): Promise<MemoryEntry> {
    await this.callTool('put_page', {
      path: `diagnosis/${safeReportId(reportId)}.md`,
      title: `Diagnosis: ${reportId}`,
      content: renderObjectMarkdown(`Diagnosis: ${reportId}`, diagnosis),
      tags: ['lite-annotate', 'diagnosis'],
    });
    return { provider: 'gbrain', reportId, path: `diagnosis/${safeReportId(reportId)}.md`, status: 'written' };
  }

  async putOutcome(reportId: string, outcome: unknown): Promise<MemoryEntry> {
    await this.callTool('put_page', {
      path: `outcomes/${safeReportId(reportId)}.md`,
      title: `Outcome: ${reportId}`,
      content: renderObjectMarkdown(`Outcome: ${reportId}`, outcome),
      tags: ['lite-annotate', 'outcome'],
    });
    return { provider: 'gbrain', reportId, path: `outcomes/${safeReportId(reportId)}.md`, status: 'written' };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method: 'tools/call',
        params: {
          name,
          arguments: args,
        },
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`GBrain MCP ${name} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    return parseMcpBody(body);
  }
}

class MarkdownMemoryAdapter implements MemoryAdapter {
  private readonly rootDir = process.env.MEMORY_DIR || join(defaultWritableRootDir(), 'memory');
  private readonly githubRepo = process.env.GBRAIN_REPO || process.env.GITHUB_REPO || '';
  private readonly githubToken = process.env.GITHUB_TOKEN || '';

  async putReport(report: LiteReport): Promise<MemoryEntry> {
    const path = `bugs/${safeReportId(report.id)}.md`;
    const content = renderReportMarkdown(report);
    await this.writeLocal(path, content);
    const url = await this.writeGitHub(path, content, `bug: ${report.title.slice(0, 72)}`);
    return { provider: 'github-markdown', reportId: report.id, path: this.localPath(path), url, status: 'written' };
  }

  async searchSimilar(report: LiteReport): Promise<MemorySearchResult[]> {
    return this.searchRecords(reportToSearchText(report));
  }

  async searchText(query: string, excludeId?: string): Promise<string> {
    const results = await this.searchRecords(query, excludeId);
    if (!results.length) return 'No similar bugs found in memory.';
    return results.map((result) => `# ${result.title}\n\n${result.excerpt}`).join('\n\n---\n\n');
  }

  async putDiagnosis(reportId: string, diagnosis: unknown): Promise<MemoryEntry> {
    const path = `diagnosis/${safeReportId(reportId)}.md`;
    await this.writeLocal(path, renderObjectMarkdown(`Diagnosis: ${reportId}`, diagnosis));
    return { provider: 'github-markdown', reportId, path: this.localPath(path), status: 'written' };
  }

  async putOutcome(reportId: string, outcome: unknown): Promise<MemoryEntry> {
    const path = `outcomes/${safeReportId(reportId)}.md`;
    await this.writeLocal(path, renderObjectMarkdown(`Outcome: ${reportId}`, outcome));
    return { provider: 'github-markdown', reportId, path: this.localPath(path), status: 'written' };
  }

  private async searchRecords(query: string, excludeId?: string): Promise<MemorySearchResult[]> {
    const terms = keywords(query);
    const seededResults = seededDemoMemoryResults(query, terms, excludeId);
    const bugDir = join(this.rootDir, 'bugs');
    let names: string[];
    try {
      names = await readdir(bugDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return seededResults;
      throw err;
    }

    const records = await Promise.all(
      names
        .filter((name) => name.endsWith('.md'))
        .filter((name) => !excludeId || !name.includes(excludeId))
        .map(async (name) => {
          const path = join(bugDir, name);
          const content = await readFile(path, 'utf8');
          return { name, path, content };
        })
    );

    return [
      ...seededResults,
      ...records
      .map((record) => {
        const lower = record.content.toLowerCase();
        const score = terms.reduce((total, term) => total + countOccurrences(lower, term), 0);
        return {
          provider: 'github-markdown' as const,
          reportId: record.name.replace(/\.md$/, ''),
          score,
          title: extractTitle(record.content) ?? record.name.replace(/\.md$/, ''),
          excerpt: excerpt(record.content, terms[0]),
          path: record.path,
        };
      })
      .filter((result) => result.score > 0 || terms.length === 0),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private async writeLocal(path: string, content: string): Promise<void> {
    const fullPath = this.localPath(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }

  private localPath(path: string): string {
    return join(this.rootDir, path);
  }

  private async writeGitHub(path: string, content: string, message: string): Promise<string | undefined> {
    if (!this.githubToken || !this.githubRepo.includes('/')) return undefined;
    const [owner, repo] = this.githubRepo.split('/');
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeContentPath(path)}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'lite-annotate',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(content).toString('base64'),
        }),
      }
    );
    if (!res.ok) return undefined;
    const data = await res.json() as any;
    return data.content?.html_url;
  }
}

function seededDemoMemoryResults(query: string, terms: string[], excludeId?: string): MemorySearchResult[] {
  if (process.env.LITE_ANNOTATE_DEMO_MEMORY === 'off') return [];
  if (excludeId === 'memory_profile_missing_user_guard') return [];

  const lower = query.toLowerCase();
  const matchesPinnedBug = [
    'user profile',
    'reading name',
    'undefined',
    '/users',
    'src/users.js',
    'get /api/users/999',
  ].some((needle) => lower.includes(needle));

  if (!matchesPinnedBug) return [];

  return [{
    provider: 'github-markdown',
    reportId: 'memory_profile_missing_user_guard',
    score: Math.max(25, terms.reduce((total, term) => total + countOccurrences(DEMO_MEMORY_EXCERPT.toLowerCase(), term), 0)),
    title: 'Prior profile bug: missing user fallback',
    excerpt: DEMO_MEMORY_EXCERPT,
    path: 'demo-memory://profile-missing-user-fallback',
  }];
}

const DEMO_MEMORY_EXCERPT = [
  'A previous profile-loading bug failed after /api/users/999 returned no user.',
  'The diagnosis found src/users.js was reading user.name without checking for a missing user.',
  'The verified fix strategy was to guard missing user before reading name and return a fallback greeting.',
].join(' ');

function renderReportMarkdown(report: LiteReport): string {
  const consoleText = report.console.map((entry) => {
    const source = entry.source ? ` ${entry.source}` : '';
    return `[${entry.level}]${source} ${entry.message}`;
  }).join('\n') || 'No console events captured';
  const networkText = report.network.map((entry) => (
    `${entry.method} ${entry.url} -> ${entry.status ?? 'n/a'} (${entry.durationMs ?? 'n/a'}ms)${entry.failed ? ' failed' : ''}`
  )).join('\n') || 'No network breadcrumbs captured';
  const sessionText = report.session.map((entry) => (
    `[${entry.type}] ${entry.target ?? entry.route ?? entry.value ?? ''} ${entry.timestamp}`
  )).join('\n') || 'No session breadcrumbs captured';
  const screenshotText = report.screenshot.type === 'data-url-or-url'
    ? `Captured (${report.screenshot.value?.slice(0, 80)}...)`
    : `Not captured: ${report.screenshot.reason}`;
  const annotationText = [
    `- Target: ${report.annotation.target || 'Not selected'}`,
    `- Selector: ${report.annotation.selector || 'n/a'}`,
    `- Point: ${report.annotation.x ?? 'n/a'}, ${report.annotation.y ?? 'n/a'}`,
    `- Viewport point: ${report.annotation.viewportX ?? 'n/a'}, ${report.annotation.viewportY ?? 'n/a'}`,
  ].join('\n');

  return `# Bug: ${report.title}

## ID
${report.id}

## Project
${report.projectId}

## Repo
${report.repo}

## URL
${report.url}

## Route
${report.route}

## Description
${report.description || 'No description provided'}

## Page Annotation
${annotationText}

## Browser
- User agent: ${report.userAgent}
- Viewport: ${report.viewport.width}x${report.viewport.height}
- Created: ${report.createdAt}

## Console
\`\`\`text
${consoleText}
\`\`\`

## Network
\`\`\`text
${networkText}
\`\`\`

## Session
\`\`\`text
${sessionText}
\`\`\`

## Screenshot
${screenshotText}

## Status
open
`;
}

function renderObjectMarkdown(title: string, value: unknown): string {
  return `# ${title}

\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\`
`;
}

function parseMcpBody(body: string): any {
  if (!body.trim()) return {};
  if (body.trimStart().startsWith('event:') || body.includes('\ndata:')) {
    const dataLine = body.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return {};
    return parseJson(dataLine.slice('data:'.length).trim());
  }
  const parsed = parseJson(body);
  return parsed.result ?? parsed;
}

function parseJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function keywords(value: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this']);
  const terms = value
    .toLowerCase()
    .match(/[a-z0-9_./'-]{3,}/g) ?? [];
  return Array.from(new Set(terms.filter((term) => !stop.has(term)))).slice(0, 40);
}

function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function extractTitle(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1];
}

function excerpt(content: string, term?: string): string {
  if (!term) return content.slice(0, 500);
  const lower = content.toLowerCase();
  const index = lower.indexOf(term);
  if (index < 0) return content.slice(0, 500);
  return content.slice(Math.max(0, index - 180), Math.min(content.length, index + 420));
}

function encodeContentPath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

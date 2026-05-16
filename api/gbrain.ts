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
  private readonly staticToken = process.env.GBRAIN_MCP_TOKEN || process.env.GBRAIN_ACCESS_TOKEN;
  private readonly clientId = process.env.GBRAIN_CLIENT_ID;
  private readonly clientSecret = process.env.GBRAIN_CLIENT_SECRET;
  private readonly scope = process.env.GBRAIN_OAUTH_SCOPE || 'read write';
  private readonly putTool = process.env.GBRAIN_PUT_TOOL || 'put_page';
  private readonly searchTool = process.env.GBRAIN_SEARCH_TOOL || 'search';
  private tokenCache?: { token: string; expiresAt: number };
  private discoveredTokenUrl?: string;

  async putReport(report: LiteReport): Promise<MemoryEntry> {
    const slug = bugSlug(report.id);
    await this.callTool(this.putTool, {
      slug,
      content: renderReportMemoryPage(report),
    });
    return { provider: 'gbrain', reportId: report.id, path: slug, status: 'written' };
  }

  async searchSimilar(report: LiteReport): Promise<MemorySearchResult[]> {
    const response = await this.callTool(this.searchTool, {
      query: reportToSearchText(report),
      limit: 5,
    });
    return extractGBrainResultItems(response).slice(0, 5).map(normalizeGBrainSearchResult);
  }

  async putDiagnosis(reportId: string, diagnosis: unknown): Promise<MemoryEntry> {
    const slug = `diagnosis/${safeReportId(reportId)}`;
    await this.callTool(this.putTool, {
      slug,
      content: renderObjectMemoryPage(`Diagnosis: ${reportId}`, 'diagnosis', reportId, diagnosis),
    });
    return { provider: 'gbrain', reportId, path: slug, status: 'written' };
  }

  async putOutcome(reportId: string, outcome: unknown): Promise<MemoryEntry> {
    const slug = `outcomes/${safeReportId(reportId)}`;
    await this.callTool(this.putTool, {
      slug,
      content: renderObjectMemoryPage(`Outcome: ${reportId}`, 'outcome', reportId, outcome),
    });
    return { provider: 'gbrain', reportId, path: slug, status: 'written' };
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    const token = await this.accessToken();
    if (token) headers.Authorization = `Bearer ${token}`;

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

  private async accessToken(): Promise<string | undefined> {
    if (this.staticToken) return this.staticToken;
    if (!this.clientId || !this.clientSecret) return undefined;
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) return this.tokenCache.token;

    const tokenUrl = await this.tokenUrl();
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scope,
    });
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GBrain OAuth token failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const data = parseJsonRecord(text);
    const token = typeof data.access_token === 'string' ? data.access_token : undefined;
    if (!token) throw new Error('GBrain OAuth token response missing access_token');
    const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
    this.tokenCache = {
      token,
      expiresAt: Date.now() + Math.max(30, expiresIn - 30) * 1000,
    };
    return token;
  }

  private async tokenUrl(): Promise<string> {
    const explicit = process.env.GBRAIN_OAUTH_TOKEN_URL || process.env.GBRAIN_TOKEN_URL;
    if (explicit) return explicit;
    if (this.discoveredTokenUrl) return this.discoveredTokenUrl;

    const metadataUrl = new URL('/.well-known/oauth-authorization-server', this.endpoint).toString();
    const res = await fetch(metadataUrl, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GBrain OAuth discovery failed: ${res.status} ${text.slice(0, 300)}`);
    }
    const metadata = parseJsonRecord(text);
    const tokenEndpoint = typeof metadata.token_endpoint === 'string' ? metadata.token_endpoint : undefined;
    if (!tokenEndpoint) throw new Error('GBrain OAuth metadata missing token_endpoint');
    this.discoveredTokenUrl = tokenEndpoint;
    return tokenEndpoint;
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

function renderReportMemoryPage(report: LiteReport): string {
  return `${frontmatter({
    title: `Bug: ${report.title}`,
    type: 'bug_report',
    report_id: report.id,
    project_id: report.projectId,
    repo: report.repo,
    route: report.route,
    url: report.url,
    created_at: report.createdAt,
    tags: ['lite-annotate', 'bug-report', report.projectId],
  })}
${renderReportMarkdown(report)}`;
}

function renderObjectMemoryPage(title: string, type: string, reportId: string, value: unknown): string {
  return `${frontmatter({
    title,
    type,
    report_id: reportId,
    tags: ['lite-annotate', type],
  })}
${renderObjectMarkdown(title, value)}`;
}

function renderObjectMarkdown(title: string, value: unknown): string {
  return `# ${title}

\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\`
`;
}

function parseMcpBody(body: string): any {
  const response = parseMcpTransportBody(body);
  const record = asRecord(response);
  if (record?.error) {
    throw new Error(`GBrain MCP error: ${formatUnknown(record.error)}`);
  }

  const result = record && 'result' in record ? record.result : response;
  const toolResult = asRecord(result);
  if (toolResult?.isError) {
    const message = mcpContentText(toolResult) || formatUnknown(toolResult);
    throw new Error(`GBrain MCP tool error: ${message.slice(0, 500)}`);
  }

  const text = toolResult ? mcpContentText(toolResult) : undefined;
  if (text !== undefined) return parseMaybeJson(text);
  return result ?? {};
}

function parseMcpTransportBody(body: string): unknown {
  const trimmed = body.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith('event:') || trimmed.startsWith('data:') || trimmed.includes('\ndata:')) {
    const parsedEvents = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter((line) => line && line !== '[DONE]')
      .map(parseMaybeJson);
    for (let index = parsedEvents.length - 1; index >= 0; index -= 1) {
      const event = parsedEvents[index];
      if (asRecord(event)?.result || asRecord(event)?.error) return event;
    }
    return parsedEvents[parsedEvents.length - 1] ?? {};
  }

  return parseMaybeJson(trimmed);
}

function parseMaybeJson(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = parseMaybeJson(value);
  return asRecord(parsed) ?? {};
}

function mcpContentText(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.content)) return undefined;
  const parts = value.content
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => item.text)
    .filter((text): text is string => typeof text === 'string');
  return parts.length ? parts.join('\n') : undefined;
}

function extractGBrainResultItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return parseGBrainSearchText(value);
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ['results', 'items', 'pages', 'refs', 'matches']) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function parseGBrainSearchText(value: string): Record<string, unknown>[] {
  const hits: Record<string, unknown>[] = [];
  const linePattern = /^\s*\[([0-9.]+)\]\s+([^\s]+)(?:\s+--\s+(.*))?$/;
  for (const line of value.split('\n')) {
    const match = line.match(linePattern);
    if (!match) continue;
    const [, score, path, text = ''] = match;
    hits.push({
      provider: 'gbrain',
      score: Number(score),
      slug: path,
      path,
      title: text.replace(/^#\s*/, '').trim() || path,
      excerpt: text.trim(),
    });
  }
  return hits;
}

function normalizeGBrainSearchResult(item: unknown, index: number): MemorySearchResult {
  const record = asRecord(item) ?? {};
  const path = firstString(record.slug, record.path, record.file, record.file_path);
  const title = firstString(record.title, record.name, path) ?? `GBrain result ${index + 1}`;
  const rawExcerpt = firstString(
    record.excerpt,
    record.snippet,
    record.text,
    record.content,
    record.chunk_text,
    record.compiled_truth
  ) ?? formatUnknown(record).slice(0, 800);
  return {
    provider: 'gbrain',
    reportId: firstString(record.reportId, record.report_id) ?? reportIdFromPath(path),
    score: toScore(record.score, record.rank, record.rank_score, record.rrf_score, 5 - index),
    title,
    excerpt: rawExcerpt.slice(0, 800),
    path,
    url: firstString(record.url),
  };
}

function bugSlug(reportId: string): string {
  return `bugs/${safeReportId(reportId)}`;
}

function reportIdFromPath(path?: string): string | undefined {
  return path?.match(/(?:^|\/)(bug_[A-Za-z0-9_-]+)/)?.[1];
}

function frontmatter(values: Record<string, string | string[]>): string {
  const lines = Object.entries(values).map(([key, value]) => {
    if (Array.isArray(value)) return `${key}: [${value.map(yamlString).join(', ')}]`;
    return `${key}: ${yamlString(value)}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function toScore(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function formatUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

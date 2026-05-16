import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMemoryAdapter } from '../api/gbrain.js';
import { normalizeReportPayload } from '../api/report_contract.js';

test('memory adapter writes reports, searches similar reports, and stores diagnosis/outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-memory-'));
  const oldMemoryDir = process.env.MEMORY_DIR;
  const oldProvider = process.env.MEMORY_PROVIDER;
  process.env.MEMORY_DIR = root;
  process.env.MEMORY_PROVIDER = 'github-markdown';

  try {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
    const report = normalizeReportPayload(fixture, { id: 'bug_memory', createdAt: fixture.createdAt });
    const memory = createMemoryAdapter();

    const entry = await memory.putReport(report);
    assert.equal(entry.provider, 'github-markdown');
    assert.equal(entry.status, 'written');
    await stat(join(root, 'bugs', 'bug_memory.md'));

    const similar = await memory.searchSimilar(report);
    assert.ok(similar.some((result) => result.reportId === 'bug_memory'));

    await memory.putDiagnosis(report.id, { rootCause: 'user.name dereference', confidence: 0.82 });
    await memory.putOutcome(report.id, { pr: 'https://github.com/example/repo/pull/1', status: 'opened' });
    await stat(join(root, 'diagnosis', 'bug_memory.md'));
    await stat(join(root, 'outcomes', 'bug_memory.md'));
  } finally {
    if (oldMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = oldMemoryDir;
    if (oldProvider === undefined) delete process.env.MEMORY_PROVIDER;
    else process.env.MEMORY_PROVIDER = oldProvider;
  }
});

test('gbrain memory adapter writes pages through HTTP MCP and searches native results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gbrain-'));
  const calls: McpCall[] = [];
  const server = await createFakeGBrainServer(calls);
  const env = snapshotEnv();
  setGBrainEnv({ root, url: server.url, oauth: true });

  try {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
    const report = normalizeReportPayload(fixture, { id: 'bug_memory', createdAt: fixture.createdAt });
    const memory = createMemoryAdapter();

    const entry = await memory.putReport(report);
    assert.equal(entry.provider, 'gbrain');
    assert.equal(entry.status, 'written');
    assert.equal(entry.path, 'bugs/bug_memory');

    const similar = await memory.searchSimilar(report);
    assert.equal(similar[0]?.provider, 'gbrain');
    assert.equal(similar[0]?.reportId, 'bug_memory');
    assert.match(similar[0]?.excerpt ?? '', /Cannot read properties/);

    await memory.putDiagnosis(report.id, { rootCause: 'user.name dereference', confidence: 0.82 });
    await memory.putOutcome(report.id, { pr: 'https://github.com/example/repo/pull/1', status: 'opened' });

    const toolCalls = calls.filter((call) => call.path === '/mcp');
    assert.ok(toolCalls.every((call) => call.authorization === 'Bearer mcp-token'));
    assert.deepEqual(
      toolCalls.map((call) => call.tool),
      ['put_page', 'search', 'put_page', 'put_page']
    );
    assert.equal(
      toolCalls[1].arguments.query,
      'User profile crashes reading name Clicking Load User Profile crashes the dashboard.'
    );

    const putReport = toolCalls[0].arguments;
    assert.equal(putReport.slug, 'bugs/bug_memory');
    assert.match(String(putReport.content), /report_id: "bug_memory"/);
    assert.match(String(putReport.content), /type: "bug_report"/);
    assert.match(String(putReport.content), /## Console/);
    assert.match(String(putReport.content), /Cannot read properties of undefined reading 'name'/);
    assert.equal(toolCalls[2].arguments.slug, 'diagnosis/bug_memory');
    assert.equal(toolCalls[3].arguments.slug, 'outcomes/bug_memory');
  } finally {
    restoreEnv(env);
    await server.close();
  }
});

test('gbrain memory adapter parses text search output from hosted GBrain MCP', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gbrain-text-'));
  const calls: McpCall[] = [];
  const server = await createFakeGBrainServer(calls, {
    searchPayload: `[1.0000] bugs/bug_memory -- # Bug: User profile crashes reading name
[0.6749] bugs/bug_prior -- # Bug: Prior profile crash`,
  });
  const env = snapshotEnv();
  setGBrainEnv({ root, url: server.url, oauth: true });

  try {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
    const report = normalizeReportPayload(fixture, { id: 'bug_memory', createdAt: fixture.createdAt });
    const memory = createMemoryAdapter();

    const similar = await memory.searchSimilar(report);
    assert.equal(similar[0]?.provider, 'gbrain');
    assert.equal(similar[0]?.reportId, 'bug_memory');
    assert.equal(similar[0]?.score, 1);
    assert.equal(similar[0]?.path, 'bugs/bug_memory');
    assert.match(similar[0]?.title ?? '', /User profile crashes/);
    assert.equal(similar[1]?.reportId, 'bug_prior');
  } finally {
    restoreEnv(env);
    await server.close();
  }
});

test('gbrain provider falls back to markdown memory when MCP is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lite-annotate-gbrain-fallback-'));
  const server = await createFailingServer();
  const env = snapshotEnv();
  setGBrainEnv({ root, url: server.url, oauth: false });
  process.env.GBRAIN_MCP_TOKEN = 'static-token';

  try {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/report.json', import.meta.url), 'utf8'));
    const report = normalizeReportPayload(fixture, { id: 'bug_memory', createdAt: fixture.createdAt });
    const memory = createMemoryAdapter();

    const entry = await memory.putReport(report);
    assert.equal(entry.provider, 'github-markdown');
    assert.equal(entry.status, 'fallback-written');
    assert.match(entry.fallbackReason ?? '', /GBrain MCP put_page failed: 503/);
    await stat(join(root, 'bugs', 'bug_memory.md'));
  } finally {
    restoreEnv(env);
    await server.close();
  }
});

interface McpCall {
  path: string;
  authorization?: string;
  tool?: string;
  arguments: Record<string, unknown>;
}

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

async function createFakeGBrainServer(
  calls: McpCall[],
  options: { searchPayload?: unknown } = {}
): Promise<TestServer> {
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/.well-known/oauth-authorization-server') {
        return json(res, {
          token_endpoint: serverUrl(server, '/token'),
          grant_types_supported: ['client_credentials'],
          scopes_supported: ['read', 'write'],
        });
      }

      if (req.url === '/token') {
        const body = await readRequest(req);
        assert.match(body, /grant_type=client_credentials/);
        assert.match(body, /client_id=lite-annotate/);
        assert.match(body, /client_secret=test-secret/);
        return json(res, { access_token: 'mcp-token', token_type: 'Bearer', expires_in: 3600, scope: 'read write' });
      }

      if (req.url !== '/mcp') {
        res.writeHead(404).end('not found');
        return;
      }

      const body = JSON.parse(await readRequest(req));
      const tool = body.params?.name;
      const args = body.params?.arguments ?? {};
      calls.push({
        path: req.url,
        authorization: req.headers.authorization,
        tool,
        arguments: args,
      });

      if (tool === 'search') {
        return mcp(res, body.id, options.searchPayload ?? [
          {
            slug: 'bugs/bug_memory',
            title: 'Bug: User profile crashes reading name',
            excerpt: "Cannot read properties of undefined reading 'name'",
            score: 12,
          },
        ]);
      }

      return mcp(res, body.id, { ok: true, slug: args.slug });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' }).end(err instanceof Error ? err.message : String(err));
    }
  });

  await listen(server);
  return { url: serverUrl(server, '/mcp'), close: () => close(server) };
}

async function createFailingServer(): Promise<TestServer> {
  const server = createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' }).end('gbrain unavailable');
  });
  await listen(server);
  return { url: serverUrl(server, '/mcp'), close: () => close(server) };
}

function setGBrainEnv({ root, url, oauth }: { root: string; url: string; oauth: boolean }): void {
  process.env.MEMORY_DIR = root;
  process.env.MEMORY_PROVIDER = 'gbrain';
  process.env.GBRAIN_MCP_URL = url;
  delete process.env.GBRAIN_MCP_TOKEN;
  delete process.env.GBRAIN_ACCESS_TOKEN;
  delete process.env.GBRAIN_OAUTH_TOKEN_URL;
  delete process.env.GBRAIN_TOKEN_URL;
  process.env.GBRAIN_OAUTH_SCOPE = 'read write';
  if (oauth) {
    process.env.GBRAIN_CLIENT_ID = 'lite-annotate';
    process.env.GBRAIN_CLIENT_SECRET = 'test-secret';
  } else {
    delete process.env.GBRAIN_CLIENT_ID;
    delete process.env.GBRAIN_CLIENT_SECRET;
  }
}

function snapshotEnv(): Record<string, string | undefined> {
  return {
    MEMORY_DIR: process.env.MEMORY_DIR,
    MEMORY_PROVIDER: process.env.MEMORY_PROVIDER,
    GBRAIN_MCP_URL: process.env.GBRAIN_MCP_URL,
    GBRAIN_MCP_TOKEN: process.env.GBRAIN_MCP_TOKEN,
    GBRAIN_ACCESS_TOKEN: process.env.GBRAIN_ACCESS_TOKEN,
    GBRAIN_CLIENT_ID: process.env.GBRAIN_CLIENT_ID,
    GBRAIN_CLIENT_SECRET: process.env.GBRAIN_CLIENT_SECRET,
    GBRAIN_OAUTH_SCOPE: process.env.GBRAIN_OAUTH_SCOPE,
    GBRAIN_OAUTH_TOKEN_URL: process.env.GBRAIN_OAUTH_TOKEN_URL,
    GBRAIN_TOKEN_URL: process.env.GBRAIN_TOKEN_URL,
  };
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function readRequest(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function mcp(res: ServerResponse, id: unknown, payload: unknown): void {
  json(res, {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
    },
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function serverUrl(server: ReturnType<typeof createServer>, path: string): string {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}${path}`;
}

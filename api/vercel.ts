import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { app } from './index.js';

type VercelRequest = IncomingMessage & {
  body?: unknown;
};

export default async function handler(req: VercelRequest, res: ServerResponse) {
  try {
    const request = await toWebRequest(req);
    const response = await app.fetch(request);
    await writeWebResponse(res, response);
  } catch (err) {
    console.error('[vercel] request failed:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: 'request_failed', message: errorMessage(err) }));
  }
}

async function toWebRequest(req: VercelRequest): Promise<Request> {
  const method = req.method || 'GET';
  const headers = toWebHeaders(req.headers);
  const protocol = headerValue(req.headers['x-forwarded-proto']) || 'https';
  const host = headerValue(req.headers.host) || 'localhost';
  const url = new URL(req.url || '/', `${protocol}://${host}`);
  const init: RequestInit = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    const body = req.body === undefined ? await readIncomingBody(req) : serializeParsedBody(req.body);
    init.body = body;
  }

  return new Request(url, init);
}

function toWebHeaders(headers: IncomingHttpHeaders): Headers {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(key, item);
      continue;
    }
    webHeaders.set(key, String(value));
  }
  return webHeaders;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function serializeParsedBody(body: unknown): BodyInit {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  return JSON.stringify(body);
}

async function readIncomingBody(req: IncomingMessage): Promise<BodyInit> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (!response.body) {
    res.end();
    return;
  }

  res.end(Buffer.from(await response.arrayBuffer()));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

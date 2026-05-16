export interface LiteConsoleEvent {
  level: string;
  message: string;
  timestamp: string;
  source?: string;
  stack?: string;
}

export interface LiteNetworkEvent {
  type: 'fetch' | 'xhr' | string;
  method: string;
  url: string;
  status: number | null;
  durationMs: number | null;
  failed: boolean;
  error?: string;
  timestamp?: string;
}

export interface LiteSessionEvent {
  type: string;
  target?: string;
  route?: string;
  value?: string;
  timestamp: string;
}

export interface LiteScreenshot {
  type: 'data-url-or-url' | 'failure';
  value?: string;
  reason?: string;
}

export interface LiteAnnotation {
  title: string;
  description: string;
  target?: string;
  selector?: string;
  route?: string;
  x?: number;
  y?: number;
  viewportX?: number;
  viewportY?: number;
  elementRect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface LiteReport {
  id: string;
  projectId: string;
  repo: string;
  title: string;
  description: string;
  annotation: LiteAnnotation;
  url: string;
  route: string;
  userAgent: string;
  viewport: {
    width: number;
    height: number;
  };
  console: LiteConsoleEvent[];
  network: LiteNetworkEvent[];
  session: LiteSessionEvent[];
  screenshot: LiteScreenshot;
  createdAt: string;
}

export class ReportValidationError extends Error {
  readonly statusCode = 400;

  constructor(public readonly issues: string[]) {
    super(`Invalid report payload: ${issues.join('; ')}`);
    this.name = 'ReportValidationError';
  }
}

const MAX_BREADCRUMBS = 50;
const DEFAULT_PROJECT_ID = 'demo';

export function normalizeReportPayload(
  payload: unknown,
  assigned: { id: string; createdAt?: string }
): LiteReport {
  const issues: string[] = [];
  const input = isRecord(payload) ? payload : {};

  if (!isRecord(payload)) {
    issues.push('body must be a JSON object');
  }

  const annotation = isRecord(input.annotation) ? input.annotation : {};
  const browser = isRecord(input.browser) ? input.browser : {};

  const title = firstNonEmptyString(input.title, annotation.title);
  if (!title) issues.push('title is required');

  const url = firstNonEmptyString(input.url, browser.url);
  if (!url) issues.push('url is required');

  const userAgent = firstNonEmptyString(input.userAgent, browser.userAgent);
  if (!userAgent) issues.push('userAgent is required');

  const repo = firstNonEmptyString(input.repo, annotation.repo);
  if (!repo) issues.push('repo is required');

  const viewport = normalizeViewport(input.viewport ?? browser.viewport, issues);
  const createdAt = normalizeTimestamp(
    assigned.createdAt ?? input.createdAt ?? browser.timestamp,
    new Date().toISOString()
  );

  const report: LiteReport = {
    id: assigned.id,
    projectId: firstNonEmptyString(input.projectId, annotation.projectId) ?? DEFAULT_PROJECT_ID,
    repo: repo ?? '',
    title: title ?? '',
    description: firstString(input.description, annotation.description) ?? '',
    annotation: normalizeAnnotation(annotation, title ?? '', firstString(input.description, annotation.description) ?? ''),
    url: url ?? '',
    route: firstNonEmptyString(input.route, browser.route, routeFromUrl(url)) ?? '/',
    userAgent: userAgent ?? '',
    viewport,
    console: normalizeConsole(input.console ?? input.consoleLogs),
    network: normalizeNetwork(input.network),
    session: normalizeSession(input.session),
    screenshot: normalizeScreenshot(input.screenshot),
    createdAt,
  };

  if (issues.length) throw new ReportValidationError(issues);
  return report;
}

export function assertLiteReport(report: LiteReport): void {
  const issues: string[] = [];
  if (!report.id) issues.push('id is required');
  if (!report.projectId) issues.push('projectId is required');
  if (!report.repo) issues.push('repo is required');
  if (!report.title) issues.push('title is required');
  if (!report.url) issues.push('url is required');
  if (!report.route) issues.push('route is required');
  if (!report.userAgent) issues.push('userAgent is required');
  if (!Number.isFinite(report.viewport.width) || !Number.isFinite(report.viewport.height)) {
    issues.push('viewport width and height are required');
  }
  if (!Array.isArray(report.console)) issues.push('console must be an array');
  if (!Array.isArray(report.network)) issues.push('network must be an array');
  if (!Array.isArray(report.session)) issues.push('session must be an array');
  if (!report.screenshot?.type) issues.push('screenshot type is required');
  if (!report.createdAt) issues.push('createdAt is required');
  if (issues.length) throw new ReportValidationError(issues);
}

export function reportToSearchText(report: LiteReport): string {
  const consoleText = report.console.map((entry) => entry.message).join(' ');
  const networkText = report.network.map((entry) => `${entry.method} ${entry.url} ${entry.status ?? ''}`).join(' ');
  const sessionText = report.session.map((entry) => `${entry.type} ${entry.target ?? ''} ${entry.route ?? ''}`).join(' ');
  const annotationText = [
    report.annotation.target,
    report.annotation.selector,
    report.annotation.route,
  ].filter(Boolean).join(' ');
  return [
    report.title,
    report.description,
    annotationText,
    report.url,
    report.route,
    consoleText,
    networkText,
    sessionText,
  ].join(' ');
}

function normalizeAnnotation(value: unknown, title: string, description: string): LiteAnnotation {
  const annotation = isRecord(value) ? value : {};
  const elementRect = normalizeElementRect(annotation.elementRect);
  return {
    title,
    description,
    target: firstString(annotation.target, annotation.selectedElement, annotation.activeTarget),
    selector: firstString(annotation.selector),
    route: firstString(annotation.route),
    x: toNullableInteger(annotation.x) ?? undefined,
    y: toNullableInteger(annotation.y) ?? undefined,
    viewportX: toNullableInteger(annotation.viewportX) ?? undefined,
    viewportY: toNullableInteger(annotation.viewportY) ?? undefined,
    elementRect,
  };
}

function normalizeElementRect(value: unknown): LiteAnnotation['elementRect'] {
  const rect = isRecord(value) ? value : {};
  const x = toNullableInteger(rect.x);
  const y = toNullableInteger(rect.y);
  const width = toNullableInteger(rect.width);
  const height = toNullableInteger(rect.height);
  if (x === null || y === null || width === null || height === null) return undefined;
  return { x, y, width, height };
}

function normalizeViewport(value: unknown, issues: string[]): LiteReport['viewport'] {
  const viewport = isRecord(value) ? value : {};
  const width = toPositiveInteger(viewport.width);
  const height = toPositiveInteger(viewport.height);
  if (width === null || height === null) {
    issues.push('viewport.width and viewport.height are required');
  }
  return {
    width: width ?? 0,
    height: height ?? 0,
  };
}

function normalizeConsole(value: unknown): LiteConsoleEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_BREADCRUMBS).map((entry) => {
    const item = isRecord(entry) ? entry : {};
    const message = firstString(item.message, item.msg, item.error, String(entry)) ?? '';
    return {
      level: firstNonEmptyString(item.level, item.type) ?? 'log',
      message,
      timestamp: normalizeTimestamp(item.timestamp ?? item.ts, new Date().toISOString()),
      source: firstString(item.source),
      stack: firstString(item.stack),
    };
  });
}

function normalizeNetwork(value: unknown): LiteNetworkEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_BREADCRUMBS).map((entry) => {
    const item = isRecord(entry) ? entry : {};
    return {
      type: (firstNonEmptyString(item.type) ?? 'fetch') as LiteNetworkEvent['type'],
      method: (firstNonEmptyString(item.method) ?? 'GET').toUpperCase(),
      url: firstNonEmptyString(item.url) ?? '',
      status: toNullableInteger(item.status),
      durationMs: toNullableInteger(item.durationMs),
      failed: Boolean(item.failed),
      error: firstString(item.error),
      timestamp: item.timestamp ? normalizeTimestamp(item.timestamp, new Date().toISOString()) : undefined,
    };
  });
}

function normalizeSession(value: unknown): LiteSessionEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_BREADCRUMBS).map((entry) => {
    const item = isRecord(entry) ? entry : {};
    return {
      type: firstNonEmptyString(item.type) ?? 'event',
      target: firstString(item.target),
      route: firstString(item.route),
      value: firstString(item.value),
      timestamp: normalizeTimestamp(item.timestamp ?? item.ts, new Date().toISOString()),
    };
  });
}

function normalizeScreenshot(value: unknown): LiteScreenshot {
  if (typeof value === 'string' && value.trim()) {
    return { type: 'data-url-or-url', value };
  }
  if (isRecord(value)) {
    const type = firstNonEmptyString(value.type);
    const screenshotValue = firstNonEmptyString(value.value, value.url, value.dataUrl);
    if ((type === 'data-url-or-url' || screenshotValue) && screenshotValue) {
      return { type: 'data-url-or-url', value: screenshotValue };
    }
    return {
      type: 'failure',
      reason: firstNonEmptyString(value.reason, value.error) ?? 'capture_failed',
    };
  }
  return { type: 'failure', reason: 'not_provided' };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = firstString(value);
    if (stringValue?.trim()) return stringValue.trim();
  }
  return undefined;
}

function toPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function toNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

function routeFromUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !url.trim()) return undefined;
  try {
    return new URL(url).pathname || '/';
  } catch {
    return undefined;
  }
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

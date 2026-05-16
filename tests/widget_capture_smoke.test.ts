import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

test('widget captures browser breadcrumbs and submits the Person A payload shape', async () => {
  const script = await readFile(new URL('../widget/index.js', import.meta.url), 'utf8');
  const submitted: any[] = [];
  const context = createBrowserContext(submitted);

  vm.runInNewContext(script, context);

  context.console.error("Cannot read properties of undefined reading 'name'");
  context.window.onerror("Cannot read properties of undefined reading 'name'", 'app.js', 10, 5, new Error('profile crash'));
  context.window.dispatchEvent({ type: 'unhandledrejection', reason: new Error('async profile crash') });
  await context.window.fetch('/api/users/999');
  context.document.dispatchEvent({ type: 'click', target: fakeTarget('button', 'Load User Profile', 'load-profile') });
  context.document.dispatchEvent({ type: 'focusin', target: fakeTarget('input', 'Search') });

  const launcher = context.document.body.children.find((child: any) => child.getAttribute('data-lite-annotate-launcher') === 'true');
  assert.ok(launcher);
  await launcher.dispatchEvent({ type: 'click', target: launcher });

  const popover = context.document.body.children.find((child: any) => child !== launcher);
  const titleInput = popover.children.find((child: any) => child.tagName === 'INPUT');
  const descInput = popover.children.find((child: any) => child.tagName === 'TEXTAREA');
  const annotate = popover.children.find((child: any) => child.textContent === 'Annotate Page');
  const submit = popover.children.find((child: any) => child.textContent === 'Submit Report');
  titleInput.value = 'User profile crashes reading name';
  descInput.value = 'Clicking the profile button crashes.';
  await annotate.dispatchEvent({ type: 'click', target: annotate });
  await new Promise((resolve) => setTimeout(resolve, 0));
  context.document.dispatchEvent({
    type: 'click',
    target: fakeTarget('button', 'Load User Profile', 'load-profile'),
    pageX: 128,
    pageY: 244,
    clientX: 128,
    clientY: 244,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });
  await submit.dispatchEvent({ type: 'click', target: submit });

  assert.equal(submitted.length, 1);
  const payload = submitted[0];
  assert.equal(payload.title, 'User profile crashes reading name');
  assert.equal(payload.url, 'https://demo.example.com/users');
  assert.equal(payload.route, '/users');
  assert.equal(payload.annotation.target, 'button#load-profile:Load User Profile');
  assert.equal(payload.annotation.selector, 'button#load-profile');
  assert.equal(payload.annotation.x, 128);
  assert.equal(payload.annotation.viewportY, 244);
  assert.deepEqual(payload.viewport, { width: 1280, height: 720 });
  assert.ok(payload.console.some((entry: any) => entry.source === 'window.onerror'));
  assert.ok(payload.console.some((entry: any) => entry.source === 'unhandledrejection'));
  assert.ok(payload.network.some((entry: any) => entry.type === 'fetch' && entry.status === 404));
  assert.ok(payload.session.some((entry: any) => entry.type === 'click'));
  assert.equal(payload.screenshot.type, 'failure');
  assert.equal(payload.screenshot.reason, 'html2canvas_unavailable');
});

function createBrowserContext(submitted: any[]): any {
  const listeners = new Map<string, Function[]>();
  const document = new FakeDocument();
  const window: any = {
    ANNOTATE_API_URL: 'https://api.example.com',
    ANNOTATE_PROJECT_ID: 'demo',
    ANNOTATE_REPO: 'ibrolord/lite-annotate-demo',
    location: {
      protocol: 'https:',
      origin: 'https://demo.example.com',
      href: 'https://demo.example.com/users',
      pathname: '/users',
    },
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    document,
    navigator: { userAgent: 'Widget Smoke Browser' },
    performance: { now: nowCounter() },
    history: {
      pushState() {},
      replaceState() {},
    },
    addEventListener(type: string, handler: Function) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatchEvent(event: any) {
      for (const handler of listeners.get(event.type) ?? []) handler(event);
    },
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init: { detail?: unknown } = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    fetch: async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/report')) {
        submitted.push(JSON.parse(String(init?.body)));
        return response(201, { reportId: 'bug_widget_smoke' });
      }
      return response(404, { error: 'missing user' });
    },
  };
  window.window = window;

  return {
    window,
    document,
    navigator: window.navigator,
    history: window.history,
    location: window.location,
    performance: window.performance,
    CustomEvent: window.CustomEvent,
    console: {
      log() {},
      warn() {},
      error() {},
    },
    fetch: window.fetch,
    setTimeout,
    clearTimeout,
    Error,
    Array,
    String,
    JSON,
    Math,
    Date,
    encodeURIComponent,
  };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function nowCounter() {
  let value = 0;
  return () => {
    value += 10;
    return value;
  };
}

function fakeTarget(tagName: string, text: string, id = '') {
  return {
    tagName: tagName.toUpperCase(),
    id,
    nodeType: 1,
    className: '',
    parentElement: null,
    innerText: text,
    textContent: text,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { x: 52, y: 225, width: 152, height: 37 };
    },
  };
}

class FakeDocument {
  documentElement = new FakeElement('html');
  body = new FakeElement('body');
  listeners = new Map<string, Function[]>();

  createElement(tagName: string) {
    return new FakeElement(tagName);
  }

  addEventListener(type: string, handler: Function) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type: string, handler: Function) {
    const handlers = this.listeners.get(type) ?? [];
    this.listeners.set(type, handlers.filter((candidate) => candidate !== handler));
  }

  dispatchEvent(event: any) {
    for (const handler of this.listeners.get(event.type) ?? []) handler(event);
  }
}

class FakeElement {
  tagName: string;
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  listeners = new Map<string, Function[]>();
  attributes = new Map<string, string>();
  textContent = '';
  innerText = '';
  value = '';
  placeholder = '';
  rows = 0;
  disabled = false;
  id = '';
  nodeType = 1;
  className = '';
  parentElement: FakeElement | null = null;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(child: FakeElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove() {}

  contains(target: unknown): boolean {
    if (target === this) return true;
    return this.children.some((child) => child === target || child.contains(target));
  }

  getBoundingClientRect() {
    return { x: 52, y: 225, width: 152, height: 37 };
  }

  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }

  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }

  addEventListener(type: string, handler: Function) {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async dispatchEvent(event: any) {
    for (const handler of this.listeners.get(event.type) ?? []) {
      await handler(event);
    }
  }
}

(function () {
  const API_URL = window.ANNOTATE_API_URL ||
    (window.location.protocol === 'file:' ? 'http://localhost:3001' : window.location.origin);
  const PROJECT_ID = window.ANNOTATE_PROJECT_ID || 'demo';
  const REPO = window.ANNOTATE_REPO || 'ibrolord/lite-annotate-demo';
  const MAX_EVENTS = 50;

  const consoleEvents = [];
  const networkEvents = [];
  const sessionEvents = [];
  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  let selectedAnnotation = null;
  let annotationMarker = null;
  let annotationHighlight = null;

  function now() {
    return new Date().toISOString();
  }

  function pushCapped(list, item) {
    list.push(item);
    while (list.length > MAX_EVENTS) list.shift();
  }

  function stringifyArg(arg) {
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
    if (typeof arg === 'string') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }

  function recordConsole(level, args, source) {
    pushCapped(consoleEvents, {
      level,
      message: Array.from(args).map(stringifyArg).join(' '),
      timestamp: now(),
      source,
      stack: args.find((arg) => arg instanceof Error)?.stack,
    });
  }

  ['log', 'warn', 'error'].forEach((level) => {
    const original = console[level] && console[level].bind(console);
    if (!original) return;
    console[level] = (...args) => {
      recordConsole(level, args, 'console');
      original(...args);
    };
  });

  const previousOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    recordConsole('error', [
      `${message}${source ? ` at ${source}:${lineno || 0}:${colno || 0}` : ''}`,
      error instanceof Error ? error : '',
    ], 'window.onerror');
    if (typeof previousOnError === 'function') {
      return previousOnError.apply(this, arguments);
    }
    return false;
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error
      ? `${event.reason.name}: ${event.reason.message}`
      : stringifyArg(event.reason);
    recordConsole('error', [reason], 'unhandledrejection');
  });

  if (originalFetch) {
    window.fetch = async function annotateFetch(input, init) {
      const started = performance.now();
      const method = (init && init.method) || (input && input.method) || 'GET';
      const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      try {
        const response = await originalFetch(input, init);
        pushCapped(networkEvents, {
          type: 'fetch',
          method: String(method).toUpperCase(),
          url,
          status: response.status,
          durationMs: Math.round(performance.now() - started),
          failed: !response.ok,
          timestamp: now(),
        });
        return response;
      } catch (err) {
        pushCapped(networkEvents, {
          type: 'fetch',
          method: String(method).toUpperCase(),
          url,
          status: null,
          durationMs: Math.round(performance.now() - started),
          failed: true,
          error: err instanceof Error ? err.message : String(err),
          timestamp: now(),
        });
        throw err;
      }
    };
  }

  if (window.XMLHttpRequest) {
    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;
    window.XMLHttpRequest.prototype.open = function annotateXhrOpen(method, url) {
      this.__annotate = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      return originalOpen.apply(this, arguments);
    };
    window.XMLHttpRequest.prototype.send = function annotateXhrSend() {
      const xhr = this;
      const meta = xhr.__annotate || { method: 'GET', url: '' };
      const started = performance.now();
      const record = (failed, error) => {
        pushCapped(networkEvents, {
          type: 'xhr',
          method: meta.method,
          url: meta.url,
          status: Number.isFinite(xhr.status) ? xhr.status : null,
          durationMs: Math.round(performance.now() - started),
          failed,
          error,
          timestamp: now(),
        });
      };
      xhr.addEventListener('loadend', () => record(xhr.status >= 400));
      xhr.addEventListener('error', () => record(true, 'xhr_error'));
      xhr.addEventListener('abort', () => record(true, 'xhr_abort'));
      return originalSend.apply(this, arguments);
    };
  }

  function currentRoute() {
    return window.location.pathname || '/';
  }

  function targetLabel(target) {
    if (!target || target === document || target === window) return 'window';
    const tag = (target.tagName || 'element').toLowerCase();
    const id = target.id ? `#${target.id}` : '';
    const aria = target.getAttribute && target.getAttribute('aria-label');
    const text = (aria || target.innerText || target.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return text ? `${tag}${id}:${text}` : `${tag}${id}`;
  }

  function selectorPath(target) {
    if (!target || target === document || target === window || !target.tagName) return 'window';
    const parts = [];
    let node = target;
    while (node && node.nodeType === 1 && parts.length < 4) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += `#${node.id}`;
        parts.unshift(part);
        break;
      }
      if (node.className && typeof node.className === 'string') {
        const className = node.className.trim().split(/\s+/).filter(Boolean)[0];
        if (className) part += `.${className}`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ') || targetLabel(target);
  }

  function recordSession(type, target, extra) {
    pushCapped(sessionEvents, {
      type,
      target: target ? targetLabel(target) : undefined,
      route: currentRoute(),
      timestamp: now(),
      ...extra,
    });
  }

  document.addEventListener('click', (event) => recordSession('click', event.target), true);
  document.addEventListener('focusin', (event) => recordSession('focus', event.target), true);
  document.addEventListener('change', (event) => recordSession('change', event.target, { value: '[redacted]' }), true);

  function recordRouteChange(type) {
    recordSession(type, null, { route: currentRoute() });
  }

  ['pushState', 'replaceState'].forEach((name) => {
    const original = history[name];
    history[name] = function annotateHistoryChange() {
      const result = original.apply(this, arguments);
      recordRouteChange(name);
      return result;
    };
  });
  window.addEventListener('popstate', () => recordRouteChange('popstate'));
  window.addEventListener('hashchange', () => recordRouteChange('hashchange'));
  recordRouteChange('route');

  function el(tag, styles, attrs) {
    const element = document.createElement(tag);
    if (styles) element.style.cssText = styles;
    if (attrs) Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'placeholder') element.placeholder = value;
      else if (key === 'rows') element.rows = value;
      else element[key] = value;
    });
    return element;
  }

  function removeAnnotationChrome() {
    if (annotationMarker) annotationMarker.remove();
    if (annotationHighlight) annotationHighlight.remove();
    annotationMarker = null;
    annotationHighlight = null;
  }

  function drawAnnotationChrome(annotation) {
    removeAnnotationChrome();
    annotationMarker = el('div', [
      'position:absolute',
      `left:${Math.max(0, annotation.x - 13)}px`,
      `top:${Math.max(0, annotation.y - 34)}px`,
      'z-index:99998',
      'width:26px',
      'height:26px',
      'border-radius:50%',
      'background:#dc2626',
      'color:#fff',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font:700 13px/1 system-ui,sans-serif',
      'box-shadow:0 6px 18px rgba(220,38,38,0.35)',
      'pointer-events:none',
    ].join(';'));
    annotationMarker.textContent = '1';
    document.body.appendChild(annotationMarker);

    if (annotation.elementRect) {
      annotationHighlight = el('div', [
        'position:absolute',
        `left:${annotation.elementRect.x + window.scrollX}px`,
        `top:${annotation.elementRect.y + window.scrollY}px`,
        `width:${annotation.elementRect.width}px`,
        `height:${annotation.elementRect.height}px`,
        'z-index:99997',
        'border:2px solid #dc2626',
        'border-radius:6px',
        'box-shadow:0 0 0 3px rgba(220,38,38,0.14)',
        'pointer-events:none',
      ].join(';'));
      document.body.appendChild(annotationHighlight);
    }
  }

  function captureAnnotation(event) {
    const target = event.target;
    const rect = target && target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    const annotation = {
      target: targetLabel(target),
      selector: selectorPath(target),
      route: currentRoute(),
      x: Math.round((event.pageX ?? event.clientX + window.scrollX) || 0),
      y: Math.round((event.pageY ?? event.clientY + window.scrollY) || 0),
      viewportX: Math.round(event.clientX || 0),
      viewportY: Math.round(event.clientY || 0),
      elementRect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : undefined,
    };
    selectedAnnotation = annotation;
    drawAnnotationChrome(annotation);
    recordSession('annotation', target, {
      target: annotation.target,
      x: annotation.x,
      y: annotation.y,
    });
    window.dispatchEvent(new CustomEvent('lite-annotate:annotation-selected', { detail: annotation }));
    return annotation;
  }

  function startAnnotationMode(status, popover, button) {
    status.textContent = 'Click the broken area on the page.';
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = 'crosshair';

    const banner = el('div', [
      'position:fixed',
      'top:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:100000',
      'background:#111827',
      'color:#fff',
      'padding:10px 14px',
      'border-radius:8px',
      'font:500 13px system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.18)',
      'pointer-events:none',
    ].join(';'));
    banner.textContent = 'Click anywhere to pin this bug';
    document.body.appendChild(banner);

    const finish = (event) => {
      if (event.target === button || event.target === popover || (popover.contains && popover.contains(event.target))) {
        return;
      }
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      document.removeEventListener('click', finish, true);
      document.documentElement.style.cursor = previousCursor;
      banner.remove();
      const annotation = captureAnnotation(event);
      status.textContent = `Pinned ${annotation.target}`;
    };

    setTimeout(() => document.addEventListener('click', finish, true), 0);
  }

  async function captureScreenshot() {
    if (!window.html2canvas) {
      return { type: 'failure', reason: 'html2canvas_unavailable' };
    }
    try {
      const canvas = await window.html2canvas(document.body, { useCORS: true, logging: false });
      return { type: 'data-url-or-url', value: canvas.toDataURL('image/png') };
    } catch (err) {
      return {
        type: 'failure',
        reason: err instanceof Error ? err.message : 'screenshot_failed',
      };
    }
  }

  async function buildPayload(title, description) {
    return {
      projectId: PROJECT_ID,
      repo: REPO,
      title,
      description,
      annotation: {
        title,
        description,
        ...(selectedAnnotation || {}),
      },
      url: window.location.href,
      route: currentRoute(),
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      console: consoleEvents.slice(-MAX_EVENTS),
      network: networkEvents.slice(-MAX_EVENTS),
      session: sessionEvents.slice(-MAX_EVENTS),
      screenshot: await captureScreenshot(),
      createdAt: now(),
    };
  }

  function initWidget() {
    const button = el('button', [
      'position:fixed', 'bottom:24px', 'right:24px', 'z-index:99999',
      'width:48px', 'height:48px', 'border-radius:50%',
      'background:#111827', 'color:#fff', 'border:none',
      'cursor:pointer', 'font-size:20px',
      'box-shadow:0 4px 12px rgba(0,0,0,0.3)',
    ].join(';'));
    button.textContent = 'Bug';
    button.setAttribute('data-lite-annotate-launcher', 'true');
    document.body.appendChild(button);

    let popover = null;

    button.addEventListener('click', () => {
      if (popover) {
        popover.remove();
        popover = null;
        return;
      }

      popover = el('div', [
        'position:fixed', 'bottom:84px', 'right:24px', 'z-index:99999',
        'background:#fff', 'border:1px solid #e5e7eb', 'border-radius:8px',
        'padding:20px', 'width:320px',
        'box-shadow:0 8px 24px rgba(0,0,0,0.12)',
        'font-family:system-ui,sans-serif', 'color:#111827',
      ].join(';'));

      const heading = el('div', 'font-weight:600;font-size:15px;margin-bottom:12px;');
      heading.textContent = 'Report a Bug';

      const titleInput = el('input',
        'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box;margin-bottom:10px;',
        { placeholder: "What's broken?" }
      );

      const descInput = el('textarea',
        'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;box-sizing:border-box;resize:none;margin-bottom:12px;',
        { placeholder: 'Any extra details...', rows: 3 }
      );

      const annotateButton = el('button',
        'width:100%;padding:9px;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;margin-bottom:10px;'
      );
      annotateButton.textContent = 'Annotate Page';

      const annotationStatus = el('div', 'margin:-2px 0 10px;font-size:12px;color:#6b7280;');
      annotationStatus.textContent = 'No page annotation pinned yet.';

      const submitButton = el('button',
        'width:100%;padding:10px;background:#111827;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;'
      );
      submitButton.textContent = 'Submit Report';

      const status = el('div', 'margin-top:8px;font-size:13px;color:#6b7280;text-align:center;word-break:break-word;');

      popover.appendChild(heading);
      popover.appendChild(titleInput);
      popover.appendChild(descInput);
      popover.appendChild(annotateButton);
      popover.appendChild(annotationStatus);
      popover.appendChild(submitButton);
      popover.appendChild(status);
      document.body.appendChild(popover);

      annotateButton.addEventListener('click', () => {
        startAnnotationMode(annotationStatus, popover, button);
      });

      submitButton.addEventListener('click', async () => {
        const title = titleInput.value.trim();
        if (!title) {
          status.textContent = 'Please enter a title.';
          return;
        }

        status.textContent = 'Capturing...';
        submitButton.disabled = true;

        try {
          const payload = await buildPayload(title, descInput.value.trim());
          const submit = originalFetch || window.fetch.bind(window);
          const response = await submit(`${API_URL}/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(result.error || `Report failed with ${response.status}`);
          }
          window.dispatchEvent(new CustomEvent('lite-annotate:report-submitted', {
            detail: { payload, result },
          }));
          status.innerHTML = `Submitted: <a href="${API_URL}/reports/${encodeURIComponent(result.reportId || result.id)}/view" target="_blank" rel="noreferrer">${result.reportId || result.id}</a>`;
        } catch (err) {
          status.textContent = err instanceof Error ? err.message : 'Failed to submit. Is the API running?';
          submitButton.disabled = false;
        }
      });
    });
  }

  if (document.body) initWidget();
  else document.addEventListener('DOMContentLoaded', initWidget);
})();

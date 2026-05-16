import html2canvas from 'html2canvas';

export type SensitiveMode = 'standard' | 'strict';

const STANDARD_SENSITIVE_SELECTOR = [
  '[data-annotate-sensitive]',
  '[data-sensitive]',
  '[data-private]',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[aria-label*="password" i]',
  '[autocomplete*="password" i]',
  '[name*="token" i]',
  '[name*="secret" i]',
  '[name*="password" i]',
  '[name*="email" i]',
  '[id*="token" i]',
  '[id*="secret" i]',
  '[id*="password" i]',
  '[id*="email" i]',
].join(',');

const STRICT_SENSITIVE_SELECTOR = [
  STANDARD_SENSITIVE_SELECTOR,
  '.pii',
  '.phi',
  '.financial-data',
  '.sensitive',
  '[data-pii]',
  '[data-phi]',
  '[data-financial]',
  '[class*="ssn" i]',
  '[class*="patient" i]',
  '[class*="health" i]',
  '[class*="salary" i]',
  '[class*="bank" i]',
  '[class*="account" i]',
  '[class*="card" i]',
  '[class*="invoice" i]',
  '[class*="amount" i]',
  '[class*="total" i]',
  '[id*="ssn" i]',
  '[id*="patient" i]',
  '[id*="health" i]',
  '[id*="salary" i]',
  '[id*="bank" i]',
  '[id*="account" i]',
  '[id*="card" i]',
  '[id*="invoice" i]',
  '[id*="amount" i]',
  '[id*="total" i]',
].join(',');
// Keep the binary screenshot under 900 KB so base64 JSON still leaves room
// for replay, console, network, DOM, and step diagnostics under the API body limit.
const MAX_SCREENSHOT_BYTES = 900_000;

type ScreenshotAttempt = {
  scale: number;
  type: 'image/png' | 'image/jpeg';
  quality?: number;
};

interface CaptureScreenshotOptions {
  sensitiveSelector?: string;
  sensitiveMode?: SensitiveMode;
}

export type ScreenshotFailureReason = 'canvas_error' | 'to_blob_failed' | 'too_large';

export interface ScreenshotCaptureResult {
  blob: Blob | null;
  reason?: ScreenshotFailureReason;
  size?: number;
}

/**
 * captureScreenshot — uses the bundled html2canvas runtime so screenshots work
 * on customer sites that allow the widget script but block third-party CDNs.
 * Falls back to null on any error.
 */
export async function captureScreenshot(options: CaptureScreenshotOptions = {}): Promise<Blob | null> {
  return (await captureScreenshotWithDiagnostics(options)).blob;
}

export async function captureScreenshotWithDiagnostics(options: CaptureScreenshotOptions = {}): Promise<ScreenshotCaptureResult> {
  const restoreSensitive = maskSensitiveElements(options.sensitiveSelector, options.sensitiveMode);
  try {
    let largestAttemptedSize = 0;

    for (const attempt of screenshotAttempts()) {
      const canvas = await html2canvas(document.documentElement, {
        useCORS: true,
        allowTaint: false,
        logging: false,
        scale: attempt.scale,
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
        x: window.scrollX,
        y: window.scrollY,
        scrollX: -window.scrollX,
        scrollY: -window.scrollY,
        imageTimeout: 2000,
      });
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(
          (blob) => resolve(blob),
          attempt.type,
          attempt.quality
        );
      });
      if (!blob) return { blob: null, reason: 'to_blob_failed' };
      largestAttemptedSize = Math.max(largestAttemptedSize, blob.size);
      if (blob.size <= MAX_SCREENSHOT_BYTES) return { blob };
    }

    return { blob: null, reason: 'too_large', size: largestAttemptedSize };
  } catch {
    // CORS errors, cross-origin iframes, or missing html2canvas.
    return { blob: null, reason: 'canvas_error' };
  } finally {
    restoreSensitive();
  }
}

function screenshotAttempts(): ScreenshotAttempt[] {
  return uniqueAttempts([
    { scale: 1, type: 'image/png' },
    { scale: Math.min(window.devicePixelRatio || 1, 1.25), type: 'image/jpeg', quality: 0.72 },
    { scale: 1, type: 'image/jpeg', quality: 0.68 },
    { scale: 0.75, type: 'image/jpeg', quality: 0.6 },
    { scale: 0.5, type: 'image/jpeg', quality: 0.52 },
    { scale: 0.35, type: 'image/jpeg', quality: 0.45 },
  ]);
}

function uniqueAttempts(attempts: ScreenshotAttempt[]): ScreenshotAttempt[] {
  const seen = new Set<string>();
  return attempts
    .map((attempt) => ({
      ...attempt,
      scale: Math.max(0.25, Number(attempt.scale.toFixed(2))),
    }))
    .filter((attempt) => {
      const key = `${attempt.scale}:${attempt.type}:${attempt.quality}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function baseSensitiveSelector(sensitiveMode: SensitiveMode = 'standard'): string {
  return sensitiveMode === 'strict' ? STRICT_SENSITIVE_SELECTOR : STANDARD_SENSITIVE_SELECTOR;
}

export function buildSensitiveSelector(selector?: string, sensitiveMode: SensitiveMode = 'standard'): string {
  return [baseSensitiveSelector(sensitiveMode), selector]
    .filter(Boolean)
    .join(',');
}

export function maskSensitiveElements(selector?: string, sensitiveMode: SensitiveMode = 'standard'): () => void {
  const restore: Array<() => void> = [];
  const seen = new Set<HTMLElement>();

  const maskSelector = (candidate: string) => {
    try {
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(candidate))) {
        if (seen.has(el)) continue;
        seen.add(el);
        const previous = {
          color: el.style.color,
          textShadow: el.style.textShadow,
          backgroundColor: el.style.backgroundColor,
          caretColor: el.style.caretColor,
        };
        el.style.color = 'transparent';
        el.style.textShadow = '0 0 10px rgba(15, 23, 42, 0.95)';
        el.style.backgroundColor = 'rgba(15, 23, 42, 0.16)';
        el.style.caretColor = 'transparent';
        restore.push(() => {
          el.style.color = previous.color;
          el.style.textShadow = previous.textShadow;
          el.style.backgroundColor = previous.backgroundColor;
          el.style.caretColor = previous.caretColor;
        });
      }
    } catch {
      // Invalid customer-provided selector; ignore that selector only.
    }
  };

  maskSelector(baseSensitiveSelector(sensitiveMode));
  if (selector) {
    maskSelector(selector);
  }

  return () => {
    for (const restoreOne of restore.reverse()) restoreOne();
  };
}

export function safeSensitiveSelector(selector?: string, sensitiveMode: SensitiveMode = 'standard'): string {
  const base = baseSensitiveSelector(sensitiveMode);
  if (!selector) return base;
  try {
    document.querySelector(selector);
    return `${base},${selector}`;
  } catch {
    return base;
  }
}

/**
 * blobToBase64 — converts a Blob to a base64 data URL string.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

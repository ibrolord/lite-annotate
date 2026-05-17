import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeReportPayload } from '../api/report_contract.js';
import { runReportTriage } from '../api/triage.js';

const basePayload = {
  projectId: 'demo',
  repo: 'ibrolord/lite-annotate-demo',
  title: 'User profile crashes reading name',
  description: 'Clicking load profile crashes',
  url: 'https://demo.example.com/users',
  route: '/users',
  userAgent: 'node-test',
  viewport: { width: 1280, height: 720 },
  annotation: {
    title: 'User profile crashes reading name',
    description: 'Clicking load profile crashes',
    target: 'button:Load User Profile',
  },
  console: [
    {
      level: 'error',
      message: "Cannot read properties of undefined reading 'name'",
      timestamp: '2026-05-16T12:00:00.000Z',
    },
  ],
  network: [
    {
      type: 'fetch',
      method: 'GET',
      url: '/api/users/999',
      status: 404,
      durationMs: 33,
      failed: true,
      timestamp: '2026-05-16T12:00:00.000Z',
    },
  ],
  session: [
    {
      type: 'click',
      target: 'button:Load User Profile',
      timestamp: '2026-05-16T12:00:00.000Z',
    },
  ],
  screenshot: { type: 'failure', reason: 'not available in test' },
};

test('runReportTriage falls back to fast evidence-only triage without an API key', async () => {
  const report = normalizeReportPayload(basePayload, {
    id: 'bug_triage',
    createdAt: '2026-05-16T12:00:00.000Z',
  });

  const triage = await runReportTriage(report, { apiKey: '' });

  assert.equal(triage.source, 'heuristic');
  assert.equal(triage.verdict, 'real_bug');
  assert.equal(triage.isRealBug, true);
  assert.match(triage.userSummary, /User profile crashes reading name/);
  assert.match(triage.agentReport, /captured browser evidence/i);
  assert.equal(triage.nextAction, 'run_autofix');
  assert.ok(triage.evidence.some((item) => /Console error/.test(item)));
  assert.ok(triage.evidence.some((item) => /Network failure/.test(item)));
});

test('runReportTriage uses Claude Sonnet 4.6 through Anthropic messages API', async () => {
  const report = normalizeReportPayload(basePayload, {
    id: 'bug_triage_sonnet',
    createdAt: '2026-05-16T12:00:00.000Z',
  });
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestBody: Record<string, unknown> = {};
  let requestHeaderValues: Record<string, string | null> = {};
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const headers = new Headers(init?.headers);
    requestHeaderValues = {
      apiKey: headers.get('x-api-key'),
      anthropicVersion: headers.get('anthropic-version'),
    };
    return new Response(JSON.stringify({
      content: [{
        type: 'text',
        text: JSON.stringify({
          verdict: 'real_bug',
          confidence: 'high',
          isRealBug: true,
          userSummary: 'The user says the profile crashes after clicking Load User Profile.',
          agentReport: 'The browser capture shows a TypeError and a failed user lookup request, so this should be treated as a real bug.',
          headline: 'Sonnet triaged this as a real bug',
          rationale: 'Runtime evidence and failed network evidence are both present.',
          evidence: ["Console error: Cannot read properties of undefined reading 'name'", 'Network failure: GET /api/users/999 -> 404'],
          nextAction: 'run_autofix',
        }),
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const triage = await runReportTriage(report, { apiKey: 'anthropic-test-token', timeoutMs: 1000 });

    assert.equal(requestUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(requestHeaderValues.apiKey, 'anthropic-test-token');
    assert.equal(requestHeaderValues.anthropicVersion, '2023-06-01');
    assert.equal(requestBody.model, 'claude-sonnet-4-6');
    assert.equal(requestBody.max_tokens, 600);
    assert.equal(triage.source, 'llm');
    assert.equal(triage.model, 'claude-sonnet-4-6');
    assert.equal(triage.verdict, 'real_bug');
    assert.match(triage.userSummary, /profile crashes/);
    assert.match(triage.agentReport, /TypeError/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

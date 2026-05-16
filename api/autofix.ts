import Anthropic from '@anthropic-ai/sdk';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const client = new Anthropic();
const REPO_PATH = process.env.REPO_PATH || process.env.HOME + '/lite-annotate/demo-app';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "ibrolord/lite-annotate-demo"

export async function triggerAutofix(bugId: string, report: any) {
  console.log(`[autofix] starting for bug ${bugId}`);

  // 1. Find source files
  let files: string[] = [];
  try {
    const result = execFileSync('find', [
      REPO_PATH + '/src',
      '(',
      '-name', '*.ts',
      '-o', '-name', '*.tsx',
      '-o', '-name', '*.js',
      ')',
    ], { encoding: 'utf8' });
    files = result.split('\n').filter(Boolean).slice(0, 10);
  } catch {
    try {
      const result = execFileSync('find', [
        REPO_PATH, '-maxdepth', '2',
        '(', '-name', '*.ts', '-o', '-name', '*.js', ')',
      ], { encoding: 'utf8' });
      files = result.split('\n').filter(Boolean).slice(0, 10);
    } catch {
      console.error('[autofix] could not find source files');
      return;
    }
  }

  const fileContents = files
    .map((f) => {
      try { return `--- ${f} ---\n${readFileSync(f, 'utf8')}`; }
      catch { return null; }
    })
    .filter(Boolean)
    .join('\n\n');

  console.log(`[autofix] sending ${files.length} files to Claude`);

  // 2. Ask Claude for a fix
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: `You are an autofix agent. You receive a bug report and source code.
Return ONLY valid JSON: { "filePath": "...", "fixedCode": "...", "prTitle": "...", "explanation": "..." }
filePath must be one of the files provided. fixedCode is the complete fixed file content.`,
    messages: [{
      role: 'user',
      content: `Bug Report:
Title: ${report.title}
Description: ${report.description || 'none'}
URL: ${report.url}
Console Logs:
${(report.consoleLogs || []).map((l: any) => `[${l.level}] ${l.msg}`).join('\n')}

Source files:
${fileContents}

Fix the bug. Return JSON only.`,
    }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  console.log('[autofix] Claude responded');

  let fix: any;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    fix = JSON.parse(jsonMatch?.[0] || raw);
  } catch {
    console.error('[autofix] malformed JSON:', raw.slice(0, 200));
    return;
  }

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log('[autofix] No GITHUB_TOKEN/GITHUB_REPO — skipping PR');
    console.log('[autofix] Fix:', fix.explanation);
    return;
  }

  await openPR(bugId, fix);
}

async function openPR(bugId: string, fix: any) {
  const branch = `fix/bug-${bugId.slice(0, 8)}`;
  const [owner, repo] = GITHUB_REPO!.split('/');

  const headers = {
    Authorization: `token ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Get main SHA
  const refsRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/main`,
    { headers }
  );
  const refs = await refsRes.json() as any;
  const sha = refs.object?.sha;
  if (!sha) { console.error('[autofix] could not get main SHA'); return; }

  // Create branch
  await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
    method: 'POST', headers,
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });

  // Get file SHA
  const filePath = fix.filePath.replace(REPO_PATH + '/', '').replace(/^\//, '');
  const fileRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    { headers }
  );
  const fileData = await fileRes.json() as any;

  // Commit fix
  await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      message: fix.prTitle,
      content: Buffer.from(fix.fixedCode).toString('base64'),
      sha: fileData.sha,
      branch,
    }),
  });

  // Open PR
  const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: 'POST', headers,
    body: JSON.stringify({
      title: fix.prTitle,
      body: `**Bug:** ${fix.explanation}\n\n*Auto-fixed by Lite Annotate + GBrain*\n\nBug ID: \`${bugId}\``,
      head: branch,
      base: 'main',
    }),
  });

  const pr = await prRes.json() as any;
  console.log(`[autofix] PR opened: ${pr.html_url}`);
}

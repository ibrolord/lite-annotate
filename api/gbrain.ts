import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const GBRAIN_DIR = process.env.GBRAIN_DIR || join(homedir(), '.gbrain', 'bugs');

export function writeBugToGBrain(report: {
  id: string;
  title: string;
  description?: string;
  url: string;
  consoleLogs?: Array<{ level: string; msg: string; ts: number }>;
}) {
  mkdirSync(GBRAIN_DIR, { recursive: true });

  const logs = (report.consoleLogs || [])
    .map((l) => `[${l.level}] ${l.msg}`)
    .join('\n');

  const content = `# Bug: ${report.title}

## ID
${report.id}

## URL
${report.url}

## Description
${report.description || 'No description provided'}

## Console Logs
\`\`\`
${logs || 'No logs captured'}
\`\`\`

## Status
open

## Created
${new Date().toISOString()}
`;

  writeFileSync(join(GBRAIN_DIR, `${report.id}.md`), content);
}

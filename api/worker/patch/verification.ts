import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export interface StructuredPatchFile {
  path: string;
  content: string;
}

export interface VerificationCommandInput {
  command: string;
  args: string[];
}

export interface VerificationCommandResult {
  name: string;
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface PatchVerificationResult {
  ok: boolean;
  modifiedFiles: string[];
  commands: VerificationCommandResult[];
  error?: string;
}

export interface StructuredPatchVerificationInput {
  workspacePath: string;
  targetFiles: string[];
  files: StructuredPatchFile[];
  smokeCommands?: VerificationCommandInput[];
  runPackageScripts?: boolean;
}

const PACKAGE_SCRIPT_ORDER = ['test', 'typecheck', 'build'] as const;

function normalizeRepoPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((segment) => segment === '..') ||
    normalized.length > 240
  ) {
    return null;
  }
  return normalized;
}

function resolveInside(root: string, repoPath: string): string | null {
  const absolute = resolve(root, repoPath);
  const rel = relative(root, absolute);
  if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) return null;
  return absolute;
}

function isJavaScriptPath(path: string): boolean {
  return /\.(?:cjs|mjs|js|jsx)$/i.test(path);
}

function isTypeScriptPath(path: string): boolean {
  return /\.(?:ts|tsx)$/i.test(path);
}

function isCssPath(path: string): boolean {
  return /\.(?:css|scss)$/i.test(path);
}

function isHtmlPath(path: string): boolean {
  return /\.(?:html)$/i.test(path);
}

function inlineCheck(name: string, check: () => string): VerificationCommandResult {
  try {
    return { name, ok: true, stdout: check(), stderr: '' };
  } catch (error) {
    return {
      name,
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertNoConflictMarkers(path: string, content: string): void {
  if (/^(<<<<<<<|=======|>>>>>>>) /m.test(content)) {
    throw new Error(`${path} contains merge conflict markers`);
  }
}

function checkBalancedDelimiters(path: string, content: string, open: string, close: string): void {
  let depth = 0;
  for (const char of content) {
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth < 0) throw new Error(`${path} has an unmatched ${close}`);
  }
  if (depth !== 0) throw new Error(`${path} has unbalanced ${open}${close}`);
}

function validateCss(path: string, content: string): string {
  assertNoConflictMarkers(path, content);
  checkBalancedDelimiters(path, content, '{', '}');
  checkBalancedDelimiters(path, content, '(', ')');
  return 'CSS sanity check passed';
}

function validateHtml(path: string, content: string): string {
  assertNoConflictMarkers(path, content);
  checkBalancedDelimiters(path, content, '<', '>');
  return 'HTML sanity check passed';
}

function validateTypeScript(path: string, content: string): string {
  assertNoConflictMarkers(path, content);
  checkBalancedDelimiters(path, content, '{', '}');
  checkBalancedDelimiters(path, content, '(', ')');
  checkBalancedDelimiters(path, content, '[', ']');
  return 'TypeScript sanity check passed';
}

function runCommand(cwd: string, command: VerificationCommandInput, displayName?: string): VerificationCommandResult {
  const name = displayName ?? [command.command, ...command.args].join(' ');
  try {
    const stdout = execFileSync(command.command, command.args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return { name, ok: true, stdout, stderr: '' };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      name,
      ok: false,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

function packageScripts(workspacePath: string): string[] {
  const packageJson = join(workspacePath, 'package.json');
  if (!existsSync(packageJson)) return [];

  try {
    const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as { scripts?: Record<string, unknown> };
    return PACKAGE_SCRIPT_ORDER.filter((script) => typeof parsed.scripts?.[script] === 'string');
  } catch {
    return [];
  }
}

function validatePatchScope(files: StructuredPatchFile[], targetFiles: string[]): string | null {
  const allowed = new Set(targetFiles.map(normalizeRepoPath));
  if (allowed.has(null)) return 'targetFiles contains an unsafe path';

  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    if (!path) return `Patch contains unsafe path: ${file.path}`;
    if (!allowed.has(path)) return `Patch attempts to modify ${path} outside targetFiles`;
  }

  return null;
}

export function verifyStructuredPatch(input: StructuredPatchVerificationInput): PatchVerificationResult {
  const workspacePath = resolve(input.workspacePath);
  const scopeError = validatePatchScope(input.files, input.targetFiles);
  if (scopeError) return { ok: false, modifiedFiles: [], commands: [], error: scopeError };

  const modifiedFiles: string[] = [];

  for (const file of input.files) {
    const repoPath = normalizeRepoPath(file.path);
    if (!repoPath) return { ok: false, modifiedFiles, commands: [], error: `Patch contains unsafe path: ${file.path}` };

    const absolutePath = resolveInside(workspacePath, repoPath);
    if (!absolutePath) return { ok: false, modifiedFiles, commands: [], error: `Patch escapes workspace: ${repoPath}` };

    const previous = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;
    if (previous === file.content) continue;

    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, file.content);
    modifiedFiles.push(repoPath);
  }

  const commands: VerificationCommandResult[] = [];
  if (input.runPackageScripts !== false) {
    for (const script of packageScripts(workspacePath)) {
      const result = runCommand(
        workspacePath,
        { command: 'npm', args: ['run', script] },
        `npm run ${script}`
      );
      commands.push(result);
      if (!result.ok) {
        return { ok: false, modifiedFiles, commands, error: `${result.name} failed` };
      }
    }
  }

  for (const file of modifiedFiles.filter(isJavaScriptPath)) {
    const result = runCommand(
      workspacePath,
      { command: process.execPath, args: ['--check', file] },
      `node --check ${file}`
    );
    commands.push(result);
    if (!result.ok) {
      return { ok: false, modifiedFiles, commands, error: `${result.name} failed` };
    }
  }

  for (const file of modifiedFiles.filter(isTypeScriptPath)) {
    const absolutePath = resolveInside(workspacePath, file);
    const content = absolutePath ? readFileSync(absolutePath, 'utf8') : '';
    const result = inlineCheck(`typescript sanity ${file}`, () => validateTypeScript(file, content));
    commands.push(result);
    if (!result.ok) {
      return { ok: false, modifiedFiles, commands, error: `${result.name} failed` };
    }
  }

  for (const file of modifiedFiles.filter(isCssPath)) {
    const absolutePath = resolveInside(workspacePath, file);
    const content = absolutePath ? readFileSync(absolutePath, 'utf8') : '';
    const result = inlineCheck(`css sanity ${file}`, () => validateCss(file, content));
    commands.push(result);
    if (!result.ok) {
      return { ok: false, modifiedFiles, commands, error: `${result.name} failed` };
    }
  }

  for (const file of modifiedFiles.filter(isHtmlPath)) {
    const absolutePath = resolveInside(workspacePath, file);
    const content = absolutePath ? readFileSync(absolutePath, 'utf8') : '';
    const result = inlineCheck(`html sanity ${file}`, () => validateHtml(file, content));
    commands.push(result);
    if (!result.ok) {
      return { ok: false, modifiedFiles, commands, error: `${result.name} failed` };
    }
  }

  for (const smoke of input.smokeCommands ?? []) {
    const result = runCommand(workspacePath, smoke);
    commands.push(result);
    if (!result.ok) {
      return { ok: false, modifiedFiles, commands, error: `${result.name} failed` };
    }
  }

  return { ok: true, modifiedFiles: modifiedFiles.sort(), commands };
}

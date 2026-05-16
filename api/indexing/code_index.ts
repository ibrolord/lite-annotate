import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx']);
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'vendor',
]);
const IGNORED_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);

export interface IndexedCodeFile {
  path: string;
  language: 'javascript' | 'typescript';
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  components: string[];
  routeHints: string[];
  symbolReferences: string[];
  nearbyTests: string[];
  content: string;
}

export interface CodeIndex {
  root: string;
  files: IndexedCodeFile[];
  packageScripts: Record<string, string>;
}

export interface ReportLike {
  repo?: string;
  title?: string;
  description?: string;
  repo?: string;
  url?: string;
  route?: string;
  console?: Array<{ level?: string; message?: string; msg?: string }>;
  consoleLogs?: Array<{ level?: string; message?: string; msg?: string }>;
  network?: Array<{ method?: string; url?: string; status?: number; failed?: boolean }>;
  session?: Array<{ type?: string; target?: string }>;
}

export interface RankedCandidateFile {
  path: string;
  score: number;
  reasons: string[];
  file: IndexedCodeFile;
}

function toRepoPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function isIgnoredFile(path: string): boolean {
  const name = basename(path);
  if (IGNORED_FILE_NAMES.has(name)) return true;
  if (/^\.env[.\w-]*$/.test(name)) return true;
  return false;
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path));
}

function readPackageScripts(root: string): Record<string, string> {
  const packagePath = join(root, 'package.json');
  if (!existsSync(packagePath)) return {};

  try {
    const json = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, unknown> };
    const scripts: Record<string, string> = {};
    for (const [name, value] of Object.entries(json.scripts ?? {})) {
      if (typeof value === 'string') scripts[name] = value;
    }
    return scripts;
  } catch {
    return {};
  }
}

function walkSourceFiles(root: string, dir = root): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) files.push(...walkSourceFiles(root, absolute));
      continue;
    }
    if (!entry.isFile() || isIgnoredFile(absolute) || !isSourceFile(absolute)) continue;
    files.push(absolute);
  }

  return files;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function extractAll(content: string, pattern: RegExp, group = 1): string[] {
  const values: string[] = [];
  for (const match of content.matchAll(pattern)) {
    const value = match[group];
    if (value) values.push(value);
  }
  return values;
}

function extractNamedExports(content: string): string[] {
  const direct = [
    ...extractAll(content, /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g),
    ...extractAll(content, /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g),
    ...extractAll(content, /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g),
  ];
  const grouped = extractAll(content, /\bexport\s*\{([^}]+)\}/g)
    .flatMap((group) => group.split(','))
    .map((name) => name.trim().replace(/\s+as\s+.*$/i, ''));
  return unique([...direct, ...grouped]);
}

function extractFunctions(content: string): string[] {
  return unique([
    ...extractAll(content, /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g),
    ...extractAll(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g),
    ...extractAll(content, /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g),
  ]);
}

function extractClasses(content: string): string[] {
  return unique(extractAll(content, /\bclass\s+([A-Za-z_$][\w$]*)/g));
}

function extractImports(content: string): string[] {
  return unique([
    ...extractAll(content, /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g),
    ...extractAll(content, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ]);
}

function extractRouteHints(repoPath: string, content: string): string[] {
  const hints = extractAll(content, /['"`](\/[A-Za-z0-9_./:-]+)['"`]/g)
    .filter((value) => value.length > 1 && !value.startsWith('//'));

  const pathSegments = repoPath
    .replace(/\.(test|spec)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/i, '')
    .split('/')
    .filter((segment) => segment && !['src', 'app', 'pages', 'components', 'lib', 'utils', 'index'].includes(segment));
  for (const segment of pathSegments) {
    if (/^[A-Za-z0-9_-]+$/.test(segment)) hints.push(`/${segment.toLowerCase()}`);
  }

  return unique(hints);
}

function extractSymbolReferences(content: string): string[] {
  return unique(extractAll(content, /\b[A-Za-z_$][\w$]*\b/g).filter((value) => value.length > 2));
}

function languageFor(path: string): IndexedCodeFile['language'] {
  return extname(path).includes('ts') ? 'typescript' : 'javascript';
}

function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?)\//i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function baseWithoutTestSuffix(path: string): string {
  return basename(path)
    .replace(/\.(test|spec)\.[^.]+$/i, '')
    .replace(/\.[^.]+$/i, '');
}

function attachNearbyTests(files: IndexedCodeFile[]): void {
  const tests = files.filter((file) => isTestPath(file.path));
  for (const file of files) {
    if (isTestPath(file.path)) continue;
    const fileBase = baseWithoutTestSuffix(file.path);
    file.nearbyTests = tests
      .filter((testFile) => {
        if (baseWithoutTestSuffix(testFile.path) !== fileBase) return false;
        const testDir = dirname(testFile.path);
        const fileDir = dirname(file.path);
        return testDir === fileDir || testDir.includes(fileDir) || fileDir.includes(testDir);
      })
      .map((testFile) => testFile.path)
      .sort();
  }
}

export function buildCodeIndex(root: string): CodeIndex {
  const resolvedRoot = existsSync(root) ? root : join(process.cwd(), root);
  const files = walkSourceFiles(resolvedRoot)
    .filter((path) => statSync(path).size <= 250_000)
    .map((path): IndexedCodeFile => {
      const repoPath = toRepoPath(resolvedRoot, path);
      const content = readFileSync(path, 'utf8');
      const functions = extractFunctions(content);
      const classes = extractClasses(content);
      const components = unique([...functions, ...classes].filter((name) => /^[A-Z]/.test(name)));

      return {
        path: repoPath,
        language: languageFor(repoPath),
        imports: extractImports(content),
        exports: extractNamedExports(content),
        functions,
        classes,
        components,
        routeHints: extractRouteHints(repoPath, content),
        symbolReferences: extractSymbolReferences(content),
        nearbyTests: [],
        content,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  attachNearbyTests(files);

  return {
    root: resolvedRoot,
    files,
    packageScripts: readPackageScripts(resolvedRoot),
  };
}

function reportText(report: ReportLike): string {
  const consoleEvents = [...(report.console ?? []), ...(report.consoleLogs ?? [])]
    .map((entry) => `${entry.level ?? ''} ${entry.message ?? entry.msg ?? ''}`)
    .join('\n');
  const networkEvents = (report.network ?? [])
    .map((entry) => `${entry.method ?? ''} ${entry.url ?? ''} ${entry.status ?? ''} ${entry.failed ? 'failed' : ''}`)
    .join('\n');
  const sessionEvents = (report.session ?? [])
    .map((entry) => `${entry.type ?? ''} ${entry.target ?? ''}`)
    .join('\n');

  return [
    report.title,
    report.description,
    report.url,
    report.route,
    consoleEvents,
    networkEvents,
    sessionEvents,
  ]
    .filter(Boolean)
    .join('\n');
}

function reportTokens(report: ReportLike): Set<string> {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'clicking', 'button']);
  return new Set(
    reportText(report)
      .toLowerCase()
      .match(/[a-z][a-z0-9_]{2,}/g)
      ?.filter((token) => !stopWords.has(token)) ?? []
  );
}

function routeTokens(report: ReportLike): string[] {
  const values = [report.route, report.url, ...(report.network ?? []).map((entry) => entry.url)]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return unique(values.match(/\/([a-z0-9_-]+)/g)?.map((value) => value.slice(1)) ?? []);
}

function quotedConsoleSymbols(report: ReportLike): string[] {
  const messages = [...(report.console ?? []), ...(report.consoleLogs ?? [])]
    .map((entry) => entry.message ?? entry.msg ?? '')
    .join('\n');
  return unique(extractAll(messages, /['"`]([A-Za-z_$][\w$]*)['"`]/g));
}

function stackTracePaths(report: ReportLike): string[] {
  return unique(
    extractAll(reportText(report), /((?:src|app|pages|lib|components)\/[A-Za-z0-9_./-]+\.[cm]?[jt]sx?)(?::\d+)?/g)
  );
}

function addScore(
  state: { score: number; reasons: string[] },
  points: number,
  reason: string
): void {
  state.score += points;
  state.reasons.push(reason);
}

export function rankCandidateFiles(index: CodeIndex, report: ReportLike): RankedCandidateFile[] {
  const tokens = reportTokens(report);
  const routes = routeTokens(report);
  const consoleSymbols = quotedConsoleSymbols(report);
  const stackPaths = stackTracePaths(report);

  return index.files
    .filter((file) => !isTestPath(file.path))
    .map((file): RankedCandidateFile => {
      const state = { score: 0, reasons: [] as string[] };
      const lowerPath = file.path.toLowerCase();
      const lowerContent = file.content.toLowerCase();
      const basenameToken = baseWithoutTestSuffix(file.path).toLowerCase();

      for (const stackPath of stackPaths) {
        if (file.path === stackPath || file.path.endsWith(`/${stackPath}`)) {
          addScore(state, 2600, `stack trace references ${stackPath}`);
        }
      }

      for (const route of routes) {
        if (lowerPath.includes(route)) addScore(state, 240, `path matches route token "${route}"`);
        if (file.routeHints.includes(`/${route}`)) addScore(state, 220, `route hint matches /${route}`);
        if (basenameToken === route || basenameToken === route.replace(/s$/, '')) {
          addScore(state, 180, `file name matches route token "${route}"`);
        }
      }

      for (const symbol of consoleSymbols) {
        const lowerSymbol = symbol.toLowerCase();
        if (lowerContent.includes(`.${lowerSymbol}`) || lowerContent.includes(`[${JSON.stringify(lowerSymbol)}]`)) {
          addScore(state, 180, `code references console symbol "${symbol}"`);
        } else if (file.symbolReferences.some((ref) => ref.toLowerCase() === lowerSymbol)) {
          addScore(state, 90, `symbol table references "${symbol}"`);
        }
      }

      for (const token of tokens) {
        if (lowerPath.includes(token)) addScore(state, 60, `path matches report token "${token}"`);
        if (file.exports.some((name) => name.toLowerCase().includes(token))) {
          addScore(state, 45, `export matches report token "${token}"`);
        }
        if (file.functions.some((name) => name.toLowerCase().includes(token))) {
          addScore(state, 35, `function matches report token "${token}"`);
        }
      }

      if (file.nearbyTests.length > 0) addScore(state, 15, `nearby tests: ${file.nearbyTests.join(', ')}`);

      return {
        path: file.path,
        score: state.score,
        reasons: unique(state.reasons),
        file,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

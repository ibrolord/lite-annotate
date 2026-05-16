import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LiteReport } from './report_contract.js';

export interface StoredReportRecord {
  report: LiteReport;
  raw: unknown;
  memory?: unknown;
  autofix?: StoredAutofixRecord;
  updatedAt: string;
}

export interface StoredAutofixRecord extends Record<string, unknown> {
  status?: string;
}

export class ReportStore {
  constructor(private readonly rootDir = defaultReportStoreDir()) {}

  async put(record: StoredReportRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.reportPath(record.report.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  }

  async get(reportId: string): Promise<StoredReportRecord | null> {
    try {
      const content = await readFile(this.reportPath(reportId), 'utf8');
      return JSON.parse(content) as StoredReportRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async update(reportId: string, update: (record: StoredReportRecord) => StoredReportRecord): Promise<StoredReportRecord | null> {
    const record = await this.get(reportId);
    if (!record) return null;
    const next = update(record);
    await this.put(next);
    return next;
  }

  async list(): Promise<LiteReport[]> {
    try {
      const names = await readdir(this.rootDir);
      const records = await Promise.all(
        names
          .filter((name) => name.endsWith('.json'))
          .map((name) => readFile(join(this.rootDir, name), 'utf8').then((content) => JSON.parse(content) as StoredReportRecord))
      );
      return records
        .map((record) => record.report)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  private reportPath(reportId: string): string {
    return join(this.rootDir, `${safeReportId(reportId)}.json`);
  }
}

export function defaultReportStoreDir(): string {
  return process.env.REPORT_STORE_DIR || join(process.cwd(), '.lite-annotate', 'reports');
}

export function safeReportId(reportId: string): string {
  const safe = reportId.replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`Invalid report id: ${reportId}`);
  }
  return safe;
}

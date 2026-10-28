/**
 * `screentrackr sync`, the parts that are not the command line: one sync at a
 * time (a lock under the data home), running each saved source with its
 * failure kept to itself, and each source's last run in `meta`
 * (`sync_last:<kind>`). Reading and applying a source is the same code
 * `import` runs; the CLI passes it in as `run`.
 *
 * Nothing here holds a secret: sources carry no tokens (core/config.ts
 * refuses them), and failure messages have any token value the environment
 * holds replaced before they are printed or stored.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncKind, SyncSource } from './config.js';
import type { Db } from './db.js';
import { LibraryError } from './errors.js';
import type { ImportSummary } from './importers/index.js';
import { sqlite } from './sqlite.js';

export const SYNC_LOCK_FILE = 'sync.lock';
export const SYNC_PID_FILE = 'sync.pid';
const META_PREFIX = 'sync_last:';
const MAX_ERROR_CHARS = 500;

/** Another sync holds the lock. A user error (exit 1). */
export class SyncBusyError extends LibraryError {
  constructor(readonly pid: number | null) {
    super(`A sync is already running${pid !== null ? ` (process ${pid})` : ''}. Try again when it finishes.`);
    this.name = 'SyncBusyError';
  }
}

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown };
  return (typeof e.errcode === 'number' && (e.errcode & 0xff) === 5) || /database is locked|SQLITE_BUSY/i.test(String(e.message));
}

function holderPid(home: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(home, SYNC_PID_FILE), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the sync lock under `home` (which must exist), or throw SyncBusyError.
 * The same primitive as the setup lock (core/setup.ts): an exclusive
 * transaction on a small SQLite file, dropped by the operating system when
 * the holder exits or crashes, so it is never left behind. Returns release.
 */
export function acquireSyncLock(home: string): () => void {
  const lock = new sqlite.DatabaseSync(join(home, SYNC_LOCK_FILE));
  try {
    lock.exec('PRAGMA busy_timeout = 0');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lock.close();
    if (isBusy(err)) throw new SyncBusyError(holderPid(home));
    throw err;
  }
  try {
    writeFileSync(join(home, SYNC_PID_FILE), String(process.pid), { mode: 0o600 });
  } catch {
    // Informational only.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      lock.exec('ROLLBACK');
    } finally {
      lock.close();
    }
  };
}

const TOKEN_ENV: Record<SyncKind, string | null> = { plex: 'PLEX_TOKEN', jellyfin: 'JELLYFIN_TOKEN', 'apple-tv': null };

/** The environment variable a source reads its token from, or null. */
export function tokenEnvOf(kind: SyncKind): string | null {
  return TOKEN_ENV[kind];
}

/** `text` with every token value in `env` (PLEX_TOKEN, JELLYFIN_TOKEN) replaced by [redacted]. */
export function redactSecrets(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text;
  for (const name of Object.values(TOKEN_ENV)) {
    const value = name ? env[name]?.trim() : undefined;
    // Shorter than any real token; replacing it would blank ordinary words.
    if (!value || value.length < 4) continue;
    out = out.split(value).join('[redacted]');
  }
  return out;
}

/** One source's run: its counts, or why it failed. */
export interface SourceResult {
  kind: SyncKind;
  ok: boolean;
  records?: number;
  added?: number;
  updated?: number;
  unchanged?: number;
  needsReview?: number;
  /** Records left out because they fit more than one item (see ImportSummary.reviews). */
  ambiguous?: number;
  /** Why it failed, with tokens redacted. */
  error?: string;
  /** True when the failure was not a user or library error (a bug, say). */
  unexpected?: boolean;
}

export interface SourceRunOutput {
  records: number;
  summary: ImportSummary;
}

export interface RunSyncOptions {
  /** For redaction (default process.env). */
  env?: Record<string, string | undefined>;
  before?: (source: SyncSource) => void;
  after?: (result: SourceResult, source: SyncSource) => void;
}

/** Errors that are the user's or the source's (a server down, a missing token), not a bug. */
function isExpected(err: unknown): boolean {
  if (err instanceof LibraryError) return true;
  // The CLI's UserError and node:util parse errors, without importing the CLI.
  return err instanceof Error && (err.name === 'UserError' || String((err as { code?: unknown }).code ?? '').startsWith('ERR_PARSE_ARGS'));
}

/**
 * Run each source in order. A source that throws fails alone: the error is
 * recorded (redacted) and the next source runs.
 */
export async function runSyncSources(
  sources: readonly SyncSource[],
  run: (source: SyncSource) => Promise<SourceRunOutput>,
  opts: RunSyncOptions = {},
): Promise<SourceResult[]> {
  const results: SourceResult[] = [];
  for (const source of sources) {
    opts.before?.(source);
    let result: SourceResult;
    try {
      const { records, summary } = await run(source);
      result = {
        kind: source.kind,
        ok: true,
        records,
        added: summary.added,
        updated: summary.updated,
        unchanged: summary.unchanged,
        needsReview: summary.needsReview,
        ambiguous: summary.reviews.length,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        kind: source.kind,
        ok: false,
        error: redactSecrets(message, opts.env ?? process.env).slice(0, MAX_ERROR_CHARS),
        ...(isExpected(err) ? {} : { unexpected: true }),
      };
    }
    results.push(result);
    opts.after?.(result, source);
  }
  return results;
}

export interface SyncTotals {
  added: number;
  updated: number;
  unchanged: number;
  needsReview: number;
}

export function syncTotals(results: readonly SourceResult[]): SyncTotals {
  const t: SyncTotals = { added: 0, updated: 0, unchanged: 0, needsReview: 0 };
  for (const r of results) {
    t.added += r.added ?? 0;
    t.updated += r.updated ?? 0;
    t.unchanged += r.unchanged ?? 0;
    t.needsReview += r.needsReview ?? 0;
  }
  return t;
}

/** A source's last run as stored in meta. */
export interface LastRun {
  at: string;
  ok: boolean;
  records?: number;
  added?: number;
  updated?: number;
  unchanged?: number;
  needsReview?: number;
  error?: string;
  /** When it last succeeded (this run, or an earlier one). */
  lastOkAt?: string;
}

function readLast(db: Db, kind: SyncKind): LastRun | null {
  const row = db.sql.prepare('SELECT value FROM meta WHERE key = ?').get(`${META_PREFIX}${kind}`) as { value: string | null } | undefined;
  if (!row?.value) return null;
  try {
    const v = JSON.parse(row.value) as unknown;
    if (typeof v !== 'object' || v === null || typeof (v as LastRun).at !== 'string' || typeof (v as LastRun).ok !== 'boolean') return null;
    return v as LastRun;
  } catch {
    return null;
  }
}

/** Store a source's run in meta (`sync_last:<kind>`). Never called for a dry run. */
export function recordSyncRun(db: Db, result: SourceResult, now: Date = new Date()): void {
  const at = now.toISOString();
  const prev = readLast(db, result.kind);
  const last: LastRun = result.ok
    ? {
        at,
        ok: true,
        records: result.records ?? 0,
        added: result.added ?? 0,
        updated: result.updated ?? 0,
        unchanged: result.unchanged ?? 0,
        needsReview: result.needsReview ?? 0,
        lastOkAt: at,
      }
    : {
        at,
        ok: false,
        error: redactSecrets(result.error ?? 'failed').slice(0, MAX_ERROR_CHARS),
        ...(prev?.lastOkAt ? { lastOkAt: prev.lastOkAt } : {}),
      };
  db.sql
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(`${META_PREFIX}${result.kind}`, JSON.stringify(last));
}

export interface SourceStatus {
  kind: SyncKind;
  lastRun: LastRun | null;
}

/** Each kind's last run (null when it never ran, or the record can't be read). */
export function readSyncStatus(db: Db, kinds: readonly SyncKind[]): SourceStatus[] {
  return kinds.map((kind) => ({ kind, lastRun: readLast(db, kind) }));
}

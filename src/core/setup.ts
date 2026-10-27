/**
 * The setup pipeline shared by `screentrackr setup` and the MCP `setup_catalog`
 * tool: download (or reuse cached) IMDb datasets, build the catalog, refresh
 * automatic matches. A lock under the data home keeps two setups (a terminal
 * and an MCP client, say) from downloading into the same cache at once.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog, type CatalogStats } from './catalog/build.js';
import { downloadDatasets, type DownloadResult } from './catalog/download.js';
import type { Db } from './db.js';
import { cacheDir } from './home.js';
import { LibraryError } from './library.js';
import { rematch } from './match.js';
import { MATCHING_PENDING_KEY } from './schema.js';
import { sqlite } from './sqlite.js';

export const IMDB_CREDIT = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';

/** The lock: an SQLite file whose exclusive transaction is held for the whole setup. */
export const SETUP_LOCK_FILE = 'setup.lock';
/** The pid of the latest lock holder, for messages. */
export const SETUP_PID_FILE = 'setup.pid';

export interface SetupOptions {
  /** Check IMDb for newer dataset files. */
  refresh?: boolean;
  /** Load top-billed cast (default true). */
  withCast?: boolean;
  includeTvMovies?: boolean;
  /** Skip download and build; only redo the library matching a build left pending. */
  matchOnly?: boolean;
  /** The caller already holds the setup lock (the MCP job takes it before starting its worker). */
  lockHeld?: boolean;
  onProgress?: (msg: string) => void;
}

export interface SetupResult {
  /** Null for a matchOnly run. */
  catalog: CatalogStats | null;
  downloads: DownloadResult[];
  matching: { matched: number; ambiguous: number; unmatched: number };
  credit: string;
}

/** Another setup holds the lock. */
export class SetupBusyError extends LibraryError {
  constructor(readonly pid: number | null) {
    super(
      `Setup is already running${pid !== null ? ` (process ${pid})` : ' in another process'}. Wait for it to finish, then try again.`,
    );
    this.name = 'SetupBusyError';
  }
}

function isBusy(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown };
  // SQLITE_BUSY (5) and its extended codes, or the message when no code is attached.
  return (typeof e.errcode === 'number' && (e.errcode & 0xff) === 5) || /database is locked|SQLITE_BUSY/i.test(String(e.message));
}

function holderPid(home: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(join(home, SETUP_PID_FILE), 'utf8'), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Take the setup lock under `home`, or throw SetupBusyError when another
 * setup holds it. The lock is an exclusive write transaction on a small
 * SQLite file (`setup.lock`), held open until release: SQLite's file locking
 * keeps it exclusive across processes and threads, and the operating system
 * drops it when the holder exits, crashes or is killed, so it can never be
 * left behind and there is no stale-lock guessing. `setup.pid` names the
 * holder, for the busy message only. Returns the release function; keep it
 * reachable while setup runs, since a garbage-collected connection closes
 * and so releases the lock.
 */
export function acquireSetupLock(home: string): () => void {
  const lock = new sqlite.DatabaseSync(join(home, SETUP_LOCK_FILE));
  try {
    lock.exec('PRAGMA busy_timeout = 0');
    lock.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    lock.close();
    if (isBusy(err)) throw new SetupBusyError(holderPid(home));
    throw err;
  }
  try {
    writeFileSync(join(home, SETUP_PID_FILE), String(process.pid), { mode: 0o600 });
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

/** The pid of the setup holding the lock under `home` (null if unknown), or undefined when no setup is running. */
export function setupRunning(home: string): number | null | undefined {
  let release: () => void;
  try {
    release = acquireSetupLock(home);
  } catch (err) {
    if (err instanceof SetupBusyError) return err.pid;
    throw err;
  }
  release();
  return undefined;
}

/** True when a catalog build committed but the library rematch after it has not finished. */
export function matchingPending(db: Db): boolean {
  return Boolean(db.sql.prepare('SELECT 1 FROM meta WHERE key = ?').get(MATCHING_PENDING_KEY));
}

/**
 * Download the datasets (cached files are reused unless `refresh`), build the
 * catalog and refresh automatic matches, holding the setup lock throughout.
 * With `matchOnly`, only the rematch runs. Statuses, ratings, notes and manual
 * links are never changed.
 */
export async function runSetup(db: Db, opts: SetupOptions = {}): Promise<SetupResult> {
  const progress = opts.onProgress ?? (() => {});
  const release = opts.lockHeld ? () => {} : acquireSetupLock(db.home);
  try {
    let catalog: CatalogStats | null = null;
    let downloads: DownloadResult[] = [];
    if (!opts.matchOnly) {
      const cache = cacheDir(db.home);
      downloads = await downloadDatasets(cache, { refresh: opts.refresh ?? false, onProgress: progress });
      catalog = await buildCatalog(db, {
        cacheDir: cache,
        withCast: opts.withCast ?? true,
        includeTvMovies: opts.includeTvMovies ?? false,
        onProgress: progress,
      });
    }
    progress('Matching your library against the catalog');
    const matching = rematch(db);
    return { catalog, downloads, matching, credit: IMDB_CREDIT };
  } finally {
    release();
  }
}

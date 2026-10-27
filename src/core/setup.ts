/**
 * The setup pipeline shared by `screentrackr setup` and the MCP `setup_catalog`
 * tool: download (or reuse cached) IMDb datasets, build the catalog, refresh
 * automatic matches. A lock file under the data home keeps two setups (a
 * terminal and an MCP client, say) from downloading into the same cache at once.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog, type CatalogStats } from './catalog/build.js';
import { downloadDatasets, type DownloadResult } from './catalog/download.js';
import type { Db } from './db.js';
import { cacheDir } from './home.js';
import { LibraryError } from './library.js';
import { rematch } from './match.js';

export const IMDB_CREDIT = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';

export const SETUP_LOCK_FILE = 'setup.lock';

/** A lock older than this is treated as abandoned even if its pid is alive (pids get reused). */
const STALE_LOCK_MS = 12 * 60 * 60 * 1000;

export interface SetupOptions {
  /** Check IMDb for newer dataset files. */
  refresh?: boolean;
  /** Load top-billed cast (default true). */
  withCast?: boolean;
  includeTvMovies?: boolean;
  onProgress?: (msg: string) => void;
  /** For tests: where to download from and how. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SetupResult {
  catalog: CatalogStats;
  downloads: DownloadResult[];
  matching: { matched: number; ambiguous: number; unmatched: number };
  credit: string;
}

/** Another setup holds the lock. */
export class SetupBusyError extends LibraryError {
  constructor(readonly pid: number) {
    super(`Setup is already running (process ${pid}). Wait for it to finish, then try again.`);
    this.name = 'SetupBusyError';
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The pid of a live setup holding the lock under `home`, or null when the
 * lock is free, abandoned (its process died) or very old.
 */
export function setupLockHolder(home: string): number | null {
  let holder: { pid?: unknown; startedAt?: unknown };
  try {
    holder = JSON.parse(readFileSync(join(home, SETUP_LOCK_FILE), 'utf8')) as typeof holder;
  } catch {
    // Missing, unreadable or half-written.
    return null;
  }
  const pid = typeof holder.pid === 'number' ? holder.pid : NaN;
  const startedAt = typeof holder.startedAt === 'number' ? holder.startedAt : 0;
  return Number.isInteger(pid) && pid > 0 && alive(pid) && Date.now() - startedAt < STALE_LOCK_MS ? pid : null;
}

/**
 * Take the setup lock under `home`, or throw SetupBusyError when a live setup
 * holds it. A lock left by a process that has died (or is very old) is
 * replaced. Returns the function that releases it.
 */
export function acquireSetupLock(home: string): () => void {
  const path = join(home, SETUP_LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = setupLockHolder(home);
      if (pid !== null) throw new SetupBusyError(pid);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the setup lock at ${path}.`);
}

/**
 * Download the datasets (cached files are reused unless `refresh`), build the
 * catalog and refresh automatic matches, holding the setup lock throughout.
 * Statuses, ratings, notes and manual links are never changed.
 */
export async function runSetup(db: Db, opts: SetupOptions = {}): Promise<SetupResult> {
  const progress = opts.onProgress ?? (() => {});
  const release = acquireSetupLock(db.home);
  try {
    const cache = cacheDir(db.home);
    const downloads = await downloadDatasets(cache, {
      refresh: opts.refresh ?? false,
      onProgress: progress,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const catalog = await buildCatalog(db, {
      cacheDir: cache,
      withCast: opts.withCast ?? true,
      includeTvMovies: opts.includeTvMovies ?? false,
      onProgress: progress,
    });
    progress('Matching your library against the catalog');
    const matching = rematch(db);
    return { catalog, downloads, matching, credit: IMDB_CREDIT };
  } finally {
    release();
  }
}

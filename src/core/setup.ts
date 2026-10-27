/**
 * The setup pipeline shared by `screentrackr setup` and the MCP `setup_catalog`
 * tool: download (or reuse cached) IMDb datasets, build the catalog, refresh
 * automatic matches. A lock file under the data home keeps two setups (a
 * terminal and an MCP client, say) from downloading into the same cache at once.
 */
import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { buildCatalog, type CatalogStats } from './catalog/build.js';
import { downloadDatasets, type DownloadResult } from './catalog/download.js';
import type { Db } from './db.js';
import { cacheDir } from './home.js';
import { LibraryError } from './library.js';
import { rematch } from './match.js';
import { MATCHING_PENDING_KEY } from './schema.js';

export const IMDB_CREDIT = 'Information courtesy of IMDb (https://www.imdb.com). Used with permission.';

export const SETUP_LOCK_FILE = 'setup.lock';

/** Two boot-time estimates closer than this are the same boot (uptime has coarse resolution and clocks drift). */
const SAME_BOOT_MS = 5 * 60 * 1000;

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
  constructor(readonly pid: number) {
    super(`Setup is already running (process ${pid}). Wait for it to finish, then try again.`);
    this.name = 'SetupBusyError';
  }
}

interface LockInfo {
  pid: number;
  token: string;
  /** When this machine booted, by the lock holder's clock: tells a pid from before a reboot. */
  bootedAt: number;
}

function bootedAt(): number {
  return Date.now() - uptime() * 1000;
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

function readLock(path: string): { raw: string; info: LockInfo | null } | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof v.pid === 'number' && Number.isInteger(v.pid) && v.pid > 0 && typeof v.token === 'string' && typeof v.bootedAt === 'number') {
      return { raw, info: { pid: v.pid, token: v.token, bootedAt: v.bootedAt } };
    }
  } catch {
    // Garbled.
  }
  return { raw, info: null };
}

/** True when the lock's process is still running in this boot of the machine. */
function live(info: LockInfo | null): info is LockInfo {
  return info !== null && Math.abs(info.bootedAt - bootedAt()) < SAME_BOOT_MS && alive(info.pid);
}

/**
 * The pid of a live setup holding the lock under `home`, or null when the
 * lock is free or abandoned (its process died, or the machine rebooted since).
 */
export function setupLockHolder(home: string): number | null {
  const lock = readLock(join(home, SETUP_LOCK_FILE));
  return lock && live(lock.info) ? lock.info.pid : null;
}

/**
 * Take the setup lock under `home`, or throw SetupBusyError when a live setup
 * holds it. The lock file appears atomically with its content (written aside,
 * then hard-linked into place), and an abandoned lock is moved away with an
 * atomic rename before it is replaced, so two setups can't both win. Returns
 * the release function, which removes the lock only while it is still ours.
 */
export function acquireSetupLock(home: string): () => void {
  const path = join(home, SETUP_LOCK_FILE);
  const info: LockInfo = { pid: process.pid, token: randomUUID(), bootedAt: bootedAt() };
  const mine = JSON.stringify(info);
  const temp = `${path}.${info.token}.tmp`;
  writeFileSync(temp, mine, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        linkSync(temp, path);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          if (readLock(path)?.raw === mine) rmSync(path, { force: true });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const seen = readLock(path);
      if (!seen) continue; // Released meanwhile: try again.
      if (live(seen.info)) throw new SetupBusyError(seen.info.pid);
      // Abandoned. Move it aside atomically; only one contender's rename succeeds.
      const aside = `${path}.${info.token}.stale`;
      try {
        renameSync(path, aside);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      const moved = readLock(aside);
      if (moved && moved.raw !== seen.raw) {
        // A live setup took the lock between our read and the rename: put it back.
        try {
          linkSync(aside, path);
        } catch {
          // Someone holds it again either way.
        }
        rmSync(aside, { force: true });
        throw new SetupBusyError(moved.info?.pid ?? 0);
      }
      rmSync(aside, { force: true });
    }
    throw new Error(`Could not take the setup lock at ${path}.`);
  } finally {
    rmSync(temp, { force: true });
  }
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

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DB_FILE = 'screentrackr.db';
export const CACHE_DIR = 'cache';
export const BACKUPS_DIR = 'backups';

/**
 * Resolve the data home. Precedence: explicit flag, then SCREENTRACKR_HOME,
 * then ~/.screentrackr. Empty strings are treated as unset.
 */
export function resolveHome(flag?: string): string {
  if (flag) return resolve(flag);
  const env = process.env.SCREENTRACKR_HOME;
  if (env) return resolve(env);
  return join(homedir(), '.screentrackr');
}

export function dbPath(home: string): string {
  return join(home, DB_FILE);
}

export function cacheDir(home: string): string {
  return join(home, CACHE_DIR);
}

export function backupsDir(home: string): string {
  return join(home, BACKUPS_DIR);
}

import { chmodSync, mkdirSync } from 'node:fs';
import { backupsDir, cacheDir, dbPath } from './home.js';
import { FTS_SQL, MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import { sqlite, type DatabaseSync } from './sqlite.js';

export interface Db {
  sql: DatabaseSync;
  /** True when this SQLite build has FTS5 and titles_fts exists. */
  fts: boolean;
  home: string;
  close(): void;
}

/** Run fn inside BEGIN/COMMIT, rolling back on any error. Not reentrant. */
export function transaction<T>(sql: DatabaseSync, fn: () => T): T {
  sql.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    sql.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      sql.exec('ROLLBACK');
    } catch {
      // The failure may already have ended the transaction.
    }
    throw err;
  }
}

function probeFts5(): boolean {
  const probe = new sqlite.DatabaseSync(':memory:');
  try {
    probe.exec('CREATE VIRTUAL TABLE fts_probe USING fts5(x)');
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

function currentVersion(sql: DatabaseSync): number {
  const hasMeta = sql
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return 0;
  const row = sql.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function migrate(sql: DatabaseSync): void {
  const from = currentVersion(sql);
  if (!Number.isInteger(from) || from < 0) {
    throw new Error(`Unreadable schema_version in database: ${String(from)}`);
  }
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${from} is newer than this screentrackr supports (${SCHEMA_VERSION}). Upgrade screentrackr.`,
    );
  }
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v] as string;
    transaction(sql, () => {
      sql.exec(step);
      sql
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(v + 1));
    });
  }
}

/**
 * Open (creating if needed) the database under `home`: creates home, cache/
 * and backups/, enables WAL and foreign keys, runs pending migrations, and
 * creates titles_fts when FTS5 is available.
 */
export function openDb(home: string): Db {
  // The library is personal: folders we create are owner-only, and the db file
  // is 0600 (SQLite gives its -wal and -shm files the same permissions).
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDir(home), { recursive: true, mode: 0o700 });
  mkdirSync(backupsDir(home), { recursive: true, mode: 0o700 });

  const sql = new sqlite.DatabaseSync(dbPath(home));
  chmodSync(dbPath(home), 0o600);
  try {
    sql.exec('PRAGMA journal_mode = WAL');
    sql.exec('PRAGMA foreign_keys = ON');
    sql.exec('PRAGMA busy_timeout = 5000');
    migrate(sql);

    let fts = probeFts5();
    if (fts) {
      try {
        sql.exec(FTS_SQL);
      } catch {
        fts = false;
      }
    }
    let closed = false;
    return {
      sql,
      fts,
      home,
      close() {
        if (closed) return;
        closed = true;
        sql.close();
      },
    };
  } catch (err) {
    sql.close();
    throw err;
  }
}

/** True once a catalog build has completed (meta.catalog_built_at is set). */
export function catalogReady(db: Db): boolean {
  const row = db.sql.prepare("SELECT value FROM meta WHERE key = 'catalog_built_at'").get() as
    | { value: string | null }
    | undefined;
  return Boolean(row?.value);
}

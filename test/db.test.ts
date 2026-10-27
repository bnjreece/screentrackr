import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogReady, openDb, type Db } from '../src/core/db.js';
import { resolveHome } from '../src/core/home.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/schema.js';
import { sqlite } from '../src/core/sqlite.js';

describe('resolveHome', () => {
  const saved = process.env.SCREENTRACKR_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.SCREENTRACKR_HOME;
    else process.env.SCREENTRACKR_HOME = saved;
  });

  it('prefers the flag over the env var', () => {
    process.env.SCREENTRACKR_HOME = '/tmp/from-env';
    expect(resolveHome('/tmp/from-flag')).toBe('/tmp/from-flag');
  });

  it('prefers the env var over the default', () => {
    process.env.SCREENTRACKR_HOME = '/tmp/from-env';
    expect(resolveHome()).toBe('/tmp/from-env');
  });

  it('falls back to ~/.screentrackr', () => {
    delete process.env.SCREENTRACKR_HOME;
    expect(resolveHome()).toBe(join(homedir(), '.screentrackr'));
  });

  it('ignores an empty env var', () => {
    process.env.SCREENTRACKR_HOME = '';
    expect(resolveHome()).toBe(join(homedir(), '.screentrackr'));
  });
});

describe('openDb', () => {
  let home: string;
  let db: Db | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'screentrackr-db-'));
  });
  afterEach(() => {
    db?.close();
    db = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  const version = (d: Db) =>
    (d.sql.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
      .value;

  it('creates the db file, dirs and the current schema version', () => {
    db = openDb(home);
    expect(SCHEMA_VERSION).toBe(2);
    expect(existsSync(join(home, 'screentrackr.db'))).toBe(true);
    expect(existsSync(join(home, 'cache'))).toBe(true);
    expect(existsSync(join(home, 'backups'))).toBe(true);
    expect(version(db)).toBe('2');
    expect(db.home).toBe(home);
  });

  it('creates a missing home directory', () => {
    const nested = join(home, 'a', 'b');
    db = openDb(nested);
    expect(existsSync(join(nested, 'screentrackr.db'))).toBe(true);
  });

  it('sets WAL mode and foreign keys', () => {
    db = openDb(home);
    const jm = db.sql.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = db.sql.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(jm.journal_mode).toBe('wal');
    expect(fk.foreign_keys).toBe(1);
  });

  it('is idempotent on reopen', () => {
    db = openDb(home);
    db.sql
      .prepare("INSERT INTO library_items (source_title, status, source) VALUES ('Keep Me', 'queue', 'manual')")
      .run();
    db.close();
    db = openDb(home);
    expect(version(db)).toBe('2');
    const n = db.sql.prepare('SELECT COUNT(*) AS n FROM library_items').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('reports catalogReady false on a fresh db, true once catalog_built_at is set', () => {
    db = openDb(home);
    expect(catalogReady(db)).toBe(false);
    db.sql
      .prepare("INSERT INTO meta (key, value) VALUES ('catalog_built_at', ?)")
      .run(new Date().toISOString());
    expect(catalogReady(db)).toBe(true);
  });

  it('exposes fts as a boolean, and titles_fts exists exactly when true', () => {
    db = openDb(home);
    expect(typeof db.fts).toBe('boolean');
    const row = db.sql
      .prepare("SELECT name FROM sqlite_master WHERE name = 'titles_fts'")
      .get();
    expect(row !== undefined).toBe(db.fts);
  });

  it('creates every spec table', () => {
    db = openDb(home);
    const names = (
      db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      'meta',
      'titles',
      'title_genres',
      'ratings',
      'people',
      'title_people',
      'library_items',
      'match_candidates',
      'item_external_ids',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('rejects a bogus library_items.status', () => {
    db = openDb(home);
    expect(() =>
      db!.sql
        .prepare("INSERT INTO library_items (source_title, status, source) VALUES ('X', 'bogus', 'manual')")
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('rejects bogus match_status, source, watched_era and out-of-range my_rating', () => {
    db = openDb(home);
    const ins = (cols: string, vals: string) =>
      db!.sql
        .prepare(`INSERT INTO library_items (source_title, status, source, ${cols}) VALUES ('X', 'queue', 'manual', ${vals})`)
        .run();
    expect(() => ins('match_status', "'nope'")).toThrow(/CHECK/i);
    expect(() => ins('watched_era', "'1990s'")).toThrow(/CHECK/i);
    expect(() => ins('my_rating', '11')).toThrow(/CHECK/i);
    expect(() => ins('my_rating', '0')).toThrow(/CHECK/i);
    expect(() =>
      db!.sql
        .prepare("INSERT INTO library_items (source_title, status, source) VALUES ('X', 'queue', 'web')")
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('defaults owned to 1, match_status to unmatched and sets timestamps', () => {
    db = openDb(home);
    db.sql
      .prepare("INSERT INTO library_items (source_title, status, source) VALUES ('X', 'queue', 'legacy')")
      .run();
    const row = db.sql.prepare('SELECT * FROM library_items').get() as Record<string, unknown>;
    expect(row.owned).toBe(1);
    expect(row.match_status).toBe('unmatched');
    expect(typeof row.added_at).toBe('string');
    expect(typeof row.updated_at).toBe('string');
  });
});

describe('migrating a version 1 database', () => {
  it('keeps every item, id and match candidate, and accepts the new sources', () => {
    const home = mkdtempSync(join(tmpdir(), 'screentrackr-mig-'));
    try {
      // A database as version 1 left it.
      mkdirSync(home, { recursive: true });
      const raw = new sqlite.DatabaseSync(join(home, 'screentrackr.db'));
      raw.exec('PRAGMA foreign_keys = ON');
      raw.exec(MIGRATIONS[0] as string);
      raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
      raw.exec(`INSERT INTO library_items (id, source_title, status, watched_era, my_rating, source, owned, apple_persistent_id, match_status, added_at, updated_at)
        VALUES (7, 'The Glass Harbor', 'watched', '2010s', 8, 'paste', 0, 'A1', 'ambiguous', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
               (12, 'Night Ferry', 'queue', NULL, NULL, 'csv', 1, NULL, 'unmatched', '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`);
      raw.exec("INSERT INTO match_candidates (item_id, tconst, score) VALUES (7, 'tt9000001', 0.8), (7, 'tt9000002', 0.7)");
      raw.close();

      const db = openDb(home);
      try {
        expect(db.sql.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '2' });
        expect(db.sql.prepare('SELECT id, source_title, status, watched_era, my_rating, source, owned, apple_persistent_id, added_at, updated_at FROM library_items ORDER BY id').all()).toEqual([
          { id: 7, source_title: 'The Glass Harbor', status: 'watched', watched_era: '2010s', my_rating: 8, source: 'paste', owned: 0, apple_persistent_id: 'A1', added_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z' },
          { id: 12, source_title: 'Night Ferry', status: 'queue', watched_era: null, my_rating: null, source: 'csv', owned: 1, apple_persistent_id: null, added_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z' },
        ]);
        expect(db.sql.prepare('SELECT item_id, tconst, score FROM match_candidates ORDER BY tconst').all()).toEqual([
          { item_id: 7, tconst: 'tt9000001', score: 0.8 },
          { item_id: 7, tconst: 'tt9000002', score: 0.7 },
        ]);
        expect(db.sql.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_v1' OR name LIKE '%_v2'").all()).toEqual([]);
        db.sql.prepare("INSERT INTO library_items (source_title, status, source) VALUES ('X', 'queue', 'imdb')").run();
        db.sql.prepare("INSERT INTO item_external_ids (item_id, kind, value) VALUES (12, 'letterboxd', 'https://boxd.it/x1')").run();
        // Foreign keys still cascade from the rebuilt table.
        db.sql.prepare('DELETE FROM library_items WHERE id = 7').run();
        db.sql.prepare('DELETE FROM library_items WHERE id = 12').run();
        expect(db.sql.prepare('SELECT COUNT(*) AS n FROM match_candidates').get()).toEqual({ n: 0 });
        expect(db.sql.prepare('SELECT COUNT(*) AS n FROM item_external_ids').get()).toEqual({ n: 0 });
        expect(db.sql.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('file permissions', () => {
  it('creates the data home owner-only and the database file 0600', async () => {
    const { mkdtempSync, statSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = join(mkdtempSync(join(tmpdir(), 'st-perm-')), 'home');
    const db = openDb(home);
    db.close();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'screentrackr.db')).mode & 0o777).toBe(0o600);
  });
});

/**
 * Schema V4 (viewings, lists, list_items) and its backfill: a V3 library
 * migrates with every watched date, watched-date source and status unchanged,
 * one viewing per dated item, and a watched-date cache that refreshWatched
 * reproduces exactly. All titles are made up.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/core/db.js';
import { dbPath } from '../src/core/home.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/schema.js';
import { sqlite } from '../src/core/sqlite.js';
import { checkWatchedCache, refreshWatched, viewingsOf } from '../src/core/viewings.js';

let tmp: string;
let home: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-v4-'));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

interface Row {
  id: number;
  status: string;
  watched_at: string | null;
  watched_at_source: string | null;
  watched_era: string | null;
}

/** Build a V3 database the way 0.3.0 left one, with a mix of dated and undated items. */
function seedV3(): Row[] {
  const raw = new sqlite.DatabaseSync(dbPath(home));
  raw.exec('PRAGMA foreign_keys = ON');
  for (let v = 0; v < 3; v++) raw.exec(MIGRATIONS[v] as string);
  raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '3')");
  const ins = raw.prepare(
    "INSERT INTO library_items (source_title, status, watched_era, watched_at, watched_at_source, match_status, source) VALUES (?, ?, ?, ?, ?, 'unmatched', ?)",
  );
  ins.run('Pale Rooftops', 'watched', null, '2019-04-02', 'trakt', 'trakt');
  ins.run('Pale Rooftops II', 'watched', '2010s', '2018-11-30T21:14:09.000Z', 'letterboxd', 'letterboxd');
  ins.run('A Hand-Set Date', 'watched', 'long-ago', '2024-01-05', null, 'paste');
  ins.run('Queue Only', 'queue', null, null, null, 'csv');
  ins.run('Watched Undated', 'watched', '2020s', null, null, 'imdb');
  ins.run('Dated But Queued', 'someday', null, '2021-06-07 20:00', 'jellyfin', 'jellyfin');
  // A 0.3.0 JSON v1 import could store the literal source "manual"; V4 reads it as NULL (both: a date the user set).
  ins.run('Literal Manual', 'watched', null, '2022-02-02', 'manual', 'json');
  const rows = raw.prepare('SELECT id, status, watched_at, watched_at_source, watched_era FROM library_items ORDER BY id').all() as unknown as Row[];
  raw.close();
  return rows;
}

describe('schema V4', () => {
  it('is the current version and adds the viewings, lists and list_items tables', () => {
    expect(SCHEMA_VERSION).toBe(4);
    const db = openDb(home);
    const tables = (db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(['viewings', 'lists', 'list_items']));
    const indexes = (db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((t) => t.name);
    expect(indexes).toEqual(expect.arrayContaining(['viewings_item', 'viewings_ref', 'viewings_dated', 'list_items_item']));
    db.close();
  });

  it('migrates a V3 library with every watched date, source and status unchanged', () => {
    const before = seedV3();
    const db = openDb(home);
    const after = db.sql.prepare('SELECT id, status, watched_at, watched_at_source, watched_era FROM library_items ORDER BY id').all() as unknown as Row[];
    // The one change: a literal "manual" source becomes NULL, which means the same.
    const expected = before.map((r) => (r.watched_at_source === 'manual' ? { ...r, watched_at_source: null } : r));
    expect(after).toEqual(expected);

    // One viewing per dated item: the date string unchanged, the source or manual.
    for (const r of before) {
      const vs = viewingsOf(db, r.id);
      if (r.watched_at === null) expect(vs).toEqual([]);
      else {
        expect(vs).toHaveLength(1);
        expect(vs[0]).toMatchObject({ watchedAt: r.watched_at, source: r.watched_at_source ?? 'manual', sourceRef: null, rewatch: null, rating: null });
      }
    }
    expect(checkWatchedCache(db)).toEqual([]);

    // refreshWatched reproduces every cached date and source exactly.
    for (const r of before) refreshWatched(db, r.id);
    const refreshed = db.sql.prepare('SELECT id, status, watched_at, watched_at_source, watched_era FROM library_items ORDER BY id').all() as unknown as Row[];
    expect(refreshed).toEqual(expected);
    db.close();
  });

  it('cascades viewings and memberships when an item is removed', () => {
    seedV3();
    const db = openDb(home);
    db.sql.exec("INSERT INTO lists (name, norm_name) VALUES ('Spooky', 'spooky')");
    db.sql.exec('INSERT INTO list_items (list_id, item_id) VALUES (1, 1)');
    db.sql.exec('DELETE FROM library_items WHERE id = 1');
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM viewings WHERE item_id = 1').get()).toEqual({ n: 0 });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM list_items').get()).toEqual({ n: 0 });
    // A list removed takes its memberships, never the items.
    db.sql.exec('INSERT INTO list_items (list_id, item_id) VALUES (1, 2)');
    db.sql.exec('DELETE FROM lists');
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM list_items').get()).toEqual({ n: 0 });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM library_items').get()).toEqual({ n: 6 });
    db.close();
  });

  it('enforces the viewing checks and the dated-play uniqueness', () => {
    seedV3();
    const db = openDb(home);
    expect(() => db.sql.exec("INSERT INTO viewings (item_id, watched_at, rewatch, source) VALUES (1, '2020-01-01', 2, 'manual')")).toThrow();
    expect(() => db.sql.exec("INSERT INTO viewings (item_id, watched_at, rating, source) VALUES (1, '2020-01-01', 11, 'manual')")).toThrow();
    // Same item, source and calendar date with no ref: one play.
    expect(() => db.sql.exec("INSERT INTO viewings (item_id, watched_at, source) VALUES (1, '2019-04-02T08:00:00Z', 'trakt')")).toThrow();
    // With refs, two plays on one day are two.
    db.sql.exec("INSERT INTO viewings (item_id, watched_at, source, source_ref) VALUES (1, '2019-04-02', 'trakt', '9007199254740993')");
    db.sql.exec("INSERT INTO viewings (item_id, watched_at, source, source_ref) VALUES (1, '2019-04-02', 'trakt', '9007199254740994')");
    expect(() => db.sql.exec("INSERT INTO viewings (item_id, watched_at, source, source_ref) VALUES (1, '2019-05-02', 'trakt', '9007199254740993')")).toThrow();
    db.close();
  });
});

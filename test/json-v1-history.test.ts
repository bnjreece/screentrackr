/**
 * ScreenTrackr JSON v1, 0.4.0 additions: item `viewings` and `lists`, and the
 * envelope `lists`. Additive (version stays 1). All titles are made up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { exportLibrary } from '../src/core/export.js';
import { applyImport, ImportError, parseImportDetailed } from '../src/core/importers/index.js';
import { addToList, createList, listLists } from '../src/core/lists.js';
import { addViewing, checkWatchedCache } from '../src/core/viewings.js';

let tmp: string;
let a: Db;
let b: Db;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-jv1-'));
  a = openDb(join(tmp, 'a'));
  b = openDb(join(tmp, 'b'));
});
afterEach(() => {
  a.close();
  b.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seed(db: Db): number {
  const id = Number(
    db.sql.prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Pale Rooftops', 'watched', 'unmatched', 'letterboxd')").run()
      .lastInsertRowid,
  );
  db.sql.prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Quiet Field', 'queue', 'unmatched', 'csv')").run();
  addViewing(db, id, { watchedAt: '2019-04-02', source: 'letterboxd', sourceRef: 'https://boxd.it/e1', rating: 7, rewatch: false });
  addViewing(db, id, { watchedAt: '2021-10-31', source: 'trakt', sourceRef: '9007199254740993' });
  addViewing(db, id, { watchedAt: '2021-10-31', source: 'letterboxd', sourceRef: 'https://boxd.it/e2', rewatch: true });
  addViewing(db, id, { watchedAt: null, source: 'trakt' });
  createList(db, 'Halloween', { description: 'October' });
  createList(db, 'Empty one');
  addToList(db, 'Halloween', [id]);
  return id;
}

const strip = (x: ReturnType<typeof exportLibrary>) => ({ ...x, exportedAt: undefined, items: x.items.map((i) => ({ ...i, addedAt: undefined, updatedAt: undefined })) });

describe('export', () => {
  it('writes viewings oldest first and lists per item, omitted when empty, and the envelope lists', () => {
    seed(a);
    const out = exportLibrary(a);
    const [watched, queued] = out.items;
    expect(watched?.viewings).toEqual([
      { watchedAt: '2019-04-02', rewatch: false, rating: 7, source: 'letterboxd', sourceRef: 'https://boxd.it/e1' },
      { watchedAt: '2021-10-31', rewatch: null, rating: null, source: 'trakt', sourceRef: '9007199254740993' },
      { watchedAt: '2021-10-31', rewatch: true, rating: null, source: 'letterboxd', sourceRef: 'https://boxd.it/e2' },
      { watchedAt: null, rewatch: null, rating: null, source: 'trakt', sourceRef: null },
    ]);
    expect(watched).toMatchObject({ watchedAt: '2021-10-31', watchedAtSource: 'letterboxd', lists: ['Halloween'] });
    expect(queued && 'viewings' in queued).toBe(false);
    expect(queued && 'lists' in queued).toBe(false);
    expect(out.lists).toEqual([
      { name: 'Empty one', description: null, createdAt: expect.any(String) },
      { name: 'Halloween', description: 'October', createdAt: expect.any(String) },
    ]);
    expect(out.version).toBe(1);
  });
});

describe('import', () => {
  it('restores exactly with --replace: plays, cache, lists, an empty list and descriptions', () => {
    seed(a);
    const first = exportLibrary(a);
    const parsed = parseImportDetailed(JSON.stringify(first));
    applyImport(b, parsed.records, { mode: 'replace', lists: parsed.lists });
    const second = exportLibrary(b);
    expect(strip(second)).toEqual(strip(first));
    expect(listLists(b).map((l) => [l.name, l.description, l.count])).toEqual([
      ['Empty one', null, 0],
      ['Halloween', 'October', 1],
    ]);
    expect(checkWatchedCache(b)).toEqual([]);
  });

  it('restores a play with a ref and one without on the same day, an explicitly empty era, and long descriptions', () => {
    const id = Number(
      a.sql.prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Pale Rooftops', 'watched', 'unmatched', 'csv')").run().lastInsertRowid,
    );
    addViewing(a, id, { watchedAt: '2021-03-03', source: 'manual', sourceRef: 'manual:00112233aabbccdd', rating: 5 });
    addViewing(a, id, { watchedAt: '2021-03-03', source: 'manual', rating: 7 });
    a.sql.prepare('UPDATE library_items SET watched_era = NULL WHERE id = ?').run(id);
    createList(a, 'Emoji', { description: '\u{1F383}'.repeat(600) });
    const first = exportLibrary(a);
    expect(first.items[0]?.watchedEra).toBeNull();
    const parsed = parseImportDetailed(JSON.stringify(first));
    applyImport(b, parsed.records, { mode: 'replace', lists: parsed.lists });
    expect(strip(exportLibrary(b))).toEqual(strip(first));
  });

  it('merges its own export back unchanged, dateless plays with different ratings included', () => {
    const id = Number(
      a.sql.prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Pale Rooftops', 'watched', 'unmatched', 'trakt')").run().lastInsertRowid,
    );
    addViewing(a, id, { watchedAt: null, source: 'trakt', rating: 7, rewatch: true });
    addViewing(a, id, { watchedAt: null, source: 'trakt' });
    const before = exportLibrary(a);
    const parsed = parseImportDetailed(JSON.stringify(before));
    expect(applyImport(a, parsed.records, { mode: 'merge', lists: parsed.lists })).toMatchObject({ updated: 0, unchanged: 1 });
    expect(strip(exportLibrary(a))).toEqual(strip(before));
  });

  it('merges add-only: plays the library has and the file lacks stay, and a re-import is unchanged', () => {
    const id = seed(a);
    const parsed = parseImportDetailed(JSON.stringify(exportLibrary(a)));
    addViewing(a, id, { watchedAt: '2024-01-01', source: 'manual' });
    expect(applyImport(a, parsed.records, { mode: 'merge', lists: parsed.lists })).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    expect(a.sql.prepare('SELECT COUNT(*) AS n FROM viewings').get()).toEqual({ n: 5 });
  });

  it('without viewings, watchedAt becomes one play as before', () => {
    const file = { format: 'screentrackr-library', version: 1, items: [{ sourceTitle: 'Pale Rooftops', status: 'watched', watchedAt: '2020-01-01', watchedAtSource: 'trakt' }] };
    const parsed = parseImportDetailed(JSON.stringify(file));
    expect(parsed.records[0]).toMatchObject({ watchedAt: '2020-01-01', watchedAtSource: 'trakt' });
    expect(parsed.records[0]?.viewings).toBeUndefined();
  });

  it('lets viewings win over a disagreeing watchedAt, with a warning', () => {
    const file = {
      format: 'screentrackr-library',
      version: 1,
      items: [{ sourceTitle: 'Pale Rooftops', status: 'watched', watchedAt: '2020-01-01', viewings: [{ watchedAt: '2022-02-02', source: 'manual' }] }],
    };
    const parsed = parseImportDetailed(JSON.stringify(file));
    expect(parsed.warnings.join('\n')).toMatch(/Pale Rooftops.*2020-01-01.*2022-02-02/);
    applyImport(b, parsed.records, { mode: 'merge' });
    expect(b.sql.prepare('SELECT watched_at AS at FROM library_items').get()).toEqual({ at: '2022-02-02' });
  });

  it('rejects malformed viewings and lists', () => {
    const bad = (item: object, extra: object = {}) => () =>
      parseImportDetailed(JSON.stringify({ format: 'screentrackr-library', version: 1, items: [{ sourceTitle: 'X', ...item }], ...extra }));
    expect(bad({ viewings: [{ watchedAt: '2020-01-01' }] })).toThrow(ImportError);
    expect(bad({ viewings: [{ watchedAt: '2020-01-01', source: 'myspace' }] })).toThrow(/viewings/);
    expect(bad({ viewings: [{ watchedAt: 'later', source: 'manual' }] })).toThrow(/viewings/);
    expect(bad({ lists: [''] })).toThrow(/lists/);
    expect(bad({}, { lists: [{ name: '' }] })).toThrow(/lists/);
  });
});

/**
 * The 0.4.0 import core: ImportRecord.viewings, viewingsComplete and lists.
 * Every play an import knows about is kept, a re-import never duplicates one,
 * and a complete set removes only the plays of its own source that it no
 * longer lists. All titles and ids are made up; no catalog is built.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { foldRecords } from '../src/core/importers/common.js';
import { applyImport, ImportError, type ImportRecord } from '../src/core/importers/index.js';
import { createList, getList, listsOfItem } from '../src/core/lists.js';
import { updateItem } from '../src/core/library.js';
import { addViewing, checkWatchedCache, viewingsOf } from '../src/core/viewings.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-impv-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items; DELETE FROM lists;');
});

const onlyItem = () => db.sql.prepare('SELECT id, status, watched_at AS at, watched_at_source AS src, watched_era AS era FROM library_items').all() as {
  id: number;
  status: string;
  at: string | null;
  src: string | null;
  era: string | null;
}[];
const plays = () => viewingsOf(db, (onlyItem()[0] as { id: number }).id).map((v) => [v.watchedAt, v.source, v.sourceRef, v.rewatch, v.rating]);

const letterboxd = (entries: { date: string | null; ref: string; rewatch?: boolean; rating?: number }[], extra: Partial<ImportRecord> = {}): ImportRecord => ({
  sourceTitle: 'Pale Rooftops',
  sourceYear: 1994,
  externalIds: { letterboxd: 'https://boxd.it/film1' },
  status: 'watched',
  source: 'letterboxd',
  fillOnly: true,
  ownedIfNew: false,
  viewings: entries.map((e) => ({ watchedAt: e.date, sourceRef: e.ref, rewatch: e.rewatch ?? false, ...(e.rating !== undefined ? { rating: e.rating } : {}) })),
  viewingsComplete: true,
  ...extra,
});

describe('viewings on import', () => {
  it('keeps every play, flags and ratings included, and caches the latest', () => {
    const res = applyImport(db, [letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1', rating: 7 }, { date: '2021-10-31', ref: 'https://boxd.it/e2', rewatch: true }])], { mode: 'merge' });
    expect(res).toMatchObject({ added: 1, updated: 0 });
    expect(plays()).toEqual([
      ['2021-10-31', 'letterboxd', 'https://boxd.it/e2', true, null],
      ['2019-04-02', 'letterboxd', 'https://boxd.it/e1', false, 7],
    ]);
    expect(onlyItem()).toMatchObject([{ at: '2021-10-31', src: 'letterboxd', era: '2020s' }]);
  });

  it('reports a re-import of the same plays unchanged', () => {
    const r = letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1' }, { date: '2021-10-31', ref: 'https://boxd.it/e2', rewatch: true }]);
    applyImport(db, [r], { mode: 'merge' });
    expect(applyImport(db, [r], { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(plays()).toHaveLength(2);
  });

  it('a complete set removes exactly the play it no longer lists and keeps a manual one', () => {
    applyImport(db, [letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1' }, { date: '2021-10-31', ref: 'https://boxd.it/e2', rewatch: true }])], { mode: 'merge' });
    const id = (onlyItem()[0] as { id: number }).id;
    addViewing(db, id, { watchedAt: '2020-06-06', source: 'manual' });
    const res = applyImport(db, [letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1' }])], { mode: 'merge' });
    expect(res).toMatchObject({ updated: 1 });
    expect(plays().map((p) => [p[0], p[1]])).toEqual([
      ['2020-06-06', 'manual'],
      ['2019-04-02', 'letterboxd'],
    ]);
    expect(onlyItem()).toMatchObject([{ at: '2020-06-06', src: null }]);
  });

  it('never touches another source when a set is complete', () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', sourceYear: 1994, status: 'watched', source: 'trakt', viewings: [{ watchedAt: '2018-01-01', sourceRef: '9007199254740993' }] }], {
      mode: 'merge',
    });
    applyImport(db, [letterboxd([])], { mode: 'merge' });
    expect(plays()).toEqual([['2018-01-01', 'trakt', '9007199254740993', null, null]]);
  });

  it('upgrades a play backfilled from a 0.3.0 date when the diary names it', () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', sourceYear: 1994, status: 'watched', source: 'letterboxd', watchedAt: '2021-10-31' }], { mode: 'merge' });
    expect(plays()).toEqual([['2021-10-31', 'letterboxd', null, null, null]]);
    applyImport(db, [letterboxd([{ date: '2021-10-31', ref: 'https://boxd.it/e2', rewatch: true, rating: 9 }])], { mode: 'merge' });
    expect(plays()).toEqual([['2021-10-31', 'letterboxd', 'https://boxd.it/e2', true, 9]]);
  });

  it('turns a plain watchedAt into one play of the record source; a date from a file without a source is manual', () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'csv', watchedAt: '2020-02-02' }], { mode: 'merge' });
    expect(plays()).toEqual([['2020-02-02', 'csv', null, null, null]]);
    db.sql.exec('DELETE FROM library_items');
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'apple-tv', watchedAt: '2020-02-02', watchedAtSource: null }], { mode: 'merge' });
    expect(plays()).toEqual([['2020-02-02', 'manual', null, null, null]]);
    expect(onlyItem()).toMatchObject([{ src: null }]);
  });

  it('takes the latest play across sources: an older date never replaces a newer one', () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'apple-tv', watchedAt: '2024-05-05' }], { mode: 'merge' });
    const res = applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'letterboxd', watchedAt: '2019-01-01' }], { mode: 'merge' });
    expect(res.updated).toBe(1);
    expect(onlyItem()).toMatchObject([{ at: '2024-05-05', src: 'apple-tv' }]);
    expect(plays()).toHaveLength(2);
  });

  it('keeps each new last-played date of a single-date source (Jellyfin, the TV app)', () => {
    const jf = (d: string): ImportRecord => ({ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'jellyfin', watchedAt: d });
    applyImport(db, [jf('2023-01-01')], { mode: 'merge' });
    expect(applyImport(db, [jf('2023-01-01')], { mode: 'merge' }).unchanged).toBe(1);
    applyImport(db, [jf('2024-02-02')], { mode: 'merge' });
    expect(plays().map((p) => p[0])).toEqual(['2024-02-02', '2023-01-01']);
  });

  it('keeps an int64 play id as a string and dateless plays by count', () => {
    const trakt = (n: number): ImportRecord => ({
      sourceTitle: 'Pale Rooftops',
      status: 'watched',
      source: 'trakt',
      viewings: [{ watchedAt: '2020-01-01', sourceRef: '9007199254740993' }, ...Array.from({ length: n }, () => ({ watchedAt: null }))],
    });
    applyImport(db, [trakt(2)], { mode: 'merge' });
    applyImport(db, [trakt(2)], { mode: 'merge' });
    expect(plays().map((p) => p[2])).toEqual(['9007199254740993', null, null]);
    applyImport(db, [trakt(3)], { mode: 'merge' });
    expect(plays()).toHaveLength(4);
  });

  it('clearWatchedAtIfOwn removes this source plays, so the cache falls back to another source', () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'trakt', watchedAt: '2022-02-02T10:00:00.000Z' }], { mode: 'merge' });
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'imdb', watchedAt: '2021-01-01' }], { mode: 'merge' });
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'trakt', clearWatchedAtIfOwn: true }], { mode: 'merge' });
    expect(plays().map((p) => p[1])).toEqual(['imdb']);
    expect(onlyItem()).toMatchObject([{ at: '2021-01-01', src: 'imdb' }]);
  });

  it('writes no plays for a record that goes to review', () => {
    applyImport(
      db,
      [
        { sourceTitle: 'The Glass Harbor', sourceYear: 1978, status: 'watched', source: 'paste' },
        { sourceTitle: 'The Glass Harbor', sourceYear: 2009, status: 'queue', source: 'paste' },
      ],
      { mode: 'merge' },
    );
    const res = applyImport(db, [{ sourceTitle: 'The Glass Harbor', status: 'watched', source: 'trakt', watchedAt: '2020-01-01' }], { mode: 'merge' });
    expect(res.reviews).toHaveLength(1);
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM viewings').get()).toEqual({ n: 0 });
  });

  it('writes nothing on a dry run', () => {
    const res = applyImport(db, [letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1' }], { lists: ['Spooky'] })], { mode: 'merge', dryRun: true });
    expect(res).toMatchObject({ added: 1, dryRun: true });
    expect(db.sql.prepare('SELECT (SELECT COUNT(*) FROM viewings) AS v, (SELECT COUNT(*) FROM lists) AS l').get()).toEqual({ v: 0, l: 0 });
  });

  it('validates plays and lists', () => {
    const bad = (extra: Partial<ImportRecord>) => () => applyImport(db, [{ sourceTitle: 'X', source: 'csv', ...extra }], { mode: 'merge' });
    expect(bad({ viewings: [{ watchedAt: 'soon' }] })).toThrow(ImportError);
    expect(bad({ viewings: [{ watchedAt: '2020-01-01', rating: 0 }] })).toThrow(/rating/);
    expect(bad({ viewings: [{ watchedAt: '2020-01-01', source: 'bogus' as never }] })).toThrow(/source/);
    expect(bad({ viewings: 'x' as never })).toThrow(/viewings/);
    expect(bad({ viewingsComplete: 'yes' as never })).toThrow(/viewingsComplete/);
    expect(bad({ lists: [''] })).toThrow(/list/);
    expect(bad({ lists: 'Spooky' as never })).toThrow(/lists/);
  });

  it('keeps the cache sound through all of it', () => {
    applyImport(db, [letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1' }])], { mode: 'merge' });
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'plex', watchedAt: '2025-01-01' }], { mode: 'merge' });
    applyImport(db, [letterboxd([])], { mode: 'merge' });
    expect(checkWatchedCache(db)).toEqual([]);
  });
});

describe('items that differ only in plays or lists', () => {
  const twins = () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', source: 'paste' }, { sourceTitle: 'Pale Rooftops', source: 'paste' }], { mode: 'merge' });
    return (db.sql.prepare('SELECT id FROM library_items ORDER BY id').all() as { id: number }[]).map((r) => r.id) as [number, number];
  };

  it('are not interchangeable when their lists differ', () => {
    const [a, b] = twins();
    createList(db, 'Halloween');
    createList(db, 'Winter');
    db.sql.prepare('INSERT INTO list_items (list_id, item_id) SELECT id, ? FROM lists WHERE name = ?').run(a, 'Halloween');
    db.sql.prepare('INSERT INTO list_items (list_id, item_id) SELECT id, ? FROM lists WHERE name = ?').run(b, 'Winter');
    const res = applyImport(db, [{ sourceTitle: 'Pale Rooftops', source: 'csv', notes: 'changed' }], { mode: 'merge' });
    expect(res).toMatchObject({ updated: 0, reviews: [{ candidateIds: [a, b] }] });
  });

  it('are not interchangeable when their plays differ', () => {
    const [a, b] = twins();
    addViewing(db, a, { watchedAt: null, source: 'trakt' });
    addViewing(db, b, { watchedAt: null, source: 'plex' });
    const res = applyImport(db, [{ sourceTitle: 'Pale Rooftops', source: 'csv', notes: 'changed' }], { mode: 'merge' });
    expect(res).toMatchObject({ updated: 0, reviews: [{ candidateIds: [a, b] }] });
  });
});

describe('lists on import', () => {
  it('creates lists on demand and only ever adds memberships', () => {
    const r = (lists: string[]): ImportRecord => ({ sourceTitle: 'Pale Rooftops', source: 'letterboxd', lists });
    expect(applyImport(db, [r(['Halloween', 'Spooky'])], { mode: 'merge' })).toMatchObject({ added: 1, listsCreated: ['Halloween', 'Spooky'] });
    const id = (onlyItem()[0] as { id: number }).id;
    expect(listsOfItem(db, id)).toEqual(['Halloween', 'Spooky']);
    expect(applyImport(db, [r(['halloween'])], { mode: 'merge' })).toMatchObject({ unchanged: 1 });
    expect(listsOfItem(db, id)).toEqual(['Halloween', 'Spooky']);
    createList(db, 'Winter');
    expect(applyImport(db, [r(['WINTER'])], { mode: 'merge' })).toMatchObject({ updated: 1 });
    expect(listsOfItem(db, id)).toEqual(['Halloween', 'Spooky', 'Winter']);
  });

  it('takes envelope lists (descriptions, empty lists) and fills a blank description', () => {
    createList(db, 'Halloween');
    applyImport(db, [], { mode: 'merge', lists: [{ name: 'halloween', description: 'October' }, { name: 'Empty', description: null, createdAt: '2020-01-01T00:00:00.000Z' }] });
    expect(getList(db, 'Halloween')).toMatchObject({ name: 'Halloween', description: 'October' });
    expect(getList(db, 'Empty')).toMatchObject({ count: 0, createdAt: '2020-01-01T00:00:00.000Z' });
  });

  it('replace starts from empty: no plays or lists survive but what the file has', () => {
    applyImport(db, [letterboxd([{ date: '2019-04-02', ref: 'https://boxd.it/e1' }], { lists: ['Halloween'] })], { mode: 'merge' });
    createList(db, 'Old');
    applyImport(db, [{ sourceTitle: 'Other Film', source: 'json' }], { mode: 'replace' });
    expect(db.sql.prepare('SELECT (SELECT COUNT(*) FROM viewings) AS v, (SELECT COUNT(*) FROM lists) AS l').get()).toEqual({ v: 0, l: 0 });
  });
});

describe('foldRecords with plays and lists', () => {
  it('keeps every play, unions lists, and is complete when any record is', () => {
    const warnings: string[] = [];
    const folded = foldRecords(
      [
        { sourceTitle: 'A', source: 'letterboxd', externalIds: { letterboxd: 'f' }, viewings: [{ watchedAt: '2020-01-01', sourceRef: 'e1' }], viewingsComplete: true, lists: ['X'] },
        { sourceTitle: 'A', source: 'letterboxd', externalIds: { letterboxd: 'f' }, watchedAt: '2021-01-01', lists: ['Y', 'x'] },
      ],
      (r) => r.externalIds?.letterboxd,
      (w) => warnings.push(w),
    );
    expect(folded).toHaveLength(1);
    expect(folded[0]?.viewings).toEqual([{ watchedAt: '2020-01-01', sourceRef: 'e1' }, { watchedAt: '2021-01-01' }]);
    expect(folded[0]?.viewingsComplete).toBe(true);
    expect(folded[0]?.lists).toEqual(['X', 'Y']);
  });
});

describe('the user-set date rules stay', () => {
  it('a date the user sets is a manual play no import removes', () => {
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'trakt', watchedAt: '2019-04-02' }], { mode: 'merge' });
    const id = (onlyItem()[0] as { id: number }).id;
    updateItem(db, id, { watchedAt: '2019-06-01' });
    applyImport(db, [{ sourceTitle: 'Pale Rooftops', status: 'watched', source: 'trakt', clearWatchedAtIfOwn: true }], { mode: 'merge' });
    expect(onlyItem()).toMatchObject([{ at: '2019-06-01', src: null }]);
  });
});

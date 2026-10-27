/**
 * The one clear an import may make: a watched date the same source set
 * earlier (clearWatchedAtIfOwn), and the per-item record of which source set
 * the date (watched_at_source, schema V3) that it relies on. All titles and
 * ids are made up. No catalog is built, so every item stays unmatched.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { exportLibrary } from '../src/core/export.js';
import { foldRecords } from '../src/core/importers/common.js';
import { applyImport, ImportError, parseImport, type ImportRecord } from '../src/core/importers/index.js';
import { updateItem } from '../src/core/library.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-wds-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');
});

const rows = () =>
  db.sql.prepare('SELECT id, status, watched_at AS at, watched_at_source AS src, my_rating AS rating FROM library_items ORDER BY id').all() as {
    id: number;
    status: string;
    at: string | null;
    src: string | null;
    rating: number | null;
  }[];

const trakt = (extra: Partial<ImportRecord> = {}): ImportRecord => ({
  sourceTitle: 'The Copper Orchard',
  sourceYear: 1994,
  externalIds: { trakt: '9001' },
  status: 'watched',
  source: 'trakt',
  fillOnly: true,
  ownedIfNew: false,
  ...extra,
});

describe('recording which source set the watched date', () => {
  it('records the source on insert and on a merge that changes the date', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: 'trakt' }]);
    applyImport(db, [{ sourceTitle: 'The Copper Orchard', sourceYear: 1994, watchedAt: '2020-01-05', source: 'imdb' }], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2020-01-05', src: 'imdb' }]);
  });

  it('keeps the recorded source when a record repeats the same date', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    const res = applyImport(db, [{ sourceTitle: 'The Copper Orchard', sourceYear: 1994, watchedAt: '2019-04-02', source: 'imdb' }], { mode: 'merge' });
    expect(res.unchanged).toBe(1);
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: 'trakt' }]);
  });

  it('leaves no source on an item without a date', () => {
    applyImport(db, [trakt({ status: undefined, statusIfNew: 'queue' })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: null, src: null }]);
  });

  it('forgets the source when the user sets or clears the date', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    const id = (rows()[0] as { id: number }).id;
    updateItem(db, id, { watchedAt: '2019-04-02' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: null }]);
    updateItem(db, id, { watchedAt: null });
    expect(rows()).toMatchObject([{ at: null, src: null }]);
  });
});

describe('clearWatchedAtIfOwn', () => {
  it('clears a date the same source set, leaving status and rating alone', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02T21:14:09.000Z', myRating: 7 })], { mode: 'merge' });
    const res = applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(res).toMatchObject({ added: 0, updated: 1 });
    expect(rows()).toMatchObject([{ status: 'watched', at: null, src: null, rating: 7 }]);
    // Nothing left to clear: a second run changes nothing.
    expect(applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' })).toMatchObject({ updated: 0, unchanged: 1 });
  });

  it('clears the era the cleared date implies, and keeps an era the date does not imply', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02', watchedEra: '2010s' })], { mode: 'merge' });
    // A record without a status clears the era too.
    applyImport(db, [trakt({ status: undefined, clearWatchedAtIfOwn: true })], { mode: 'merge' });
    const era = () => (db.sql.prepare('SELECT watched_era AS era FROM library_items').get() as { era: string | null }).era;
    expect(era()).toBeNull();
    db.sql.exec('DELETE FROM item_external_ids; DELETE FROM library_items;');
    applyImport(db, [trakt({ watchedAt: '2019-04-02', watchedEra: 'long-ago' })], { mode: 'merge' });
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: null }]);
    expect(era()).toBe('long-ago');
  });

  it('never clears a date the user set', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    const id = (rows()[0] as { id: number }).id;
    updateItem(db, id, { watchedAt: '2018-11-30' });
    expect(applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' }).updated).toBe(0);
    expect(rows()).toMatchObject([{ at: '2018-11-30', src: null }]);
  });

  it('never clears a date another source set, even over one this source set first', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    applyImport(db, [{ sourceTitle: 'The Copper Orchard', sourceYear: 1994, watchedAt: '2019-05-01', source: 'letterboxd' }], { mode: 'merge' });
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-05-01', src: 'letterboxd' }]);
  });

  it('does nothing without the flag, and a record with a date sets it instead', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    applyImport(db, [trakt()], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: 'trakt' }]);
    applyImport(db, [trakt({ watchedAt: '2021-07-07', clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2021-07-07', src: 'trakt' }]);
  });

  it('never clears a date of an item that has none from this source: a new item just has no date', () => {
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ status: 'watched', at: null, src: null }]);
  });

  it('is rejected when it is not true or false', () => {
    expect(() => applyImport(db, [trakt({ clearWatchedAtIfOwn: 'yes' as unknown as boolean })], { mode: 'merge' })).toThrow(ImportError);
    expect(() => applyImport(db, [trakt({ watchedAt: '2019-04-02', watchedAtSource: 'myspace' as never })], { mode: 'merge' })).toThrow(
      /watched date source/,
    );
    expect(rows()).toEqual([]);
  });
});

describe('JSON v1', () => {
  it('writes watchedAtSource only for a date an import source set, and a round trip keeps it clearable', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    applyImport(db, [{ sourceTitle: 'Night Ferry', watchedAt: '2020-02-02', status: 'watched', source: 'paste' }], { mode: 'merge' });
    const id = (rows()[1] as { id: number }).id;
    updateItem(db, id, { watchedAt: '2020-02-03' });
    const exported = exportLibrary(db);
    expect(exported.items.map((i) => i.watchedAtSource)).toEqual(['trakt', undefined]);
    expect('watchedAtSource' in (exported.items[1] as object)).toBe(false);

    applyImport(db, parseImport(JSON.stringify(exported)), { mode: 'replace' });
    expect(rows()).toMatchObject([
      { at: '2019-04-02', src: 'trakt' },
      { at: '2020-02-03', src: null },
    ]);
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([
      { at: null, src: null },
      { at: '2020-02-03', src: null },
    ]);
  });

  it('a date a JSON v1 file gives without watchedAtSource is never cleared, whatever the item source', () => {
    const file = {
      format: 'screentrackr-library',
      version: 1,
      items: [{ sourceTitle: 'The Copper Orchard', sourceYear: 1994, status: 'watched', watchedAt: '2019-04-02', source: 'trakt', externalIds: { trakt: '9001' } }],
    };
    applyImport(db, parseImport(JSON.stringify(file)), { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: null }]);
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: null }]);
  });

  it('a JSON v1 merge of the same date takes the file\'s word on who set it', () => {
    applyImport(db, [trakt({ watchedAt: '2019-04-02' })], { mode: 'merge' });
    const file = (extra: object) =>
      JSON.stringify({
        format: 'screentrackr-library',
        version: 1,
        items: [{ sourceTitle: 'The Copper Orchard', sourceYear: 1994, status: 'watched', watchedAt: '2019-04-02', externalIds: { trakt: '9001' }, ...extra }],
      });
    // No watchedAtSource: the date is no longer the source's to clear.
    expect(applyImport(db, parseImport(file({})), { mode: 'merge' })).toMatchObject({ updated: 1, added: 0 });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: null }]);
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: null }]);
    // Another source named: only that source may clear it.
    applyImport(db, parseImport(file({ watchedAtSource: 'letterboxd' })), { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: 'letterboxd' }]);
    applyImport(db, [trakt({ clearWatchedAtIfOwn: true })], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: 'letterboxd' }]);
    // The same word again changes nothing.
    expect(applyImport(db, parseImport(file({ watchedAtSource: 'letterboxd' })), { mode: 'merge' })).toMatchObject({ updated: 0, unchanged: 1 });
    // An ordinary importer repeating the date keeps the recorded source.
    applyImport(db, [{ sourceTitle: 'The Copper Orchard', sourceYear: 1994, watchedAt: '2019-04-02', source: 'imdb' }], { mode: 'merge' });
    expect(rows()).toMatchObject([{ at: '2019-04-02', src: 'letterboxd' }]);
  });

  it('rejects an unknown watchedAtSource and ignores one without a date', () => {
    const file = (extra: object) => JSON.stringify({ format: 'screentrackr-library', version: 1, items: [{ sourceTitle: 'Night Ferry', ...extra }] });
    expect(() => parseImport(file({ watchedAt: '2020-01-01', watchedAtSource: 'myspace' }))).toThrow(/watchedAtSource/);
    expect(parseImport(file({ watchedAtSource: 'trakt' }))[0]?.watchedAtSource).toBeNull();
  });
});

describe('foldRecords', () => {
  it('keeps the latest date with its source, and asks to clear when any row asks', () => {
    const warn = () => undefined;
    const [dated] = foldRecords(
      [
        { sourceTitle: 'A', source: 'json', watchedAt: '2019-01-01', watchedAtSource: 'trakt' },
        { sourceTitle: 'A', source: 'json', watchedAt: '2020-01-01', watchedAtSource: null },
      ],
      () => 'a',
      warn,
    );
    expect(dated).toMatchObject({ watchedAt: '2020-01-01', watchedAtSource: null });
    // Instants, not strings: 23:00 at -02:00 is an hour after midnight UTC the next day.
    const [offset] = foldRecords(
      [
        { sourceTitle: 'A', source: 'json', watchedAt: '2024-01-02T00:00:00Z', watchedAtSource: 'trakt' },
        { sourceTitle: 'A', source: 'json', watchedAt: '2024-01-01T23:00:00-02:00', watchedAtSource: 'letterboxd' },
      ],
      () => 'a',
      warn,
    );
    expect(offset).toMatchObject({ watchedAt: '2024-01-01T23:00:00-02:00', watchedAtSource: 'letterboxd' });
    const [cleared] = foldRecords([trakt({ myRating: 6 }), trakt({ clearWatchedAtIfOwn: true })], () => 'k', warn);
    expect(cleared?.clearWatchedAtIfOwn).toBe(true);
    expect(cleared?.watchedAt).toBeUndefined();
  });
});

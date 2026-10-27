/**
 * Import engine rules that sources other than the owner's own library rely on:
 * owned and status values that apply only to a new item (ownedIfNew,
 * statusIfNew), descriptive fields that only fill blanks (fillOnly), a
 * source's own stable ids (externalIds), and folding several rows for one
 * film into a single record (foldRecords). All titles and people are made up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { exportLibrary } from '../src/core/export.js';
import { foldRecords } from '../src/core/importers/common.js';
import { applyImport, ImportError, parseImport, type ImportRecord } from '../src/core/importers/index.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-policy-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: IMDB });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items;');
});

function items(): LibraryItem[] {
  return (db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[]).map(rowToItem);
}
const externalIds = () =>
  db.sql.prepare('SELECT item_id AS id, kind, value FROM item_external_ids ORDER BY item_id, kind').all() as {
    id: number;
    kind: string;
    value: string;
  }[];

const owner = (extra: Partial<ImportRecord> = {}): ImportRecord => ({
  sourceTitle: 'Seven Lanterns',
  sourceDirector: 'Dana Fincher',
  sourceRuntimeMin: 117,
  sourceGenre: 'Crime',
  owned: true,
  sourceOwnedRaw: 'Yes',
  source: 'paste',
  ...extra,
});

describe('ownedIfNew', () => {
  it('sets owned only on a new item and never changes an existing one', () => {
    const rec: ImportRecord = { sourceTitle: 'Night Ferry', sourceYear: 2002, source: 'imdb', ownedIfNew: false };
    expect(applyImport(db, [rec], { mode: 'merge' })).toMatchObject({ added: 1 });
    expect(items()[0]).toMatchObject({ owned: false, sourceOwnedRaw: null });

    db.sql.exec('DELETE FROM library_items');
    applyImport(db, [owner()], { mode: 'merge' });
    const res = applyImport(db, [{ sourceTitle: 'Seven Lanterns', sourceYear: 1995, source: 'imdb', ownedIfNew: false }], {
      mode: 'merge',
    });
    expect(res.added).toBe(0);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ owned: true, sourceOwnedRaw: 'Yes' });
  });

  it('counts a re-import of a not-owned new item as an exact repeat', () => {
    const rec: ImportRecord = { sourceTitle: 'Night Ferry', sourceYear: 2002, source: 'imdb', ownedIfNew: false, status: 'watched' };
    applyImport(db, [rec], { mode: 'merge' });
    expect(applyImport(db, [rec], { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    // Two identical rows of one file stay two items, then repeat as two.
    db.sql.exec('DELETE FROM library_items');
    expect(applyImport(db, [rec, rec], { mode: 'merge' })).toMatchObject({ added: 2 });
    expect(applyImport(db, [rec, rec], { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 2 });
  });

  it('an explicit owned still wins over ownedIfNew', () => {
    applyImport(db, [{ sourceTitle: 'Night Ferry', source: 'imdb', owned: true, ownedIfNew: false }], { mode: 'merge' });
    expect(items()[0]?.owned).toBe(true);
  });
});

describe('statusIfNew', () => {
  it('gives a new item that status and never changes an existing status', () => {
    const wish: ImportRecord = { sourceTitle: 'Copper Sky', sourceYear: 2018, source: 'imdb', statusIfNew: 'someday', ownedIfNew: false };
    applyImport(db, [wish], { mode: 'merge' });
    expect(items()[0]).toMatchObject({ status: 'someday', watchedEra: null });
    expect(applyImport(db, [wish], { mode: 'merge' })).toMatchObject({ unchanged: 1 });

    db.sql.exec('DELETE FROM library_items');
    applyImport(db, [owner({ status: 'watched', watchedEra: '2010s', myRating: 9 })], { mode: 'merge' });
    const res = applyImport(db, [{ sourceTitle: 'Seven Lanterns', sourceYear: 1995, source: 'imdb', statusIfNew: 'queue', ownedIfNew: false }], {
      mode: 'merge',
    });
    expect(res).toMatchObject({ added: 0, updated: 1 }); // only the year and the link are filled in
    expect(items()[0]).toMatchObject({ status: 'watched', watchedEra: '2010s', myRating: 9, owned: true });
  });

  it('an explicit status still applies on merge (an upgrade to watched keeps the era)', () => {
    applyImport(db, [owner({ status: 'priority' })], { mode: 'merge' });
    applyImport(db, [{ sourceTitle: 'Seven Lanterns', sourceYear: 1995, source: 'imdb', status: 'watched', myRating: 7, ownedIfNew: false }], {
      mode: 'merge',
    });
    expect(items()[0]).toMatchObject({ status: 'watched', myRating: 7, owned: true });
  });

  it('rejects an unknown statusIfNew', () => {
    expect(() =>
      applyImport(db, [{ sourceTitle: 'X', source: 'imdb', statusIfNew: 'later' as never }], { mode: 'merge' }),
    ).toThrow(ImportError);
  });
});

describe('fillOnly', () => {
  it('fills blank descriptive fields and never replaces the owner source values', () => {
    applyImport(db, [owner({ sourceGenre: 'Crime', collection: null })], { mode: 'merge' });
    const rec: ImportRecord = {
      sourceTitle: 'Seven Lanterns',
      sourceYear: 1995,
      sourceDirector: 'Dana Fincher',
      sourceGenre: 'Crime, Mystery, Thriller',
      collection: 'Shelf',
      source: 'imdb',
      fillOnly: true,
      ownedIfNew: false,
    };
    expect(applyImport(db, [rec], { mode: 'merge' })).toMatchObject({ updated: 1 });
    expect(items()[0]).toMatchObject({ sourceGenre: 'Crime', sourceYear: 1995, collection: 'Shelf', source: 'paste' });
    expect(applyImport(db, [rec], { mode: 'merge' })).toMatchObject({ updated: 0, unchanged: 1 });
  });
});

describe('externalIds', () => {
  const lb = (uri: string, extra: Partial<ImportRecord> = {}): ImportRecord => ({
    sourceTitle: 'The Glass Harbor',
    sourceYear: 1978,
    source: 'letterboxd',
    ownedIfNew: false,
    externalIds: { letterboxd: uri },
    ...extra,
  });

  it('stores them on a new item and recognizes the item by them later', () => {
    applyImport(db, [lb('https://boxd.it/aA1')], { mode: 'merge' });
    const [item] = items();
    expect(externalIds()).toEqual([{ id: item?.id, kind: 'letterboxd', value: 'https://boxd.it/aA1' }]);
    // A later row with the same id is that item even under another title.
    const res = applyImport(db, [lb('https://boxd.it/aA1', { sourceTitle: 'Glass Harbour', status: 'watched' })], { mode: 'merge' });
    expect(res).toMatchObject({ added: 0, updated: 1 });
    expect(items()).toHaveLength(1);
    expect(items()[0]?.status).toBe('watched');
    expect(applyImport(db, [lb('https://boxd.it/aA1', { sourceTitle: 'Glass Harbour', status: 'watched' })], { mode: 'merge' })).toMatchObject({
      unchanged: 1,
    });
  });

  it('a different id of the same kind is a different film', () => {
    applyImport(db, [lb('https://boxd.it/aA1')], { mode: 'merge' });
    expect(applyImport(db, [lb('https://boxd.it/bB2')], { mode: 'merge' })).toMatchObject({ added: 1 });
    expect(items()).toHaveLength(2);
  });

  it('a merge adds a missing id to an existing item without touching others', () => {
    applyImport(db, [owner({ sourceTitle: 'The Glass Harbor', sourceDirector: 'Orrin Vale', sourceRuntimeMin: 112, sourceGenre: null })], {
      mode: 'merge',
    });
    expect(applyImport(db, [lb('https://boxd.it/aA1', { fillOnly: true })], { mode: 'merge' })).toMatchObject({ updated: 1 });
    expect(externalIds()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ owned: true, source: 'paste' });
    expect(applyImport(db, [lb('https://boxd.it/aA1', { fillOnly: true })], { mode: 'merge' })).toMatchObject({ unchanged: 1 });
  });

  it('round trips through JSON v1 export, import and replace', () => {
    applyImport(db, [lb('https://boxd.it/aA1'), owner()], { mode: 'merge' });
    const file = exportLibrary(db);
    expect(file.items[0]?.externalIds).toEqual({ letterboxd: 'https://boxd.it/aA1' });
    expect(file.items[1]).not.toHaveProperty('externalIds');
    const text = JSON.stringify(file);
    expect(applyImport(db, parseImport(text), { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 2 });
    expect(applyImport(db, parseImport(text), { mode: 'replace' })).toMatchObject({ added: 2 });
    expect(externalIds().map((x) => x.value)).toEqual(['https://boxd.it/aA1']);
    expect(exportLibrary(db).items.map((x) => x.externalIds ?? null)).toEqual([{ letterboxd: 'https://boxd.it/aA1' }, null]);
  });

  it('rejects unknown kinds and blank values are ignored', () => {
    expect(() => applyImport(db, [lb('x', { externalIds: { netflix: 'n1' } as never })], { mode: 'merge' })).toThrow(ImportError);
    applyImport(db, [lb('  ')], { mode: 'merge' });
    expect(externalIds()).toEqual([]);
  });
});

describe('foldRecords', () => {
  const base = (extra: Partial<ImportRecord>): ImportRecord => ({ sourceTitle: 'Two Kettles', source: 'imdb', imdbIdHint: 'tt9000003', ...extra });

  it('folds rows for one key: watched beats a new-item status, ratings must agree, the latest date wins', () => {
    const warnings: string[] = [];
    const out = foldRecords(
      [
        base({ statusIfNew: 'queue', ownedIfNew: false }),
        { sourceTitle: 'Other', source: 'imdb', imdbIdHint: 'tt9000004' },
        base({ status: 'watched', myRating: 8, watchedAt: '2021-01-02', sourceYear: 2009 }),
        base({ status: 'watched', myRating: 8, watchedAt: '2023-05-06' }),
      ],
      (r) => r.imdbIdHint ?? null,
      (w) => warnings.push(w),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ status: 'watched', myRating: 8, watchedAt: '2023-05-06', sourceYear: 2009, ownedIfNew: false });
    expect(out[0]?.statusIfNew).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('leaves out ratings that disagree, with a warning', () => {
    const warnings: string[] = [];
    const out = foldRecords([base({ status: 'watched', myRating: 8 }), base({ status: 'watched', myRating: 6 })], (r) => r.imdbIdHint ?? null, (w) =>
      warnings.push(w),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.myRating).toBeUndefined();
    expect(out[0]?.status).toBe('watched');
    expect(warnings[0]).toMatch(/Two Kettles.*rating/);
  });

  it('keeps rows without a key as they are', () => {
    const out = foldRecords([base({ imdbIdHint: null }), base({ imdbIdHint: null })], (r) => r.imdbIdHint ?? null, () => {});
    expect(out).toHaveLength(2);
  });
});

/**
 * The IMDb CSV importer: the ratings export and list exports (watchlist,
 * check-ins, custom lists). Every title, person and id in the fixtures is
 * invented; none of it comes from a real export.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { decodeImdbFile, parseImdb, type ImdbOptions } from '../src/core/importers/imdb.js';
import { applyImport, detectFormat, ImportError, parseImportDetailed, type ImportRecord } from '../src/core/importers/index.js';
import { exportLibrary } from '../src/core/export.js';
import { LIBRARY_COLUMNS, linkItem, rowToItem, type LibraryRow } from '../src/core/library.js';
import { rematch } from '../src/core/match.js';
import type { LibraryItem } from '../src/core/types.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const EXPORTS = join(import.meta.dirname, 'fixtures', 'imdb-export');
const file = (name: string) => ({ name, text: readFileSync(join(EXPORTS, name), 'utf8') });

const RATINGS_HEADER =
  'Const,Your Rating,Date Rated,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors';
const LIST_HEADER =
  'Position,Const,Created,Modified,Description,Title,Original Title,URL,Title Type,IMDb Rating,Runtime (mins),Year,Genres,Num Votes,Release Date,Directors,Your Rating,Date Rated';

let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-imdb-'));
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
const byConst = (tconst: string) => items().filter((i) => i.tconst === tconst);
const parse = (files: { name: string; text: string }[], opts: ImdbOptions = {}) => parseImdb(files, opts);
const rec = (records: ImportRecord[], tconst: string) => records.find((r) => r.imdbIdHint === tconst);

describe('detecting IMDb files', () => {
  it('detects both header shapes, also when named .csv, and the old format', () => {
    expect(detectFormat(file('ratings.csv').text, 'imdb-1234.csv')).toBe('imdb');
    expect(detectFormat(file('watchlist.csv').text, 'imdb-5678.csv')).toBe('imdb');
    expect(detectFormat(file('ratings.csv').text)).toBe('imdb');
    expect(detectFormat('position,const,created,modified,description,Title,Title type,Directors,You rated,IMDb Rating\n')).toBe('imdb');
  });

  it('leaves an ordinary CSV with a title column to the CSV importer', () => {
    expect(detectFormat('title,year,imdb_id\nThe Example,2001,tt9000001\n', 'x.csv')).toBe('csv');
  });

  it('plain import of a list file treats it as a watchlist and says so', () => {
    const res = parseImportDetailed(file('watchlist.csv').text, undefined, 'imdb-5678.csv');
    expect(res.format).toBe('imdb');
    expect(res.warnings.join('\n')).toMatch(/watchlist/i);
    expect(rec(res.records, 'tt9000004')).toMatchObject({ statusIfNew: 'queue' });
  });
});

describe('parsing the ratings export', () => {
  it('maps rated movies to watched with the rating, as hints, never owned and without IMDb aggregates', () => {
    const { records, skippedByType } = parse([file('ratings.csv')]);
    expect(records.map((r) => r.imdbIdHint)).toEqual(['tt9000001', 'tt9000005', 'tt9000011', 'tt9000006', 'tt9500001']);
    expect(skippedByType).toEqual({ 'TV Episode': 1, Short: 1 });
    const glass = rec(records, 'tt9000001') as ImportRecord;
    expect(glass).toEqual({
      sourceTitle: 'The Glass Harbor',
      sourceYear: 1978,
      sourceDirector: 'Orrin Vale',
      sourceGenre: 'Drama, Mystery',
      imdbIdHint: 'tt9000001',
      imdbIdExact: true,
      externalIds: { imdb: 'tt9000001' },
      status: 'watched',
      myRating: 8,
      source: 'imdb',
      ownedIfNew: false,
      fillOnly: true,
    });
    // No runtime (location dependent), no tconst link, no watch date from Date Rated.
    for (const r of records) {
      expect(r.sourceRuntimeMin ?? null).toBeNull();
      expect(r.tconst ?? null).toBeNull();
      expect(r.watchedAt ?? null).toBeNull();
      expect(r.watchedEra ?? null).toBeNull();
      expect(r.owned).toBeUndefined();
    }
    expect(rec(records, 'tt9000005')?.sourceDirector).toBe('Orrin Vale, Mira Calloway');
    expect(rec(records, 'tt9000006')?.myRating).toBe(7);
    expect(rec(records, 'tt9500001')?.sourceTitle).toBe('The "Quiet" Stranger');
  });

  it('uses the original title when the title has no Latin letters', () => {
    const { records } = parse([file('ratings.csv')]);
    expect(rec(records, 'tt9000011')?.sourceTitle).toBe('Le Phare Noir');
  });

  it('brings in other title types only when asked', () => {
    const { records, skippedByType } = parse([file('ratings.csv')], { includeTypes: ['short'] });
    expect(rec(records, 'tt9400001')).toMatchObject({ sourceTitle: 'Tiny Ledger', status: 'watched', myRating: 4 });
    expect(skippedByType).toEqual({ 'TV Episode': 1 });
  });

  it('skips a row with a rating that is not a whole number from 1 to 10, with a warning', () => {
    const text = `${RATINGS_HEADER}\ntt9000004,8.5,2024-01-01,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1995,"Crime",1,"1995","Dana Fincher"\ntt9000006,11,2024-01-01,"Dune Static","Dune Static",u,Movie,7.9,116,2016,"Drama",1,"2016","Denise Villeneuve"\n`;
    const res = parse([{ name: 'r.csv', text }]);
    expect(res.records).toEqual([]);
    expect(res.warnings.join('\n')).toMatch(/Seven Lanterns.*rating/);
  });

  it('treats a header-only file as no rows', () => {
    expect(parse([file('ratings-empty.csv')])).toMatchObject({ records: [], warnings: [] });
  });

  it('refuses the old pre-2018 format with a clear message', () => {
    const old = 'position,const,created,modified,description,Title,Title type,Directors,You rated,IMDb Rating\n1,tt9000004,Wed Dec 28 00:00:00 2011,,,Seven Lanterns,Feature Film,Dana Fincher,8,8.4\n';
    expect(() => parse([{ name: 'old.csv', text: old }])).toThrow(/older IMDb export format/);
  });

  it('refuses a file that is not an IMDb export', () => {
    expect(() => parse([{ name: 'x.csv', text: 'title,year\nA,2001\n' }])).toThrow(ImportError);
  });
});

describe('parsing list exports', () => {
  it('a watchlist: unrated rows go in the queue only when new, rated rows are watched, other types are skipped', () => {
    const { records, skippedByType, warnings } = parse([file('watchlist.csv')], { as: 'watchlist' });
    expect(skippedByType).toEqual({ 'TV Series': 1, 'TV Movie': 1 });
    expect(warnings).toEqual([]);
    const lanterns = rec(records, 'tt9000004') as ImportRecord;
    expect(lanterns).toMatchObject({ statusIfNew: 'queue', ownedIfNew: false, sourceDirector: 'Dana Fincher' });
    expect(lanterns.status).toBeUndefined();
    expect(rec(records, 'tt9000005')).toMatchObject({ status: 'watched', myRating: 9 });
    // The list description is dropped (never written to notes).
    expect(rec(records, 'tt9000024')?.notes ?? null).toBeNull();
  });

  it('TV movies come in when asked (the catalog was built with them)', () => {
    const { records } = parse([file('watchlist.csv')], { as: 'watchlist', includeTypes: ['tvMovie'] });
    expect(rec(records, 'tt9200001')).toMatchObject({ sourceTitle: 'Holiday Signal', statusIfNew: 'queue' });
  });

  it('check-ins are watched; their dates are used only with checkinDates', () => {
    expect(rec(parse([file('watchlist.csv')], { as: 'checkins' }).records, 'tt9000004')).toMatchObject({ status: 'watched' });
    expect(rec(parse([file('watchlist.csv')], { as: 'checkins' }).records, 'tt9000004')?.watchedAt ?? null).toBeNull();
    expect(rec(parse([file('watchlist.csv')], { as: 'checkins', checkinDates: true }).records, 'tt9000004')).toMatchObject({
      status: 'watched',
      watchedAt: '2025-01-15',
    });
  });

  it('a custom list sets no status and only names the collection given', () => {
    const { records } = parse([file('watchlist.csv')], { as: 'list', collection: 'Harbor nights' });
    const lanterns = rec(records, 'tt9000004') as ImportRecord;
    expect(lanterns.status).toBeUndefined();
    expect(lanterns.statusIfNew).toBeUndefined();
    expect(lanterns.collection).toBe('Harbor nights');
  });

  it('localized titles in a list file fall back to the original title', () => {
    const text = `${LIST_HEADER}\n1,tt9000011,2025-01-01,2025-01-01,,"Чёрный маяк","Le Phare Noir",u,Movie,7.3,95,1987,"Drama",3100,1987-04-01,"Selma Ruiz",,\n`;
    expect(parse([{ name: 'l.csv', text }], { as: 'watchlist' }).records[0]?.sourceTitle).toBe('Le Phare Noir');
  });
});

describe('files saved again in a spreadsheet', () => {
  const excel = [
    'Position;Const;Created;Modified;Description;Title;Original Title;URL;Title Type;IMDb Rating;Runtime (mins);Year;Genres;Num Votes;Release Date;Directors;Your Rating;Date Rated',
    '1;tt9000004;29/05/2025;29/05/2025;;Seven Lanterns;Seven Lanterns;u;Movie;8,4;117;1995;Crime;750000;22/09/1995;Dana Fincher;;',
    '2;tt9500002;03/06/2025;03/06/2025;;Café Marlow;Café Marlow;u;Movie;6,1;95;2011;Drama;300;01/01/2011;Bea Quint;7;03/06/2025',
  ].join('\r\n');

  it('reads semicolons, Windows-1252 text and day-first dates', () => {
    const bytes = Buffer.from(excel, 'latin1');
    const decoded = decodeImdbFile(bytes);
    expect(decoded.warning).toMatch(/Windows-1252/);
    const res = parse([{ name: 'excel.csv', text: decoded.text }], { as: 'checkins', checkinDates: true });
    expect(res.records.map((r) => [r.sourceTitle, r.watchedAt])).toEqual([
      ['Seven Lanterns', '2025-05-29'],
      ['Café Marlow', '2025-06-03'],
    ]);
    expect(res.records[1]).toMatchObject({ status: 'watched', myRating: 7 });
  });

  it('lets any date column of the file decide the order of an ambiguous check-in date', () => {
    const text = `${LIST_HEADER}\n1,tt9000004,03/04/2025,13/04/2025,,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1995,"Crime",1,1995,"Dana Fincher",,\n`;
    const res = parse([{ name: 'l.csv', text }], { as: 'checkins', checkinDates: true });
    expect(res.records[0]?.watchedAt).toBe('2025-04-03');
    const rated = `${LIST_HEADER}\n1,tt9000004,03/04/2025,03/04/2025,,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1995,"Crime",1,1995,"Dana Fincher",8,04/25/2025\n`;
    expect(parse([{ name: 'l.csv', text: rated }], { as: 'checkins', checkinDates: true }).records[0]?.watchedAt).toBe('2025-03-04');
  });

  it('drops dates it cannot read as day-first or month-first, with a warning', () => {
    const text = `${LIST_HEADER}\n1,tt9000004,03/04/2025,03/04/2025,,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1995,"Crime",1,1995,"Dana Fincher",,\n`;
    const res = parse([{ name: 'l.csv', text }], { as: 'checkins', checkinDates: true });
    expect(res.records[0]?.watchedAt ?? null).toBeNull();
    expect(res.warnings.join('\n')).toMatch(/date/i);
  });

  it('strips a byte order mark and reads plain UTF-8 without a warning', () => {
    const decoded = decodeImdbFile(Buffer.from('\uFEFF' + file('ratings.csv').text, 'utf8'));
    expect(decoded.warning).toBeUndefined();
    expect(parse([{ name: 'bom.csv', text: decoded.text }]).records).toHaveLength(5);
  });
});

describe('folding rows for one title', () => {
  it('folds the same Const across files: a rating beats the watchlist', () => {
    const { records } = parse([file('watchlist.csv'), file('ratings.csv')], { as: 'watchlist' });
    const salt = records.filter((r) => r.imdbIdHint === 'tt9000005');
    expect(salt).toHaveLength(1);
    expect(salt[0]).toMatchObject({ status: 'watched', myRating: 9 });
    expect(salt[0]?.statusIfNew).toBeUndefined();
  });

  it('a duplicate Const with different ratings keeps watched and leaves the rating out, with a warning', () => {
    const text = `${RATINGS_HEADER}\ntt9000004,8,2024-01-01,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1995,"Crime",1,"1995","Dana Fincher"\ntt9000004,6,2024-02-01,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1995,"Crime",1,"1995","Dana Fincher"\n`;
    const res = parse([{ name: 'r.csv', text }]);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.status).toBe('watched');
    expect(res.records[0]?.myRating).toBeUndefined();
    expect(res.warnings.join('\n')).toMatch(/Seven Lanterns/);
  });
});

describe('importing into the library', () => {
  const importFiles = (files: { name: string; text: string }[], opts: ImdbOptions = {}) => applyImport(db, parse(files, opts).records, { mode: 'merge' });

  it('adds rated movies as watched, not owned, matched through the Const', () => {
    const res = importFiles([file('ratings.csv')]);
    expect(res).toMatchObject({ added: 5, updated: 0 });
    expect(byConst('tt9000001')[0]).toMatchObject({ status: 'watched', myRating: 8, owned: false, source: 'imdb', matchStatus: 'matched', watchedAt: null });
    expect(byConst('tt9000011')[0]).toMatchObject({ sourceTitle: 'Le Phare Noir', matchStatus: 'matched' });
    // Not in the movie catalog: kept, unmatched.
    expect(items().find((i) => i.sourceTitle === 'The "Quiet" Stranger')).toMatchObject({ matchStatus: 'unmatched' });
  });

  it('a runtime off from the catalog with a same-titled rival neither refutes the Const nor makes a duplicate', () => {
    // The owner's paste: the 1978 film, owned, with its own runtime.
    applyImport(db, [{ sourceTitle: 'The Glass Harbor', sourceDirector: 'Orrin Vale', sourceRuntimeMin: 112, owned: true, source: 'paste' }], {
      mode: 'merge',
    });
    expect(items()[0]?.tconst).toBe('tt9000001');
    // The export lists 128 minutes, which is the 2009 remake's runtime.
    const res = importFiles([file('ratings.csv')]);
    expect(res).toMatchObject({ added: 4, updated: 1, reviews: [] });
    const glass = byConst('tt9000001');
    expect(glass).toHaveLength(1);
    expect(glass[0]).toMatchObject({ status: 'watched', myRating: 8, owned: true, source: 'paste', sourceRuntimeMin: 112 });
    expect(byConst('tt9000002')).toHaveLength(0);
  });

  it('a watchlist row never downgrades a watched item and never clears owned', () => {
    applyImport(
      db,
      [{ sourceTitle: 'Seven Lanterns', sourceDirector: 'Dana Fincher', sourceRuntimeMin: 117, sourceGenre: 'Crime', status: 'watched', watchedEra: '2010s', myRating: 9, owned: true, sourceOwnedRaw: 'Yes', source: 'paste' }],
      { mode: 'merge' },
    );
    importFiles([file('watchlist.csv')], { as: 'watchlist' });
    const lanterns = byConst('tt9000004');
    expect(lanterns).toHaveLength(1);
    expect(lanterns[0]).toMatchObject({ status: 'watched', watchedEra: '2010s', myRating: 9, owned: true, sourceOwnedRaw: 'Yes', sourceGenre: 'Crime' });
    // New watchlist movies go in the queue, not owned.
    expect(byConst('tt9000024')[0]).toMatchObject({ status: 'queue', owned: false, notes: null });
  });

  it('an existing item in priority keeps it when the watchlist lists it', () => {
    applyImport(db, [{ sourceTitle: 'Seven Lanterns', sourceYear: 1995, status: 'priority', source: 'csv' }], { mode: 'merge' });
    importFiles([file('watchlist.csv')], { as: 'watchlist' });
    expect(byConst('tt9000004')[0]).toMatchObject({ status: 'priority', owned: true });
  });

  it('re-importing the same files changes nothing', () => {
    const files = [file('watchlist.csv'), file('ratings.csv')];
    const first = importFiles(files, { as: 'watchlist' });
    expect(first.added).toBe(7);
    expect(importFiles(files, { as: 'watchlist' })).toMatchObject({ added: 0, updated: 0, unchanged: 7 });
  });

  it('a newer export updates the rating', () => {
    importFiles([file('ratings.csv')]);
    const text = file('ratings.csv').text.replace('tt9000001,8,', 'tt9000001,10,');
    expect(importFiles([{ name: 'newer.csv', text }])).toMatchObject({ updated: 1, unchanged: 4 });
    expect(byConst('tt9000001')[0]?.myRating).toBe(10);
  });

  it('a Const missing from the catalog is never swapped for another title of the same name', () => {
    // A short with the same title, year and director as a feature in the catalog.
    const text = `${RATINGS_HEADER}\ntt9400002,7,2024-01-01,"Night Ferry","Night Ferry",u,Short,6.0,12,2002,"Short",10,"2002","Dana Fincher"\n`;
    importFiles([{ name: 'r.csv', text }], { includeTypes: ['short'] });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ sourceTitle: 'Night Ferry', tconst: 'tt9400002', matchStatus: 'unmatched', status: 'watched' });
    // The feature's own IMDb row is another item.
    const feature = `${RATINGS_HEADER}\ntt9000010,6,2024-01-01,"Night Ferry","Night Ferry",u,Movie,6.8,112,2002,"Drama",10,"2002","Dana Fincher"\n`;
    expect(importFiles([{ name: 'f.csv', text: feature }])).toMatchObject({ added: 1 });
    expect(byConst('tt9000010')).toHaveLength(1);
    expect(items()).toHaveLength(2);
  });

  it('the Const stays the item\'s identity through setup, match and a JSON v1 restore', () => {
    // A short missing from the catalog with the same title, year and director as a feature in it.
    const text = `${RATINGS_HEADER}\ntt9400002,7,2024-01-01,"Night Ferry","Night Ferry",u,Short,6.0,12,2002,"Short",10,"2002","Dana Fincher"\n`;
    importFiles([{ name: 'r.csv', text }], { includeTypes: ['short'] });
    const short = { sourceTitle: 'Night Ferry', tconst: 'tt9400002', matchStatus: 'unmatched', matchScore: null };
    expect(items()).toMatchObject([short]);
    expect(db.sql.prepare('SELECT kind, value FROM item_external_ids').all()).toEqual([{ kind: 'imdb', value: 'tt9400002' }]);
    for (const onlyUnresolved of [true, false]) {
      rematch(db, { onlyUnresolved });
      expect(items()).toMatchObject([short]);
    }
    const exported = exportLibrary(db);
    expect(exported.items[0]?.externalIds).toEqual({ imdb: 'tt9400002' });
    applyImport(db, parseImportDetailed(JSON.stringify(exported)).records, { mode: 'replace' });
    expect(items()).toMatchObject([short]);
    rematch(db);
    expect(items()).toMatchObject([short]);
    // A Const the catalog has is linked by rematch as well, never swapped for a rival.
    db.sql.exec('DELETE FROM library_items');
    importFiles([file('ratings.csv')]);
    rematch(db);
    expect(byConst('tt9000001')[0]).toMatchObject({ matchStatus: 'matched', matchScore: 100 });
  });

  it('an exact IMDb id never lands on an item hand-linked to another title', () => {
    applyImport(db, [{ sourceTitle: 'Night Ferry', sourceYear: 2002, source: 'paste' }], { mode: 'merge' });
    const id = items()[0]?.id as number;
    linkItem(db, id, 'tt9000010');
    const text = `${RATINGS_HEADER}\ntt9400002,7,2024-01-01,"Night Ferry","Night Ferry",u,Short,6.0,12,2002,"Short",10,"2002","Dana Fincher"\n`;
    importFiles([{ name: 'r.csv', text }], { includeTypes: ['short'] });
    expect(db.sql.prepare('SELECT item_id, kind, value FROM item_external_ids WHERE item_id = ?').all(id)).toEqual([]);
    expect(items().find((i) => i.id === id)).toMatchObject({ tconst: 'tt9000010', matchStatus: 'manual' });
  });

  it('another format\'s record for a same-named feature never merges into an IMDb short missing from the catalog', () => {
    const text = `${RATINGS_HEADER}\ntt9400002,7,2024-01-01,"Night Ferry","Night Ferry",u,Short,6.0,12,2002,"Short",10,"2002","Dana Fincher"\n`;
    importFiles([{ name: 'r.csv', text }], { includeTypes: ['short'] });
    // A CSV row that matches the feature in the catalog (same title, year and director).
    const res = applyImport(db, [{ sourceTitle: 'Night Ferry', sourceYear: 2002, sourceDirector: 'Dana Fincher', myRating: 4, owned: true, source: 'csv' }], {
      mode: 'merge',
    });
    expect(res).toMatchObject({ added: 1, updated: 0 });
    const short = { sourceTitle: 'Night Ferry', tconst: 'tt9400002', matchStatus: 'unmatched', myRating: 7, owned: false };
    expect(items()).toMatchObject([short, { tconst: 'tt9000010', matchStatus: 'matched', myRating: 4, owned: true }]);
    rematch(db);
    expect(items()).toMatchObject([short, { tconst: 'tt9000010', matchStatus: 'matched' }]);
    applyImport(db, parseImportDetailed(JSON.stringify(exportLibrary(db))).records, { mode: 'replace' });
    expect(items()).toMatchObject([short, { tconst: 'tt9000010', matchStatus: 'matched', myRating: 4 }]);
  });

  it('linking an IMDb item by hand to another title drops the old id, so the next import finds it', () => {
    const short = `${RATINGS_HEADER}\ntt9400002,7,2024-01-01,"Night Ferry","Night Ferry",u,Short,6.0,12,2002,"Short",10,"2002","Dana Fincher"\n`;
    importFiles([{ name: 'r.csv', text: short }], { includeTypes: ['short'] });
    const id = items()[0]?.id as number;
    linkItem(db, id, 'tt9000010');
    expect(db.sql.prepare('SELECT kind FROM item_external_ids WHERE item_id = ?').all(id)).toEqual([]);
    const feature = `${RATINGS_HEADER}\ntt9000010,8,2024-02-01,"Night Ferry","Night Ferry",u,Movie,6.8,112,2002,"Drama",10,"2002","Dana Fincher"\n`;
    expect(importFiles([{ name: 'f.csv', text: feature }])).toMatchObject({ added: 0, updated: 1 });
    expect(items()).toMatchObject([{ id, tconst: 'tt9000010', matchStatus: 'manual', myRating: 8 }]);
    expect(db.sql.prepare('SELECT kind, value FROM item_external_ids WHERE item_id = ?').all(id)).toEqual([{ kind: 'imdb', value: 'tt9000010' }]);
    // The link and the id survive a JSON v1 round trip, and a repeat changes nothing.
    applyImport(db, parseImportDetailed(JSON.stringify(exportLibrary(db))).records, { mode: 'replace' });
    expect(items()).toMatchObject([{ tconst: 'tt9000010', matchStatus: 'manual', myRating: 8 }]);
    expect(importFiles([{ name: 'f.csv', text: feature }])).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
  });

  it('linking by hand to the same title keeps the id', () => {
    importFiles([file('ratings.csv')]);
    const id = byConst('tt9000001')[0]?.id as number;
    linkItem(db, id, 'tt9000001');
    expect(db.sql.prepare('SELECT value FROM item_external_ids WHERE item_id = ?').all(id)).toEqual([{ value: 'tt9000001' }]);
  });

  it('notes come from a list row\'s Description only when asked', () => {
    importFiles([file('watchlist.csv')], { as: 'watchlist' });
    expect(byConst('tt9000024')[0]?.notes).toBeNull();
    db.sql.exec('DELETE FROM library_items');
    importFiles([file('watchlist.csv')], { as: 'watchlist', notesFromDescription: true });
    expect(byConst('tt9000024')[0]?.notes).toBe('Watch on the "big" screen\nwith the projector');
    expect(byConst('tt9000004')[0]?.notes).toBeNull();
  });

  it('a dry run reports the counts and writes nothing', () => {
    importFiles([file('ratings.csv')]);
    const before = JSON.stringify(exportLibrary(db).items);
    const text = file('ratings.csv').text.replace('tt9000001,8,', 'tt9000001,10,');
    const records = parse([{ name: 'n.csv', text }, file('watchlist.csv')], { as: 'watchlist' }).records;
    const res = applyImport(db, records, { mode: 'merge', dryRun: true });
    expect(res).toMatchObject({ dryRun: true, updated: 1, backupPath: null });
    expect(res.added).toBeGreaterThan(0);
    expect(JSON.stringify(exportLibrary(db).items)).toBe(before);
    const backups = join(tmp, 'home', 'backups');
    const backupsBefore = readdirSync(backups).length;
    expect(applyImport(db, records, { mode: 'replace', dryRun: true })).toMatchObject({ dryRun: true, backupPath: null });
    expect(JSON.stringify(exportLibrary(db).items)).toBe(before);
    expect(readdirSync(backups)).toHaveLength(backupsBefore);
    expect(applyImport(db, records, { mode: 'merge' }).dryRun).toBeUndefined();
  });

  it('an exact IMDb id keeps its link when a record reaches the item another way', async () => {
    // Before setup: an Apple TV item, then the IMDb row of the short it is.
    const bare = openDb(join(tmp, `exact-${Date.now()}`));
    try {
      const apple: ImportRecord = { sourceTitle: 'Night Ferry', applePersistentId: 'A7', source: 'apple-tv', owned: true };
      const lb: ImportRecord = { sourceTitle: 'Night Ferry', externalIds: { letterboxd: 'https://boxd.it/x7' }, source: 'letterboxd', fillOnly: true, ownedIfNew: false };
      applyImport(bare, [apple], { mode: 'merge' });
      const text = `${RATINGS_HEADER}\ntt9400002,7,2024-01-01,"Night Ferry","Night Ferry",u,Short,6.0,12,2002,"Short",10,"2002","Dana Fincher"\n`;
      applyImport(bare, parse([{ name: 'r.csv', text }], { includeTypes: ['short'] }).records, { mode: 'merge' });
      applyImport(bare, [lb], { mode: 'merge' });
      const all = () => (bare.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[]).map(rowToItem);
      const short = { sourceTitle: 'Night Ferry', applePersistentId: 'A7', tconst: 'tt9400002', matchStatus: 'unmatched', myRating: 7 };
      expect(all()).toMatchObject([short]);
      expect(bare.sql.prepare('SELECT kind FROM item_external_ids ORDER BY kind').all()).toEqual([{ kind: 'imdb' }, { kind: 'letterboxd' }]);
      // The catalog has a feature of that title, which these rows alone would match.
      await buildCatalog(bare, { cacheDir: IMDB });
      for (const r of [apple, lb, { sourceTitle: 'Night Ferry', source: 'csv' } as ImportRecord]) {
        applyImport(bare, [r], { mode: 'merge' });
        expect(all()).toMatchObject([short]);
      }
      const exported = exportLibrary(bare);
      applyImport(bare, parseImportDetailed(JSON.stringify(exported)).records, { mode: 'replace' });
      expect(all()).toMatchObject([short]);
    } finally {
      bare.close();
    }
  });

  it('rejects an imdb external id that is not an IMDb id', () => {
    expect(() => applyImport(db, [{ sourceTitle: 'X', source: 'json', externalIds: { imdb: 'nope' } }], { mode: 'merge' })).toThrow(/invalid imdb id/);
  });

  it('a Const in the catalog is taken as is, even when the export year is further off', () => {
    const text = `${RATINGS_HEADER}\ntt9000004,8,2024-01-01,"Seven Lanterns","Seven Lanterns",u,Movie,8.4,117,1998,"Crime",1,"1998","Dana Fincher"\n`;
    importFiles([{ name: 'r.csv', text }]);
    expect(byConst('tt9000004')[0]).toMatchObject({ matchStatus: 'matched', myRating: 8 });
  });

  it('before setup the Const is kept as an unchecked hint', () => {
    const bare = openDb(join(tmp, 'bare'));
    try {
      applyImport(bare, parse([file('ratings.csv')]).records, { mode: 'merge' });
      const glass = (bare.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items WHERE source_title = 'The Glass Harbor'`).get() as unknown as LibraryRow);
      expect(rowToItem(glass)).toMatchObject({ tconst: 'tt9000001', matchStatus: 'unmatched', owned: false });
    } finally {
      bare.close();
    }
  });
});

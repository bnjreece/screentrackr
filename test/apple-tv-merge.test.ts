/**
 * Merging the Apple TV app's library into an existing one.
 *
 * The TV app's `year` is the year of the edition on sale (a restoration, a
 * digital release), not the film's: a 1972 film can show 2015. These tests use
 * the synthetic catalog in fixtures/imdb (made-up titles and ids only).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { parseAppleTvJxaOutput } from '../src/core/importers/apple-tv.js';
import { applyImport, parseImport } from '../src/core/importers/index.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../src/core/library.js';
import { matchOne } from '../src/core/match.js';
import type { LibraryItem } from '../src/core/types.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-apple-tv-merge-'));
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

interface Track {
  name: string;
  year: number;
  director: string;
  minutes: number;
  id: string;
  playedDate?: string;
}

/** What the JXA script prints for these tracks. */
const jxa = (tracks: Track[]) =>
  JSON.stringify(
    tracks.map((t) => ({
      name: t.name,
      year: t.year,
      director: t.director,
      genre: 'Drama',
      duration: t.minutes * 60 + 12.5,
      playedCount: t.playedDate ? 1 : 0,
      playedDate: t.playedDate ?? null,
      persistentID: t.id,
      dateAdded: '2021-03-04T05:06:07.000Z',
      mediaKind: 'movie',
    })),
  );
const importTv = (tracks: Track[]) => applyImport(db, parseAppleTvJxaOutput(jxa(tracks)), { mode: 'merge' });

/** An existing library as an older source left it: linked to IMDb, with status and rating, no Apple ids. */
function seed(rows: Record<string, unknown>[]): void {
  const file = JSON.stringify({ format: 'screentrackr-library', version: 1, exportedAt: '2026-01-01T00:00:00Z', items: rows });
  applyImport(db, parseImport(file), { mode: 'merge' });
}

describe('parsing: the TV app year is an edition year', () => {
  it('keeps the year out of sourceYear and carries it as the edition year', () => {
    const [rec] = parseAppleTvJxaOutput(jxa([{ name: 'Red Thread', year: 2015, director: 'Teodor Brask', minutes: 131, id: 'AAAA000000000001' }]));
    expect(rec?.sourceYear ?? null).toBeNull();
    expect(rec?.editionYear).toBe(2015);
  });

  it('turns a trailing ": ... Edition" or ": Director\'s Cut" segment into an edition group', () => {
    const recs = parseAppleTvJxaOutput(
      jxa([
        { name: "Quiet Ledger: The Collector's Edition", year: 2019, director: 'Dana Fincher', minutes: 139, id: 'AAAA000000000002' },
        { name: 'Red Thread - 50th Anniversary Edition', year: 2022, director: 'Teodor Brask', minutes: 131, id: 'AAAA000000000003' },
        { name: "Wolf Season: Director's Cut", year: 2012, director: 'Dana Fincher', minutes: 158, id: 'AAAA000000000004' },
        // A cut named like a film is left alone: it may be the film's own title.
        { name: 'Paper Engine: The Next Cut', year: 2016, director: 'Dana Fincher', minutes: 120, id: 'AAAA000000000005' },
      ]),
    );
    expect(recs.map((r) => r.sourceTitle)).toEqual([
      "Quiet Ledger (The Collector's Edition)",
      'Red Thread (50th Anniversary Edition)',
      "Wolf Season (Director's Cut)",
      'Paper Engine: The Next Cut',
    ]);
  });
});

describe('matching a new Apple TV movie', () => {
  it('matches the film although the edition year is long after it', () => {
    expect(matchOne(db, { title: 'Iron Meadow', editionYear: 2011, director: 'Teodor Brask', runtimeMin: 118 })).toMatchObject({
      status: 'matched',
      tconst: 'tt9000022',
    });
  });

  it('a film released after the edition year (plus one) cannot be it', () => {
    // The 2009 remake fits title and director credit loosely, but an edition sold in 1990 is the 1978 film.
    expect(matchOne(db, { title: 'The Glass Harbor', editionYear: 1990, runtimeMin: 112 })).toMatchObject({
      status: 'matched',
      tconst: 'tt9000001',
    });
    const res = matchOne(db, { title: 'The Glass Harbor', editionYear: 1990 });
    expect(res.candidates.map((c) => c.tconst)).not.toContain('tt9000002');
    // A year in the title is still the film's own year.
    expect(matchOne(db, { title: 'Iron Meadow (1956)', editionYear: 2012 })).toMatchObject({ tconst: 'tt9000022' });
  });

  it('adds new items matched despite a later Apple year, with no source year stored', () => {
    const res = importTv([
      { name: 'Iron Meadow', year: 2011, director: 'Teodor Brask', minutes: 118, id: 'AAAA000000000010' },
      { name: "Seven Lanterns (Director's Cut)", year: 2010, director: 'Dana Fincher', minutes: 117, id: 'AAAA000000000011' },
      { name: 'Red Thread (Subtitled)', year: 2015, director: 'Teodor Brask', minutes: 131, id: 'AAAA000000000012' },
      { name: "Quiet Ledger: The Collector's Edition", year: 2019, director: 'Dana Fincher', minutes: 139, id: 'AAAA000000000013' },
    ]);
    expect(res).toMatchObject({ added: 4, needsReview: 0 });
    expect(items().map((i) => [i.tconst, i.matchStatus, i.sourceYear])).toEqual([
      ['tt9000022', 'matched', null],
      ['tt9000004', 'matched', null],
      ['tt9000027', 'matched', null],
      ['tt9000003', 'matched', null],
    ]);
  });
});

describe('merging Apple TV into a library already linked to IMDb', () => {
  const library = [
    { sourceTitle: 'Red Thread', sourceDirector: 'Teodor Brask', sourceRuntimeMin: 131, tconst: 'tt9000027', matchStatus: 'matched', status: 'watched', myRating: 8 },
    { sourceTitle: 'Iron Meadow', sourceYear: 1956, sourceDirector: 'Teodor Brask', sourceRuntimeMin: 118, tconst: 'tt9000022', matchStatus: 'matched', status: 'priority' },
    { sourceTitle: 'The Glass Harbor', sourceDirector: 'Orrin Vale', sourceRuntimeMin: 112, tconst: 'tt9000001', matchStatus: 'matched', status: 'watched', myRating: 7 },
    { sourceTitle: 'Seven Lanterns', sourceDirector: 'Dana Fincher', sourceRuntimeMin: 117, tconst: 'tt9000004', matchStatus: 'matched', status: 'queue' },
  ];
  const tv: Track[] = [
    // Restored and re-sold decades later: edition years far from the films'.
    { name: 'Red Thread (Restored Version)', year: 2015, director: 'Teodor Brask', minutes: 131, id: 'AAAA000000000020' },
    { name: 'Iron Meadow', year: 2011, director: 'Teodor Brask', minutes: 118, id: 'AAAA000000000021' },
    { name: 'The Glass Harbor', year: 2003, director: 'Orrin Vale', minutes: 112, id: 'AAAA000000000022' },
    { name: "Seven Lanterns (Director's Cut)", year: 2010, director: 'Dana Fincher', minutes: 118, id: 'AAAA000000000023' },
    // The 2009 remake, which the library does not have yet: same title, another director and runtime.
    { name: 'The Glass Harbor', year: 2012, director: 'Teodor Brask', minutes: 128, id: 'AAAA000000000024' },
  ];

  it('attaches the Apple ids to the linked items instead of adding duplicates', () => {
    seed(library);
    const before = items();
    const res = importTv(tv);
    expect(res).toMatchObject({ added: 1, updated: 4, needsReview: 0, reviews: [] });
    const after = items();
    expect(after.slice(0, 4).map((i) => [i.tconst, i.applePersistentId])).toEqual([
      ['tt9000027', 'AAAA000000000020'],
      ['tt9000022', 'AAAA000000000021'],
      ['tt9000001', 'AAAA000000000022'],
      ['tt9000004', 'AAAA000000000023'],
    ]);
    // The remake is its own new item, matched to the 2009 film.
    expect(after[4]).toMatchObject({ sourceTitle: 'The Glass Harbor', tconst: 'tt9000002', matchStatus: 'matched', applePersistentId: 'AAAA000000000024' });
    // Never the edition year over (or into) source_year; never a status or rating change.
    expect(after.slice(0, 4).map((i) => i.sourceYear)).toEqual(before.map((i) => i.sourceYear));
    expect(after.slice(0, 4).map((i) => [i.status, i.myRating])).toEqual(before.map((i) => [i.status, i.myRating]));
    expect(after[4]?.sourceYear).toBeNull();
  });

  it('a second identical import adds nothing and changes nothing', () => {
    seed(library);
    importTv(tv);
    const once = items();
    expect(importTv(tv)).toMatchObject({ added: 0, updated: 0, unchanged: tv.length, needsReview: 0 });
    expect(items()).toEqual(once);
  });

  it('an edition sold before a film came out is not that film', () => {
    // Only the remake is in the library; an Apple edition from 1990 is the original.
    seed([{ sourceTitle: 'The Glass Harbor', tconst: 'tt9000002', matchStatus: 'matched', status: 'watched', myRating: 5 }]);
    expect(importTv([{ name: 'The Glass Harbor', year: 1990, director: 'Orrin Vale', minutes: 112, id: 'AAAA000000000030' }])).toMatchObject({ added: 1, updated: 0 });
    expect(items().map((i) => [i.tconst, i.applePersistentId, i.myRating])).toEqual([
      ['tt9000002', null, 5],
      ['tt9000001', 'AAAA000000000030', null],
    ]);
  });

  it('an unmatched item with the same title, director and runtime takes the Apple id', () => {
    // An item the catalog could not place (no IMDb link) is still the same movie by its facts.
    seed([{ sourceTitle: 'Basement Tapes', sourceYear: 1985, sourceDirector: 'Hana Weir', sourceRuntimeMin: 100, status: 'watched' }]);
    expect(importTv([{ name: 'Basement Tapes (Remastered Feature)', year: 2014, director: 'Hana Weir', minutes: 100, id: 'AAAA000000000040' }])).toMatchObject({
      added: 0,
      updated: 1,
    });
    expect(items()).toMatchObject([{ sourceTitle: 'Basement Tapes', sourceYear: 1985, applePersistentId: 'AAAA000000000040', status: 'watched' }]);
  });

  it('a wrong director credit on an item linked to the same IMDb title does not make a duplicate', () => {
    // An older source credited the screenwriter; the catalog link says which film it is.
    seed([{ sourceTitle: 'Red Thread', sourceDirector: 'Wren Ashby', sourceRuntimeMin: 131, tconst: 'tt9000027', matchStatus: 'matched', status: 'watched' }]);
    expect(importTv([{ name: 'Red Thread', year: 2015, director: 'Teodor Brask', minutes: 131, id: 'AAAA000000000050' }])).toMatchObject({ added: 0, updated: 1 });
    expect(items()).toMatchObject([{ tconst: 'tt9000027', applePersistentId: 'AAAA000000000050', status: 'watched' }]);
  });

  it('a different director still keeps an unlinked item apart', () => {
    seed([{ sourceTitle: 'Basement Tapes', sourceDirector: 'Hana Weir', sourceRuntimeMin: 100 }]);
    expect(importTv([{ name: 'Basement Tapes', year: 2014, director: 'Gus Okafor', minutes: 100, id: 'AAAA000000000051' }])).toMatchObject({ added: 1, updated: 0 });
  });

  it('other sources keep the one-year rule: a year far off is another movie', () => {
    seed([{ sourceTitle: 'Basement Tapes', sourceYear: 1985, sourceDirector: 'Hana Weir', sourceRuntimeMin: 100 }]);
    const csv = parseImport('title,year,director\nBasement Tapes,2014,Hana Weir\n', 'csv');
    expect(applyImport(db, csv, { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
  });
});

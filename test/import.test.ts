import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { exportLibrary, type LibraryJsonV1 } from '../src/core/export.js';
import { backupsDir } from '../src/core/home.js';
import {
  applyImport,
  detectFormat,
  ImportError,
  parseImport,
  parseImportDetailed,
  type ImportRecord,
} from '../src/core/importers/index.js';
import { LIBRARY_COLUMNS, linkItem, rowToItem, updateItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const IMPORT = join(import.meta.dirname, 'fixtures', 'import');
const fixture = (name: string) => readFileSync(join(IMPORT, name), 'utf8');

let tmp: string;
let db: Db;
let bare: Db; // no catalog built

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-import-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: IMDB });
  bare = openDb(join(tmp, 'bare'));
});
afterAll(() => {
  db.close();
  bare.close();
  rmSync(tmp, { recursive: true, force: true });
});

function wipe(d: Db): void {
  d.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items;');
}
beforeEach(() => {
  wipe(db);
  wipe(bare);
});

function items(d: Db): LibraryItem[] {
  return (d.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[]).map(
    rowToItem,
  );
}
const byTitle = (d: Db, title: string) => items(d).filter((i) => i.sourceTitle === title);
const one = (d: Db, title: string) => {
  const found = byTitle(d, title);
  expect(found).toHaveLength(1);
  return found[0] as LibraryItem;
};
const comparable = (xs: LibraryItem[]) =>
  xs.map((x) => {
    const rest: Partial<LibraryItem> = { ...x };
    delete rest.id;
    delete rest.addedAt;
    delete rest.updatedAt;
    return rest;
  });

describe('detectFormat', () => {
  it('detects each fixture', () => {
    expect(detectFormat(fixture('apple-paste.txt'))).toBe('apple-paste');
    expect(detectFormat(fixture('legacy.json'))).toBe('legacy');
    expect(detectFormat(fixture('neon-rows.json'))).toBe('neon-rows');
    expect(detectFormat(fixture('library.csv'))).toBe('csv');
    expect(detectFormat(fixture('library.csv'), 'mine.csv')).toBe('csv');
    const v1: LibraryJsonV1 = { format: 'screentrackr-library', version: 1, exportedAt: '2026-10-23T00:00:00.000Z', items: [] };
    expect(detectFormat(JSON.stringify(v1))).toBe('json-v1');
  });

  it('rejects text it cannot place', () => {
    expect(() => detectFormat('just some words')).toThrow(ImportError);
    expect(() => detectFormat('{"hello": 1}')).toThrow(ImportError);
    expect(() => detectFormat('{not json')).toThrow(ImportError);
  });
});

describe('apple paste', () => {
  it('reads the 7-column layout with a blank second column', () => {
    const recs = parseImport(fixture('apple-paste.txt'));
    expect(recs).toHaveLength(6);
    const q = recs[0] as ImportRecord;
    expect(q).toMatchObject({
      sourceTitle: 'Quiet Ledger',
      sourceRuntimeMin: 139,
      sourceDirector: 'Dana Fincher',
      collection: 'Ledger Collection',
      sourceGenre: 'Thriller',
      owned: true,
      sourceOwnedRaw: 'Yes',
      source: 'paste',
    });
    expect(q.status).toBeUndefined();
    expect(q.myRating).toBeUndefined();
  });

  it('treats a blank owned column as owned and keeps the raw value', () => {
    const dune = parseImport(fixture('apple-paste.txt')).find((r) => r.sourceTitle === 'Dune Static');
    expect(dune).toMatchObject({ owned: true, sourceOwnedRaw: '' });
  });

  it('uses a header row when present, in any column order', () => {
    const text = 'Genre\tTitle\tDirector\tDuration\tOwned\nDrama\tNight Ferry\tDana Fincher\t1:52:00\tYes\n';
    expect(detectFormat(text)).toBe('apple-paste');
    const recs = parseImport(text);
    expect(recs).toEqual([
      expect.objectContaining({ sourceTitle: 'Night Ferry', sourceGenre: 'Drama', sourceDirector: 'Dana Fincher', sourceRuntimeMin: 112 }),
    ]);
  });

  it('keeps rows whose trailing blank columns were trimmed', () => {
    const recs = parseImport('Night Ferry\t\t1:52:00\tDana Fincher\n', 'apple-paste');
    expect(recs[0]).toMatchObject({ sourceTitle: 'Night Ferry', owned: true, sourceOwnedRaw: '' });
  });
});

describe('legacy ExportData', () => {
  it('maps statuses, ratings and IMDb ids keyed by title onto the right records', () => {
    const { records, warnings } = parseImportDetailed(fixture('legacy.json'));
    expect(records).toHaveLength(4);
    const get = (t: string) => records.find((r) => r.sourceTitle === t) as ImportRecord;
    expect(get('Quiet Ledger')).toMatchObject({ status: 'watched', watchedEra: '2010s', myRating: 9, source: 'legacy' });
    expect(get('Dune Static')).toMatchObject({ status: 'priority', watchedEra: null, owned: true, sourceOwnedRaw: '' });
    expect(get('Dune Static').myRating).toBeUndefined();
    expect(get('Border Choir')).toMatchObject({ status: 'watched', watchedEra: 'long-ago', myRating: 7, imdbIdHint: 'tt9000007' });
    // movieImdbData's Year comes from the same title-only lookup as the id, so it is not source evidence.
    expect(get('Border Choir').sourceYear ?? null).toBeNull();
    expect(get('Echo Valley').status).toBeUndefined();
    // A status for a title that is not in movieList is reported, not dropped silently.
    expect(warnings.join('\n')).toContain('A Title Not In The List');
  });

  it('uses the IMDb id hint when importing', () => {
    applyImport(db, parseImport(fixture('legacy.json')), { mode: 'merge' });
    expect(one(db, 'Border Choir')).toMatchObject({ tconst: 'tt9000007', matchStatus: 'matched' });
  });
});

describe('neon rows', () => {
  it('maps watched-2020s, the rating and imdbData.imdbID as a hint', () => {
    const recs = parseImport(fixture('neon-rows.json'));
    expect(recs[0]).toMatchObject({
      sourceTitle: 'Copper Sky',
      sourceDirector: 'Denise Villeneuve',
      sourceRuntimeMin: 109,
      status: 'watched',
      watchedEra: '2020s',
      myRating: 8,
      imdbIdHint: 'tt9000018',
      owned: true,
    });
    expect(recs[1]).toMatchObject({ sourceTitle: 'Night Ferry', owned: true, sourceOwnedRaw: '' });
    // imdbData comes from the same title-only lookup as the hint, so its Year is not source evidence.
    expect(recs[0]?.sourceYear ?? null).toBeNull();
    expect(recs[1]?.status).toBeUndefined();
  });
});

describe('csv', () => {
  it('reads the header columns, quoted fields and blanks', () => {
    const recs = parseImport(fixture('library.csv'));
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({ sourceTitle: 'Paper Engine', sourceYear: 2010, status: 'watched', myRating: 8, imdbIdHint: 'tt9000009', source: 'csv' });
    expect(recs[1]).toMatchObject({ sourceTitle: 'Salt & Signal', sourceDirector: 'Orrin Vale, Mira Calloway', status: 'priority' });
    expect(recs[1]?.myRating).toBeUndefined();
    expect(recs[2]?.status).toBeUndefined();
  });

  it('rejects a rating outside 1 to 10 instead of guessing', () => {
    expect(() => parseImport('title,rating\nNight Ferry,11\n', 'csv')).toThrow(ImportError);
  });
});

describe('applyImport', () => {
  it('matches each record on insert and reports needs review', () => {
    const res = applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    expect(res).toMatchObject({ added: 6, updated: 0, unchanged: 0, backupPath: null });
    expect(one(db, 'Quiet Ledger')).toMatchObject({ tconst: 'tt9000003', matchStatus: 'matched' });
    expect(one(db, "Seven Lanterns (Director's Cut)")).toMatchObject({ tconst: 'tt9000004', matchStatus: 'matched' });
    expect(one(db, 'Basement Tapes').matchStatus).toBe('unmatched');
    expect(res.needsReview).toBe(items(db).filter((i) => i.matchStatus === 'ambiguous' || i.matchStatus === 'unmatched').length);
    expect(res.needsReview).toBeGreaterThan(0);
  });

  it('Review Focus #3: importing the same paste twice adds nothing the second time', () => {
    const recs = parseImport(fixture('apple-paste.txt'));
    applyImport(db, recs, { mode: 'merge' });
    const before = items(db);
    const again = applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: recs.length });
    expect(items(db)).toEqual(before);
  });

  it('Review Focus #3 holds without a catalog too', () => {
    const recs = parseImport(fixture('apple-paste.txt'));
    expect(applyImport(bare, recs, { mode: 'merge' }).added).toBe(6);
    expect(applyImport(bare, recs, { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 6 });
    expect(items(bare)).toHaveLength(6);
  });

  it('keeps two rows with the same title and different runtimes as two items', () => {
    applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    const harbors = byTitle(db, 'The Glass Harbor');
    expect(harbors.map((h) => h.sourceRuntimeMin).sort()).toEqual([112, 128]);
    expect(harbors.map((h) => h.tconst).sort()).toEqual(['tt9000001', 'tt9000002']);

    applyImport(bare, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    expect(byTitle(bare, 'The Glass Harbor')).toHaveLength(2);
  });

  it('merge never clears a rating or status the incoming record lacks', () => {
    applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    const q = one(db, 'Quiet Ledger');
    updateItem(db, q.id, { status: 'watched', watchedEra: '2010s', myRating: 9, notes: 'keep me' });

    // The paste has no status or rating at all.
    const res = applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    expect(res.unchanged).toBe(6);
    expect(one(db, 'Quiet Ledger')).toMatchObject({ status: 'watched', watchedEra: '2010s', myRating: 9, notes: 'keep me' });

    // A record with a status but no rating changes the status and keeps the rating.
    const rec: ImportRecord = { sourceTitle: 'Quiet Ledger', sourceRuntimeMin: 139, status: 'priority', source: 'csv' };
    expect(applyImport(db, [rec], { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
    expect(one(db, 'Quiet Ledger')).toMatchObject({ status: 'priority', watchedEra: null, myRating: 9, notes: 'keep me' });
  });

  it('merge updates fields the source has', () => {
    applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    const res = applyImport(db, parseImport(fixture('legacy.json')), { mode: 'merge' });
    // Quiet Ledger and Dune Static exist; Border Choir and Echo Valley are new.
    expect(res).toMatchObject({ added: 2, updated: 2 });
    expect(one(db, 'Quiet Ledger')).toMatchObject({ status: 'watched', watchedEra: '2010s', myRating: 9 });
    expect(one(db, 'Dune Static')).toMatchObject({ status: 'priority' });
  });

  it('runs in one transaction: a bad record leaves the library untouched', () => {
    applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    const before = items(db);
    const bad = [
      { sourceTitle: 'Night Ferry', source: 'csv' },
      { sourceTitle: 'Echo Valley', myRating: 42, source: 'csv' },
    ] as ImportRecord[];
    expect(() => applyImport(db, bad, { mode: 'merge' })).toThrow();
    expect(items(db)).toEqual(before);
  });

  it('replace writes a backup into backups/ first and returns its path', () => {
    applyImport(db, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    const res = applyImport(db, parseImport(fixture('neon-rows.json')), { mode: 'replace' });
    expect(res.backupPath).not.toBeNull();
    const path = res.backupPath as string;
    expect(dirname(path)).toBe(backupsDir(db.home));
    expect(existsSync(path)).toBe(true);
    const backup = JSON.parse(readFileSync(path, 'utf8')) as LibraryJsonV1;
    expect(backup.format).toBe('screentrackr-library');
    expect(backup.items).toHaveLength(6);
    expect(res).toMatchObject({ added: 2, updated: 0, unchanged: 0 });
    expect(items(db).map((i) => i.sourceTitle).sort()).toEqual(['Copper Sky', 'Night Ferry']);

    // The backup restores the previous library.
    const restored = applyImport(db, parseImport(readFileSync(path, 'utf8')), { mode: 'replace' });
    expect(restored.added).toBe(6);
  });
});

describe('export', () => {
  function seed(d: Db): void {
    applyImport(d, parseImport(fixture('apple-paste.txt')), { mode: 'merge' });
    applyImport(d, parseImport(fixture('legacy.json')), { mode: 'merge' });
    applyImport(d, parseImport(fixture('neon-rows.json')), { mode: 'merge' });
    const q = one(d, 'Quiet Ledger');
    updateItem(d, q.id, { watchedAt: '2015-06-01', notes: 'with friends' });
  }

  it('exports JSON v1 without ids', () => {
    seed(db);
    const out = exportLibrary(db);
    expect(out.format).toBe('screentrackr-library');
    expect(out.version).toBe(1);
    expect(Number.isNaN(Date.parse(out.exportedAt))).toBe(false);
    expect(out.items).toHaveLength(items(db).length);
    expect(out.items[0]).not.toHaveProperty('id');
    expect(out.items[0]).toHaveProperty('tconst');
  });

  it('round trips through import into an empty db', async () => {
    seed(db);
    const text = JSON.stringify(exportLibrary(db));
    expect(detectFormat(text)).toBe('json-v1');

    const other = openDb(join(tmp, 'roundtrip'));
    try {
      await buildCatalog(other, { cacheDir: IMDB });
      const res = applyImport(other, parseImport(text), { mode: 'merge' });
      expect(res.added).toBe(items(db).length);
      expect(comparable(items(other))).toEqual(comparable(items(db)));
      // And a second import of the same export is a no-op.
      expect(applyImport(other, parseImport(text), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0 });
    } finally {
      other.close();
    }
  });

  it('round trips into a db with no catalog, keeping tconsts', () => {
    seed(db);
    const text = JSON.stringify(exportLibrary(db));
    applyImport(bare, parseImport(text), { mode: 'merge' });
    const linked = (xs: LibraryItem[]) => comparable(xs.filter((i) => i.tconst !== null));
    expect(linked(items(bare))).toEqual(linked(items(db)));
    expect(items(bare)).toHaveLength(items(db).length);
  });
});

describe('IMDb id hints imported before setup', () => {
  it('keeps the hint and uses it once the catalog is built', async () => {
    const home = join(tmp, 'hint-before-setup');
    const d = openDb(home);
    try {
      // A title the catalog would never match by name, so only the hint can place it.
      const records: ImportRecord[] = [
        { sourceTitle: 'Ledger Of Quiet Things', imdbIdHint: 'tt9000003', status: 'watched', source: 'csv' },
      ];
      const first = applyImport(d, records, { mode: 'merge' });
      expect(first).toMatchObject({ added: 1, needsReview: 1 });
      const before = one(d, 'Ledger Of Quiet Things');
      expect(before.matchStatus).toBe('unmatched');
      expect(before.tconst).toBe('tt9000003');

      // The same file again before setup is still one item, unchanged.
      expect(applyImport(d, records, { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 1 });

      await buildCatalog(d, { cacheDir: IMDB });
      const { rematch } = await import('../src/core/match.js');
      rematch(d);
      const after = one(d, 'Ledger Of Quiet Things');
      expect(after.matchStatus).toBe('matched');
      expect(after.tconst).toBe('tt9000003');
      expect(after.status).toBe('watched');
    } finally {
      d.close();
    }
  });

  it('does not treat a stored hint as a catalog link in searches', async () => {
    const { searchMovies } = await import('../src/core/search.js');
    applyImport(bare, [{ sourceTitle: 'Ledger Of Quiet Things', imdbIdHint: 'tt9000003', source: 'csv' }], { mode: 'merge' });
    const res = searchMovies(bare, {});
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ tconst: null, library: { matchStatus: 'unmatched' } });
  });
});

describe('JSON v1 with a kept hint', () => {
  it('round trips an unmatched item with a hint as a hint, never as a link', () => {
    applyImport(bare, [{ sourceTitle: 'Ledger Of Quiet Things', imdbIdHint: 'tt9000003', source: 'csv' }], { mode: 'merge' });
    const text = JSON.stringify(exportLibrary(bare));
    const recs = parseImport(text, 'json-v1');
    expect(recs[0]?.tconst ?? null).toBeNull();
    expect(recs[0]?.imdbIdHint).toBe('tt9000003');

    // Into a db with a catalog, the hint is checked like any other.
    applyImport(db, recs, { mode: 'merge' });
    expect(one(db, 'Ledger Of Quiet Things')).toMatchObject({ tconst: 'tt9000003', matchStatus: 'matched' });

    // Into another bare db it stays an unmatched item carrying the hint.
    wipe(bare);
    applyImport(bare, recs, { mode: 'merge' });
    expect(one(bare, 'Ledger Of Quiet Things')).toMatchObject({ tconst: 'tt9000003', matchStatus: 'unmatched' });
  });
});

describe('merge never folds a different movie into an existing item', () => {
  const csv = (body: string) => parseImport(`title,year,status,rating,imdb_id\n${body}\n`, 'csv');
  const byYear = (xs: LibraryItem[]) => [...xs].sort((a, b) => (a.sourceYear ?? 0) - (b.sourceYear ?? 0));

  it('a stale hint the record itself refutes never splits its own item on a later import', () => {
    // The hint names the 1978 film, the year names 2009: matching links the 2009 film.
    expect(applyImport(db, csv('The Glass Harbor,2009,priority,5,tt9000001'), { mode: 'merge' })).toMatchObject({ added: 1 });
    expect(one(db, 'The Glass Harbor')).toMatchObject({ tconst: 'tt9000002', matchStatus: 'matched' });
    // The same row with a new status and rating updates that item instead of adding a twin.
    expect(applyImport(db, csv('The Glass Harbor,2009,watched,7,tt9000001'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
    expect(one(db, 'The Glass Harbor')).toMatchObject({ tconst: 'tt9000002', status: 'watched', myRating: 7 });
    // A hint matching accepts still rules out an item linked to the other film.
    expect(applyImport(db, csv('The Glass Harbor,,someday,2,tt9000001'), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
    expect(byTitle(db, 'The Glass Harbor').map((i) => [i.tconst, i.status])).toEqual([
      ['tt9000002', 'watched'],
      ['tt9000001', 'someday'],
    ]);
  });

  it('successive CSV imports of a remake pair with no runtimes stay two items', () => {
    expect(applyImport(db, csv('The Glass Harbor,1978,watched,8,'), { mode: 'merge' })).toMatchObject({ added: 1 });
    expect(applyImport(db, csv('The Glass Harbor,2009,priority,5,'), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
    expect(byYear(byTitle(db, 'The Glass Harbor'))).toMatchObject([
      { sourceYear: 1978, status: 'watched', myRating: 8, tconst: 'tt9000001' },
      { sourceYear: 2009, status: 'priority', myRating: 5, tconst: 'tt9000002' },
    ]);
    // Each file again is still a no-op.
    expect(applyImport(db, csv('The Glass Harbor,1978,watched,8,'), { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 1 });
    expect(applyImport(db, csv('The Glass Harbor,2009,priority,5,'), { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 1 });
    expect(byTitle(db, 'The Glass Harbor')).toHaveLength(2);
  });

  it('a conflicting year keeps them apart without a catalog too', () => {
    applyImport(bare, csv('The Glass Harbor,1978,watched,8,'), { mode: 'merge' });
    expect(applyImport(bare, csv('The Glass Harbor,2009,priority,5,'), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
    expect(byYear(byTitle(bare, 'The Glass Harbor'))).toMatchObject([
      { sourceYear: 1978, status: 'watched', myRating: 8 },
      { sourceYear: 2009, status: 'priority', myRating: 5 },
    ]);
  });

  it('different IMDb ids keep same-titled records apart even with no years', () => {
    applyImport(db, csv('The Glass Harbor,,watched,8,tt9000001'), { mode: 'merge' });
    expect(applyImport(db, csv('The Glass Harbor,,priority,5,tt9000002'), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
    const harbors = byTitle(db, 'The Glass Harbor');
    expect(harbors.map((h) => [h.tconst, h.status, h.myRating]).sort()).toEqual([
      ['tt9000001', 'watched', 8],
      ['tt9000002', 'priority', 5],
    ]);
  });

  it('a year within one still updates the same item', () => {
    applyImport(bare, csv('The Glass Harbor,1978,watched,8,'), { mode: 'merge' });
    expect(applyImport(bare, csv('The Glass Harbor,1979,priority,,'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
    expect(one(bare, 'The Glass Harbor')).toMatchObject({ sourceYear: 1979, status: 'priority', myRating: 8 });
  });

  it('a record without a year or id still updates the one existing item', () => {
    applyImport(db, csv('The Glass Harbor,1978,watched,8,'), { mode: 'merge' });
    expect(applyImport(db, csv('The Glass Harbor,,,9,'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
    expect(one(db, 'The Glass Harbor')).toMatchObject({ sourceYear: 1978, status: 'watched', myRating: 9, tconst: 'tt9000001' });
  });
});

describe('JSON v1 fields left out', () => {
  const v1 = (items: Record<string, unknown>[]) =>
    JSON.stringify({ format: 'screentrackr-library', version: 1, items });

  it('parses an omitted status and owned flag as absent, not as defaults', () => {
    const [rec] = parseImport(v1([{ sourceTitle: 'Quiet Ledger', notes: 'n' }]), 'json-v1');
    expect(rec?.status).toBeUndefined();
    expect(rec?.owned).toBeUndefined();
  });

  it('merging a record with only a title and notes keeps watched status, era and owned', () => {
    applyImport(db, parseImport(v1([{ sourceTitle: 'Quiet Ledger', status: 'watched', watchedEra: '2010s', owned: false }]), 'json-v1'), {
      mode: 'merge',
    });
    const res = applyImport(db, parseImport(v1([{ sourceTitle: 'Quiet Ledger', notes: 'rewatch' }]), 'json-v1'), { mode: 'merge' });
    expect(res).toMatchObject({ added: 0, updated: 1 });
    expect(one(db, 'Quiet Ledger')).toMatchObject({ status: 'watched', watchedEra: '2010s', owned: false, notes: 'rewatch' });
  });

  it('treats a null status, owned flag or other optional field like an omitted one', () => {
    applyImport(db, parseImport(v1([{ sourceTitle: 'Quiet Ledger', status: 'watched', watchedEra: '2010s', owned: false }]), 'json-v1'), {
      mode: 'merge',
    });
    const nulls = { status: null, owned: null, matchStatus: null, source: null, addedAt: null, updatedAt: null };
    const res = applyImport(db, parseImport(v1([{ sourceTitle: 'Quiet Ledger', notes: 'again', ...nulls }]), 'json-v1'), {
      mode: 'merge',
    });
    expect(res).toMatchObject({ added: 0, updated: 1 });
    expect(one(db, 'Quiet Ledger')).toMatchObject({ status: 'watched', watchedEra: '2010s', owned: false, notes: 'again' });
    applyImport(db, parseImport(v1([{ sourceTitle: 'Dune Static', ...nulls }]), 'json-v1'), { mode: 'merge' });
    expect(one(db, 'Dune Static')).toMatchObject({ status: 'queue', owned: true, source: 'json' });
  });

  it('a new item with no status or owned flag is still a queued, owned item', () => {
    applyImport(db, parseImport(v1([{ sourceTitle: 'Quiet Ledger' }]), 'json-v1'), { mode: 'merge' });
    expect(one(db, 'Quiet Ledger')).toMatchObject({ status: 'queue', watchedEra: null, owned: true });
  });
});

describe('one merge resolver: update only a uniquely identified item', () => {
  const csv = (body: string) => parseImport(`title,year,status,rating,imdb_id\n${body}\n`, 'csv');
  const byYear = (xs: LibraryItem[]) => [...xs].sort((a, b) => (a.sourceYear ?? 0) - (b.sourceYear ?? 0));
  const both = (fn: (d: Db) => void) => {
    fn(bare);
    fn(db);
  };

  it('a shared IMDb id hint never folds a remake into the original (before and after setup)', () => {
    both((d) => {
      expect(applyImport(d, csv('The Glass Harbor,1978,watched,8,tt9000001'), { mode: 'merge' })).toMatchObject({ added: 1 });
      expect(applyImport(d, csv('The Glass Harbor,2009,priority,5,tt9000001'), { mode: 'merge' })).toMatchObject({
        added: 1,
        updated: 0,
      });
      expect(byYear(byTitle(d, 'The Glass Harbor'))).toMatchObject([
        { sourceYear: 1978, status: 'watched', myRating: 8 },
        { sourceYear: 2009, status: 'priority', myRating: 5 },
      ]);
      // Each file again changes nothing.
      expect(applyImport(d, csv('The Glass Harbor,1978,watched,8,tt9000001'), { mode: 'merge' })).toMatchObject({ unchanged: 1 });
      expect(applyImport(d, csv('The Glass Harbor,2009,priority,5,tt9000001'), { mode: 'merge' })).toMatchObject({ unchanged: 1 });
      expect(byTitle(d, 'The Glass Harbor')).toHaveLength(2);
    });
  });

  it('a year in the title beats the year field when the same hint is shared', () => {
    applyImport(bare, csv('The Glass Harbor (1978),2009,watched,8,tt9000001'), { mode: 'merge' });
    expect(applyImport(bare, csv('The Glass Harbor (2009),2009,priority,5,tt9000001'), { mode: 'merge' })).toMatchObject({
      added: 1,
      updated: 0,
    });
    expect(one(bare, 'The Glass Harbor (1978)')).toMatchObject({ status: 'watched', myRating: 8 });
  });

  it('two Apple editions sharing one IMDb id stay two items', () => {
    const edition = (title: string, apple: string, rating: number): ImportRecord => ({
      sourceTitle: title,
      applePersistentId: apple,
      imdbIdHint: 'tt9000004',
      myRating: rating,
      source: 'apple-tv',
    });
    both((d) => {
      applyImport(d, [edition('Seven Lanterns', 'APPLE-EDITION-A', 8)], { mode: 'merge' });
      expect(applyImport(d, [edition('Seven Lanterns', 'APPLE-EDITION-B', 5)], { mode: 'merge' })).toMatchObject({
        added: 1,
        updated: 0,
      });
      const ed = items(d).filter((i) => i.sourceTitle === 'Seven Lanterns');
      expect(ed.map((i) => [i.applePersistentId, i.myRating])).toEqual([
        ['APPLE-EDITION-A', 8],
        ['APPLE-EDITION-B', 5],
      ]);
      // Each edition again updates only itself.
      expect(applyImport(d, [edition('Seven Lanterns', 'APPLE-EDITION-A', 9)], { mode: 'merge' })).toMatchObject({ updated: 1 });
      expect(items(d).map((i) => i.myRating)).toEqual([9, 5]);
      wipe(d);
    });
  });

  it('two linked editions in a JSON v1 file stay two items, and a partial import updates the named one', () => {
    const v1 = (xs: Record<string, unknown>[]) => JSON.stringify({ format: 'screentrackr-library', version: 1, items: xs });
    const file = v1([
      { sourceTitle: 'Seven Lanterns', tconst: 'tt9000004', matchStatus: 'matched', myRating: 7 },
      { sourceTitle: "Seven Lanterns (Director's Cut)", tconst: 'tt9000004', matchStatus: 'matched', myRating: 9 },
    ]);
    both((d) => {
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 2, reviews: [] });
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
      const partial = v1([{ sourceTitle: "Seven Lanterns (Director's Cut)", tconst: 'tt9000004', matchStatus: 'matched', myRating: 10 }]);
      expect(applyImport(d, parseImport(partial), { mode: 'merge' })).toMatchObject({ updated: 1 });
      expect(items(d).map((i) => i.myRating)).toEqual([7, 10]);
      wipe(d);
    });
  });

  it('a title-only record that fits several items changes nothing and lists the candidates for review', () => {
    both((d) => {
      applyImport(d, csv('Copperline Avenue,1980,watched,8,\nCopperline Avenue,2020,priority,,'), { mode: 'merge' });
      const before = items(d);
      const [old, remake] = byYear(byTitle(d, 'Copperline Avenue'));
      const res = applyImport(d, csv('Copperline Avenue,,,3,'), { mode: 'merge' });
      expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 0, needsReview: 1 });
      expect(res.reviews).toEqual([
        expect.objectContaining({ record: 1, sourceTitle: 'Copperline Avenue', candidateIds: [old?.id, remake?.id] }),
      ]);
      expect(items(d)).toEqual(before);
      // A year picks the one item.
      expect(applyImport(d, csv('Copperline Avenue,2020,,3,'), { mode: 'merge' })).toMatchObject({ updated: 1, reviews: [] });
      expect(byYear(byTitle(d, 'Copperline Avenue')).map((i) => i.myRating)).toEqual([8, 3]);
      wipe(d);
    });
  });

  it('within one file, two records never both write to the same item', () => {
    both((d) => {
      // Two different rows the file itself adds are two entries, so two items.
      const res = applyImport(d, csv('Copperline Avenue,1980,watched,3,\nCopperline Avenue,1980,watched,5,'), { mode: 'merge' });
      expect(res).toMatchObject({ added: 2, updated: 0, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue').map((i) => i.myRating)).toEqual([3, 5]);
      wipe(d);
      applyImport(d, csv('Copperline Avenue,1980,watched,3,'), { mode: 'merge' });

      // Against one existing item: the first record claims and updates it, the second becomes its own item.
      const again = applyImport(d, csv('Copperline Avenue,1980,watched,6,\nCopperline Avenue,1980,watched,7,'), { mode: 'merge' });
      expect(again).toMatchObject({ added: 1, updated: 1, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue').map((i) => i.myRating)).toEqual([6, 7]);
      wipe(d);
    });
  });

  it('restoring a JSON v1 backup with replace keeps two editions of one title', () => {
    // `add` of a tconst already in the library adds another edition: same title, year, runtime and link.
    const edition = (rating: number) => ({
      sourceTitle: 'Paper Engine',
      sourceYear: 2010,
      sourceRuntimeMin: 120,
      tconst: 'tt9000009',
      matchStatus: 'manual',
      source: 'manual',
      myRating: rating,
    });
    const file = JSON.stringify({ format: 'screentrackr-library', version: 1, items: [edition(9), edition(4)] });
    both((d) => {
      applyImport(d, csv('Paper Engine,2010,queue,2,'), { mode: 'merge' });
      expect(applyImport(d, parseImport(file), { mode: 'replace' })).toMatchObject({ added: 2, reviews: [] });
      expect(byTitle(d, 'Paper Engine').map((i) => i.myRating)).toEqual([9, 4]);
      // A merge into an empty library keeps both too, and the file again changes nothing.
      wipe(d);
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 2, reviews: [] });
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
      wipe(d);
    });
  });

  it('two different IMDb id hints never fold into one item, even without years', () => {
    both((d) => {
      applyImport(d, csv('The Glass Harbor,,watched,8,tt9000001'), { mode: 'merge' });
      expect(applyImport(d, csv('The Glass Harbor,,priority,5,tt9000002'), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
      expect(byTitle(d, 'The Glass Harbor').map((i) => [i.tconst, i.status, i.myRating])).toEqual([
        ['tt9000001', 'watched', 8],
        ['tt9000002', 'priority', 5],
      ]);
      wipe(d);
    });
  });

  it('a record with no IMDb id keeps the hint an item saved before setup', () => {
    applyImport(bare, csv('Paper Engine,2010,watched,8,tt9000009'), { mode: 'merge' });
    expect(applyImport(bare, csv('Paper Engine,2010,,,'), { mode: 'merge' })).toMatchObject({ updated: 0, unchanged: 1 });
    expect(one(bare, 'Paper Engine')).toMatchObject({ tconst: 'tt9000009', matchStatus: 'unmatched' });
  });

  it('re-importing each importer fixture reports everything unchanged', () => {
    const files = ['apple-paste.txt', 'legacy.json', 'neon-rows.json', 'library.csv'];
    both((d) => {
      for (const f of files) {
        const recs = parseImport(fixture(f));
        applyImport(d, recs, { mode: 'merge' });
        const before = items(d);
        const again = applyImport(d, parseImport(fixture(f)), { mode: 'merge' });
        expect(again, f).toMatchObject({ added: 0, updated: 0, unchanged: recs.length, reviews: [] });
        expect(items(d), f).toEqual(before);
      }
      // All of them in sequence, then again, and the JSON v1 export of the result.
      for (const f of files) {
        const recs = parseImport(fixture(f));
        expect(applyImport(d, recs, { mode: 'merge' }), f).toMatchObject({ added: 0, updated: 0, reviews: [] });
      }
      const exported = parseImport(JSON.stringify(exportLibrary(d)));
      expect(applyImport(d, exported, { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: exported.length, reviews: [] });
      wipe(d);
    });
  });
});

describe('runtime tolerance in merge', () => {
  it('treats runtimes within 3 minutes as the same cut, and further apart as another item', () => {
    const d = openDb(join(tmp, `runtime-tol`));
    const count = () => (d.sql.prepare('SELECT count(*) AS n FROM library_items').get() as { n: number }).n;
    applyImport(d, [{ sourceTitle: 'Slow Tide Harbor', sourceRuntimeMin: 120, source: 'paste' }], { mode: 'merge' });
    const second = applyImport(d, [{ sourceTitle: 'Slow Tide Harbor', sourceRuntimeMin: 121, status: 'watched', source: 'csv' }], { mode: 'merge' });
    expect(second.updated).toBe(1);
    expect(count()).toBe(1);
    const third = applyImport(d, [{ sourceTitle: 'Slow Tide Harbor', sourceRuntimeMin: 150, source: 'csv' }], { mode: 'merge' });
    expect(third.added).toBe(1);
    expect(count()).toBe(2);
    d.close();
  });
});

describe('one import claims each item at most once', () => {
  const v1 = (xs: Record<string, unknown>[]) => JSON.stringify({ format: 'screentrackr-library', version: 1, items: xs });
  const csv = (body: string) => parseImport(`title,year,status,rating,imdb_id\n${body}\n`, 'csv');
  const both = (fn: (d: Db) => void) => {
    for (const d of [bare, db]) {
      fn(d);
      wipe(d);
    }
  };
  const valued = { sourceTitle: 'Paper Engine', sourceYear: 2010, myRating: 8, notes: 'the good copy' };
  const blank = { sourceTitle: 'Paper Engine', sourceYear: 2010, myRating: null, notes: null };
  const editions = (d: Db) => byTitle(d, 'Paper Engine').map((i) => [i.myRating, i.notes]);

  for (const [name, order] of [
    ['valued then null', [valued, blank]],
    ['null then valued', [blank, valued]],
  ] as const) {
    it(`restoring an export keeps both editions (${name}) and a repeat is unchanged`, () => {
      both((d) => {
        applyImport(d, parseImport(v1([...order])), { mode: 'merge' });
        expect(byTitle(d, 'Paper Engine')).toHaveLength(2);
        const file = JSON.stringify(exportLibrary(d));
        const before = items(d);
        wipe(d);
        expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 2, unchanged: 0, reviews: [] });
        expect(comparable(items(d))).toEqual(comparable(before));
        for (let n = 0; n < 3; n++) {
          expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2, reviews: [] });
        }
        expect(comparable(items(d))).toEqual(comparable(before));
        // --replace restores the same two editions.
        expect(applyImport(d, parseImport(file), { mode: 'replace' })).toMatchObject({ added: 2, unchanged: 0, reviews: [] });
        expect(comparable(items(d))).toEqual(comparable(before));
        expect(editions(d)).toEqual(order.map((e) => [e.myRating, e.notes]));
      });
    });
  }

  it('the reviewer reproduction: export then import into an empty library adds both editions', () => {
    both((d) => {
      applyImport(d, parseImport(v1([valued, blank])), { mode: 'merge' });
      const file = JSON.stringify(exportLibrary(d));
      wipe(d);
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 2, unchanged: 0 });
      expect(editions(d)).toEqual([
        [8, 'the good copy'],
        [null, null],
      ]);
    });
  });

  it('identical editions stay two items through export, import, replace and repeats', () => {
    both((d) => {
      expect(applyImport(d, parseImport(v1([valued, valued])), { mode: 'merge' })).toMatchObject({ added: 2, unchanged: 0 });
      const file = JSON.stringify(exportLibrary(d));
      const before = items(d);
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
      expect(applyImport(d, parseImport(file), { mode: 'replace' })).toMatchObject({ added: 2, unchanged: 0 });
      expect(comparable(items(d))).toEqual(comparable(before));
      wipe(d);
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 2, unchanged: 0 });
      expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 0, unchanged: 2 });
      expect(comparable(items(d))).toEqual(comparable(before));
    });
  });

  it('two identical CSV rows are two items, and the file again is unchanged', () => {
    both((d) => {
      const rows = 'Copperline Avenue,1980,watched,3,\nCopperline Avenue,1980,watched,3,';
      expect(applyImport(d, csv(rows), { mode: 'merge' })).toMatchObject({ added: 2, unchanged: 0, reviews: [] });
      expect(applyImport(d, csv(rows), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue')).toHaveLength(2);
    });
  });

  it('an Apple paste that lists an edition twice adds two items, and the paste again changes nothing', () => {
    const paste = fixture('apple-paste.txt');
    const firstRow = paste.split('\n')[0] as string;
    const doubled = `${firstRow}\n${paste}`;
    both((d) => {
      const recs = parseImport(doubled, 'apple-paste');
      expect(applyImport(d, recs, { mode: 'merge' })).toMatchObject({ added: recs.length, reviews: [] });
      expect(byTitle(d, 'Quiet Ledger')).toHaveLength(2);
      const before = items(d);
      for (let n = 0; n < 2; n++) {
        expect(applyImport(d, parseImport(doubled, 'apple-paste'), { mode: 'merge' })).toMatchObject({
          added: 0,
          updated: 0,
          unchanged: recs.length,
          reviews: [],
        });
      }
      expect(items(d)).toEqual(before);
    });
  });

  it('two identical editions still take an update from a changed file, one row each', () => {
    const genre = (body: string) => parseImport(`title,year,status,genre\n${body}\n`, 'csv');
    both((d) => {
      const twice = (g: string) => genre(`Copperline Avenue,1980,watched,${g}\nCopperline Avenue,1980,watched,${g}`);
      expect(applyImport(d, twice('Drama'), { mode: 'merge' })).toMatchObject({ added: 2, reviews: [] });
      // Indistinguishable items are not a choice between movies, so nothing goes to review.
      expect(applyImport(d, twice('Crime'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 2, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue').map((i) => i.sourceGenre)).toEqual(['Crime', 'Crime']);
      expect(applyImport(d, twice('Crime'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2, reviews: [] });
      // One row updates one of them.
      expect(applyImport(d, genre('Copperline Avenue,1980,watched,Western'), { mode: 'merge' })).toMatchObject({ updated: 1, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue').map((i) => i.sourceGenre).sort()).toEqual(['Crime', 'Western']);
      // Items that differ (here by genre) are still a choice the owner makes.
      expect(applyImport(d, genre('Copperline Avenue,1980,watched,Horror'), { mode: 'merge' })).toMatchObject({ updated: 0, reviews: [{ record: 1 }] });
    });
  });

  it('ambiguity is judged among unclaimed items only', () => {
    both((d) => {
      applyImport(d, csv('Copperline Avenue,1980,watched,8,\nCopperline Avenue,2020,priority,,'), { mode: 'merge' });
      // The first record claims the 2020 item, so the title-only record fits just the 1980 one.
      const res = applyImport(d, csv('Copperline Avenue,2020,,3,\nCopperline Avenue,,,4,'), { mode: 'merge' });
      expect(res).toMatchObject({ added: 0, updated: 2, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue').map((i) => [i.sourceYear, i.myRating])).toEqual([
        [1980, 4],
        [2020, 3],
      ]);
    });
  });

  it('a later record never takes an item an earlier record claimed: it becomes a new item', () => {
    both((d) => {
      applyImport(d, csv('Copperline Avenue,1980,watched,3,'), { mode: 'merge' });
      const res = applyImport(d, csv('Copperline Avenue,1980,watched,6,\nCopperline Avenue,1980,watched,7,'), { mode: 'merge' });
      expect(res).toMatchObject({ added: 1, updated: 1, reviews: [] });
      expect(byTitle(d, 'Copperline Avenue').map((i) => i.myRating)).toEqual([6, 7]);
    });
  });
});

describe('a title year beneath an edition suffix keeps remakes apart', () => {
  const csv = (body: string) => parseImport(`title,year,status,rating,imdb_id\n${body}\n`, 'csv');
  const both = (fn: (d: Db) => void) => {
    for (const d of [bare, db]) {
      fn(d);
      wipe(d);
    }
  };

  for (const suffix of ['(4K)', '(Special Edition)']) {
    it(`"The Glass Harbor (1978) ${suffix}" is not updated by "The Glass Harbor (2009)"`, () => {
      both((d) => {
        expect(applyImport(d, csv(`The Glass Harbor (1978) ${suffix},,watched,8,`), { mode: 'merge' })).toMatchObject({ added: 1 });
        expect(applyImport(d, csv('The Glass Harbor (2009),,priority,5,'), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
        expect(one(d, `The Glass Harbor (1978) ${suffix}`)).toMatchObject({ status: 'watched', myRating: 8 });
        expect(one(d, 'The Glass Harbor (2009)')).toMatchObject({ status: 'priority', myRating: 5 });
        // And the other way round.
        wipe(d);
        applyImport(d, csv('The Glass Harbor (2009),,priority,5,'), { mode: 'merge' });
        expect(applyImport(d, csv(`The Glass Harbor (1978) ${suffix},,watched,8,`), { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
      });
    });
  }

  it('a year beneath a suffix still merges with the same year', () => {
    both((d) => {
      applyImport(d, csv('The Glass Harbor (1978) (4K),,watched,8,'), { mode: 'merge' });
      expect(applyImport(d, csv('The Glass Harbor,1978,,9,'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
      expect(one(d, 'The Glass Harbor (1978) (4K)').myRating).toBe(9);
    });
  });

  it('a bare "(4K)" title with no year merges as before', () => {
    both((d) => {
      applyImport(d, csv('The Glass Harbor (4K),,watched,8,'), { mode: 'merge' });
      expect(applyImport(d, csv('The Glass Harbor,2009,,9,'), { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
      expect(one(d, 'The Glass Harbor (4K)')).toMatchObject({ myRating: 9, sourceYear: 2009 });
    });
  });
});

describe('a no-op record that fits several different items claims none of them', () => {
  const lib = (body: string) => parseImport(`title,year,status,rating\n${body}\n`, 'csv');
  const sparse = (body: string) => parseImport(`title,status,rating\n${body}\n`, 'csv');
  const both = (fn: (d: Db) => void) => {
    for (const d of [bare, db]) {
      fn(d);
      wipe(d);
    }
  };
  const old = 'The Glass Harbor,1978,watched,8';
  const remake = 'The Glass Harbor,2009,priority,5';

  for (const [name, rows] of [
    ['1978 added first', `${old}\n${remake}`],
    ['2009 added first', `${remake}\n${old}`],
  ] as const) {
    it(`a blank row then a changed row goes to review, never to the remaining item (${name})`, () => {
      both((d) => {
        applyImport(d, lib(rows), { mode: 'merge' });
        const before = items(d);
        const ids = byTitle(d, 'The Glass Harbor')
          .map((i) => i.id)
          .sort((a, b) => a - b);
        const res = applyImport(d, sparse('The Glass Harbor,,\nThe Glass Harbor,watched,2'), { mode: 'merge' });
        // Before setup both items are unmatched, so the unchanged record also counts as needing review.
        expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 1, needsReview: d === bare ? 2 : 1 });
        expect(res.reviews).toEqual([{ record: 2, sourceTitle: 'The Glass Harbor', candidateIds: ids }]);
        expect(items(d)).toEqual(before);
      });
    });

    it(`a file reproducing the library is all unchanged (${name})`, () => {
      both((d) => {
        applyImport(d, lib(rows), { mode: 'merge' });
        const before = items(d);
        expect(applyImport(d, lib(rows), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2, reviews: [] });
        expect(applyImport(d, sparse('The Glass Harbor,watched,8\nThe Glass Harbor,priority,5'), { mode: 'merge' })).toMatchObject({
          added: 0,
          updated: 0,
          unchanged: 2,
          reviews: [],
        });
        expect(applyImport(d, sparse('The Glass Harbor,,\nThe Glass Harbor,,'), { mode: 'merge' })).toMatchObject({
          added: 0,
          updated: 0,
          unchanged: 2,
          reviews: [],
        });
        const file = JSON.stringify(exportLibrary(d));
        expect(applyImport(d, parseImport(file), { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 2, reviews: [] });
        expect(items(d)).toEqual(before);
      });
    });
  }
});

describe('a repeat that also fits a different item claims nothing', () => {
  const sparse = (body: string) => parseImport(`title,status,rating\n${body}\n`, 'csv');
  const old = 'The Glass Harbor,1978,watched,8';
  const remake = 'The Glass Harbor,2009,priority,5';

  for (const [name, rows] of [
    ['1978 added first', `${old}\n${remake}`],
    ['2009 added first', `${remake}\n${old}`],
  ] as const) {
    it(`a status-only repeat of one item, then a changed row, goes to review (${name})`, () => {
      for (const d of [bare, db]) {
        applyImport(d, parseImport(`title,year,status,rating\n${rows}\n`, 'csv'), { mode: 'merge' });
        const before = items(d);
        const ids = byTitle(d, 'The Glass Harbor')
          .map((i) => i.id)
          .sort((a, b) => a - b);
        // "watched" leaves the 1978 film as it is but would also fit the 2009 remake.
        for (const file of ['The Glass Harbor,watched,\nThe Glass Harbor,watched,2', 'The Glass Harbor,priority,\nThe Glass Harbor,watched,2']) {
          const res = applyImport(d, sparse(file), { mode: 'merge' });
          expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
          expect(res.reviews).toEqual([{ record: 2, sourceTitle: 'The Glass Harbor', candidateIds: ids }]);
          expect(items(d)).toEqual(before);
        }
        wipe(d);
      }
    });
  }

  it('an item whose only difference is its re-derived match still counts as repeated, so rows do not swap', () => {
    const ins = db.sql.prepare(
      "INSERT INTO library_items (tconst, source_title, source_year, status, my_rating, match_status, match_score, source) VALUES (?, 'The Glass Harbor', 1978, ?, ?, ?, ?, 'csv')",
    );
    const own = () => items(db).map((i) => [i.id, i.status, i.myRating]);
    for (const order of [0, 1]) {
      wipe(db);
      // An unresolved edition and a matched one: a row with a year now matches the
      // unresolved one's data to the same movie, which must not steer it to the other.
      const rows: [string | null, string, number, string, number | null][] = [
        [null, 'someday', 10, 'ambiguous', 54.3],
        ['tt9000001', 'watched', 3, 'matched', 73.7],
      ];
      for (const row of order ? rows.reverse() : rows) ins.run(...row);
      const before = own();
      for (const file of ['The Glass Harbor,1978,someday,10', 'The Glass Harbor,1978,someday,10\nThe Glass Harbor,1978,watched,3']) {
        const res = applyImport(db, parseImport(`title,year,status,rating\n${file}\n`, 'csv'), { mode: 'merge' });
        expect(res.added).toBe(0);
        expect(own()).toEqual(before);
      }
    }
  });
});

describe('editions that differ only in how they were matched', () => {
  it('re-importing an export gives each row its own edition, in any order', () => {
    applyImport(db, parseImport('title,year,status,rating\nThe Glass Harbor,1978,watched,8\nThe Glass Harbor,1978,watched,8\n', 'csv'), {
      mode: 'merge',
    });
    const [first, second] = byTitle(db, 'The Glass Harbor') as [LibraryItem, LibraryItem];
    for (const linked of [first, second]) {
      for (const e of [first, second]) {
        db.sql.prepare("UPDATE library_items SET tconst = 'tt9000001', match_status = 'matched', match_score = 73.7 WHERE id = ?").run(e.id);
      }
      linkItem(db, linked.id, 'tt9000001');
      const before = items(db);
      const file = exportLibrary(db);
      for (const rows of [file.items, [...file.items].reverse()]) {
        const res = applyImport(db, parseImport(JSON.stringify({ ...file, items: rows })), { mode: 'merge' });
        expect(res).toMatchObject({ added: 0, updated: 0, unchanged: 2, reviews: [] });
        expect(items(db)).toEqual(before);
      }
    }
  });
});

describe('a record whose own automatic match disagrees with stored links', () => {
  it('never rewrites a hand-linked item just because the guess rules out the other one', () => {
    applyImport(db, parseImport('title,runtime,status,rating\nThe Glass Harbor,113,queue,6\nThe Glass Harbor,113,someday,2\n', 'csv'), { mode: 'merge' });
    const [a, b] = byTitle(db, 'The Glass Harbor') as [LibraryItem, LibraryItem];
    db.sql.prepare("UPDATE library_items SET tconst = 'tt9000002', match_status = 'matched', match_score = 80 WHERE id IN (?, ?)").run(a.id, b.id);
    linkItem(db, a.id, 'tt9000002');
    const before = items(db).find((i) => i.id === a.id);
    applyImport(db, parseImport('title,runtime,status,rating\nThe Glass Harbor,113,someday,2\n', 'csv'), { mode: 'merge' });
    const after = items(db).find((i) => i.id === a.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.myRating).toBe(before?.myRating);
  });
});

describe('a remake imported after the original', () => {
  for (const order of [['Orrin Vale', 'Teodor Brask'], ['Teodor Brask', 'Orrin Vale']] as const) {
    it(`never rewrites the other film (${order.join(' then ')})`, () => {
      applyImport(db, parseImport(`title,director,status,rating\nThe Glass Harbor,${order[0]},watched,8\n`, 'csv'), { mode: 'merge' });
      const [first] = byTitle(db, 'The Glass Harbor') as [LibraryItem];
      expect(first.matchStatus).toBe('matched');
      applyImport(db, parseImport(`title,director,status,rating\nThe Glass Harbor,${order[1]},priority,5\n`, 'csv'), { mode: 'merge' });
      const after = items(db).find((i) => i.id === first.id);
      expect(after).toMatchObject({ tconst: first.tconst, sourceDirector: order[0], status: 'watched', myRating: 8 });
      expect(byTitle(db, 'The Glass Harbor')).toHaveLength(2);
    });
  }
});

describe('a remake imported before setup', () => {
  for (const order of [['Orrin Vale', 'Teodor Brask'], ['Teodor Brask', 'Orrin Vale']] as const) {
    it(`different directors keep two items (${order.join(' then ')})`, () => {
      applyImport(bare, parseImport(`title,director,status,rating\nThe Glass Harbor,${order[0]},watched,8\n`, 'csv'), { mode: 'merge' });
      const res = applyImport(bare, parseImport(`title,director,status,rating\nThe Glass Harbor,${order[1]},priority,5\n`, 'csv'), { mode: 'merge' });
      expect(res).toMatchObject({ added: 1, updated: 0 });
      const all = byTitle(bare, 'The Glass Harbor');
      expect(all.map((i) => i.sourceDirector).sort()).toEqual([...order].sort());
    });
  }
  it('Unknown, blank and co-director credits are not conflicts', () => {
    applyImport(bare, parseImport('title,director,status\nThe Glass Harbor,Orrin Vale & Mira Vale,watched\n', 'csv'), { mode: 'merge' });
    expect(applyImport(bare, parseImport('title,director,rating\nThe Glass Harbor,Unknown,7\n', 'csv'), { mode: 'merge' }).updated).toBe(1);
    expect(applyImport(bare, parseImport('title,director,rating\nThe Glass Harbor,Mira Vale,6\n', 'csv'), { mode: 'merge' }).updated).toBe(1);
    expect(byTitle(bare, 'The Glass Harbor')).toHaveLength(1);
  });
});

describe('exact title formatting never settles which of two movies a record is', () => {
  const stored = {
    original: 'title,year,status\nThe Glass Harbor,1978,queue\n',
    remake: 'title,status\nThe Glass Harbor (2009),queue\n',
  };
  for (const which of ['bare', 'db'] as const) {
    for (const order of [['original', 'remake'], ['remake', 'original']] as const) {
      const label = `${order.join(' then ')}, ${which === 'bare' ? 'before' : 'after'} setup`;
      const d = () => (which === 'bare' ? bare : db);
      const seed = () => {
        for (const k of order) applyImport(d(), parseImport(stored[k], 'csv'), { mode: 'merge' });
        return items(d());
      };

      it(`a yearless "The Glass Harbor" goes to review, not to the 1978 film (${label})`, () => {
        const before = seed();
        const res = applyImport(d(), parseImport('title,status,rating\nThe Glass Harbor,watched,8\n', 'csv'), { mode: 'merge' });
        expect(res).toMatchObject({ added: 0, updated: 0 });
        expect(res.reviews).toHaveLength(1);
        expect(res.reviews[0]?.candidateIds.sort()).toEqual(before.map((i) => i.id).sort());
        expect(items(d())).toEqual(before);
      });

      it(`a yearless repeat of the 1978 film claims nothing, so a later row still goes to review (${label})`, () => {
        seed();
        const orig = one(d(), 'The Glass Harbor');
        updateItem(d(), orig.id, { status: 'watched', myRating: 8 });
        const before = items(d());
        const res = applyImport(d(), parseImport('title,status,rating\nThe Glass Harbor,watched,8\nThe Glass Harbor,priority,5\n', 'csv'), {
          mode: 'merge',
        });
        expect(res).toMatchObject({ added: 0, updated: 0 });
        expect(res.reviews.map((r) => r.record)).toEqual([2]);
        expect(items(d())).toEqual(before);
      });

      it(`a year still picks its own film (${label})`, () => {
        seed();
        const res = applyImport(d(), parseImport('title,year,status\nThe Glass Harbor,2009,watched\n', 'csv'), { mode: 'merge' });
        expect(res).toMatchObject({ added: 0, updated: 1 });
        expect(one(d(), 'The Glass Harbor (2009)').status).toBe('watched');
        expect(one(d(), 'The Glass Harbor').status).toBe('queue');
      });
    }
  }

  it('editions of one linked movie still narrow by exact title', () => {
    applyImport(db, parseImport('title,year,status\nThe Glass Harbor,1978,queue\nThe Glass Harbor (4K),1978,queue\n', 'csv'), { mode: 'merge' });
    expect(items(db).map((i) => i.tconst)).toEqual(['tt9000001', 'tt9000001']);
    const res = applyImport(db, parseImport('title,status\nThe Glass Harbor (4K),watched\n', 'csv'), { mode: 'merge' });
    expect(res).toMatchObject({ updated: 1, reviews: [] });
    expect(one(db, 'The Glass Harbor (4K)').status).toBe('watched');
    expect(one(db, 'The Glass Harbor').status).toBe('queue');
  });
});

describe('an item linked to the catalog keeps its catalog identity when its source fields are blank', () => {
  const hinted = 'title,status,rating,imdb_id\nThe Glass Harbor,priority,9,tt9000001\n';
  const dated = 'title,year,status,rating\nThe Glass Harbor,2026,watched,3\n';

  it('a record with a conflicting year never rewrites a hint-matched item with no year (the reviewer reproduction)', () => {
    applyImport(db, parseImport(hinted, 'csv'), { mode: 'merge' });
    const original = one(db, 'The Glass Harbor');
    expect(original).toMatchObject({ tconst: 'tt9000001', matchStatus: 'matched', sourceYear: null });
    const res = applyImport(db, parseImport(dated, 'csv'), { mode: 'merge' });
    expect(res).toMatchObject({ added: 1, updated: 0 });
    expect(items(db).find((i) => i.id === original.id)).toEqual(original);
  });

  it('the other order: a hint for the 1978 film never claims the item that says 2026', () => {
    applyImport(db, parseImport(dated, 'csv'), { mode: 'merge' });
    const first = one(db, 'The Glass Harbor');
    expect(first.matchStatus).not.toBe('matched');
    const res = applyImport(db, parseImport(hinted, 'csv'), { mode: 'merge' });
    expect(res).toMatchObject({ added: 1, updated: 0 });
    expect(items(db).find((i) => i.id === first.id)).toEqual(first);
    expect(items(db).find((i) => i.id !== first.id)).toMatchObject({ tconst: 'tt9000001', status: 'priority', myRating: 9 });
  });

  it('a hand link with no source year or director uses the catalog year and directors', () => {
    for (const body of [dated, 'title,director,status,rating\nThe Glass Harbor,Kit McQuarrel,watched,3\n', 'title,runtime,status,rating\nThe Glass Harbor,150,watched,3\n']) {
      wipe(db);
      applyImport(db, parseImport('title,status,rating\nThe Glass Harbor,priority,9\n', 'csv'), { mode: 'merge' });
      const linked = linkItem(db, one(db, 'The Glass Harbor').id, 'tt9000001');
      const res = applyImport(db, parseImport(body, 'csv'), { mode: 'merge' });
      expect(res, body).toMatchObject({ added: 1, updated: 0 });
      expect(items(db).find((i) => i.id === linked.id), body).toEqual(linked);
    }
  });

  it('agreeing catalog evidence still updates the linked item', () => {
    applyImport(db, parseImport(hinted, 'csv'), { mode: 'merge' });
    const original = one(db, 'The Glass Harbor');
    const res = applyImport(db, parseImport('title,year,director,status\nThe Glass Harbor,1979,Orrin Vale,watched\n', 'csv'), { mode: 'merge' });
    expect(res).toMatchObject({ added: 0, updated: 1 });
    expect(items(db).find((i) => i.id === original.id)).toMatchObject({ status: 'watched', tconst: 'tt9000001', sourceYear: 1979 });
  });
});

describe('placeholder values carry no identity', () => {
  for (const placeholder of ['Unknown', '-', '  ']) {
    it(`a "${placeholder}" director never erases a known one`, () => {
      applyImport(bare, parseImport('title,director,status,rating\nThe Glass Harbor,Orrin Vale,watched,8\n', 'csv'), { mode: 'merge' });
      applyImport(bare, parseImport(JSON.stringify({ format: 'screentrackr-library', version: 1, exportedAt: '2026-01-01T00:00:00Z', items: [{ sourceTitle: 'The Glass Harbor', sourceDirector: placeholder }] })), { mode: 'merge' });
      expect(byTitle(bare, 'The Glass Harbor')[0]?.sourceDirector).toBe('Orrin Vale');
      const res = applyImport(bare, parseImport('title,director,status,rating\nThe Glass Harbor,Teodor Brask,priority,5\n', 'csv'), { mode: 'merge' });
      expect(res.added).toBe(1);
      expect(byTitle(bare, 'The Glass Harbor').find((i) => i.sourceDirector === 'Orrin Vale')).toMatchObject({ status: 'watched', myRating: 8 });
    });
  }

  it('blank Apple ids never make two different movies the same item', () => {
    const file = (title: string, year: number, status: string, rating: number) =>
      JSON.stringify({ format: 'screentrackr-library', version: 1, exportedAt: '2026-01-01T00:00:00Z', items: [{ sourceTitle: title, sourceYear: year, status, myRating: rating, applePersistentId: ' ' }] });
    applyImport(bare, parseImport(file('The Glass Harbor', 1978, 'watched', 8)), { mode: 'merge' });
    const res = applyImport(bare, parseImport(file('Quiet Ledger', 1999, 'priority', 5)), { mode: 'merge' });
    expect(res.added).toBe(1);
    expect(byTitle(bare, 'The Glass Harbor')[0]).toMatchObject({ sourceYear: 1978, status: 'watched', myRating: 8, applePersistentId: null });
  });
});

describe('a hint the catalog cannot confirm', () => {
  it('is not evidence once the catalog exists: a re-import with a stored "Unknown" director stays unchanged', () => {
    const csv = 'title,director,runtime,status,imdb_id\nPaper Engine,Unknown,101,queue,tt1234567\n';
    applyImport(db, parseImport(csv, 'csv'), { mode: 'merge' });
    const first = byTitle(db, 'Paper Engine');
    expect(first).toHaveLength(1);
    // Libraries imported by earlier versions stored the placeholder as written.
    db.sql.prepare("UPDATE library_items SET source_director = 'Unknown' WHERE id = ?").run(first[0]!.id);
    const res = applyImport(db, parseImport(csv, 'csv'), { mode: 'merge' });
    expect(res).toMatchObject({ added: 0 });
    expect(byTitle(db, 'Paper Engine')).toHaveLength(1);
  });
});

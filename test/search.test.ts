import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { FilterSchema } from '../src/core/filters.js';
import { addFromCatalog, updateItem } from '../src/core/library.js';
import { CatalogMissingError, compileSearch, searchMovies, type MovieResult } from '../src/core/search.js';
import { libraryStats } from '../src/core/stats.js';
import { addToList, createList } from '../src/core/lists.js';
import { addViewing } from '../src/core/viewings.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

// Synthetic fixture facts (see test/fixtures/make-imdb-fixtures.ts):
// Dana Fincher directs tt9000003, 04, 09, 10, 19, 20.
// Denise Villeneuve directs tt9000006, 07, 08, 18, 24.

let tmp: string;
let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-search-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: FIXTURES });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function insertUnmatched(fields: {
  title: string;
  director?: string | null;
  genre?: string | null;
  runtime?: number | null;
  year?: number | null;
  status?: string;
}): number {
  const r = db.sql
    .prepare(
      "INSERT INTO library_items (source_title, source_director, source_genre, source_runtime_min, source_year, status, match_status, source) VALUES (?, ?, ?, ?, ?, ?, 'unmatched', 'paste')",
    )
    .run(fields.title, fields.director ?? null, fields.genre ?? null, fields.runtime ?? null, fields.year ?? null, fields.status ?? 'queue');
  return Number(r.lastInsertRowid);
}

/** Library: Fincher 03, 04 (two editions), 20; Villeneuve 06, 07, 18; one unmatched item. */
function seedLibrary(): void {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items; DELETE FROM lists;');
  ids = {
    q03: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    s04a: addFromCatalog(db, 'tt9000004', { status: 'queue' }).id,
    s04b: addFromCatalog(db, 'tt9000004', { status: 'watched' }).id,
    r20: addFromCatalog(db, 'tt9000020', { status: 'priority' }).id,
    d06: addFromCatalog(db, 'tt9000006', { status: 'watched' }).id,
    b07: addFromCatalog(db, 'tt9000007', { status: 'queue' }).id,
    c18: addFromCatalog(db, 'tt9000018', { status: 'someday' }).id,
    unmatched: insertUnmatched({ title: 'Basement Tapes', director: 'Fincher', genre: 'Thriller', runtime: 100, year: 2001 }),
  };
}

const tconsts = (rs: MovieResult[]) => rs.map((r) => r.tconst).sort();

beforeEach(() => seedLibrary());

describe('FilterSchema', () => {
  it('measures a list name the way list create does, after NFC (release review, Astra r1)', () => {
    const decomposed = 'e\u0301'.repeat(60); // 120 code units, 60 characters once composed
    expect(FilterSchema.safeParse({ lists: [decomposed] }).success).toBe(true);
    expect(FilterSchema.safeParse({ lists: ['x'.repeat(101)] }).success).toBe(false);
  });

  it('applies defaults', () => {
    const f = FilterSchema.parse({});
    expect(f.scope).toBe('library');
    expect(f.limit).toBe(20);
    expect(f.offset).toBe(0);
    expect(f.sort).toBe('rating');
    expect(f.genreMode).toBe('any');
    expect(f.minVotes).toBe(0);
    expect(FilterSchema.parse({ scope: 'all' }).minVotes).toBe(1000);
    expect(FilterSchema.parse({ scope: 'all', minVotes: 5 }).minVotes).toBe(5);
  });

  it('rejects an invalid sort, a limit over 200, and unknown keys', () => {
    expect(FilterSchema.safeParse({ sort: 'bogus' }).success).toBe(false);
    expect(FilterSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(FilterSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(FilterSchema.safeParse({ director: ['x'] }).success).toBe(false);
  });

  it('only allows notInLibrary with scope all', () => {
    expect(FilterSchema.safeParse({ notInLibrary: true }).success).toBe(false);
    expect(FilterSchema.safeParse({ scope: 'all', notInLibrary: true }).success).toBe(true);
    // A movie you do not have has no watched status, so unwatched is redundant there, not contradictory.
    expect(FilterSchema.safeParse({ scope: 'all', notInLibrary: true, unwatched: true }).success).toBe(true);
    expect(FilterSchema.safeParse({ scope: 'all', notInLibrary: true, status: ['queue'] }).success).toBe(false);
    expect(FilterSchema.safeParse({ scope: 'all', notInLibrary: true, myRatingMin: 7 }).success).toBe(false);
  });

  it('rejects status together with unwatched', () => {
    expect(FilterSchema.safeParse({ status: ['watched'], unwatched: true }).success).toBe(false);
  });
});

describe('searchMovies (library scope)', () => {
  it('ORs directors, partial and case-insensitive', () => {
    const res = searchMovies(db, { directors: ['fincher', 'VILLEN'] });
    expect(tconsts(res.results)).toEqual(
      [null, 'tt9000003', 'tt9000004', 'tt9000006', 'tt9000007', 'tt9000018', 'tt9000020'].sort(),
    );
    expect(res.total).toBe(7);
  });

  it('narrows with genre, rating, runtime and unwatched', () => {
    const f = { directors: ['fincher', 'villeneuve'], genres: ['Thriller'], minRating: 7.5, maxRuntime: 120, unwatched: true };
    expect(tconsts(searchMovies(db, f).results)).toEqual(['tt9000004', 'tt9000018']);
    updateItem(db, ids.c18 as number, { status: 'watched' });
    expect(tconsts(searchMovies(db, f).results)).toEqual(['tt9000004']);
  });

  it('genreMode all requires every genre', () => {
    const all = searchMovies(db, { genres: ['Mystery', 'thriller'], genreMode: 'all' });
    expect(tconsts(all.results)).toEqual(['tt9000004', 'tt9000020']);
    const any = searchMovies(db, { genres: ['Mystery', 'Thriller'] });
    expect(any.total).toBe(7);
  });

  it('collapses two editions of one tconst', () => {
    const res = searchMovies(db, { text: 'seven lanterns' });
    expect(res.results).toHaveLength(1);
    const r = res.results[0] as MovieResult;
    expect(r.tconst).toBe('tt9000004');
    expect(r.library?.editions).toBe(2);
    expect(r.library?.id).toBe(ids.s04a);
    expect(r.directors).toEqual(['Dana Fincher']);
    expect(r.cast).toEqual(['Eli Stroud', 'Fay Lindqvist', 'Ash Marlow']);
    expect(r.genres).toEqual(['Crime', 'Mystery', 'Thriller']);
    expect(r.rating).toBe(8.4);
    expect(r.runtimeMin).toBe(117);
  });

  it('reports the edition that matched an item-level filter', () => {
    const res = searchMovies(db, { text: 'seven lanterns', status: ['watched'] });
    expect(res.results[0]?.library?.id).toBe(ids.s04b);
    expect(res.results[0]?.library?.editions).toBe(2);
  });

  it('includes an unmatched item from its source fields', () => {
    const res = searchMovies(db, { directors: ['fincher'], genres: ['thriller'], maxRuntime: 105 });
    expect(res.results).toHaveLength(1);
    const r = res.results[0] as MovieResult;
    expect(r.tconst).toBeNull();
    expect(r.title).toBe('Basement Tapes');
    expect(r.directors).toEqual(['Fincher']);
    expect(r.genres).toEqual(['Thriller']);
    expect(r.year).toBe(2001);
    expect(r.library).toMatchObject({ id: ids.unmatched, matchStatus: 'unmatched', status: 'queue', editions: 1, owned: true });
  });

  it('filters by status and my rating', () => {
    updateItem(db, ids.r20 as number, { myRating: 9 });
    updateItem(db, ids.d06 as number, { myRating: 6 });
    expect(tconsts(searchMovies(db, { myRatingMin: 7 }).results)).toEqual(['tt9000020']);
    expect(tconsts(searchMovies(db, { status: ['priority', 'someday'] }).results)).toEqual(['tt9000018', 'tt9000020']);
  });

  it('sorts and paginates', () => {
    const byYear = searchMovies(db, { sort: 'year', order: 'asc' }).results.map((r) => r.year);
    expect(byYear).toEqual([...byYear].sort((a, b) => (a as number) - (b as number)));
    const byRating = searchMovies(db, {}).results;
    expect(byRating[0]?.tconst).toBe('tt9000003');
    expect(byRating[byRating.length - 1]?.rating).toBeNull();
    const titles = searchMovies(db, { sort: 'title' }).results.map((r) => r.title);
    expect(titles[0]).toBe('A Room Downstairs');
    const page = searchMovies(db, { sort: 'title', limit: 2, offset: 2 });
    expect(page.total).toBe(7);
    expect(page.results.map((r) => r.title)).toEqual(titles.slice(2, 4));
  });

  it("sort 'random' returns limit rows", () => {
    expect(searchMovies(db, { sort: 'random', limit: 3 }).results).toHaveLength(3);
  });

  it('filters by year range and minimum runtime', () => {
    expect(tconsts(searchMovies(db, { yearFrom: 2015, yearTo: 2016 }).results)).toEqual(['tt9000006', 'tt9000007']);
    expect(tconsts(searchMovies(db, { minRuntime: 140 }).results)).toEqual(['tt9000020']);
  });
});

describe('searchMovies (scope all)', () => {
  it('annotates library items and excludes them with notInLibrary', () => {
    const all = searchMovies(db, { scope: 'all', directors: ['fincher'] });
    expect(tconsts(all.results)).toEqual(['tt9000003', 'tt9000004', 'tt9000009', 'tt9000010', 'tt9000019', 'tt9000020']);
    expect(all.results.find((r) => r.tconst === 'tt9000009')?.library).toBeNull();
    expect(all.results.find((r) => r.tconst === 'tt9000004')?.library?.editions).toBe(2);

    const notOwned = searchMovies(db, { scope: 'all', directors: ['fincher'], notInLibrary: true });
    expect(tconsts(notOwned.results)).toEqual(['tt9000009', 'tt9000010', 'tt9000019']);

    // "Haven't watched and don't own": unwatched adds nothing to notInLibrary and must not empty it.
    const unwatchedNotOwned = searchMovies(db, { scope: 'all', directors: ['fincher'], notInLibrary: true, unwatched: true });
    expect(tconsts(unwatchedNotOwned.results)).toEqual(['tt9000009', 'tt9000010', 'tt9000019']);
  });

  it('applies the default minVotes of 1000', () => {
    const rs = searchMovies(db, { scope: 'all', directors: ['ruiz'] });
    expect(tconsts(rs.results)).toEqual(['tt9000011', 'tt9000023', 'tt9000028', 'tt9000013'].sort());
    expect(tconsts(searchMovies(db, { scope: 'all', directors: ['orrin vale'] }).results)).toEqual(['tt9000001', 'tt9000005']);
    const withObscure = searchMovies(db, { scope: 'all', directors: ['orrin vale'], minVotes: 0 });
    expect(tconsts(withObscure.results)).toEqual(['tt9000001', 'tt9000005', 'tt9000014', 'tt9000025', 'tt9000029']);
  });

  it('searches by actor and title text', () => {
    expect(tconsts(searchMovies(db, { scope: 'all', actors: ['hana weir'] }).results)).toEqual(
      ['tt9000006', 'tt9000011', 'tt9000018', 'tt9000024'].sort(),
    );
    expect(tconsts(searchMovies(db, { scope: 'all', text: 'glass harbor' }).results)).toEqual(['tt9000001', 'tt9000002']);
    expect(tconsts(searchMovies(db, { scope: 'all', text: 'phare' }).results)).toEqual(['tt9000011']);
  });

  it('item-level filters restrict to library movies', () => {
    expect(tconsts(searchMovies(db, { scope: 'all', unwatched: true, directors: ['villeneuve'] }).results)).toEqual([
      'tt9000007',
      'tt9000018',
    ]);
  });
});

describe('injection', () => {
  it('binds director input as a value', () => {
    const res = searchMovies(db, { directors: ["x' OR 1=1 --"] });
    expect(res.total).toBe(0);
    expect(searchMovies(db, { scope: 'all', directors: ["x' OR 1=1 --"] }).total).toBe(0);
  });

  it('binds text input and LIKE wildcards stay literal', () => {
    const evil = "%' ; DROP TABLE titles; --";
    expect(() => searchMovies(db, { text: evil })).not.toThrow();
    expect(() => searchMovies(db, { scope: 'all', text: evil })).not.toThrow();
    expect(db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'titles'").get()).toBeTruthy();
    expect(searchMovies(db, { text: '%' }).total).toBe(0);
    expect(searchMovies(db, { directors: ['_'] }).total).toBe(0);
    expect(searchMovies(db, { scope: 'all', text: '"' }).total).toBe(0);

    const compiled = compileSearch(FilterSchema.parse({ text: evil, directors: ["x' OR 1=1 --"] }), { fts: db.fts, catalog: true });
    expect(compiled.sql).not.toContain('DROP');
    expect(compiled.sql).not.toContain('1=1');
    expect(compiled.params).toContain("%x' OR 1=1 --%");
  });

  it('rejects an invalid sort through searchMovies', () => {
    expect(() => searchMovies(db, { sort: 'title; DROP TABLE titles' })).toThrow(/sort/);
  });
});

describe('before setup (Review Focus #2)', () => {
  let tmp2: string;
  let empty: Db;
  beforeAll(() => {
    tmp2 = mkdtempSync(join(tmpdir(), 'screentrackr-nocat-'));
    empty = openDb(join(tmp2, 'home'));
    empty.sql
      .prepare(
        "INSERT INTO library_items (source_title, source_director, source_genre, source_runtime_min, source_year, status, match_status, source) VALUES (?, ?, ?, ?, ?, 'queue', 'unmatched', 'paste')",
      )
      .run('Quiet Ledger', 'Dana Fincher', 'Thriller', 139, 1999);
  });
  afterAll(() => {
    empty.close();
    rmSync(tmp2, { recursive: true, force: true });
  });

  it('library scope works from source fields', () => {
    const res = searchMovies(empty, { directors: ['fincher'], genres: ['Thriller'], unwatched: true });
    expect(res.total).toBe(1);
    expect(res.results[0]).toMatchObject({ tconst: null, title: 'Quiet Ledger', runtimeMin: 139, rating: null });
  });

  it('scope all throws CatalogMissingError', () => {
    expect(() => searchMovies(empty, { scope: 'all' })).toThrow(CatalogMissingError);
    expect(() => searchMovies(empty, { scope: 'all' })).toThrow('Catalog not built. Run `screentrackr setup`.');
  });

  it('libraryStats works without a catalog', () => {
    const s = libraryStats(empty);
    expect(s.total).toBe(1);
    expect(s.topDirectors).toEqual([['Dana Fincher', 1]]);
    expect(s.byDecade).toEqual([['1990s', 1]]);
  });
});

describe('libraryStats', () => {
  it('counts by status, match state, genre, director and decade', () => {
    db.sql
      .prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Unclear', 'queue', 'ambiguous', 'paste')")
      .run();
    const s = libraryStats(db);
    expect(s.total).toBe(9);
    expect(s.byStatus).toEqual({ queue: 4, priority: 1, someday: 1, watched: 3 });
    expect(s.unmatched).toBe(1);
    expect(s.ambiguous).toBe(1);
    expect(s.topDirectors[0]).toEqual(['Dana Fincher', 4]);
    expect(s.topDirectors).toContainEqual(['Fincher', 1]);
    expect(s.topGenres[0]).toEqual(['Thriller', 7]);
    expect(s.byDecade).toEqual([
      ['1990s', 3],
      ['2000s', 1],
      ['2010s', 4],
    ]);
  });
});

describe('store genre for owned movies', () => {
  it('a matched library item matches a genre by its store genre when IMDb lacks it', () => {
    const before = searchMovies(db, { genres: ['Western'] });
    expect(before.results.map((r) => r.library?.id)).not.toContain(ids.b07);
    db.sql.prepare("UPDATE library_items SET source_genre = 'Western' WHERE id = ?").run(ids.b07!);
    const after = searchMovies(db, { genres: ['Western'] });
    expect(after.results.map((r) => r.library?.id)).toContain(ids.b07);
    // The catalog-wide scope is unchanged: only IMDb genres count there.
    const all = searchMovies(db, { scope: 'all', genres: ['Western'], minVotes: 0 });
    expect(all.results.map((r) => r.tconst)).not.toContain('tt9000007');
  });
});

describe('0.4.0 shared filter fields', () => {
  it('validates the new fields', () => {
    expect(FilterSchema.safeParse({ decades: ['1980s'] }).success).toBe(true);
    for (const d of ['1985s', '1870s', '2200s', '80s', '1980']) expect(FilterSchema.safeParse({ decades: [d] }).success, d).toBe(false);
    expect(FilterSchema.safeParse({ decades: ['1880s', '2190s'] }).success).toBe(true);
    expect(FilterSchema.safeParse({ scope: 'all', notInLibrary: true, owned: true }).success).toBe(false);
    expect(FilterSchema.safeParse({ scope: 'all', notInLibrary: true, lists: ['Halloween'] }).success).toBe(false);
    expect(FilterSchema.safeParse({ neverSeen: true, status: ['watched'] }).success).toBe(false);
    expect(FilterSchema.safeParse({ neverSeen: true, status: ['queue', 'watched'] }).success).toBe(true);
    expect(FilterSchema.safeParse({ minVotes: 10, maxVotes: 5 }).success).toBe(false);
    expect(FilterSchema.safeParse({ lists: ['x'.repeat(101)] }).success).toBe(false);
    expect(FilterSchema.parse({ lists: ['A'] }).listMode).toBe('any');
  });

  it('owned filters library items in both scopes', () => {
    db.sql.prepare('UPDATE library_items SET owned = 0 WHERE id = ?').run(ids.b07 as number);
    expect(tconsts(searchMovies(db, { owned: false }).results)).toEqual(['tt9000007']);
    expect(tconsts(searchMovies(db, { owned: true }).results)).not.toContain('tt9000007');
    expect(tconsts(searchMovies(db, { scope: 'all', owned: false }).results)).toEqual(['tt9000007']);
  });

  it('decades OR together and AND with a year bound', () => {
    expect(tconsts(searchMovies(db, { decades: ['1990s'] }).results)).toEqual(['tt9000003', 'tt9000004']);
    expect(tconsts(searchMovies(db, { decades: ['1990s', '2010s'], yearFrom: 1996 }).results)).toEqual(
      ['tt9000003', 'tt9000006', 'tt9000007', 'tt9000018', 'tt9000020'],
    );
  });

  it('lists: any or all, in both scopes, and an unknown list is an error', () => {
    createList(db, 'Halloween');
    createList(db, 'Winter');
    addToList(db, 'Halloween', [ids.r20 as number, ids.b07 as number]);
    addToList(db, 'Winter', [ids.b07 as number]);
    expect(tconsts(searchMovies(db, { lists: ['halloween'] }).results)).toEqual(['tt9000007', 'tt9000020']);
    expect(tconsts(searchMovies(db, { lists: ['Halloween', 'Winter'], listMode: 'all' }).results)).toEqual(['tt9000007']);
    expect(tconsts(searchMovies(db, { lists: ['Halloween', 'Winter'] }).results)).toEqual(['tt9000007', 'tt9000020']);
    expect(tconsts(searchMovies(db, { scope: 'all', lists: ['Winter'] }).results)).toEqual(['tt9000007']);
    expect(() => searchMovies(db, { lists: ['Nope'] })).toThrow(/No list named "Nope"/);
  });

  it('neverSeen: this item has no viewings and is not watched', () => {
    addViewing(db, ids.b07 as number, { watchedAt: '2020-01-01', source: 'manual' });
    expect(tconsts(searchMovies(db, { neverSeen: true }).results)).toEqual([null, 'tt9000004', 'tt9000018', 'tt9000020']);
  });

  it('excludeWatched drops films watched or played in any edition, and keeps owned unwatched ones', () => {
    addViewing(db, ids.b07 as number, { watchedAt: null, source: 'trakt' });
    expect(tconsts(searchMovies(db, { excludeWatched: true }).results)).toEqual([null, 'tt9000018', 'tt9000020']);
    const all = tconsts(searchMovies(db, { scope: 'all', excludeWatched: true, minVotes: 0, limit: 200 }).results);
    expect(all).toContain('tt9000020');
    expect(all).toContain('tt9000001');
    for (const t of ['tt9000003', 'tt9000004', 'tt9000006', 'tt9000007']) expect(all).not.toContain(t);
  });

  it('maxVotes bounds votes from above and drops titles with no votes', () => {
    const res = searchMovies(db, { scope: 'all', minVotes: 0, maxVotes: 5000, limit: 200 });
    expect(res.results.length).toBeGreaterThan(0);
    for (const r of res.results) expect(r.votes !== null && r.votes <= 5000).toBe(true);
    expect(tconsts(res.results)).toContain('tt9000023');
    expect(tconsts(res.results)).not.toContain('tt9000001');
  });
});

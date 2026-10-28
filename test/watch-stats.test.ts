/** core/stats.ts: watch stats over plays (viewings). Every title, person and date here is made up. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { addFromCatalog } from '../src/core/library.js';
import { addToList, createList } from '../src/core/lists.js';
import { libraryStats, watchStats, watchSummary } from '../src/core/stats.js';
import { addViewing } from '../src/core/viewings.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');
const NOW = new Date(2025, 10, 1, 12, 0, 0);

let tmp: string;
let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-watch-stats-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: FIXTURES });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function unlinked(title: string, f: { year: number; genre: string; director: string; status: string }): number {
  return Number(
    db.sql
      .prepare(
        "INSERT INTO library_items (source_title, source_year, source_genre, source_director, status, match_status, source) VALUES (?, ?, ?, ?, ?, 'unmatched', 'paste')",
      )
      .run(title, f.year, f.genre, f.director, f.status).lastInsertRowid,
  );
}

function rate(id: number, rating: number, updatedAt: string): void {
  db.sql.prepare('UPDATE library_items SET my_rating = ?, updated_at = ? WHERE id = ?').run(rating, updatedAt, id);
}

function seed(): void {
  db.sql.exec('DELETE FROM list_items; DELETE FROM lists; DELETE FROM viewings; DELETE FROM match_candidates; DELETE FROM library_items;');
  ids = {
    // Two editions of Quiet Ledger (tt9000003: Crime, Drama, Thriller; Dana Fincher; IMDb 8.6; 1999).
    q3a: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    q3b: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    // Seven Lanterns (tt9000004: Crime, Mystery, Thriller; Dana Fincher; IMDb 8.4; 1995): one dateless play.
    s4: addFromCatalog(db, 'tt9000004', { status: 'watched' }).id,
    // Dune Static (tt9000006: Drama, Mystery, Sci-Fi; Denise Villeneuve; IMDb 7.9; 2016).
    d6: addFromCatalog(db, 'tt9000006', { status: 'watched' }).id,
    // Not watched: never counted.
    r20: addFromCatalog(db, 'tt9000020', { status: 'queue' }).id,
    u1: unlinked('Backyard Opera', { year: 1987, genre: 'Comedy, Music', director: 'Lena Holt', status: 'watched' }),
    u2: unlinked('Tin Moon', { year: 2001, genre: 'Horror', director: 'Lena Holt', status: 'watched' }),
  };
  addViewing(db, ids.q3a as number, { watchedAt: '2024-03-01', source: 'manual', sourceRef: 'manual:0000000000000001' });
  // The same night from two sources, on two editions: one play, and a rewatch of the 2024 one.
  addViewing(db, ids.q3b as number, { watchedAt: '2025-02-10', source: 'letterboxd', sourceRef: 'https://boxd.it/x1' });
  addViewing(db, ids.q3a as number, { watchedAt: '2025-02-10T21:30:00Z', source: 'trakt', sourceRef: '9007199254740993' });
  addViewing(db, ids.s4 as number, { watchedAt: null, source: 'trakt', sourceRef: '17' });
  addViewing(db, ids.d6 as number, { watchedAt: '2023-01-05', rewatch: false, source: 'letterboxd', sourceRef: 'https://boxd.it/x2' });
  addViewing(db, ids.d6 as number, { watchedAt: '2023-08-09', rewatch: true, source: 'letterboxd', sourceRef: 'https://boxd.it/x3' });
  addViewing(db, ids.u2 as number, { watchedAt: '2025-10-31', source: 'apple-tv' });
  // A film's rating is its most recently updated rated edition's.
  rate(ids.q3a as number, 8, '2024-03-02T00:00:00.000Z');
  rate(ids.q3b as number, 9, '2025-02-11T00:00:00.000Z');
  rate(ids.s4 as number, 7, '2025-01-01T00:00:00.000Z');
  rate(ids.d6 as number, 8, '2023-08-10T00:00:00.000Z');
  rate(ids.u1 as number, 6, '2020-01-01T00:00:00.000Z');
}

beforeEach(seed);

describe('watchStats', () => {
  it('counts plays, films and rewatches across editions and sources', () => {
    const s = watchStats(db, { now: NOW });
    expect(s).toMatchObject({ year: null, plays: 6, films: 5, rewatches: 2, undatedFilms: 2 });
    expect(s.byYear).toEqual([
      { year: 2025, plays: 2, films: 2, rewatches: 1 },
      { year: 2024, plays: 1, films: 1, rewatches: 0 },
      { year: 2023, plays: 2, films: 1, rewatches: 1 },
    ]);
  });

  it('counts watched films by release decade, genre and director, with your average', () => {
    const s = watchStats(db, { now: NOW });
    expect(s.byDecade).toEqual([
      { decade: '1980s', films: 1 },
      { decade: '1990s', films: 2 },
      { decade: '2000s', films: 1 },
      { decade: '2010s', films: 1 },
    ]);
    expect(s.byGenre).toEqual([
      { name: 'Crime', films: 2, rated: 2, averageRating: 8 },
      { name: 'Drama', films: 2, rated: 2, averageRating: 8.5 },
      { name: 'Mystery', films: 2, rated: 2, averageRating: 7.5 },
      { name: 'Thriller', films: 2, rated: 2, averageRating: 8 },
      { name: 'Comedy', films: 1, rated: 1, averageRating: 6 },
      { name: 'Horror', films: 1, rated: 0, averageRating: null },
      { name: 'Music', films: 1, rated: 1, averageRating: 6 },
      { name: 'Sci-Fi', films: 1, rated: 1, averageRating: 8 },
    ]);
    expect(s.byDirector).toEqual([
      { name: 'Dana Fincher', films: 2, rated: 2, averageRating: 8 },
      { name: 'Lena Holt', films: 2, rated: 1, averageRating: 6 },
      { name: 'Denise Villeneuve', films: 1, rated: 1, averageRating: 8 },
    ]);
  });

  it('gives the rating distribution 1 to 10 and your average against IMDb', () => {
    const s = watchStats(db, { now: NOW });
    expect(s.ratings).toHaveLength(10);
    expect(s.ratings.filter((r) => r.films > 0)).toEqual([
      { rating: 6, films: 1 },
      { rating: 7, films: 1 },
      { rating: 8, films: 1 },
      { rating: 9, films: 1 },
    ]);
    expect(s.rated).toBe(4);
    expect(s.averageRating).toBe(7.5);
    // Linked rated films: 9 vs 8.6, 7 vs 8.4, 8 vs 7.9.
    expect(s.vsImdb).toEqual({ films: 3, myAverage: 8, imdbAverage: 8.3, difference: -0.3 });
  });

  it('--year limits every block to films played that year', () => {
    const s = watchStats(db, { year: 2025, now: NOW });
    expect(s).toMatchObject({ year: 2025, plays: 2, films: 2, rewatches: 1, undatedFilms: null, rated: 1, averageRating: 9 });
    expect(s.byYear).toEqual([{ year: 2025, plays: 2, films: 2, rewatches: 1 }]);
    expect(s.byGenre.map((g) => g.name)).toEqual(['Crime', 'Drama', 'Horror', 'Thriller']);
    expect(s.byDecade).toEqual([
      { decade: '1990s', films: 1 },
      { decade: '2000s', films: 1 },
    ]);
    expect(watchStats(db, { year: 1990, now: NOW })).toMatchObject({ plays: 0, films: 0, byYear: [], byGenre: [], vsImdb: null });
  });

  it('a list narrows to films with an edition in it, counting all their plays', () => {
    createList(db, 'Halloween');
    addToList(db, 'Halloween', [ids.u2 as number, ids.q3b as number]);
    const s = watchStats(db, { lists: ['halloween'], now: NOW });
    expect(s).toMatchObject({ plays: 3, films: 2, rewatches: 1 });
    expect(() => watchStats(db, { lists: ['Nope'] })).toThrow(/No list named "Nope"/);
  });

  it('limit caps genres and directors; by lifts the cap for its own block', () => {
    expect(watchStats(db, { limit: 2, now: NOW }).byGenre).toHaveLength(2);
    expect(watchStats(db, { limit: 2, now: NOW }).byDirector).toHaveLength(2);
    expect(watchStats(db, { by: 'genre', now: NOW }).byGenre).toHaveLength(8);
    expect(watchStats(db, { by: 'genre', limit: 3, now: NOW }).byGenre).toHaveLength(3);
    expect(watchStats(db, { by: 'year', limit: 1, now: NOW }).byYear).toEqual([{ year: 2025, plays: 2, films: 2, rewatches: 1 }]);
  });

  it('a time-of-day watched date counts in its own calendar year', () => {
    addViewing(db, ids.u1 as number, { watchedAt: '2022-12-31T23:30:00-08:00', source: 'trakt', sourceRef: '99' });
    expect(watchStats(db, { year: 2022, now: NOW })).toMatchObject({ plays: 1, films: 1 });
  });

  it('dateless plays from two sources count as the larger per-source count', () => {
    addViewing(db, ids.s4 as number, { watchedAt: null, source: 'plex' });
    addViewing(db, ids.s4 as number, { watchedAt: null, source: 'trakt', sourceRef: '18' });
    expect(watchStats(db, { now: NOW }).plays).toBe(7);
  });

  it('editions linked to one tconst are one film even with no catalog row for it', () => {
    db.sql.exec('DELETE FROM viewings; DELETE FROM library_items;');
    const ins = db.sql.prepare(
      "INSERT INTO library_items (tconst, source_title, status, match_status, source, my_rating, updated_at) VALUES ('tt8000001', 'Paper Comet', 'watched', ?, 'json', ?, ?)",
    );
    const a = Number(ins.run('manual', 8, '2024-01-01T00:00:00.000Z').lastInsertRowid);
    const b = Number(ins.run('matched', 9, '2025-01-01T00:00:00.000Z').lastInsertRowid);
    addViewing(db, a, { watchedAt: '2025-02-01', source: 'letterboxd', sourceRef: 'https://boxd.it/p1' });
    addViewing(db, b, { watchedAt: '2025-02-01', source: 'trakt', sourceRef: '5' });
    expect(watchStats(db, { now: NOW })).toMatchObject({ films: 1, plays: 1, rated: 1, averageRating: 9 });
  });

  it('rejects bad options', () => {
    expect(() => watchStats(db, { year: 99 })).toThrow(/year/);
    expect(() => watchStats(db, { by: 'month' as never })).toThrow(/by/);
    expect(() => watchStats(db, { limit: 0 })).toThrow(/limit/);
  });

  it('an empty library gives zeros and empty blocks', () => {
    db.sql.exec('DELETE FROM viewings; DELETE FROM library_items;');
    const s = watchStats(db, { now: NOW });
    expect(s).toMatchObject({ plays: 0, films: 0, rewatches: 0, undatedFilms: 0, byYear: [], byDecade: [], byGenre: [], byDirector: [], rated: 0, averageRating: null, vsImdb: null });
    expect(s.ratings.every((r) => r.films === 0)).toBe(true);
  });
});

describe('watchSummary and libraryStats', () => {
  it('summarizes this year and last year', () => {
    expect(watchSummary(db, { now: NOW })).toEqual({
      year: 2025,
      playsThisYear: 2,
      playsLastYear: 1,
      filmsThisYear: 2,
      rewatchesThisYear: 1,
      rated: 4,
      averageRating: 7.5,
    });
  });

  it('libraryStats gains playsThisYear and rated, keeping every other field', () => {
    const s = libraryStats(db, { now: NOW });
    expect(s).toMatchObject({ total: 7, playsThisYear: 2, rated: 4 });
    expect(Object.keys(s).sort()).toEqual(['ambiguous', 'byDecade', 'byStatus', 'playsThisYear', 'rated', 'topDirectors', 'topGenres', 'total', 'unmatched'].sort());
  });
});

describe('stats --watched text', () => {
  it('renders every block at 80 columns', async () => {
    const { watchStatsText, libraryStatsText } = await import('../src/cli/commands/stats.js');
    const text = watchStatsText(watchStats(db, { now: NOW }), { width: 80 });
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(text).toMatchSnapshot();
    expect(watchStatsText(watchStats(db, { by: 'rating', now: NOW }), { width: 80 })).toMatchSnapshot();
    expect(watchStatsText(watchStats(db, { year: 1990, now: NOW }), { width: 80 })).toBe('Watched, in 1990: nothing yet.');
    expect(libraryStatsText(libraryStats(db, { now: NOW }), watchSummary(db, { now: NOW }))).toMatchSnapshot();
  });

  it('says nothing yet per block', async () => {
    const { watchStatsText } = await import('../src/cli/commands/stats.js');
    db.sql.exec('UPDATE library_items SET my_rating = NULL; DELETE FROM viewings;');
    const text = watchStatsText(watchStats(db, { now: NOW }), { width: 80 });
    expect(text).toMatch(/^By year watched: nothing yet$/m);
    expect(text).toMatch(/^Your ratings: nothing yet$/m);
    expect(text).toMatch(/^Rated\s+nothing yet$/m);
  });
});

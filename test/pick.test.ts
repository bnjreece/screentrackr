/**
 * pickMovies (core/pick.ts): random picks within the shared search filter.
 * Seeded picks are repeatable, picks are distinct films, and the defaults
 * (library scope, unwatched) and --priority-first behave as the spec says.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { LibraryError } from '../src/core/errors.js';
import { addFromCatalog, getItem } from '../src/core/library.js';
import { addToList, createList } from '../src/core/lists.js';
import { chooseOffsets, mulberry32, PICK_MAX_COUNT, pickMovies } from '../src/core/pick.js';
import { searchMovies } from '../src/core/search.js';
import { addViewing } from '../src/core/viewings.js';
import { whereForItem } from '../src/core/where.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-pick-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: FIXTURES });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function insertUnmatched(title: string, status = 'queue'): number {
  const r = db.sql
    .prepare("INSERT INTO library_items (source_title, source_year, status, match_status, source, owned) VALUES (?, 2001, ?, 'unmatched', 'paste', 1)")
    .run(title, status);
  return Number(r.lastInsertRowid);
}

/**
 * Library: watched 03 and 06; tt9000004 in two editions (queue and watched);
 * priority 20; queue 07, 09, 10; someday 18; an unmatched queue item.
 */
function seed(): void {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items; DELETE FROM lists;');
  ids = {
    w03: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    w06: addFromCatalog(db, 'tt9000006', { status: 'watched' }).id,
    q04a: addFromCatalog(db, 'tt9000004', { status: 'queue' }).id,
    w04b: addFromCatalog(db, 'tt9000004', { status: 'watched' }).id,
    p20: addFromCatalog(db, 'tt9000020', { status: 'priority' }).id,
    q07: addFromCatalog(db, 'tt9000007', { status: 'queue' }).id,
    q09: addFromCatalog(db, 'tt9000009', { status: 'queue', owned: false }).id,
    q10: addFromCatalog(db, 'tt9000010', { status: 'queue' }).id,
    s18: addFromCatalog(db, 'tt9000018', { status: 'someday' }).id,
    un: insertUnmatched("Basement Tapes (Director's Cut)"),
  };
}

beforeEach(() => seed());

const key = (p: { tconst: string | null; library: { id: number } | null }) => p.tconst ?? `#${p.library?.id}`;

describe('mulberry32 and chooseOffsets', () => {
  it('is repeatable for a seed and differs across seeds', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    for (const x of xs) expect(x >= 0 && x < 1).toBe(true);
    expect(mulberry32(43)()).not.toBe(xs[0]);
  });

  it('chooses k distinct offsets below n, and all of them when k >= n', () => {
    for (let s = 0; s < 50; s++) {
      const o = chooseOffsets(7, 5, mulberry32(s));
      expect(new Set(o).size).toBe(5);
      for (const x of o) expect(Number.isInteger(x) && x >= 0 && x < 7).toBe(true);
    }
    expect(chooseOffsets(3, 10, mulberry32(1)).sort()).toEqual([0, 1, 2]);
    expect(chooseOffsets(0, 3, mulberry32(1))).toEqual([]);
  });

  it('works for a catalog-sized n without listing it', () => {
    const o = chooseOffsets(300_000, 10, mulberry32(9));
    expect(new Set(o).size).toBe(10);
    for (const x of o) expect(x < 300_000).toBe(true);
  });

  it('reaches every offset over many seeds (no offset is unreachable)', () => {
    const seen = new Set<number>();
    for (let s = 0; s < 400; s++) seen.add(chooseOffsets(6, 1, mulberry32(s))[0]!);
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('pickMovies defaults', () => {
  it('picks one unwatched movie from the library', () => {
    const unwatched = new Set(['tt9000004', 'tt9000020', 'tt9000007', 'tt9000009', 'tt9000010', 'tt9000018', `#${ids.un}`]);
    for (let s = 0; s < 30; s++) {
      const r = pickMovies(db, { seed: s });
      expect(r.total).toBe(7);
      expect(r.picks).toHaveLength(1);
      expect(unwatched.has(key(r.picks[0]!))).toBe(true);
      expect(['queue', 'priority', 'someday']).toContain(r.picks[0]!.library!.status);
    }
  });

  it('counts each film once (editions collapse) with anyStatus', () => {
    const r = pickMovies(db, { anyStatus: true, count: 10, seed: 1 });
    expect(r.total).toBe(9);
    expect(r.picks).toHaveLength(9);
    expect(new Set(r.picks.map(key)).size).toBe(9);
  });

  it('agrees with search on what the filter matches', () => {
    const f = { genres: ['Thriller'], maxRuntime: 125 };
    const s = searchMovies(db, { ...f, unwatched: true, limit: 200 });
    const r = pickMovies(db, { ...f, count: 10, seed: 3 });
    expect(r.total).toBe(s.total);
    expect(r.picks.map(key).sort()).toEqual(s.results.map(key).sort());
  });
});

describe('pickMovies seeds and counts', () => {
  it('gives the same picks for the same seed, in the same order', () => {
    const a = pickMovies(db, { count: 3, seed: 1234 });
    const b = pickMovies(db, { count: 3, seed: 1234 });
    expect(a.picks.map(key)).toEqual(b.picks.map(key));
    expect(new Set(a.picks.map(key)).size).toBe(3);
  });

  it('does not depend on the order rows were inserted (fixed order, tconst then id)', () => {
    const before = pickMovies(db, { count: 4, seed: 77 }).picks.map(key);
    // Rebuild the same library in reverse insertion order.
    db.sql.exec('DELETE FROM library_items;');
    insertUnmatched("Basement Tapes (Director's Cut)");
    for (const [t, status] of [
      ['tt9000018', 'someday'],
      ['tt9000010', 'queue'],
      ['tt9000009', 'queue'],
      ['tt9000007', 'queue'],
      ['tt9000020', 'priority'],
      ['tt9000004', 'watched'],
      ['tt9000004', 'queue'],
      ['tt9000006', 'watched'],
      ['tt9000003', 'watched'],
    ] as const) {
      addFromCatalog(db, t, { status });
    }
    const after = pickMovies(db, { count: 4, seed: 77 }).picks.map((p) => p.tconst ?? 'unmatched');
    expect(after).toEqual(before.map((k) => (k.startsWith('#') ? 'unmatched' : k)));
  });

  it('varies without a seed across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) seen.add(key(pickMovies(db, {}).picks[0]!));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('returns every match when the count is larger than the total', () => {
    const r = pickMovies(db, { status: ['someday'], count: 5, seed: 1 });
    expect(r.total).toBe(1);
    expect(r.picks.map((p) => p.tconst)).toEqual(['tt9000018']);
  });

  it('validates count and seed', () => {
    expect(PICK_MAX_COUNT).toBe(10);
    expect(() => pickMovies(db, { count: 0 })).toThrow(LibraryError);
    expect(() => pickMovies(db, { count: 11 })).toThrow(LibraryError);
    expect(() => pickMovies(db, { count: 1.5 })).toThrow(LibraryError);
    expect(() => pickMovies(db, { seed: -1 })).toThrow(LibraryError);
    expect(() => pickMovies(db, { seed: 2 ** 32 })).toThrow(LibraryError);
    expect(pickMovies(db, { seed: 2 ** 32 - 1 }).picks).toHaveLength(1);
  });

  it('refuses search-only fields (sort, limit, offset)', () => {
    expect(() => pickMovies(db, { sort: 'rating' })).toThrow(LibraryError);
    expect(() => pickMovies(db, { limit: 3 })).toThrow(LibraryError);
    expect(() => pickMovies(db, { offset: 3 })).toThrow(LibraryError);
  });
});

describe('pickMovies empty', () => {
  it('returns total 0 and no picks, like an empty search', () => {
    expect(pickMovies(db, { genres: ['Western'] })).toEqual({ total: 0, picks: [] });
  });
});

describe('pickMovies status defaults', () => {
  it('anyStatus drops the unwatched default', () => {
    const r = pickMovies(db, { anyStatus: true, status: undefined, count: 10, seed: 2 });
    expect(r.picks.some((p) => p.library?.status === 'watched')).toBe(true);
  });

  it('an explicit status or unwatched replaces the default', () => {
    const r = pickMovies(db, { status: ['watched'], count: 10, seed: 2 });
    expect(r.picks.map((p) => p.tconst).sort()).toEqual(['tt9000003', 'tt9000004', 'tt9000006']);
    expect(pickMovies(db, { unwatched: false, count: 10, seed: 2 }).total).toBe(9);
  });

  it('refuses anyStatus with status or unwatched', () => {
    expect(() => pickMovies(db, { anyStatus: true, status: ['queue'] })).toThrow(/anyStatus/);
    expect(() => pickMovies(db, { anyStatus: true, unwatched: true })).toThrow(/anyStatus/);
  });

  it('in scope all, leaves out what you have watched but keeps the rest of the catalog', () => {
    const watched = new Set(['tt9000003', 'tt9000006', 'tt9000004']);
    const r = pickMovies(db, { scope: 'all', count: 10, seed: 5 });
    expect(r.total).toBeGreaterThan(10);
    for (const p of r.picks) expect(watched.has(p.tconst as string)).toBe(false);
    // tt9000004 has a queue edition too, but the film is watched (excludeWatched is per film).
    const all = pickMovies(db, { scope: 'all', minRating: 8, count: 10, seed: 5 });
    expect(all.picks.map((p) => p.tconst).sort()).toEqual(['tt9000008', 'tt9000020', 'tt9000024']);
  });

  it('in scope all, a movie you only played (status queue) counts as watched', () => {
    addViewing(db, ids.q07!, { watchedAt: '2025-01-02', source: 'manual', sourceRef: 'manual:0000000000000001' });
    // addViewing never changes status; the play alone makes it seen.
    expect(getItem(db, ids.q07!)!.status).toBe('queue');
    const r = pickMovies(db, { scope: 'all', minVotes: 0, count: 10, text: 'Border Choir', seed: 1 });
    expect(r.total).toBe(0);
  });

  it('anyStatus in scope all keeps watched movies', () => {
    const r = pickMovies(db, { scope: 'all', anyStatus: true, minRating: 8.5, count: 10, seed: 1 });
    expect(r.picks.map((p) => p.tconst).sort()).toEqual(['tt9000003', 'tt9000024']);
  });
});

describe('pickMovies priorityFirst', () => {
  it('draws only from priority movies when any match', () => {
    for (let s = 0; s < 10; s++) {
      const r = pickMovies(db, { priorityFirst: true, count: 3, seed: s });
      expect(r.picks.map((p) => p.tconst)).toEqual(['tt9000020']);
      expect(r.total).toBe(1);
      expect(r.priorityOnly).toBe(true);
      expect(r.matched).toBe(7);
    }
  });

  it('draws from every match when no priority movie fits', () => {
    const r = pickMovies(db, { priorityFirst: true, maxRuntime: 125, count: 10, seed: 1 });
    expect(r.priorityOnly).toBe(false);
    expect(r.total).toBe(r.matched);
    expect(r.picks.length).toBe(r.total);
    expect(r.picks.some((p) => p.library?.status === 'priority')).toBe(false);
  });

  it('respects a status filter that leaves priority out', () => {
    const r = pickMovies(db, { priorityFirst: true, status: ['someday'], seed: 1 });
    expect(r.priorityOnly).toBe(false);
    expect(r.picks.map((p) => p.tconst)).toEqual(['tt9000018']);
  });

  it('in scope all, prefers your priority movies, then the whole catalog', () => {
    const r = pickMovies(db, { scope: 'all', priorityFirst: true, seed: 1 });
    expect(r.priorityOnly).toBe(true);
    expect(r.picks.map((p) => p.tconst)).toEqual(['tt9000020']);
    const none = pickMovies(db, { scope: 'all', priorityFirst: true, maxRuntime: 120, seed: 1 });
    expect(none.priorityOnly).toBe(false);
    expect(none.total).toBeGreaterThan(1);
  });

  it('empty with priorityFirst still has total 0 and no picks', () => {
    const r = pickMovies(db, { priorityFirst: true, genres: ['Western'] });
    expect(r).toMatchObject({ total: 0, picks: [] });
  });
});

describe('pickMovies filters', () => {
  it('owned, decades, lists and neverSeen narrow the pool', () => {
    expect(pickMovies(db, { owned: false, count: 10, seed: 1 }).picks.map((p) => p.tconst)).toEqual(['tt9000009']);
    expect(pickMovies(db, { decades: ['1990s'], count: 10, seed: 1 }).picks.map((p) => p.tconst)).toEqual(['tt9000004']);
    createList(db, 'Halloween');
    addToList(db, 'Halloween', [ids.q07!, ids.w03!]);
    expect(pickMovies(db, { lists: ['halloween'], count: 10, seed: 1 }).picks.map((p) => p.tconst)).toEqual(['tt9000007']);
    expect(pickMovies(db, { lists: ['Halloween'], anyStatus: true, count: 10, seed: 1 }).picks.map((p) => p.tconst).sort()).toEqual([
      'tt9000003',
      'tt9000007',
    ]);
    addViewing(db, ids.q10!, { watchedAt: '2024-05-05', source: 'manual', sourceRef: 'manual:0000000000000002' });
    const never = pickMovies(db, { neverSeen: true, count: 10, seed: 1 }).picks.map(key);
    expect(never).not.toContain('tt9000010');
    expect(never).toHaveLength(6);
  });

  it('refuses a list that does not exist', () => {
    expect(() => pickMovies(db, { lists: ['Nope'] })).toThrow(/No list named "Nope"/);
  });

  it('includes unmatched library items as candidates', () => {
    const r = pickMovies(db, { text: 'Basement', seed: 1 });
    expect(r.picks).toHaveLength(1);
    expect(r.picks[0]!.tconst).toBeNull();
    expect(r.picks[0]!.library!.id).toBe(ids.un);
  });
});

describe('where to watch in picks', () => {
  it('gives each pick a JustWatch link in the chosen country', () => {
    const r = pickMovies(db, { text: 'Basement', seed: 1 }, { country: 'gb' });
    expect(r.picks[0]!.whereToWatch).toBe('https://www.justwatch.com/uk/search?q=Basement%20Tapes');
    const linked = pickMovies(db, { text: 'Room Downstairs', seed: 1 });
    expect(linked.picks[0]!.whereToWatch).toBe('https://www.justwatch.com/us/search?q=A%20Room%20Downstairs');
  });

  it('cleans the source title of a linked item whose catalog row is missing, as where does', () => {
    const id = Number(
      db.sql
        .prepare("INSERT INTO library_items (source_title, status, match_status, tconst, source) VALUES ('Ferry Tales (2002) (4K)', 'queue', 'matched', 'tt9999998', 'paste')")
        .run().lastInsertRowid,
    );
    const r = pickMovies(db, { text: 'Ferry Tales', seed: 1 });
    expect(r.picks[0]!.library!.id).toBe(id);
    expect(r.picks[0]!.whereToWatch).toBe('https://www.justwatch.com/us/search?q=Ferry%20Tales');
    expect(whereForItem(db, getItem(db, id)!, 'us').url).toBe(r.picks[0]!.whereToWatch);
  });

  it('whereForItem uses the catalog title for a linked item and the source title otherwise', () => {
    const linked = whereForItem(db, getItem(db, ids.p20!)!, 'de');
    expect(linked).toEqual({ title: 'A Room Downstairs', country: 'de', url: 'https://www.justwatch.com/de/search?q=A%20Room%20Downstairs' });
    expect(whereForItem(db, getItem(db, ids.un!)!, 'us').title).toBe('Basement Tapes');
  });
});

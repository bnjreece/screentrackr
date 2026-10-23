import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { directorsConflict, matchOne, normalizeTitle, parseDuration, rematch, sourceYearOf, splitPeople, type MatchInput } from '../src/core/match.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

/**
 * Extra synthetic catalog rows for Review Focus #4 (messy titles). Inserted
 * directly so the shared IMDb fixture counts used by other suites stay fixed.
 * Every title, person and ID is made up.
 */
interface ExtraTitle {
  tconst: string;
  title: string;
  year: number | null;
  runtime: number | null;
  directors: [string, string][];
  votes?: number;
}
const EXTRA: ExtraTitle[] = [
  // Trailing-space source title with colon and dash punctuation.
  { tconst: 'tt9500001', title: 'Operation: Improbable - Last Reckoning', year: 2023, runtime: 163, directors: [['nm9500001', 'Kit McQuarrel']], votes: 300000 },
  // A longer title that only partially matches; must never be auto-matched to the short source title.
  { tconst: 'tt9500002', title: 'Operation: Improbable - Last Reckoning Part Two', year: 2025, runtime: 169, directors: [['nm9500001', 'Kit McQuarrel']], votes: 150000 },
  // Edition suffix on the source ("Director's Cut"), with a longer runtime than the catalog.
  { tconst: 'tt9500003', title: 'Nightwardens', year: 2009, runtime: 162, directors: [['nm9500002', 'Zane Snyderman']], votes: 600000 },
  // Year in parentheses on the source; a same-titled older film exists.
  { tconst: 'tt9500004', title: 'Perigee 9', year: 2019, runtime: 93, directors: [['nm9500003', 'Toby Millard']], votes: 30000 },
  { tconst: 'tt9500005', title: 'Perigee 9', year: 1971, runtime: 101, directors: [['nm9500004', 'Ruth Ondaatje']], votes: 2000 },
  // Co-directing siblings credited under different first names than the source uses.
  { tconst: 'tt9500006', title: 'Wired Reality', year: 1999, runtime: 136, directors: [['nm9500005', 'Ada Kowalczyk'], ['nm9500006', 'Lena Kowalczyk']], votes: 2000000 },
  // A remake pair whose directors share a first name and nothing else.
  { tconst: 'tt9500007', title: 'Tidewater Bell', year: 1981, runtime: 104, directors: [['nm9000003', 'Orrin Vale']], votes: 9000 },
  { tconst: 'tt9500008', title: 'Tidewater Bell', year: 2019, runtime: 121, directors: [['nm9500007', 'Orrin Brask']], votes: 4000 },
];

function addExtraTitles(db: Db): void {
  const insT = db.sql.prepare(
    'INSERT INTO titles (tconst, title, original_title, norm_title, year, runtime_min, genres_csv, is_adult) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)',
  );
  const insP = db.sql.prepare('INSERT OR IGNORE INTO people (nconst, name) VALUES (?, ?)');
  const insTP = db.sql.prepare("INSERT INTO title_people (tconst, nconst, role, ord) VALUES (?, ?, 'director', ?)");
  const insR = db.sql.prepare('INSERT INTO ratings (tconst, rating, votes) VALUES (?, 7.0, ?)');
  const insF = db.fts ? db.sql.prepare('INSERT INTO titles_fts (tconst, title, original_title) VALUES (?, ?, NULL)') : null;
  for (const t of EXTRA) {
    insT.run(t.tconst, t.title, t.title, normalizeTitle(t.title), t.year, t.runtime);
    t.directors.forEach(([n, name], i) => {
      insP.run(n, name);
      insTP.run(t.tconst, n, i + 1);
    });
    if (t.votes) insR.run(t.tconst, t.votes);
    insF?.run(t.tconst, t.title);
  }
}

let tmp: string;
let db: Db;
beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-match-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: FIXTURES });
  addExtraTitles(db);
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('normalizeTitle', () => {
  it('handles the plan examples', () => {
    expect(normalizeTitle('The Deep Trench (Special Edition)')).toBe('deep trench');
    expect(normalizeTitle('Orbit 9 (2019)')).toBe('orbit 9');
    expect(normalizeTitle('Mission: Unlikely - Final Count ')).toBe('mission unlikely final count');
    expect(normalizeTitle('Lanterns & The Glass Harbor')).toBe('lanterns and the glass harbor');
  });

  it('drops a leading article only at the start', () => {
    expect(normalizeTitle('The Thing About the Sea')).toBe('thing about the sea');
    expect(normalizeTitle('Into the Woods')).toBe('into the woods');
    expect(normalizeTitle('The')).toBe('the');
  });
});

describe('sourceYearOf', () => {
  it('reads a trailing year, also beneath supported edition suffixes', () => {
    expect(sourceYearOf('The Glass Harbor (1978)', 2009)).toBe(1978);
    expect(sourceYearOf('The Glass Harbor (1978) (4K)', 2009)).toBe(1978);
    expect(sourceYearOf('The Glass Harbor (1978) (Special Edition)', null)).toBe(1978);
    expect(sourceYearOf("The Glass Harbor (1978) [Director's Cut] (Unrated)", null)).toBe(1978);
    expect(sourceYearOf('The Glass Harbor (Extended Edition) (1978) (Theatrical)', null)).toBe(1978);
    expect(sourceYearOf('(1978)', null)).toBe(1978);
  });

  it('falls back to the year field when no year sits among the trailing suffixes', () => {
    expect(sourceYearOf('The Glass Harbor (4K)', 2009)).toBe(2009);
    expect(sourceYearOf('The Glass Harbor (4K)', null)).toBeNull();
    expect(sourceYearOf('The Glass Harbor', undefined)).toBeNull();
    // A year behind a group that is not an edition suffix is part of the title.
    expect(sourceYearOf('The Glass Harbor (1978) (Part Two)', 2009)).toBe(2009);
  });
});

describe('parseDuration', () => {
  it('parses the supported shapes to whole minutes', () => {
    expect(parseDuration('2:25:50')).toBe(146);
    expect(parseDuration('142 min')).toBe(142);
    expect(parseDuration('142')).toBe(142);
    expect(parseDuration('95:30')).toBe(96);
    expect(parseDuration(' 1:05:00 ')).toBe(65);
  });

  it('returns null for empty or unreadable values', () => {
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('soon')).toBeNull();
    expect(parseDuration('1:75:00')).toBeNull();
    expect(parseDuration('-5')).toBeNull();
  });
});

describe('splitPeople', () => {
  it('splits on commas, ampersands and "and"', () => {
    expect(splitPeople('Dara Blume, Gil Gorman & Dan Kuenzel')).toEqual(['Dara Blume', 'Gil Gorman', 'Dan Kuenzel']);
    expect(splitPeople('Ana Wexler & Lou Wexler')).toEqual(['Ana Wexler', 'Lou Wexler']);
    expect(splitPeople('Joel Coen and Ethan Coen')).toEqual(['Joel Coen', 'Ethan Coen']);
  });

  it('drops Unknown and blanks', () => {
    expect(splitPeople('Unknown')).toEqual([]);
    expect(splitPeople(' unknown ')).toEqual([]);
    expect(splitPeople(null)).toEqual([]);
    expect(splitPeople('')).toEqual([]);
    expect(splitPeople('Ann Lee, Unknown')).toEqual(['Ann Lee']);
  });
});

/** Run each matching test both with FTS (when available) and with the LIKE fallback. */
const variants: [string, () => Db][] = [
  ['default', () => db],
  ['no FTS', () => ({ ...db, fts: false })],
];

describe.each(variants)('matchOne (%s)', (_name, get) => {
  const m = (input: MatchInput) => matchOne(get(), input);

  it('uses a valid imdbIdHint present in the catalog regardless of title', () => {
    const r = m({ title: 'Something Else Entirely', imdbIdHint: 'tt9000019' });
    expect(r.status).toBe('matched');
    expect(r.tconst).toBe('tt9000019');
  });

  // Real exports carry OMDb ids looked up by title alone, which often point at the
  // other film of a remake pair. A hint the source itself contradicts must not win.
  it('rejects a hint whose year contradicts a "(yyyy)" in the source title', () => {
    expect(m({ title: 'Perigee 9 (2019)', imdbIdHint: 'tt9500005' })).toMatchObject({ status: 'matched', tconst: 'tt9500004' });
    // The title year beats a passed year that came from the same wrong lookup.
    expect(m({ title: 'Perigee 9 (2019)', year: 1971, imdbIdHint: 'tt9500005' })).toMatchObject({ status: 'matched', tconst: 'tt9500004' });
  });

  it('rejects a hint whose year contradicts the source year field', () => {
    const r = m({ title: 'The Glass Harbor', year: 2009, imdbIdHint: 'tt9000001' });
    expect(r.tconst).not.toBe('tt9000001');
    expect(r).toMatchObject({ status: 'matched', tconst: 'tt9000002' });
    // A year within one still trusts the hint.
    expect(m({ title: 'The Glass Harbor', year: 1979, imdbIdHint: 'tt9000001' })).toMatchObject({ status: 'matched', tconst: 'tt9000001' });
  });

  it('never auto-matches a candidate whose year contradicts the source', () => {
    // Title, director and runtime all fit the 1995 film, but the source names 2021.
    const r = m({ title: 'Seven Lanterns (2021)', director: 'Dana Fincher', runtimeMin: 117 });
    expect(r).toMatchObject({ status: 'ambiguous', tconst: null });
    expect(r.candidates.map((c) => c.tconst)).toContain('tt9000004');
    // The same from the year field alone.
    expect(m({ title: 'Seven Lanterns', year: 2021, director: 'Dana Fincher', runtimeMin: 117 })).toMatchObject({
      status: 'ambiguous',
      tconst: null,
    });
    // The title year takes precedence over a contradicting year field.
    expect(m({ title: 'Seven Lanterns (2021)', year: 1995, director: 'Dana Fincher', runtimeMin: 117 }).status).not.toBe('matched');
    // A year within one is no conflict.
    expect(m({ title: 'Seven Lanterns', year: 1996, director: 'Dana Fincher', runtimeMin: 117 })).toMatchObject({
      status: 'matched',
      tconst: 'tt9000004',
    });
  });

  it('finds a title year beneath edition suffixes, so it still blocks an automatic match', () => {
    const remake = { runtimeMin: 128, director: 'Teodor Brask' };
    expect(m({ title: 'The Glass Harbor (1978)', ...remake })).toMatchObject({ status: 'ambiguous', tconst: null });
    for (const title of ['The Glass Harbor (1978) (4K)', 'The Glass Harbor (1978) (Special Edition)', "The Glass Harbor (1978) [Director's Cut]"]) {
      expect(m({ title, ...remake }), title).toMatchObject({ status: 'ambiguous', tconst: null });
      // The title year beats a year field that names the remake.
      expect(m({ title, year: 2009, ...remake }).status, title).not.toBe('matched');
    }
    // A year in the title under a suffix still picks its own film.
    expect(m({ title: 'The Glass Harbor (2009) (4K)', ...remake })).toMatchObject({ status: 'matched', tconst: 'tt9000002' });
  });

  it('treats a bare edition suffix with no year as before', () => {
    expect(m({ title: 'The Glass Harbor (4K)', runtimeMin: 128 })).toMatchObject({ status: 'matched', tconst: 'tt9000002' });
    expect(m({ title: 'The Glass Harbor (Special Edition)', year: 1978 })).toMatchObject({ status: 'matched', tconst: 'tt9000001' });
    expect(m({ title: 'The Glass Harbor (4K)' }).status).toBe('ambiguous');
  });

  it('rejects a hint whose directors share no name with the source director', () => {
    const r = m({ title: 'The Glass Harbor', director: 'Teodor Brask', runtimeMin: 128, imdbIdHint: 'tt9000001' });
    expect(r).toMatchObject({ status: 'matched', tconst: 'tt9000002' });
    // A hint for a different title entirely loses to the exact title the source names.
    const s = m({ title: 'The Glass Harbor', director: 'Orrin Vale', imdbIdHint: 'tt9000007' });
    expect(s).toMatchObject({ status: 'matched', tconst: 'tt9000001' });
  });

  it('a shared first name is not corroboration: a stale hint never beats the remake its director names', () => {
    const remake = { title: 'Tidewater Bell', director: 'Orrin Brask', runtimeMin: 121 };
    expect(m(remake)).toMatchObject({ status: 'matched', tconst: 'tt9500008' });
    expect(m({ ...remake, imdbIdHint: 'tt9500007' })).toMatchObject({ status: 'matched', tconst: 'tt9500008' });
    // Director alone, no runtime: the stale hint is contradicted, so it is never accepted outright.
    for (const [director, stale] of [['Orrin Brask', 'tt9500007'], ['Orrin Vale', 'tt9500008']] as const) {
      const r = m({ title: 'Tidewater Bell', director, imdbIdHint: stale });
      expect(r.tconst, director).not.toBe(stale);
      expect(r.score, director).toBeLessThan(100);
    }
    // The hinted film's own director still corroborates it.
    expect(m({ title: 'Tidewater Bell', director: 'Orrin Vale', imdbIdHint: 'tt9500007' })).toMatchObject({ status: 'matched', tconst: 'tt9500007', score: 100 });
  });

  it('a runtime far off the hinted film contradicts the hint, the same test the merge uses', () => {
    // Without a hint the runtime picks the remake; a stale hint for the original must not win outright.
    expect(m({ title: 'The Glass Harbor', runtimeMin: 128 })).toMatchObject({ status: 'matched', tconst: 'tt9000002' });
    const r = m({ title: 'The Glass Harbor', runtimeMin: 128, imdbIdHint: 'tt9000001' });
    expect(r.tconst).not.toBe('tt9000001');
    expect(r.score).toBeLessThan(100);
    // Within 3 minutes the hint is still accepted outright.
    expect(m({ title: 'The Glass Harbor', runtimeMin: 115, imdbIdHint: 'tt9000001' })).toMatchObject({ status: 'matched', tconst: 'tt9000001', score: 100 });
    // A longer cut of a title with no rival still matches its hint.
    expect(m({ title: 'Night Ferry', runtimeMin: 140, imdbIdHint: 'tt9000010' })).toMatchObject({ status: 'matched', tconst: 'tt9000010' });
  });

  it('a runtime off a hinted film with no same-titled rival that fits it keeps the hint outright', () => {
    // A shorter release cut: no other film the runtime could point at, so the hint stands
    // even when the title carries an unstripped tag or the director is in another script.
    expect(m({ title: 'Nightwardens (Subtitled)', director: 'Zane Snyderman', runtimeMin: 120, imdbIdHint: 'tt9500003' })).toMatchObject({
      status: 'matched',
      tconst: 'tt9500003',
      score: 100,
    });
    expect(m({ title: 'Nightwardens', director: '山田太郎', runtimeMin: 120, imdbIdHint: 'tt9500003' })).toMatchObject({
      status: 'matched',
      tconst: 'tt9500003',
      score: 100,
    });
    expect(m({ title: 'Night Ferry', runtimeMin: 140, imdbIdHint: 'tt9000010' })).toMatchObject({ status: 'matched', tconst: 'tt9000010', score: 100 });
    // A same-titled rival the runtime fits still turns the hint into one candidate among others.
    expect(m({ title: 'Tidewater Bell', runtimeMin: 121, imdbIdHint: 'tt9500007' }).tconst).not.toBe('tt9500007');
  });

  it('keeps trusting a hint when the source director is Unknown, non-Latin or merely spelled differently', () => {
    expect(m({ title: 'Wolf Season', director: 'Unknown', imdbIdHint: 'tt9000019' })).toMatchObject({ status: 'matched', tconst: 'tt9000019' });
    expect(m({ title: 'Wolf Season', director: '山田太郎', imdbIdHint: 'tt9000019' })).toMatchObject({ status: 'matched', tconst: 'tt9000019' });
    expect(m({ title: 'Wolf Season', director: 'Dana J. Fincher Jr.', imdbIdHint: 'tt9000019' })).toMatchObject({ status: 'matched', tconst: 'tt9000019' });
  });

  it('still matches a contradicted hint when it is the only fitting candidate', () => {
    // The source names an author rather than the director, but title and runtime agree.
    const r = m({ title: 'Wolf Season', director: 'Jane Novelist', runtimeMin: 158, imdbIdHint: 'tt9000019' });
    expect(r).toMatchObject({ status: 'matched', tconst: 'tt9000019' });
  });

  it('ignores a hint that is not in the catalog and falls back to the title', () => {
    const r = m({ title: 'Wolf Season', year: 2007, imdbIdHint: 'tt9999998' });
    expect(r).toMatchObject({ status: 'matched', tconst: 'tt9000019' });
  });

  it('picks the right remake by runtime', () => {
    expect(m({ title: 'The Glass Harbor', runtimeMin: 128 })).toMatchObject({ status: 'matched', tconst: 'tt9000002' });
    expect(m({ title: 'Glass Harbor', runtimeMin: 113 })).toMatchObject({ status: 'matched', tconst: 'tt9000001' });
  });

  it('is ambiguous between remakes with no year or runtime, listing both', () => {
    const r = m({ title: 'The Glass Harbor' });
    expect(r.status).toBe('ambiguous');
    expect(r.tconst).toBeNull();
    expect(r.candidates.map((c) => c.tconst).sort()).toEqual(['tt9000001', 'tt9000002']);
  });

  it('does not auto-match when the director contradicts the year and runtime', () => {
    const r = m({ title: 'The Glass Harbor', year: 2009, runtimeMin: 128, director: 'Orrin Vale' });
    expect(r.status).toBe('ambiguous');
    expect(r.tconst).toBeNull();
  });

  it('is unmatched for a title absent from the catalog', () => {
    const r = m({ title: 'Completely Imaginary Picture', year: 2001, runtimeMin: 99 });
    expect(r).toMatchObject({ status: 'unmatched', tconst: null, candidates: [] });
  });

  it('never matches on a TV series of the same title', () => {
    const r = m({ title: 'Harbor Patrol', year: 2001 });
    expect(r.status).toBe('unmatched');
  });

  // Review Focus #4: messy real-world titles match or are ambiguous, never mismatch.
  describe('messy titles', () => {
    const expectSafe = (input: MatchInput, right: string) => {
      const r = m(input);
      expect(['matched', 'ambiguous']).toContain(r.status);
      if (r.status === 'matched') expect(r.tconst).toBe(right);
      else expect(r.candidates.map((c) => c.tconst)).toContain(right);
      return r;
    };

    it('a trailing space and colon/dash punctuation', () => {
      const r = expectSafe({ title: 'Operation: Improbable - Last Reckoning ', runtimeMin: 163, director: 'Kit McQuarrel' }, 'tt9500001');
      expect(r.status).toBe('matched');
    });

    it('a partial title never auto-matches the longer catalog title', () => {
      const r = m({ title: 'Operation: Improbable - Last Reckoning Part', runtimeMin: 169, director: 'Kit McQuarrel', year: 2025 });
      expect(r.status).not.toBe('matched');
    });

    it("an edition suffix (Director's Cut) with a longer runtime", () => {
      const r = expectSafe({ title: "Nightwardens (Director's Cut)", runtimeMin: 186, director: 'Zane Snyderman' }, 'tt9500003');
      expect(r.status).toBe('matched');
    });

    it('a year in parentheses, with director Unknown', () => {
      const r = expectSafe({ title: 'Perigee 9 (2019)', director: 'Unknown', runtimeMin: null }, 'tt9500004');
      expect(r.status).toBe('matched');
    });

    it('"and" in the source where the catalog has "&", with co-directors', () => {
      const r = expectSafe({ title: 'Salt and Signal', director: 'Orrin Vale & Mira Calloway' }, 'tt9000005');
      expect(r.status).toBe('matched');
    });

    it('three co-directors in one string', () => {
      const r = expectSafe({ title: 'Glass Animals', director: 'Selma Ruiz, Mira Calloway & Dan Kuenzel' }, 'tt9000028');
      expect(r.status).toBe('matched');
    });

    it('sibling co-directors credited under other first names', () => {
      const r = expectSafe({ title: 'Wired Reality', director: 'Andy Kowalczyk & Larry Kowalczyk' }, 'tt9500006');
      expect(r.status).toBe('matched');
    });

    it('director Unknown is ignored, not held against a candidate', () => {
      const r = expectSafe({ title: 'Quiet Ledger', year: 1999, director: 'Unknown' }, 'tt9000003');
      expect(r.status).toBe('matched');
      expect(m({ title: 'The Glass Harbor', director: 'Unknown' }).status).toBe('ambiguous');
    });
  });
});

describe('rematch', () => {
  const insert = (title: string, extra: Record<string, string | number | null> = {}) => {
    const cols = ['source_title', 'source', ...Object.keys(extra)];
    const vals = [title, 'paste', ...Object.values(extra)];
    const r = db.sql
      .prepare(`INSERT INTO library_items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...vals);
    return Number(r.lastInsertRowid);
  };
  const item = (id: number) =>
    db.sql.prepare('SELECT tconst, match_status, match_score, updated_at FROM library_items WHERE id = ?').get(id) as {
      tconst: string | null;
      match_status: string;
      match_score: number | null;
      updated_at: string;
    };
  const candidates = (id: number) =>
    (db.sql.prepare('SELECT tconst FROM match_candidates WHERE item_id = ? ORDER BY tconst').all(id) as { tconst: string }[]).map(
      (r) => r.tconst,
    );

  beforeEach(() => {
    db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items;');
  });

  it('resolves items, stores candidates for ambiguous ones and reports counts', () => {
    const a = insert('Wolf Season', { source_year: 2007 });
    const b = insert('The Glass Harbor');
    const c = insert('Completely Imaginary Picture');
    const res = rematch(db);
    expect(res).toEqual({ matched: 1, ambiguous: 1, unmatched: 1 });
    expect(item(a)).toMatchObject({ tconst: 'tt9000019', match_status: 'matched' });
    expect(item(a).match_score).toBeGreaterThanOrEqual(70);
    expect(item(b)).toMatchObject({ tconst: null, match_status: 'ambiguous' });
    expect(candidates(b)).toEqual(['tt9000001', 'tt9000002']);
    expect(item(c)).toMatchObject({ tconst: null, match_status: 'unmatched' });
    expect(candidates(c)).toEqual([]);
  });

  it('clears stale candidates once an item resolves', () => {
    const b = insert('The Glass Harbor');
    rematch(db);
    expect(candidates(b)).toHaveLength(2);
    db.sql.prepare('UPDATE library_items SET source_runtime_min = 128 WHERE id = ?').run(b);
    rematch(db, { onlyUnresolved: true });
    expect(item(b)).toMatchObject({ tconst: 'tt9000002', match_status: 'matched' });
    expect(candidates(b)).toEqual([]);
  });

  it('leaves manual rows untouched', () => {
    const id = insert('Wolf Season', { source_year: 2007, tconst: 'tt9000020', match_status: 'manual', match_score: null });
    const before = item(id);
    const res = rematch(db);
    expect(item(id)).toEqual(before);
    expect(res).toEqual({ matched: 0, ambiguous: 0, unmatched: 0 });
  });

  it('onlyUnresolved skips matched rows', () => {
    const id = insert('Some Other Name', { tconst: 'tt9000003', match_status: 'matched', match_score: 90 });
    const res = rematch(db, { onlyUnresolved: true });
    expect(res).toEqual({ matched: 0, ambiguous: 0, unmatched: 0 });
    expect(item(id)).toMatchObject({ tconst: 'tt9000003', match_status: 'matched' });
  });

  it('a full rematch keeps a matched tconst that is still in the catalog', () => {
    const id = insert('Some Other Name', { tconst: 'tt9000003', match_status: 'matched', match_score: 100 });
    const res = rematch(db);
    expect(res).toEqual({ matched: 1, ambiguous: 0, unmatched: 0 });
    expect(item(id)).toMatchObject({ tconst: 'tt9000003', match_status: 'matched' });
  });
});

describe('directorsConflict', () => {
  it('compares people by surname, never by a shared first name', () => {
    expect(directorsConflict('Orrin Vale', 'Orrin Brask')).toBe(true);
    expect(directorsConflict('Orrin Vale', 'O. Vale')).toBe(false);
    expect(directorsConflict('Dana J. Fincher Jr.', 'Dana Fincher')).toBe(false);
    expect(directorsConflict('Orrin Vale & Mira Calloway', 'Mira Calloway')).toBe(false);
    expect(directorsConflict('Unknown', 'Orrin Brask')).toBe(false);
    expect(directorsConflict(null, 'Orrin Brask')).toBe(false);
  });
});

/**
 * core/exporters: Letterboxd import CSV and Trakt import CSV. Pure writers
 * over library rows plus viewings, so these tests need no file system. Golden
 * files pin the exact bytes. All titles, people and ids are made up.
 */
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { addToList, createList } from '../src/core/lists.js';
import { addViewing } from '../src/core/viewings.js';
import type { LibraryItem } from '../src/core/types.js';
import type { Viewing } from '../src/core/viewings.js';
import { loadExportSources, type ExportSource } from '../src/core/exporters/common.js';
import { LETTERBOXD_MAX_BYTES, letterboxdCsv, letterboxdField } from '../src/core/exporters/letterboxd.js';
import { traktCsv, traktField } from '../src/core/exporters/trakt.js';

const GOLDEN = join(import.meta.dirname, 'fixtures', 'export');
const golden = (name: string) => readFileSync(join(GOLDEN, name), 'utf8');

let vid = 0;
function play(itemId: number, watchedAt: string | null, source: Viewing['source'], more: Partial<Viewing> = {}): Viewing {
  vid += 1;
  return { id: vid, itemId, watchedAt, rewatch: null, rating: null, source, sourceRef: null, addedAt: `2024-01-01T00:00:${String(vid).padStart(2, '0')}.000Z`, ...more };
}

function src(item: Partial<LibraryItem> & { id: number; sourceTitle: string }, more: Partial<Omit<ExportSource, 'item'>> = {}): ExportSource {
  return {
    item: {
      tconst: null,
      sourceYear: null,
      sourceDirector: null,
      sourceRuntimeMin: null,
      sourceGenre: null,
      collection: null,
      owned: true,
      sourceOwnedRaw: null,
      status: 'queue',
      watchedEra: null,
      watchedAt: null,
      myRating: null,
      notes: null,
      matchStatus: 'unmatched',
      matchScore: null,
      source: 'paste',
      applePersistentId: null,
      addedAt: '2024-02-01T10:00:00.000Z',
      updatedAt: '2024-02-02T10:00:00.000Z',
      ...item,
    },
    externalIds: {},
    catalog: null,
    viewings: [],
    lists: [],
    ...more,
  };
}

/** The fixture library the golden files are made from. */
function fixture(): ExportSource[] {
  vid = 0;
  return [
    // A linked film with two diary entries (one a rewatch), a same-night Trakt
    // play, a Letterboxd link and a list.
    src(
      { id: 1, sourceTitle: 'The Glass Harbor', sourceYear: 1978, tconst: 'tt9000001', matchStatus: 'matched', status: 'watched', myRating: 8, sourceDirector: 'Ignored Person', updatedAt: '2024-03-04T05:06:07.000Z' },
      {
        externalIds: { letterboxd: 'https://boxd.it/aB3c', trakt: '9007199254740993' },
        catalog: { title: 'Catalog Harbor', year: 1977 },
        viewings: [
          play(1, '2020-05-01', 'letterboxd', { rewatch: false, rating: 7, sourceRef: 'https://boxd.it/e1' }),
          play(1, '2023-10-31', 'letterboxd', { rewatch: true, sourceRef: 'https://boxd.it/e2' }),
          play(1, '2023-10-31T21:30:00Z', 'trakt', { sourceRef: '9007199254740995' }),
        ],
        lists: ['Halloween', 'Late, late shows'],
      },
    ),
    // An unmatched item with commas, quotes and an accent, a source director
    // credit and only a dateless play.
    src(
      { id: 2, sourceTitle: 'Say "Hi", Café', sourceYear: 2001, sourceDirector: 'Ana Ruiz, Bo Li', status: 'watched', myRating: 6 },
      { viewings: [play(2, null, 'manual')] },
    ),
    // A queued linked film with no year of its own: the catalog fills it.
    src({ id: 3, sourceTitle: 'Night, Again', tconst: 'tt9000002', matchStatus: 'manual', status: 'queue', addedAt: '2024-05-06T07:08:09.000Z' }, { catalog: { title: 'Night, Again', year: 1999 } }),
    // A second edition of film 1, played on another day with no flag: a derived rewatch.
    src(
      { id: 4, sourceTitle: 'The Glass Harbor (4K)', sourceYear: 1978, tconst: 'tt9000001', matchStatus: 'manual', status: 'watched' },
      { viewings: [play(4, '2021-01-01 20:15', 'apple-tv')], lists: ['4K'] },
    ),
    // Watched, no plays, no rating, no year, no id.
    src({ id: 5, sourceTitle: 'Plain', status: 'watched' }),
    // Someday, no id, no year: Letterboxd matches it by title, Trakt drops it.
    src({ id: 6, sourceTitle: 'Nameless Someday', status: 'someday' }),
    // An ambiguous item's tconst is only a hint: no imdbID, its own director, no catalog fill.
    src(
      { id: 7, sourceTitle: 'Echo Valley', tconst: 'tt9000003', matchStatus: 'ambiguous', status: 'priority', sourceYear: 2005, sourceDirector: 'Cy Moe' },
      { catalog: { title: 'Wrong Film', year: 1950 } },
    ),
  ];
}

describe('letterboxd field quoting', () => {
  it('quotes commas and backslash-escapes inner quotes, and flattens line breaks', () => {
    expect(letterboxdField('Plain')).toBe('Plain');
    expect(letterboxdField('a,b')).toBe('"a,b"');
    expect(letterboxdField('Say "Hi"')).toBe('"Say \\"Hi\\""');
    expect(letterboxdField('two\r\nlines')).toBe('two lines');
    expect(letterboxdField('')).toBe('');
    // A backslash is literal unless the quoted field would put it right before a quote.
    expect(letterboxdField('AC\\DC')).toBe('AC\\DC');
    expect(letterboxdField('a,b\\c')).toBe('"a,b\\c"');
    expect(letterboxdField('a,b\\')).toBeNull();
    expect(letterboxdField('say \\"x"')).toBeNull();
  });

  it('a row with a field Letterboxd\'s quoting cannot hold is left out and named', () => {
    const lib = [src({ id: 9, sourceTitle: 'Ends, in a slash\\', status: 'watched' }), src({ id: 10, sourceTitle: 'Fine', status: 'watched' })];
    const r = letterboxdCsv(lib, { what: 'watched' });
    expect(r.rows).toBe(1);
    expect(r.unrepresentable).toEqual([9]);
    expect(r.files[0]?.content).not.toContain('slash');
  });
});

describe('trakt field quoting', () => {
  it('uses RFC 4180 quoting (what PapaParse reads by default)', () => {
    expect(traktField('Plain')).toBe('Plain');
    expect(traktField('a,b')).toBe('"a,b"');
    expect(traktField('Say "Hi"')).toBe('"Say ""Hi"""');
    expect(traktField('two\nlines')).toBe('two lines');
  });
});

describe('letterboxdCsv', () => {
  it('watched: one row per dated night, editions collapsed, plus watched films with no dated play (golden)', () => {
    const r = letterboxdCsv(fixture(), { what: 'watched' });
    expect(r.files).toHaveLength(1);
    expect(r.files[0]?.name).toBe('letterboxd-watched-1.csv');
    expect(r.files[0]?.content).toBe(golden('letterboxd-watched.csv'));
    expect(r.rows).toBe(5);
  });

  it('--lists-as-tags puts each film\'s lists in Tags on diary rows only (golden)', () => {
    const r = letterboxdCsv(fixture(), { what: 'watched', listsAsTags: true });
    expect(r.files[0]?.content).toBe(golden('letterboxd-watched-tags.csv'));
  });

  it('watchlist: queue, priority and someday films, no ratings or dates (golden)', () => {
    const r = letterboxdCsv(fixture(), { what: 'watchlist' });
    expect(r.files[0]?.name).toBe('letterboxd-watchlist-1.csv');
    expect(r.files[0]?.content).toBe(golden('letterboxd-watchlist.csv'));
    expect(r.rows).toBe(3);
  });

  it('list: the members of one list, once per film', () => {
    const r = letterboxdCsv(fixture(), { what: 'list', list: 'Halloween' });
    expect(r.files[0]?.name).toBe('letterboxd-list-1.csv');
    expect(r.files[0]?.content).toBe('imdbID,Title,Year,Directors,LetterboxdURI\ntt9000001,The Glass Harbor,1978,,https://boxd.it/aB3c\n');
    // An edition on the list brings in the film once.
    const r4 = letterboxdCsv(fixture(), { what: 'list', list: '4K' });
    expect(r4.rows).toBe(1);
    expect(r4.files[0]?.content).toContain('tt9000001,The Glass Harbor,1978');
  });

  it('a watched film never lands on the watchlist through a queued edition', () => {
    const lib = fixture();
    lib.push(src({ id: 8, sourceTitle: 'The Glass Harbor (Director\'s Cut)', tconst: 'tt9000001', matchStatus: 'matched', status: 'queue' }));
    const r = letterboxdCsv(lib, { what: 'watchlist' });
    expect(r.files[0]?.content).not.toContain('tt9000001');
  });

  it('a film queued again after it was watched is on the watchlist; status decides, not plays', () => {
    vid = 200;
    const lib = [src({ id: 1, sourceTitle: 'Again Soon', sourceYear: 1985, status: 'priority' }, { viewings: [play(1, '2015-06-06', 'manual')] })];
    expect(letterboxdCsv(lib, { what: 'watchlist' }).rows).toBe(1);
    expect(traktCsv(lib, { what: 'watchlist' }).rows.watchlist).toBe(1);
    // Its old play is still history.
    expect(letterboxdCsv(lib, { what: 'watched' }).rows).toBe(1);
  });

  it('an empty selection writes no file', () => {
    const r = letterboxdCsv([src({ id: 1, sourceTitle: 'Only Queued' })], { what: 'watched' });
    expect(r.files).toEqual([]);
    expect(r.rows).toBe(0);
  });

  it('never writes IMDb ratings, votes, genres or notes', () => {
    const lib = fixture();
    (lib[0] as ExportSource).item.notes = 'secret note';
    (lib[0] as ExportSource).item.sourceGenre = 'Horror';
    const all = ['watched', 'watchlist'].map((what) => letterboxdCsv(lib, { what: what as 'watched' }).files.map((f) => f.content).join('')).join('');
    expect(all).not.toMatch(/secret note|Horror|Catalog Harbor|Wrong Film|Ignored Person/);
  });

  it('splits by bytes at the limit, repeating the header, never mid-row', () => {
    const lib: ExportSource[] = [];
    for (let i = 1; i <= 30_000; i++) {
      lib.push(src({ id: i, sourceTitle: `Generated Film Number ${i} Ünïcödé`, sourceYear: 1950 + (i % 70), status: 'watched', myRating: 1 + (i % 10) }, { viewings: [play(i, '2022-01-02', 'manual')] }));
    }
    const r = letterboxdCsv(lib, { what: 'watched' });
    expect(r.files.length).toBeGreaterThan(1);
    expect(r.files.map((f) => f.name)).toEqual(r.files.map((_, i) => `letterboxd-watched-${i + 1}.csv`));
    const header = 'imdbID,Title,Year,Directors,LetterboxdURI,WatchedDate,Rewatch,Rating10,Tags';
    let rows = 0;
    for (const f of r.files) {
      expect(Buffer.byteLength(f.content, 'utf8')).toBeLessThanOrEqual(LETTERBOXD_MAX_BYTES);
      const lines = f.content.split('\n');
      expect(lines[0]).toBe(header);
      expect(lines.at(-1)).toBe('');
      for (const l of lines.slice(1, -1)) expect(l).toMatch(/^,Generated Film Number \d+ Ünïcödé,\d{4},,,2022-01-02,false,\d+,$/);
      rows += lines.length - 2;
      expect(f.rows).toBe(lines.length - 2);
    }
    expect(rows).toBe(30_000);
    expect(r.rows).toBe(30_000);
  });

  it('a single row over the limit is an error naming the item', () => {
    const lib = [src({ id: 42, sourceTitle: 'x'.repeat(200), status: 'watched' })];
    expect(() => letterboxdCsv(lib, { what: 'watched', maxBytes: 150 })).toThrow(/item 42/);
  });

  it('round trip: a small reader of the import format gets back every night, flag and rating', () => {
    const r = letterboxdCsv(fixture(), { what: 'watched', listsAsTags: true });
    const rows = readLetterboxd(r.files[0]?.content ?? '');
    expect(rows.map((x) => [x.Title, x.WatchedDate, x.Rewatch, x.Rating10, x.Tags])).toEqual([
      ['The Glass Harbor', '2020-05-01', 'false', '7', '4K,Halloween,Late late shows'],
      ['The Glass Harbor', '2021-01-01', 'true', '', '4K,Halloween,Late late shows'],
      ['The Glass Harbor', '2023-10-31', 'true', '8', '4K,Halloween,Late late shows'],
      ['Say "Hi", Café', '', '', '6', ''],
      ['Plain', '', '', '', ''],
    ]);
    expect(rows[3]?.Directors).toBe('Ana Ruiz,Bo Li');
  });
});

describe('traktCsv', () => {
  it('all: history, ratings and watchlist rows in one file (golden)', () => {
    const r = traktCsv(fixture(), { what: 'all' });
    expect(r.content).toBe(golden('trakt-all.csv'));
    expect(r.rows).toEqual({ history: 4, ratings: 2, watchlist: 2 });
    // Films 5 (watched) and 6 (someday) have no id and no year: dropped and counted.
    expect(r.skipped).toBe(2);
    expect(r.dateless).toBe(1);
  });

  it('each --what writes only its own rows', () => {
    for (const what of ['history', 'ratings', 'watchlist'] as const) {
      const r = traktCsv(fixture(), { what });
      const actions = new Set(r.content.trim().split('\n').slice(1).map((l) => l.split(',')[1]));
      expect([...actions]).toEqual([what]);
    }
  });

  it('keeps int64 Trakt ids exact and never writes IMDb data for unlinked items', () => {
    const r = traktCsv(fixture(), { what: 'all' });
    expect(r.content).toContain('9007199254740993');
    expect(r.content).not.toMatch(/tt9000003|Wrong Film|Catalog Harbor/);
  });

  it('a watched film with no plays still marks it watched, as one dateless play', () => {
    const r = traktCsv([src({ id: 1, sourceTitle: 'Seen Long Ago', sourceYear: 1990, status: 'watched' })], { what: 'history' });
    expect(r.content).toBe('type,action,title,year,imdb,trakt,watched_at,rating,rated_at,listed_at\nmovie,history,Seen Long Ago,1990,,,unknown,,,\n');
    expect(r.dateless).toBe(1);
  });

  it('counts skipped movies, not rows', () => {
    vid = 100;
    const lib = [src({ id: 1, sourceTitle: 'No Year', status: 'watched', myRating: 5 }, { viewings: [play(1, '2020-01-01', 'manual'), play(1, '2021-01-01', 'manual')] })];
    expect(traktCsv(lib, { what: 'all' }).skipped).toBe(1);
  });

  it('an empty selection has no rows', () => {
    const r = traktCsv([src({ id: 1, sourceTitle: 'Nothing', sourceYear: 2000, status: 'queue' })], { what: 'history' });
    expect(r.rows).toEqual({ history: 0, ratings: 0, watchlist: 0 });
  });
});

describe('loadExportSources', () => {
  let tmp: string;
  let db: Db;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'screentrackr-exporters-'));
    db = openDb(join(tmp, 'home'));
  });
  afterAll(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reads items, external ids, plays, lists and the catalog title only for linked items', () => {
    db.sql.exec("INSERT INTO titles (tconst, title, year) VALUES ('tt9000001', 'Catalog Title', 1977), ('tt9000003', 'Hint Title', 1950)");
    const a = Number(db.sql.prepare("INSERT INTO library_items (source_title, tconst, match_status, source, status) VALUES ('Own Title', 'tt9000001', 'matched', 'paste', 'watched')").run().lastInsertRowid);
    const b = Number(db.sql.prepare("INSERT INTO library_items (source_title, tconst, match_status, source) VALUES ('Hinted', 'tt9000003', 'unmatched', 'paste')").run().lastInsertRowid);
    db.sql.prepare("INSERT INTO item_external_ids (item_id, kind, value) VALUES (?, 'trakt', '123')").run(a);
    addViewing(db, a, { watchedAt: '2022-02-02', source: 'manual' });
    createList(db, 'Faves');
    addToList(db, 'Faves', [a]);
    const s = loadExportSources(db);
    expect(s.map((x) => x.item.id)).toEqual([a, b]);
    expect(s[0]?.externalIds).toEqual({ trakt: '123' });
    expect(s[0]?.catalog).toEqual({ title: 'Catalog Title', year: 1977 });
    expect(s[0]?.viewings.map((v) => v.watchedAt)).toEqual(['2022-02-02']);
    expect(s[0]?.lists).toEqual(['Faves']);
    expect(s[1]?.catalog).toBeNull();
  });
});

/** A minimal reader of Letterboxd's import CSV: commas, double quotes, backslash-escaped inner quotes. */
function readLetterboxd(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((l) => l !== '');
  const parse = (line: string): string[] => {
    const out: string[] = [];
    let i = 0;
    while (i <= line.length) {
      if (line[i] === '"') {
        let v = '';
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && line[i + 1] === '"') {
            v += '"';
            i += 2;
          } else v += line[i++];
        }
        out.push(v);
        i += 2;
      } else {
        const end = line.indexOf(',', i);
        out.push(line.slice(i, end === -1 ? line.length : end));
        i = end === -1 ? line.length + 1 : end + 1;
      }
    }
    return out;
  };
  const [head, ...rest] = lines;
  const cols = parse(head ?? '');
  return rest.map((l) => Object.fromEntries(parse(l).map((v, i) => [cols[i], v])));
}

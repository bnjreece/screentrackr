import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { DATASETS, downloadDatasets } from '../src/core/catalog/download.js';
import { readTsvGz } from '../src/core/catalog/tsv.js';
import { catalogReady, openDb, type Db } from '../src/core/db.js';
import { cacheDir } from '../src/core/home.js';
import { normalizeTitle } from '../src/core/normalize.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');
const gzName = (d: string) => `${d}.tsv.gz`;

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-cat-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('readTsvGz', () => {
  it('uses the header row and maps \\N to null', async () => {
    const rows = await collect(readTsvGz(join(FIXTURES, 'title.basics.tsv.gz')));
    const lost = rows.find((r) => r.tconst === 'tt9000015');
    expect(lost).toMatchObject({ primaryTitle: 'Lost Reel', genres: null, endYear: null });
    const atlas = rows.find((r) => r.tconst === 'tt9000014');
    expect(atlas?.startYear).toBeNull();
    expect(rows.every((r) => 'titleType' in r)).toBe(true);
  });

  it('keeps quotes literally, strips CR, fills short rows with null and skips blank lines', async () => {
    const p = join(tmp, 'x.tsv.gz');
    writeFileSync(p, gzipSync(Buffer.from('a\tb\tc\r\n"quoted\ttitle\r\n\nonly\n', 'utf8')));
    const rows = await collect(readTsvGz(p));
    expect(rows).toEqual([
      { a: '"quoted', b: 'title', c: null },
      { a: 'only', b: null, c: null },
    ]);
  });

  it('rejects on a truncated gzip', async () => {
    const p = join(tmp, 'trunc.tsv.gz');
    const full = readFileSync(join(FIXTURES, 'title.basics.tsv.gz'));
    writeFileSync(p, full.subarray(0, Math.floor(full.length / 2)));
    await expect(collect(readTsvGz(p))).rejects.toThrow();
  });
});

describe('normalizeTitle (used for titles.norm_title)', () => {
  it('handles the spec examples', () => {
    expect(normalizeTitle('The Deep Trench (Special Edition)')).toBe('deep trench');
    expect(normalizeTitle('Orbit 9 (2019)')).toBe('orbit 9');
    expect(normalizeTitle('Mission: Unlikely - Final Count ')).toBe('mission unlikely final count');
    expect(normalizeTitle('Lanterns & The Glass Harbor')).toBe('lanterns and the glass harbor');
    expect(normalizeTitle("Night Watchers (Director's Cut)")).toBe('night watchers');
  });
});

describe('buildCatalog', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(join(tmp, 'home'));
  });
  afterEach(() => db.close());

  const count = (sql: string, ...params: (string | number)[]) =>
    (db.sql.prepare(sql).get(...params) as { n: number }).n;
  const tconsts = () =>
    (db.sql.prepare('SELECT tconst FROM titles ORDER BY tconst').all() as { tconst: string }[]).map(
      (r) => r.tconst,
    );

  it('loads only movie rows by default', async () => {
    const stats = await buildCatalog(db, { cacheDir: FIXTURES });
    const ids = tconsts();
    expect(ids).toHaveLength(30);
    expect(ids.every((t) => t.startsWith('tt90000'))).toBe(true);
    expect(stats.movies).toBe(30);
    expect(stats.seconds).toBeGreaterThanOrEqual(0);
  });

  it('adds the two tvMovie rows with includeTvMovies', async () => {
    const stats = await buildCatalog(db, { cacheDir: FIXTURES, includeTvMovies: true });
    const ids = tconsts();
    expect(ids).toHaveLength(32);
    expect(ids).toContain('tt9200001');
    expect(ids).toContain('tt9200002');
    expect(ids).not.toContain('tt9100001');
    expect(ids).not.toContain('tt9300001');
    expect(ids).not.toContain('tt9400001');
    expect(stats.movies).toBe(32);
  });

  it('stores title fields, nulls and the normalized title', async () => {
    await buildCatalog(db, { cacheDir: FIXTURES });
    const row = (t: string) => db.sql.prepare('SELECT * FROM titles WHERE tconst = ?').get(t) as Record<string, unknown>;
    expect(row('tt9000003')).toMatchObject({
      title: 'Quiet Ledger',
      year: 1999,
      runtime_min: 139,
      genres_csv: 'Crime,Drama,Thriller',
      is_adult: 0,
      norm_title: 'quiet ledger',
    });
    expect(row('tt9000001').norm_title).toBe('glass harbor');
    expect(row('tt9000011').original_title).toBe('Le Phare Noir');
    expect(row('tt9000013').runtime_min).toBeNull();
    expect(row('tt9000014').year).toBeNull();
    expect(row('tt9000015').genres_csv).toBeNull();
    expect(row('tt9000017').is_adult).toBe(1);
  });

  it('splits genres on commas into title_genres', async () => {
    await buildCatalog(db, { cacheDir: FIXTURES });
    const g = (db.sql.prepare('SELECT genre FROM title_genres WHERE tconst = ? ORDER BY genre').all('tt9000003') as {
      genre: string;
    }[]).map((r) => r.genre);
    expect(g).toEqual(['Crime', 'Drama', 'Thriller']);
    expect(count("SELECT COUNT(*) AS n FROM title_genres WHERE tconst = 'tt9000015'")).toBe(0);
  });

  it('loads ratings only for kept titles', async () => {
    const stats = await buildCatalog(db, { cacheDir: FIXTURES });
    expect(stats.rated).toBe(27);
    expect(count('SELECT COUNT(*) AS n FROM ratings')).toBe(27);
    expect(count("SELECT COUNT(*) AS n FROM ratings WHERE tconst IN ('tt9999999', 'tt9100001')")).toBe(0);
    const r = db.sql.prepare("SELECT rating, votes FROM ratings WHERE tconst = 'tt9000003'").get();
    expect(r).toEqual({ rating: 8.6, votes: 900000 });
  });

  it('keeps only directors and actors/actresses with ordering <= 6', async () => {
    const stats = await buildCatalog(db, { cacheDir: FIXTURES });
    const rows = db.sql
      .prepare("SELECT nconst, role, ord FROM title_people WHERE tconst = 'tt9000003' ORDER BY role, ord")
      .all();
    expect(rows).toEqual([
      { nconst: 'nm9000011', role: 'actor', ord: 1 },
      { nconst: 'nm9000012', role: 'actor', ord: 2 },
      { nconst: 'nm9000013', role: 'actor', ord: 3 },
      { nconst: 'nm9000014', role: 'actor', ord: 5 },
      { nconst: 'nm9000015', role: 'actor', ord: 6 },
      { nconst: 'nm9000001', role: 'director', ord: 1 },
    ]);
    const co = db.sql
      .prepare("SELECT nconst, ord FROM title_people WHERE tconst = 'tt9000005' AND role = 'director' ORDER BY ord")
      .all();
    expect(co).toEqual([
      { nconst: 'nm9000003', ord: 1 },
      { nconst: 'nm9000004', ord: 2 },
    ]);
    expect(stats.castRows).toBe(count("SELECT COUNT(*) AS n FROM title_people WHERE role = 'actor'"));
    expect(stats.castRows).toBeGreaterThan(0);
  });

  it('loads only referenced people, and drops credits whose person is missing', async () => {
    const stats = await buildCatalog(db, { cacheDir: FIXTURES });
    const ids = (db.sql.prepare('SELECT nconst FROM people ORDER BY nconst').all() as { nconst: string }[]).map(
      (r) => r.nconst,
    );
    expect(ids).toEqual([
      'nm9000001', 'nm9000002', 'nm9000003', 'nm9000004', 'nm9000005', 'nm9000006',
      'nm9000011', 'nm9000012', 'nm9000013', 'nm9000014', 'nm9000015', 'nm9000016', 'nm9000017', 'nm9000018',
    ]);
    expect(stats.people).toBe(14);
    expect(count('SELECT COUNT(*) AS n FROM title_people WHERE nconst NOT IN (SELECT nconst FROM people)')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM title_people WHERE tconst = 'tt9000016' AND role = 'director'")).toBe(0);
  });

  it('withCast: false loads 0 actor rows and does not need title.principals', async () => {
    const cache = join(tmp, 'nocast');
    mkdirSync(cache);
    for (const d of DATASETS) if (d !== 'title.principals') copyFileSync(join(FIXTURES, gzName(d)), join(cache, gzName(d)));
    const stats = await buildCatalog(db, { cacheDir: cache, withCast: false });
    expect(stats.castRows).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM title_people WHERE role = 'actor'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM title_people WHERE role = 'director'")).toBeGreaterThan(0);
    expect(stats.people).toBe(6);
  });

  it('sets meta.catalog_built_at and per-dataset dates', async () => {
    expect(catalogReady(db)).toBe(false);
    await buildCatalog(db, { cacheDir: FIXTURES });
    expect(catalogReady(db)).toBe(true);
    const meta = Object.fromEntries(
      (db.sql.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]),
    );
    expect(Date.parse(meta.catalog_built_at as string)).not.toBeNaN();
    for (const d of DATASETS) expect(meta[`dataset_date:${d}`]).toBeTruthy();
    expect(meta.catalog_with_cast).toBe('1');
  });

  it('populates titles_fts when FTS5 is available', async () => {
    await buildCatalog(db, { cacheDir: FIXTURES });
    if (!db.fts) return;
    const hits = db.sql.prepare("SELECT tconst FROM titles_fts WHERE titles_fts MATCH 'phare'").all();
    expect(hits).toEqual([{ tconst: 'tt9000011' }]);
    expect(count('SELECT COUNT(*) AS n FROM titles_fts')).toBe(30);
  });

  it('rebuilds cleanly and never touches the library', async () => {
    db.sql
      .prepare("INSERT INTO library_items (source_title, tconst, status, source) VALUES ('Quiet Ledger', 'tt9000003', 'watched', 'manual')")
      .run();
    await buildCatalog(db, { cacheDir: FIXTURES });
    const stats = await buildCatalog(db, { cacheDir: FIXTURES, includeTvMovies: true });
    expect(stats.movies).toBe(32);
    expect(count('SELECT COUNT(*) AS n FROM titles')).toBe(32);
    expect(count('SELECT COUNT(*) AS n FROM library_items')).toBe(1);
    if (db.fts) expect(count('SELECT COUNT(*) AS n FROM titles_fts')).toBe(32);
    const leftovers = db.sql.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new%' ESCAPE '\\'").all();
    expect(leftovers).toEqual([]);
    const idx = (db.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(idx).toContain('titles_norm_title');
    expect(idx).toContain('title_people_nconst');
  });

  it('fails with a helpful message when a dataset is missing from the cache', async () => {
    await expect(buildCatalog(db, { cacheDir: join(tmp, 'empty') })).rejects.toThrow(/title\.basics\.tsv\.gz/);
  });

  // Review Focus #5: a failed refresh leaves the previous catalog queryable.
  describe('failed rebuild', () => {
    let cache: string;
    beforeEach(async () => {
      cache = join(tmp, 'cache');
      mkdirSync(cache);
      for (const d of DATASETS) copyFileSync(join(FIXTURES, gzName(d)), join(cache, gzName(d)));
      await buildCatalog(db, { cacheDir: cache });
    });

    const assertOldCatalogIntact = (builtAt: string) => {
      const hit = db.sql.prepare('SELECT tconst FROM titles WHERE norm_title = ?').all(normalizeTitle('Quiet Ledger'));
      expect(hit).toEqual([{ tconst: 'tt9000003' }]);
      expect(count('SELECT COUNT(*) AS n FROM titles')).toBe(30);
      expect(count("SELECT COUNT(*) AS n FROM title_people WHERE role = 'actor'")).toBeGreaterThan(0);
      const meta = db.sql.prepare("SELECT value FROM meta WHERE key = 'catalog_built_at'").get() as { value: string };
      expect(meta.value).toBe(builtAt);
      expect(db.sql.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_new%' ESCAPE '\\'").all()).toEqual([]);
      if (db.fts) expect(count('SELECT COUNT(*) AS n FROM titles_fts')).toBe(30);
    };
    const builtAt = () =>
      (db.sql.prepare("SELECT value FROM meta WHERE key = 'catalog_built_at'").get() as { value: string }).value;

    it('rejects on a truncated title.basics and keeps the old catalog', async () => {
      const before = builtAt();
      const p = join(cache, 'title.basics.tsv.gz');
      const full = readFileSync(p);
      writeFileSync(p, full.subarray(0, Math.floor(full.length * 0.6)));
      await expect(buildCatalog(db, { cacheDir: cache, includeTvMovies: true })).rejects.toThrow();
      assertOldCatalogIntact(before);
    });

    it('rejects on a truncated file late in the build (name.basics) and keeps the old catalog', async () => {
      const before = builtAt();
      const p = join(cache, 'name.basics.tsv.gz');
      const full = readFileSync(p);
      writeFileSync(p, full.subarray(0, full.length - 6));
      await expect(buildCatalog(db, { cacheDir: cache })).rejects.toThrow();
      assertOldCatalogIntact(before);
    });

    it('rejects a file missing required columns and keeps the old catalog', async () => {
      const before = builtAt();
      writeFileSync(join(cache, 'title.basics.tsv.gz'), gzipSync(Buffer.from('foo\tbar\n1\t2\n')));
      await expect(buildCatalog(db, { cacheDir: cache })).rejects.toThrow(/tconst|titleType/);
      assertOldCatalogIntact(before);
    });

    it('refuses to swap in an empty catalog', async () => {
      const before = builtAt();
      writeFileSync(
        join(cache, 'title.basics.tsv.gz'),
        gzipSync(Buffer.from('tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres\n')),
      );
      await expect(buildCatalog(db, { cacheDir: cache })).rejects.toThrow(/no movies/i);
      assertOldCatalogIntact(before);
    });
  });
});

describe('downloadDatasets', () => {
  const BASE = 'https://datasets.example.test/';
  const LM = 'Wed, 21 Oct 2026 09:00:00 GMT';
  let cache: string;
  let calls: { url: string; headers: Record<string, string> }[];

  beforeEach(() => {
    cache = join(tmp, 'cache');
    calls = [];
  });

  const fixture = (file: string) => readFileSync(join(FIXTURES, file));

  function fakeFetch(
    respond: (file: string, headers: Record<string, string>) => Response = (file) =>
      new Response(new Uint8Array(fixture(file)), { status: 200, headers: { 'last-modified': LM } }),
  ): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, headers });
      return respond(url.slice(BASE.length), headers);
    }) as typeof fetch;
  }

  const listCache = () => (existsSync(cache) ? readdirSync(cache).sort() : []);

  it('downloads every dataset with its final name and Last-Modified as mtime', async () => {
    const res = await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    expect(res.map((r) => r.file)).toEqual(DATASETS.map(gzName));
    expect(res.every((r) => r.downloaded && r.lastModified === LM)).toBe(true);
    expect(listCache()).toEqual(DATASETS.map(gzName).sort());
    expect(calls.map((c) => c.url)).toEqual(DATASETS.map((d) => BASE + gzName(d)));
    expect(statSync(join(cache, 'title.basics.tsv.gz')).mtime.toUTCString()).toBe(LM);
    expect(readFileSync(join(cache, 'title.crew.tsv.gz'))).toEqual(fixture('title.crew.tsv.gz'));
  });

  it('reuses cached files without any request unless refresh is set', async () => {
    await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    calls = [];
    const res = await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    expect(calls).toEqual([]);
    expect(res.every((r) => !r.downloaded && r.lastModified === LM)).toBe(true);
  });

  it('on refresh sends If-Modified-Since and keeps the cached file on 304', async () => {
    await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    calls = [];
    const res = await downloadDatasets(cache, {
      baseUrl: BASE,
      refresh: true,
      fetchImpl: fakeFetch(() => new Response(null, { status: 304 })),
    });
    expect(calls).toHaveLength(DATASETS.length);
    expect(calls.every((c) => c.headers['if-modified-since'] === LM)).toBe(true);
    expect(res.every((r) => !r.downloaded)).toBe(true);
    expect(listCache()).toEqual(DATASETS.map(gzName).sort());
  });

  it('on refresh replaces a file only when the remote one is newer', async () => {
    await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    const NEWER = 'Thu, 22 Oct 2026 09:00:00 GMT';
    const res = await downloadDatasets(cache, {
      baseUrl: BASE,
      refresh: true,
      // The server ignores If-Modified-Since; only title.ratings is actually newer.
      fetchImpl: fakeFetch(
        (file) =>
          new Response(new Uint8Array(fixture(file)), {
            status: 200,
            headers: { 'last-modified': file === 'title.ratings.tsv.gz' ? NEWER : LM },
          }),
      ),
    });
    const byFile = Object.fromEntries(res.map((r) => [r.file, r]));
    expect(byFile['title.ratings.tsv.gz']).toMatchObject({ downloaded: true, lastModified: NEWER });
    expect(byFile['title.basics.tsv.gz']).toMatchObject({ downloaded: false, lastModified: LM });
    expect(statSync(join(cache, 'title.ratings.tsv.gz')).mtime.toUTCString()).toBe(NEWER);
  });

  // Review Focus #5: no partial file is ever cached as complete.
  it('rejects on HTTP 500 for one file, leaving no file for it and no .part leftovers', async () => {
    await expect(
      downloadDatasets(cache, {
        baseUrl: BASE,
        fetchImpl: fakeFetch((file) =>
          file === 'title.crew.tsv.gz'
            ? new Response('oops', { status: 500, statusText: 'Internal Server Error' })
            : new Response(new Uint8Array(fixture(file)), { status: 200 }),
        ),
      }),
    ).rejects.toThrow(/500/);
    const files = listCache();
    expect(files).not.toContain('title.crew.tsv.gz');
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('rejects when the body is truncated, leaving no file and no .part', async () => {
    await expect(
      downloadDatasets(cache, {
        baseUrl: BASE,
        fetchImpl: fakeFetch((file) => {
          const buf = fixture(file);
          return new Response(new Uint8Array(file === 'title.basics.tsv.gz' ? buf.subarray(0, buf.length >> 1) : buf), {
            status: 200,
          });
        }),
      }),
    ).rejects.toThrow(/title\.basics/);
    const files = listCache();
    expect(files).not.toContain('title.basics.tsv.gz');
    expect(files.filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('rejects when the connection drops mid-body, keeping the previously cached copy', async () => {
    await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    const before = readFileSync(join(cache, 'title.principals.tsv.gz'));
    await expect(
      downloadDatasets(cache, {
        baseUrl: BASE,
        refresh: true,
        fetchImpl: fakeFetch((file) => {
          if (file !== 'title.principals.tsv.gz') return new Response(null, { status: 304 });
          const buf = fixture(file);
          const body = new ReadableStream<Uint8Array>({
            pull(c) {
              c.enqueue(new Uint8Array(buf.subarray(0, 100)));
              c.error(new Error('socket hang up'));
            },
          });
          return new Response(body, { status: 200, headers: { 'last-modified': 'Fri, 23 Oct 2026 09:00:00 GMT' } });
        }),
      }),
    ).rejects.toThrow(/socket hang up/);
    expect(readFileSync(join(cache, 'title.principals.tsv.gz'))).toEqual(before);
    expect(listCache().filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('cleans up a stale .part left by an earlier interrupted run', async () => {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'title.basics.tsv.gz.part'), 'partial');
    await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    expect(listCache().filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('feeds a full download into a working build', async () => {
    await downloadDatasets(cache, { baseUrl: BASE, fetchImpl: fakeFetch() });
    const db = openDb(join(tmp, 'home2'));
    try {
      const stats = await buildCatalog(db, { cacheDir: cache });
      expect(stats.movies).toBe(30);
      expect(cacheDir(db.home)).toBe(join(tmp, 'home2', 'cache'));
    } finally {
      db.close();
    }
  });
});

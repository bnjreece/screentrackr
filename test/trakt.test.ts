/**
 * The Trakt importer: Trakt's own "Raw export" ZIP (or the folder it unpacks
 * to, or single files from it). Every title, person, username and id in the
 * fixtures is invented.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { applyImport, detectFormat, ImportError, parseImportDetailed, type ImportRecord } from '../src/core/importers/index.js';
import { parseTrakt, readTraktExport, traktFileOf, type TraktFile, type TraktOptions } from '../src/core/importers/trakt.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';
import { listZip } from '../src/core/zip.js';
import { COMETS, DUNE, exportFiles, GLASS, makeZip, SALT, toBytes } from './fixtures/trakt-export.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let db: Db;
let n = 0;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-trakt-'));
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
const byTitle = (title: string) => items().filter((i) => i.sourceTitle === title);
const traktIds = () =>
  db.sql.prepare("SELECT item_id AS id, value FROM item_external_ids WHERE kind = 'trakt' ORDER BY item_id").all() as { id: number; value: string }[];

const asFiles = (files: Record<string, unknown>): TraktFile[] =>
  Object.entries(toBytes(files)).map(([name, data]) => ({ name, text: data.toString('utf8') }));
/** Parse the allow-listed files of a file map, in UTC unless asked otherwise. */
const parse = (files: Record<string, unknown>, opts: TraktOptions = {}) =>
  parseTrakt(
    asFiles(files).filter((f) => traktFileOf(f.name) !== null),
    { timeZone: 'UTC', ...opts },
  );
const rec = (records: ImportRecord[], traktId: number) => records.find((r) => r.externalIds?.trakt === String(traktId));

function folder(files: Record<string, unknown>): string {
  const dir = join(tmp, `export-${++n}`);
  mkdirSync(dir);
  for (const [name, data] of Object.entries(toBytes(files))) writeFileSync(join(dir, name), data);
  return dir;
}
function zipFile(files: Record<string, unknown>, opts: { store?: boolean; prefix?: string } = {}): string {
  const path = join(tmp, `trakt-export-${++n}.zip`);
  const bytes = toBytes(files);
  const entries = Object.fromEntries(Object.entries(bytes).map(([k, v]) => [`${opts.prefix ?? ''}${k}`, v]));
  writeFileSync(path, makeZip(entries, opts));
  return path;
}

/** `count` history plays of different invented movies, all at one moment. */
function bulkPlays(count: number, at: string, firstId = 20_000): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    watched_at: at,
    action: 'watch',
    type: 'movie',
    movie: { title: `Bulk Reel ${i + 1}`, year: 2001, ids: { trakt: 600 + i, slug: `bulk-reel-${i + 1}`, imdb: null, tmdb: null } },
  }));
}

describe('which files are read', () => {
  it('allow-lists the movie files and the error list, by basename, case-insensitively, with page numbers', () => {
    expect(traktFileOf('watched-history.json')).toEqual({ kind: 'watched-history', page: 1 });
    expect(traktFileOf('WATCHED-HISTORY-3.JSON')).toEqual({ kind: 'watched-history', page: 3 });
    expect(traktFileOf('trakt-export-x/ratings-movies-2.json')).toEqual({ kind: 'ratings-movies', page: 2 });
    expect(traktFileOf('lists-watchlist.json')).toEqual({ kind: 'lists-watchlist', page: 1 });
    expect(traktFileOf('collection-movies.json')).toEqual({ kind: 'collection-movies', page: 1 });
    expect(traktFileOf('watched-movies.json')).toEqual({ kind: 'watched-movies', page: 1 });
    expect(traktFileOf('_errors.json')).toEqual({ kind: 'errors', page: 1 });
    for (const name of [
      'user-settings.json',
      'network-followers.json',
      'lists-lists.json',
      'lists-list-3001-lighthouse-films.json',
      'lists-favorites.json',
      'watched-playback.json',
      'watched-shows.json',
      'ratings-shows.json',
      'collection-episodes.json',
      'notes-movies.json',
      'comments-movies.json',
      'watched-history.json.bak',
      'watched-history-0.json',
    ]) {
      expect(traktFileOf(name), name).toBeNull();
    }
  });

  it('reads a ZIP, a folder or single files, and never the files outside the allow-list', () => {
    const files = exportFiles();
    const fromZip = readTraktExport([zipFile(files)]);
    const fromStoredZip = readTraktExport([zipFile(files, { store: true, prefix: 'trakt-export-orrin/' })]);
    const fromFolder = readTraktExport([folder(files)]);
    for (const res of [fromZip, fromStoredZip, fromFolder]) {
      expect(res.files.map((f) => f.name).sort()).toEqual([
        'collection-movies.json',
        'lists-watchlist.json',
        'ratings-movies.json',
        'watched-history-2.json',
        'watched-history.json',
        'watched-movies.json',
      ]);
      expect(res.skippedFiles).toBe(4);
      expect(JSON.stringify(res)).not.toMatch(/example\.invalid|mira-calloway|Lighthouse|1970-01-01T00:00:00\.000Z","user/);
    }
    const dir = folder(files);
    const single = readTraktExport([join(dir, 'ratings-movies.json'), join(dir, 'lists-watchlist.json')]);
    expect(single.files.map((f) => f.name)).toEqual(['ratings-movies.json', 'lists-watchlist.json']);
  });

  it('refuses a single file that is not one of the files it reads, without opening it', () => {
    const dir = folder({ ...exportFiles(), 'lists-favorites.json': (exportFiles()['lists-watchlist.json'] as unknown[]).slice(0, 1) });
    // Unreadable files: an attempt to open one would fail with EACCES instead.
    chmodSync(join(dir, 'user-settings.json'), 0o000);
    chmodSync(join(dir, 'lists-favorites.json'), 0o000);
    expect(() => readTraktExport([join(dir, 'user-settings.json')])).toThrow(/not a Trakt export file/);
    expect(() => readTraktExport([join(dir, 'lists-favorites.json')])).toThrow(/not a Trakt export file/);
    expect(() => readTraktExport([join(dir, 'watched-playback.json')])).toThrow(/not a Trakt export file/);
    // A folder read never opens them either.
    expect(readTraktExport([dir]).files).toHaveLength(6);
    chmodSync(join(dir, 'user-settings.json'), 0o600);
    chmodSync(join(dir, 'lists-favorites.json'), 0o600);
  });

  it('never opens a single file that is not a .zip and not on the allow-list, even a ZIP in disguise', () => {
    const disguised = join(tmp, `export-${++n}.dat`);
    writeFileSync(disguised, makeZip(toBytes(exportFiles())));
    chmodSync(disguised, 0o000);
    expect(() => readTraktExport([disguised])).toThrow(/not a Trakt export file/);
    chmodSync(disguised, 0o600);
  });

  it('refuses an archive or folder with nothing it reads, or the same file twice', () => {
    expect(() => readTraktExport([zipFile({ 'user-settings.json': {} })])).toThrow(/no Trakt export files/i);
    expect(() => readTraktExport([folder({ 'notes.txt': 'hello' })])).toThrow(/no Trakt export files/i);
    const dup = join(tmp, `dup-${++n}.zip`);
    const body = Buffer.from('[]');
    writeFileSync(dup, makeZip({ 'a/ratings-movies.json': body, 'b/ratings-movies.json': body }));
    expect(() => readTraktExport([dup])).toThrow(/more than once/);
  });

  it('reads an unpacked export one folder down, and skips symlinks', () => {
    const outer = join(tmp, `outer-${++n}`);
    mkdirSync(outer);
    const inner = folder(exportFiles());
    const nested = join(outer, 'trakt-export-orrin');
    mkdirSync(nested);
    writeFileSync(join(nested, 'ratings-movies.json'), JSON.stringify([]));
    symlinkSync(join(inner, 'lists-watchlist.json'), join(nested, 'lists-watchlist.json'));
    const res = readTraktExport([outer]);
    expect(res.files.map((f) => f.name)).toEqual(['ratings-movies.json']);
  });
});

describe('the ZIP reader', () => {
  it('rejects something that is not a ZIP, and caps entry sizes', () => {
    expect(() => listZip(Buffer.from('not a zip at all'))).toThrow(/not a ZIP/i);
    const big = makeZip({ 'ratings-movies.json': Buffer.alloc(5000, 0x20) });
    const [entry] = listZip(big);
    expect(entry?.name).toBe('ratings-movies.json');
    expect(entry?.read(10_000).length).toBe(5000);
    expect(() => entry?.read(1000)).toThrow(/too large/i);
  });

  it('checks a stored entry\'s sizes before copying it', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.alloc(5000, 0x20) }, { store: true });
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(10, cd + 24); // claim 10 bytes uncompressed
    const [entry] = listZip(zip);
    expect(() => entry?.read(100)).toThrow(/sizes disagree/);
  });

  it('refuses a directory that declares fewer entries than it holds', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[]'), 'lists-watchlist.json': Buffer.from('[]') });
    const end = zip.length - 22;
    zip.writeUInt16LE(1, end + 8);
    zip.writeUInt16LE(1, end + 10);
    expect(() => listZip(zip)).toThrow(/damaged/);
  });

  it('refuses an entry whose local name differs from the directory', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[]') });
    zip.write('x', 30); // first byte of the local header's name
    const [entry] = listZip(zip);
    expect(() => entry?.read(100)).toThrow(/names disagree/);
  });

  it('rejects a corrupted entry', () => {
    const zip = makeZip({ 'ratings-movies.json': Buffer.from('[1,2,3]') }, { store: true });
    zip[30 + 'ratings-movies.json'.length] = 0x7b; // change the first data byte
    const [entry] = listZip(zip);
    expect(() => entry?.read(1000)).toThrow(/damaged|checksum/i);
  });

  it('flags entry names that climb out of the archive', () => {
    const zip = makeZip({ '../ratings-movies.json': Buffer.from('[]'), '/abs/lists-watchlist.json': Buffer.from('[]') });
    expect(listZip(zip).map((e) => e.unsafe)).toEqual([true, true]);
    expect(() => readTraktExport([((p) => (writeFileSync(p, zip), p))(join(tmp, `evil-${++n}.zip`))])).toThrow(/no Trakt export files/i);
  });
});

describe('parsing', () => {
  it('folds every file into one record per Trakt movie, with the spec mapping', () => {
    const res = parse(exportFiles());
    const ids = res.records.map((r) => Number(r.externalIds?.trakt)).sort((a, b) => a - b);
    expect(ids).toEqual([101, 102, 103, 104, 105, 106]);

    expect(rec(res.records, 101)).toEqual({
      sourceTitle: 'The Glass Harbor',
      sourceYear: 1978,
      imdbIdHint: 'tt9000001',
      externalIds: { trakt: '101' },
      source: 'trakt',
      ownedIfNew: false,
      fillOnly: true,
      status: 'watched',
      watchedAt: '2024-02-10',
      watchedEra: '2020s',
      myRating: 8,
    });
    // Watchlist only: a new item goes in the queue, an existing one keeps its status.
    expect(rec(res.records, 102)).toMatchObject({ statusIfNew: 'queue', notes: 'Ask Mira about this one', ownedIfNew: false });
    expect(rec(res.records, 102)?.status).toBeUndefined();
    // A rating alone never means watched.
    expect(rec(res.records, 103)).toMatchObject({ myRating: 9, imdbIdHint: 'tt9000006' });
    expect(rec(res.records, 103)?.status).toBeUndefined();
    expect(rec(res.records, 103)?.statusIfNew).toBeUndefined();
    // The collection is the only thing that means owned.
    expect(rec(res.records, 104)).toMatchObject({ owned: true, sourceOwnedRaw: 'trakt:collection', sourceYear: 2011 });
    expect(rec(res.records, 104)?.ownedIfNew).toBeUndefined();
    // watched-movies alone: watched with its last date; a null year is left out.
    expect(rec(res.records, 105)).toMatchObject({ status: 'watched', watchedAt: '2015-06-01', watchedEra: '2010s' });
    expect(rec(res.records, 105)).not.toHaveProperty('sourceYear');
    // An epoch-zero play is watched with no date.
    expect(rec(res.records, 106)).toMatchObject({ status: 'watched', sourceYear: 1994 });
    expect(rec(res.records, 106)).not.toHaveProperty('watchedAt');
    expect(rec(res.records, 106)).not.toHaveProperty('watchedEra');
    for (const r of res.records) {
      if (r.externalIds?.trakt !== '104') {
        expect(r.owned).toBeUndefined();
        expect(r.ownedIfNew).toBe(false);
      }
    }
  });

  it('counts TV rows, warns about deleted titles and bad ratings, and keeps no catalog metadata', () => {
    const res = parse(exportFiles());
    expect(res.skippedTv).toBe(2);
    expect(res.warnings.join('\n')).toMatch(/deleted/i);
    expect(res.warnings.join('\n')).toMatch(/Copper Tide.*rating/);
    expect(rec(res.records, 107)).toBeUndefined();
    const all = JSON.stringify(res.records);
    expect(all).not.toMatch(/tmdb|slug|bluray|metadata|Harbor Patrol/);
  });

  it('gives the watch date in the time zone asked for (local by default)', () => {
    const denver = parse(exportFiles(), { timeZone: 'America/Denver' });
    expect(rec(denver.records, 101)?.watchedAt).toBe('2024-02-09');
  });

  it('rejects ratings that are not whole numbers from 1 to 10', () => {
    const res = parse({
      'ratings-movies.json': [
        { rated_at: '2023-01-01T00:00:00.000Z', rating: 7.5, type: 'movie', movie: GLASS },
        { rated_at: '2023-01-01T00:00:00.000Z', rating: 0, type: 'movie', movie: SALT },
        { rated_at: '2023-01-01T00:00:00.000Z', rating: '8', type: 'movie', movie: DUNE },
      ],
    });
    expect(res.records).toEqual([]);
    expect(res.warnings).toHaveLength(3);
  });

  it('reads pages in number order, the unnumbered file as page 1, and drops repeated plays by id', () => {
    // 10 plays at one second, but two repeat across pages: 9 distinct plays is not a bulk log.
    const plays = bulkPlays(9, '2019-01-01T00:00:00.000Z');
    const res = parse({
      'watched-history-3.json': plays.slice(6),
      'watched-history.json': plays.slice(0, 3),
      'watched-history-2.json': [...plays.slice(3, 6), plays[0]],
      'watched-history-10.json': [plays[1]],
    });
    expect(res.bulkDated).toBe(0);
    expect(res.records.map((r) => r.sourceTitle)).toEqual(Array.from({ length: 9 }, (_, i) => `Bulk Reel ${i + 1}`));
    expect(res.records.every((r) => r.watchedAt === '2019-01-01')).toBe(true);
  });

  it('treats 10 or more plays at the same second as bulk-logged: watched, but no date or era', () => {
    const files = { 'watched-history.json': [...bulkPlays(10, '2019-01-01T00:00:00.000Z'), { id: 1, watched_at: '2021-03-03T12:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }] };
    const res = parse(files);
    expect(res.bulkDated).toBe(10);
    const bulk = res.records.filter((r) => r.sourceTitle.startsWith('Bulk Reel'));
    expect(bulk).toHaveLength(10);
    for (const r of bulk) {
      expect(r.status).toBe('watched');
      expect(r).not.toHaveProperty('watchedAt');
      expect(r).not.toHaveProperty('watchedEra');
    }
    expect(rec(res.records, 101)).toMatchObject({ watchedAt: '2021-03-03', watchedEra: '2020s' });
    expect(res.notices.join('\n')).toMatch(/10 watched movies/);

    const kept = parse(files, { keepBulkDates: true });
    expect(kept.bulkDated).toBe(0);
    expect(kept.records.filter((r) => r.watchedAt === '2019-01-01')).toHaveLength(10);
  });

  it('a movie with a real play and a bulk-logged one keeps the real date', () => {
    const plays = bulkPlays(10, '2019-01-01T00:00:00.000Z');
    const res = parse({
      'watched-history.json': [
        ...plays,
        { id: 2, watched_at: '2012-07-07T12:00:00.000Z', action: 'watch', type: 'movie', movie: (plays[0] as { movie: unknown }).movie },
      ],
    });
    expect(res.records.find((r) => r.sourceTitle === 'Bulk Reel 1')).toMatchObject({ watchedAt: '2012-07-07', watchedEra: '2010s' });
  });

  it('maps watch years to eras', () => {
    const play = (id: number, at: string, m: unknown) => ({ id, watched_at: at, action: 'watch', type: 'movie', movie: m });
    const res = parse({
      'watched-history.json': [play(1, '2009-12-31T12:00:00.000Z', GLASS), play(2, '2010-01-01T12:00:00.000Z', SALT), play(3, '1899-05-05T12:00:00.000Z', DUNE)],
    });
    expect(rec(res.records, 101)).toMatchObject({ watchedEra: 'long-ago' });
    expect(rec(res.records, 102)).toMatchObject({ watchedEra: '2010s' });
    // Before 1900 counts as an unknown date.
    expect(rec(res.records, 103)).toMatchObject({ status: 'watched' });
    expect(rec(res.records, 103)).not.toHaveProperty('watchedAt');
  });

  it('never lets one bad row or file stop the import', () => {
    const res = parse({
      'watched-history.json': [
        42,
        null,
        { id: 3, type: 'movie', movie: { title: '', year: 2000, ids: { trakt: 9 } } },
        { id: 4, type: 'movie', movie: { title: 'No Id', year: 2000, ids: {} } },
        { id: 5, watched_at: 'not a date', type: 'movie', movie: COMETS },
      ],
      'ratings-movies.json': '{ this is not json',
      'lists-watchlist.json': { not: 'an array' },
    });
    expect(res.records.map((r) => r.sourceTitle)).toEqual(['Paper Comets']);
    expect(rec(res.records, 106)).toMatchObject({ status: 'watched' });
    expect(rec(res.records, 106)).not.toHaveProperty('watchedAt');
    expect(res.warnings.join('\n')).toMatch(/ratings-movies\.json/);
    expect(res.warnings.join('\n')).toMatch(/lists-watchlist\.json/);
  });

  it('a timestamp past year 9998 is an unknown date, never a broken one', () => {
    const res = parse({ 'watched-history.json': [{ id: 1, watched_at: '+010000-01-01T00:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }] });
    expect(rec(res.records, 101)).toMatchObject({ status: 'watched' });
    expect(rec(res.records, 101)).not.toHaveProperty('watchedAt');
    expect(() => applyImport(db, res.records, { mode: 'merge' })).not.toThrow();
  });

  it('a damaged page marks its part of the export incomplete', () => {
    const res = parse({ ...exportFiles(), 'watched-history-2.json': '[{"id":', 'collection-movies.json': { rows: [] } });
    expect(res.incomplete.sort()).toEqual(['collection', 'watch history']);
    expect(res.warnings.join('\n')).toMatch(/watched-history-2\.json.*incomplete/);
  });

  it('a later row fills a year or IMDb id an earlier row lacked', () => {
    const bare = { title: 'Harbor Lights', year: null, ids: { trakt: 702, imdb: null } };
    const full = { title: 'Harbor Lights', year: 2020, ids: { trakt: 702, imdb: 'tt9000777' } };
    const res = parse({
      'watched-history.json': [{ id: 1, watched_at: '2023-01-01T12:00:00.000Z', action: 'watch', type: 'movie', movie: bare }],
      'ratings-movies.json': [{ rated_at: '2023-01-02T00:00:00.000Z', rating: 7, type: 'movie', movie: full }],
    });
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ sourceYear: 2020, imdbIdHint: 'tt9000777', status: 'watched', myRating: 7 });
  });

  it('ignores a malformed IMDb id but keeps the movie', () => {
    const res = parse({
      'ratings-movies.json': [{ rated_at: '2023-01-01T00:00:00.000Z', rating: 6, type: 'movie', movie: { title: 'Odd Id', year: 2003, ids: { trakt: 55, imdb: 'nm123' } } }],
    });
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).not.toHaveProperty('imdbIdHint');
  });

  it('a watched play beats the watchlist, and a strip of BOM is fine', () => {
    const res = parseTrakt(
      [
        { name: 'lists-watchlist.json', text: '\uFEFF' + JSON.stringify([{ rank: 1, id: 1, listed_at: '2024-01-01T00:00:00.000Z', notes: null, type: 'movie', movie: GLASS }]) },
        { name: 'watched-history.json', text: JSON.stringify([{ id: 1, watched_at: '2024-01-02T12:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }]) },
      ],
      { timeZone: 'UTC' },
    );
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ status: 'watched', watchedAt: '2024-01-02' });
    expect(res.records[0]?.statusIfNew).toBeUndefined();
  });
});

describe('partial exports (_errors.json)', () => {
  it('warns about every failed endpoint, without the username, and says which parts are incomplete', () => {
    const files = exportFiles();
    delete files['watched-history.json'];
    delete files['watched-history-2.json'];
    files['_errors.json'] = [
      { endpoint: 'users/orrin-vale/history?extended=gdpr', error: 'HTTP 429 for orrin-vale', fetchedPages: 3, totalPages: 9 },
      { endpoint: 'users/orrin-vale/ratings', error: 'HTTP 500', fetchedPages: 0, totalPages: 1 },
      { endpoint: 'https://api.trakt.tv/users/orrin-vale/comments?page=2', error: 'HTTP 500', fetchedPages: 0, totalPages: 1 },
    ];
    const res = parse(files);
    expect(res.exportErrors).toBe(3);
    expect(res.incomplete.sort()).toEqual(['ratings', 'watch history']);
    const text = res.warnings.join('\n');
    expect(text).not.toMatch(/orrin-vale|429/);
    expect(text).toMatch(/watch history.*incomplete/i);
    expect(text).toMatch(/watched-movies/);
    expect(text).toMatch(/ratings.*incomplete/i);
    expect(res.warnings.filter((w) => /export/i.test(w)).length).toBeGreaterThanOrEqual(3);
    // History failed, so watched comes from watched-movies, dates included.
    expect(rec(res.records, 101)).toMatchObject({ status: 'watched', watchedAt: '2024-02-10' });
  });

  it('warns when _errors.json itself cannot be read', () => {
    const res = parse({ ...exportFiles(), '_errors.json': 'nope' });
    expect(res.exportErrors).toBe(1);
    expect(res.warnings.join('\n')).toMatch(/_errors\.json/);
  });

  it('an empty error list is a complete export', () => {
    const res = parse({ ...exportFiles(), '_errors.json': [] });
    expect(res.exportErrors).toBe(0);
    expect(res.incomplete).toEqual([]);
  });
});

describe('detecting a single Trakt file in a plain import', () => {
  it('recognizes a Trakt array by its movie.ids.trakt shape, and reads it only under its export name', () => {
    const files = toBytes(exportFiles());
    const ratings = (files['ratings-movies.json'] as Buffer).toString('utf8');
    expect(detectFormat(ratings, 'ratings-movies.json')).toBe('trakt');
    expect(detectFormat(ratings, 'renamed.json')).toBe('trakt');
    const res = parseImportDetailed(ratings, undefined, 'ratings-movies.json');
    expect(res.format).toBe('trakt');
    expect(res.records.map((r) => r.sourceTitle).sort()).toEqual(['Dune Static', 'The Glass Harbor']);
    // A favorites list has the watchlist's shape: never read as one.
    const watchlist = (files['lists-watchlist.json'] as Buffer).toString('utf8');
    expect(() => parseImportDetailed(watchlist, undefined, 'lists-favorites.json')).toThrow(/only .* are read/);
    expect(() => parseImportDetailed(ratings, undefined, 'renamed.json')).toThrow(ImportError);
    expect(() => parseImportDetailed(ratings, 'trakt')).toThrow(ImportError);
    // One odd row first doesn't hide a Trakt page, and its export name is enough.
    const rows = JSON.parse(ratings) as unknown[];
    expect(detectFormat(JSON.stringify([{}, null, ...rows]), 'x.json')).toBe('trakt');
    expect(detectFormat('[]', 'ratings-movies.json')).toBe('trakt');
    expect(() => detectFormat('[]', 'other.json')).toThrow(ImportError);
    expect(() => parseImportDetailed('[{"progress":1,"movie":{"title":"X","ids":{"trakt":1}}}]', 'trakt', 'watched-playback.json')).toThrow(
      ImportError,
    );
  });
});

describe('applying a Trakt import', () => {
  it('adds new movies: matched by IMDb hint, owned only from the collection, watchlist and rating-only ones in the queue', () => {
    const { records } = parse(exportFiles());
    const summary = applyImport(db, records, { mode: 'merge' });
    expect(summary).toMatchObject({ added: 6, updated: 0 });
    expect(byTitle('The Glass Harbor')[0]).toMatchObject({
      tconst: 'tt9000001',
      matchStatus: 'matched',
      status: 'watched',
      watchedAt: '2024-02-10',
      myRating: 8,
      owned: false,
      source: 'trakt',
    });
    expect(byTitle('Salt & Signal')[0]).toMatchObject({ status: 'queue', owned: false, notes: 'Ask Mira about this one' });
    // A deliberate choice: a new rating-only movie arrives in the queue.
    expect(byTitle('Dune Static')[0]).toMatchObject({ status: 'queue', myRating: 9, owned: false });
    expect(byTitle('Lantern Road')[0]).toMatchObject({ status: 'queue', owned: true, sourceOwnedRaw: 'trakt:collection' });
    expect(traktIds().map((r) => r.value).sort()).toEqual(['101', '102', '103', '104', '105', '106']);
  });

  it('importing the same export again changes nothing', () => {
    const { records } = parse(exportFiles());
    applyImport(db, records, { mode: 'merge' });
    const before = items();
    const again = applyImport(db, parse(exportFiles()).records, { mode: 'merge' });
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 6 });
    expect(items()).toEqual(before);
  });

  it('merging never downgrades watched, clears a rating, or changes owned outside the collection', () => {
    applyImport(
      db,
      [
        { sourceTitle: 'Salt & Signal', sourceYear: 2004, status: 'watched', watchedEra: '2010s', myRating: 7, owned: true, source: 'paste' },
        { sourceTitle: 'Dune Static', sourceYear: 2016, status: 'priority', owned: true, source: 'paste', sourceGenre: 'Sci-Fi' },
        { sourceTitle: 'The Glass Harbor', sourceYear: 1978, status: 'queue', myRating: 6, owned: true, source: 'paste', notes: 'My copy' },
        { sourceTitle: 'Lantern Road', sourceYear: 2011, status: 'someday', owned: false, sourceOwnedRaw: 'no', source: 'csv' },
      ],
      { mode: 'merge' },
    );
    const summary = applyImport(db, parse(exportFiles()).records, { mode: 'merge' });
    expect(summary.added).toBe(2); // The Quiet Orchard and Paper Comets
    expect(summary.reviews).toEqual([]);
    expect(items()).toHaveLength(6);
    // On the watchlist in Trakt, watched here: stays watched, keeps its rating, era and ownership.
    expect(byTitle('Salt & Signal')[0]).toMatchObject({ status: 'watched', watchedEra: '2010s', myRating: 7, owned: true, notes: 'Ask Mira about this one' });
    // Rated in Trakt: takes the rating, keeps its status, genre and ownership.
    expect(byTitle('Dune Static')[0]).toMatchObject({ status: 'priority', myRating: 9, owned: true, sourceGenre: 'Sci-Fi' });
    // Watched in Trakt: becomes watched with the date and Trakt's rating; notes are only filled, never replaced.
    expect(byTitle('The Glass Harbor')[0]).toMatchObject({ status: 'watched', watchedAt: '2024-02-10', myRating: 8, owned: true, notes: 'My copy' });
    // In the Trakt collection: now owned, status untouched.
    expect(byTitle('Lantern Road')[0]).toMatchObject({ owned: true, status: 'someday' });
    // A second run is a no-op.
    expect(applyImport(db, parse(exportFiles()).records, { mode: 'merge' })).toMatchObject({ added: 0, updated: 0 });
  });

  it('a year from a later file keeps a same-titled older film untouched', () => {
    applyImport(db, [{ sourceTitle: 'Harbor Lights', sourceYear: 1980, status: 'queue', myRating: 4, owned: true, source: 'paste' }], { mode: 'merge' });
    const bare = { title: 'Harbor Lights', year: null, ids: { trakt: 702, imdb: null } };
    const full = { title: 'Harbor Lights', year: 2020, ids: { trakt: 702, imdb: null } };
    const res = parse({
      'watched-history.json': [{ id: 1, watched_at: '2023-01-01T12:00:00.000Z', action: 'watch', type: 'movie', movie: bare }],
      'ratings-movies.json': [{ rated_at: '2023-01-02T00:00:00.000Z', rating: 9, type: 'movie', movie: full }],
    });
    expect(applyImport(db, res.records, { mode: 'merge' })).toMatchObject({ added: 1, updated: 0 });
    expect(items().map((i) => [i.sourceYear, i.status, i.myRating])).toEqual([
      [1980, 'queue', 4],
      [2020, 'watched', 9],
    ]);
  });

  it('a Trakt id tells two films with the same title apart, and finds a film again after a retitle', () => {
    const one = { title: 'Harbor Lights', year: 1990, ids: { trakt: 701, imdb: null } };
    const two = { title: 'Harbor Lights', year: 2020, ids: { trakt: 702, imdb: null } };
    const files = {
      'ratings-movies.json': [
        { rated_at: '2023-01-01T00:00:00.000Z', rating: 5, type: 'movie', movie: one },
        { rated_at: '2023-01-01T00:00:00.000Z', rating: 7, type: 'movie', movie: two },
      ],
    };
    expect(applyImport(db, parse(files).records, { mode: 'merge' })).toMatchObject({ added: 2 });
    const renamed = { ...files, 'ratings-movies.json': [{ rated_at: '2023-01-01T00:00:00.000Z', rating: 6, type: 'movie', movie: { ...two, title: 'Harbour Lights' } }] };
    expect(applyImport(db, parse(renamed).records, { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
    expect(items().map((i) => [i.sourceYear, i.myRating])).toEqual([
      [1990, 5],
      [2020, 6],
    ]);
  });
});

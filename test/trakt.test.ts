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
import { LIBRARY_COLUMNS, rowToItem, updateItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';
import { addViewing, viewingsOf } from '../src/core/viewings.js';
import { listZip } from '../src/core/zip.js';
import { COMETS, COPPER, DUNE, exportFiles, GLASS, makeZip, SALT, toBytes } from './fixtures/trakt-export.js';

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
/**
 * 0.4.0: a record carries every play (viewings) instead of one watchedAt and
 * era; the latest dated play is what the item's watched date becomes, and the
 * era follows it in the library. These read the old facts off the plays.
 */
const latest = (r: ImportRecord | undefined): string | undefined =>
  (r?.viewings ?? []).map((v) => v.watchedAt).filter((d): d is string => d !== null).sort().pop();
const eraOf = (d: string | undefined) => (d === undefined ? undefined : Number(d.slice(0, 4)) < 2010 ? 'long-ago' : Number(d.slice(0, 4)) < 2020 ? '2010s' : '2020s');

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

describe('unsafe ZIP entries', () => {
  // The ZIP reader itself is tested in zip.test.ts; this checks the importer skips unsafe names.
  it('skips entry names that climb out of the archive', () => {
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
      viewings: [
        { watchedAt: '2024-02-10', sourceRef: '9001' },
        { watchedAt: '2023-05-01', sourceRef: '9002' },
      ],
      viewingsComplete: true,
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
    expect(rec(res.records, 105)).toMatchObject({ status: 'watched', viewings: [{ watchedAt: '2015-06-01' }] });
    // Not in the history, so its one play is not a complete set.
    expect(rec(res.records, 105)?.viewingsComplete).toBeUndefined();
    expect(rec(res.records, 105)).not.toHaveProperty('sourceYear');
    // An epoch-zero play is watched with no date.
    expect(rec(res.records, 106)).toMatchObject({ status: 'watched', sourceYear: 1994 });
    expect(latest(rec(res.records, 106))).toBeUndefined();
    expect(rec(res.records, 106)?.viewings?.length).toBeGreaterThan(0);
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
    expect(latest(rec(denver.records, 101))).toBe('2024-02-09');
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
    expect(res.records.every((r) => latest(r) === '2019-01-01' && r.viewings?.length === 1)).toBe(true);
  });

  it('treats 10 or more plays at the same second as bulk-logged: watched, but no date or era', () => {
    const files = { 'watched-history.json': [...bulkPlays(10, '2019-01-01T00:00:00.000Z'), { id: 1, watched_at: '2021-03-03T12:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }] };
    const res = parse(files);
    expect(res.bulkDated).toBe(10);
    const bulk = res.records.filter((r) => r.sourceTitle.startsWith('Bulk Reel'));
    expect(bulk).toHaveLength(10);
    for (const r of bulk) {
      expect(r.status).toBe('watched');
      // A bulk play is still a play, with its ref, but no date.
      expect(r.viewings).toEqual([{ watchedAt: null, sourceRef: expect.stringMatching(/^\d+$/) as unknown }]);
      expect(r.viewingsComplete).toBe(true);
    }
    expect(latest(rec(res.records, 101))).toBe('2021-03-03');
    expect(res.notices.join('\n')).toMatch(/10 watched movies/);

    const kept = parse(files, { keepBulkDates: true });
    expect(kept.bulkDated).toBe(0);
    expect(kept.records.filter((r) => latest(r) === '2019-01-01')).toHaveLength(10);
  });

  it('a movie with a real play and a bulk-logged one keeps the real date', () => {
    const plays = bulkPlays(10, '2019-01-01T00:00:00.000Z');
    const res = parse({
      'watched-history.json': [
        ...plays,
        { id: 2, watched_at: '2012-07-07T12:00:00.000Z', action: 'watch', type: 'movie', movie: (plays[0] as { movie: unknown }).movie },
      ],
    });
    const reel = res.records.find((r) => r.sourceTitle === 'Bulk Reel 1');
    expect(latest(reel)).toBe('2012-07-07');
    expect(reel?.viewings).toHaveLength(2);
  });

  it('maps watch years to eras', () => {
    const play = (id: number, at: string, m: unknown) => ({ id, watched_at: at, action: 'watch', type: 'movie', movie: m });
    const res = parse({
      'watched-history.json': [play(1, '2009-12-31T12:00:00.000Z', GLASS), play(2, '2010-01-01T12:00:00.000Z', SALT), play(3, '1899-05-05T12:00:00.000Z', DUNE)],
    });
    expect(eraOf(latest(rec(res.records, 101)))).toBe('long-ago');
    expect(eraOf(latest(rec(res.records, 102)))).toBe('2010s');
    // Before 1900 counts as an unknown date.
    expect(rec(res.records, 103)).toMatchObject({ status: 'watched', viewings: [{ watchedAt: null, sourceRef: '3' }] });
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
    expect(latest(rec(res.records, 106))).toBeUndefined();
    expect(res.warnings.join('\n')).toMatch(/ratings-movies\.json/);
    expect(res.warnings.join('\n')).toMatch(/lists-watchlist\.json/);
  });

  it('a timestamp past year 9998 is an unknown date, never a broken one', () => {
    const res = parse({ 'watched-history.json': [{ id: 1, watched_at: '+010000-01-01T00:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }] });
    expect(rec(res.records, 101)).toMatchObject({ status: 'watched' });
    expect(latest(rec(res.records, 101))).toBeUndefined();
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

  it('a repeated history row still fills a year, and a skipped row does not use up its id', () => {
    const bare = { title: 'Harbor Lights', year: null, ids: { trakt: 702, imdb: null } };
    const full = { title: 'Harbor Lights', year: 2020, ids: { trakt: 702, imdb: null } };
    const res = parse({
      'watched-history.json': [
        { id: 1, watched_at: '2023-01-01T12:00:00.000Z', action: 'watch', type: 'movie', movie: bare },
        { id: 1, watched_at: '2023-01-01T12:00:00.000Z', action: 'watch', type: 'movie', movie: full },
        { id: 2, watched_at: '2022-01-01T12:00:00.000Z', action: 'watch', type: 'movie', movie: null },
        { id: 2, watched_at: '2022-01-01T12:00:00.000Z', action: 'watch', type: 'movie', movie: SALT },
      ],
    });
    expect(rec(res.records, 702)).toMatchObject({ sourceYear: 2020, status: 'watched' });
    expect(rec(res.records, 102)).toMatchObject({ status: 'watched' });
    expect(latest(rec(res.records, 102))).toBe('2022-01-01');
  });

  it('the history decides the date; watched-movies is only the fallback', () => {
    const res = parse({
      'watched-history.json': [{ id: 1, watched_at: '2020-05-05T12:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }],
      'watched-movies.json': [{ plays: 3, last_watched_at: '2025-01-01T12:00:00.000Z', movie: GLASS }],
    });
    // A whole history: its plays only, as a complete set.
    expect(rec(res.records, 101)).toMatchObject({ viewings: [{ watchedAt: '2020-05-05', sourceRef: '1' }], viewingsComplete: true });
  });

  it('bulk detection counts history and watched-movies times together, each movie once', () => {
    const at = '2018-03-03T03:03:03.000Z';
    const plays = bulkPlays(5, at) as { movie: unknown }[];
    const others = (bulkPlays(5, at, 30_000) as { movie: { ids: { trakt: number } } }[]).map((p, i) => ({
      plays: 1,
      last_watched_at: at,
      movie: { ...p.movie, title: `Other Reel ${i + 1}`, ids: { ...p.movie.ids, trakt: 800 + i } },
    }));
    // The history movies also appear in watched-movies at the same second: still one each.
    const again = plays.map((p) => ({ plays: 1, last_watched_at: at, movie: p.movie }));
    const res = parse({ 'watched-history.json': plays, 'watched-movies.json': [...others, ...again] });
    expect(res.bulkDated).toBe(10);
    expect(res.records.every((r) => latest(r) === undefined)).toBe(true);
    const nine = parse({ 'watched-history.json': plays, 'watched-movies.json': [...others.slice(0, 4), ...again] });
    expect(nine.bulkDated).toBe(0);
  });

  it('every distinct history play counts toward a bulk log, also several of one movie', () => {
    const at = '2017-07-07T07:07:07.000Z';
    const plays = bulkPlays(9, at);
    const res = parse({ 'watched-history.json': [...plays, { ...(plays[0] as object), id: 99_999 }] });
    expect(res.bulkDated).toBe(9);
  });

  it('history, ratings and watchlist rows must say they are a movie', () => {
    const res = parse({
      'watched-history.json': [{ id: 1, watched_at: '2023-01-01T12:00:00.000Z', action: 'watch', movie: GLASS }],
      'ratings-movies.json': [{ rated_at: '2023-01-01T00:00:00.000Z', rating: 6, movie: SALT }],
      'lists-watchlist.json': [{ rank: 1, id: 5, listed_at: '2024-01-01T00:00:00.000Z', notes: null, movie: DUNE }],
      // These two files have no type.
      'watched-movies.json': [{ plays: 1, last_watched_at: '2015-06-01T12:00:00.000Z', movie: COMETS }],
      'collection-movies.json': [{ collected_at: '2020-01-01T00:00:00.000Z', movie: COPPER }],
    });
    expect(res.records.map((r) => r.sourceTitle).sort()).toEqual(['Copper Tide', 'Paper Comets']);
    expect(res.warnings.filter((w) => /no row type/.test(w))).toHaveLength(3);
  });

  it('a deeply nested value in a row is described, never serialized, and the rest still imports', () => {
    const deep = '['.repeat(12_000) + ']'.repeat(12_000);
    const good = JSON.stringify({ rated_at: '2023-01-01T00:00:00.000Z', rating: 7, type: 'movie', movie: SALT });
    const res = parseTrakt(
      [
        {
          name: 'ratings-movies.json',
          text: `[{"rated_at":"2023-01-01T00:00:00.000Z","rating":${deep},"type":"movie","movie":${JSON.stringify(GLASS)}},{"rated_at":"x","rating":6,"type":${deep},"movie":${JSON.stringify(DUNE)}},${good}]`,
        },
      ],
      { timeZone: 'UTC' },
    );
    expect(res.records.map((r) => r.sourceTitle)).toEqual(['Salt & Signal']);
    expect(res.warnings.join('\n')).toMatch(/rating a list/);
    expect(res.warnings.join('\n')).toMatch(/unknown row type a list/);
  });

  it('a row with an unexpected type is skipped with a warning, not imported and not counted as TV', () => {
    const res = parse({
      'ratings-movies.json': [{ rated_at: '2023-01-01T00:00:00.000Z', rating: 6, type: null, movie: GLASS }],
    });
    expect(res.records).toEqual([]);
    expect(res.skippedTv).toBe(0);
    expect(res.warnings.join('\n')).toMatch(/unknown row type/);
  });

  it('handles a very long history for one film', () => {
    const plays = Array.from({ length: 150_000 }, (_, i) => ({
      id: i + 1,
      watched_at: new Date(Date.UTC(2000, 0, 1) + i * 3_600_000).toISOString(),
      action: 'watch',
      type: 'movie',
      movie: GLASS,
    }));
    const res = parse({ 'watched-history.json': plays });
    expect(latest(rec(res.records, 101))).toBe(plays[plays.length - 1]?.watched_at.slice(0, 10));
    expect(rec(res.records, 101)?.viewings).toHaveLength(150_000);
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
    expect(res.records[0]).toMatchObject({ status: 'watched' });
    expect(latest(res.records[0])).toBe('2024-01-02');
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
    // History failed, so watched comes from watched-movies, its last play included, and nothing is a complete set.
    expect(rec(res.records, 101)).toMatchObject({ status: 'watched', viewings: [{ watchedAt: '2024-02-10' }] });
    expect(res.records.some((r) => r.viewingsComplete)).toBe(false);
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
  it('a full export clears dates an earlier partial export gave plays it now shows were logged in bulk', () => {
    const at = '2019-01-01T00:00:00.000Z';
    const real = { id: 1, watched_at: '2021-03-03T12:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS };
    // The partial export: nine plays at one second is not a bulk log, so they keep their dates.
    const partial = parse({ 'watched-history.json': [...bulkPlays(9, at), real] });
    expect(partial.bulkDated).toBe(0);
    applyImport(db, partial.records, { mode: 'merge' });
    expect(items().filter((i) => i.watchedAt === '2019-01-01')).toHaveLength(9);
    // One of them got a date you set yourself (0.4.0: no earlier than its plays); a different source set the date of another.
    const own = byTitle('Bulk Reel 1')[0] as LibraryItem;
    updateItem(db, own.id, { watchedAt: '2019-06-01' });
    applyImport(db, [{ sourceTitle: 'Bulk Reel 2', sourceYear: 2001, status: 'watched', watchedAt: '2017-02-02', source: 'letterboxd' }], {
      mode: 'merge',
    });

    // The full export has a tenth play at that second: now it is a bulk log.
    const full = parse({ 'watched-history.json': [...bulkPlays(10, at), real] });
    expect(full.bulkDated).toBe(10);
    const summary = applyImport(db, full.records, { mode: 'merge' });
    expect(summary).toMatchObject({ added: 1 });

    const after = items();
    expect(after).toHaveLength(11);
    // Dates and eras Trakt set from the bulk second are gone, as in a fresh import of the full export.
    for (let i = 3; i <= 10; i++) {
      expect(byTitle(`Bulk Reel ${i}`)[0]).toMatchObject({ status: 'watched', watchedAt: null, watchedEra: null });
    }
    // A date you set and one another source set stay.
    expect(byTitle('Bulk Reel 1')[0]).toMatchObject({ status: 'watched', watchedAt: '2019-06-01' });
    expect(byTitle('Bulk Reel 2')[0]).toMatchObject({ status: 'watched', watchedAt: '2017-02-02' });
    // A real play keeps its date.
    expect(byTitle('The Glass Harbor')[0]).toMatchObject({ watchedAt: '2021-03-03', watchedEra: '2020s' });

    // Same as importing the full export into an empty library, apart from the two protected dates.
    const fresh = after.filter((i) => !['Bulk Reel 1', 'Bulk Reel 2'].includes(i.sourceTitle)).map((i) => [i.sourceTitle, i.watchedAt, i.watchedEra])
      .sort();
    db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');
    applyImport(db, full.records, { mode: 'merge' });
    expect(
      items()
        .filter((i) => !['Bulk Reel 1', 'Bulk Reel 2'].includes(i.sourceTitle))
        .map((i) => [i.sourceTitle, i.watchedAt, i.watchedEra])
        .sort(),
    ).toEqual(fresh);

    // A second run of the full export changes nothing.
    db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');
    applyImport(db, partial.records, { mode: 'merge' });
    applyImport(db, full.records, { mode: 'merge' });
    expect(applyImport(db, full.records, { mode: 'merge' })).toMatchObject({ added: 0, updated: 0 });
  });

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

describe('history plays (0.4.0)', () => {
  const play = (id: number | string, at: string, m: unknown = GLASS) => ({ id, watched_at: at, action: 'watch', type: 'movie', movie: m });
  /** A history page as raw JSON text, so an id past 2^53 is written exactly. */
  const page = (rows: { id: number | string; watched_at: string }[]) =>
    `[${rows.map((r) => JSON.stringify({ ...r, id: 0 }).replace('"id":0', `"id":${String(r.id)}`)).join(',')}]`;
  const glassPlays = () => {
    const it = byTitle('The Glass Harbor')[0] as LibraryItem;
    return viewingsOf(db, it.id).map((v) => [v.watchedAt, v.source, v.sourceRef]);
  };

  it('keeps int64 history ids exactly, as strings, and drops a repeat of one', () => {
    const big = '9007199254740993';
    const text = page([play(big, '2024-01-01T12:00:00.000Z'), play(big, '2024-01-01T12:00:00.000Z'), play('9007199254740995', '2024-02-02T12:00:00.000Z')]);
    const res = parseTrakt([{ name: 'watched-history.json', text }], { timeZone: 'UTC' });
    expect(rec(res.records, 101)?.viewings).toEqual([
      { watchedAt: '2024-01-01', sourceRef: big },
      { watchedAt: '2024-02-02', sourceRef: '9007199254740995' },
    ]);
    applyImport(db, res.records, { mode: 'merge' });
    expect(glassPlays()).toEqual([
      ['2024-02-02', 'trakt', '9007199254740995'],
      ['2024-01-01', 'trakt', big],
    ]);
  });

  it('three plays, one in a bulk second of 10, one at the epoch: three plays, two dateless', () => {
    const rows = [
      play(1, '2018-04-04T12:00:00.000Z'),
      play(2, '2019-01-01T00:00:00.000Z'),
      play(3, '1970-01-01T00:00:00.000Z'),
      ...(bulkPlays(9, '2019-01-01T00:00:00.000Z') as { id: number; watched_at: string }[]),
    ];
    const res = parse({ 'watched-history.json': rows });
    expect(rec(res.records, 101)?.viewings).toEqual([
      { watchedAt: '2018-04-04', sourceRef: '1' },
      { watchedAt: null, sourceRef: '2' },
      { watchedAt: null, sourceRef: '3' },
    ]);
    applyImport(db, res.records, { mode: 'merge' });
    expect(byTitle('The Glass Harbor')[0]).toMatchObject({ watchedAt: '2018-04-04', watchedEra: '2010s' });
    expect(glassPlays()).toHaveLength(3);
  });

  it('a re-import changes nothing; a newer export without a play removes exactly it and keeps yours', () => {
    const first = { 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z'), play(2, '2022-02-02T12:00:00.000Z')] };
    applyImport(db, parse(first).records, { mode: 'merge' });
    expect(applyImport(db, parse(first).records, { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    const id = (byTitle('The Glass Harbor')[0] as LibraryItem).id;
    addViewing(db, id, { watchedAt: '2020-01-01', source: 'manual', sourceRef: 'manual:00000000000000aa' });
    addViewing(db, id, { watchedAt: '2021-01-01', source: 'letterboxd', sourceRef: 'https://boxd.it/e9' });
    const s = applyImport(db, parse({ 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z')] }).records, { mode: 'merge' });
    expect(s).toMatchObject({ updated: 1 });
    expect(glassPlays()).toEqual([
      ['2021-01-01', 'letterboxd', 'https://boxd.it/e9'],
      ['2020-01-01', 'manual', 'manual:00000000000000aa'],
      ['2018-04-04', 'trakt', '1'],
    ]);
  });

  it('with the history incomplete, adds the plays it has plus last_watched_at and removes nothing', () => {
    applyImport(db, parse({ 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z'), play(2, '2022-02-02T12:00:00.000Z')] }).records, { mode: 'merge' });
    const partial = parse({
      'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z')],
      'watched-movies.json': [{ plays: 3, last_watched_at: '2024-05-05T12:00:00.000Z', movie: GLASS }],
      '_errors.json': [{ endpoint: 'users/someone/history', error: 'HTTP 500', fetchedPages: 1, totalPages: 2 }],
    });
    expect(rec(partial.records, 101)).toMatchObject({ viewings: [{ watchedAt: '2018-04-04', sourceRef: '1' }, { watchedAt: '2024-05-05' }] });
    expect(rec(partial.records, 101)?.viewingsComplete).toBeUndefined();
    applyImport(db, partial.records, { mode: 'merge' });
    expect(glassPlays()).toEqual([
      ['2024-05-05', 'trakt', null],
      ['2022-02-02', 'trakt', '2'],
      ['2018-04-04', 'trakt', '1'],
    ]);
  });
});

describe('when the history cannot say it is whole (0.4.0, Astra r1)', () => {
  const play = (id: number, at: string, m: unknown = GLASS) => ({ id, watched_at: at, action: 'watch', type: 'movie', movie: m });
  const two = { 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z')], 'watched-history-2.json': [play(2, '2022-02-02T12:00:00.000Z')] };
  const refs = () => viewingsOf(db, (byTitle('The Glass Harbor')[0] as LibraryItem).id).map((v) => v.sourceRef);
  beforeEach(() => applyImport(db, parse(two).records, { mode: 'merge' }));

  it('loose files, or a page missing from the run, remove nothing', () => {
    expect(refs()).toEqual(['2', '1']);
    const loose = parse({ 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z')] }, { wholeExport: false });
    expect(loose.records.some((r) => r.viewingsComplete)).toBe(false);
    expect(loose.notices.join('\n')).toMatch(/may not be whole/);
    applyImport(db, loose.records, { mode: 'merge' });
    const gap = parse({ 'watched-history-2.json': [play(2, '2022-02-02T12:00:00.000Z')] });
    expect(gap.records.some((r) => r.viewingsComplete)).toBe(false);
    applyImport(db, gap.records, { mode: 'merge' });
    expect(refs()).toEqual(['2', '1']);
  });

  it('an unreadable _errors.json, or a history row it could not read, removes nothing', () => {
    const one = { 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z')] };
    for (const files of [
      { ...one, '_errors.json': 'not json' },
      { 'watched-history.json': [...one['watched-history.json'], { id: 3, watched_at: '2023-01-01T00:00:00.000Z', type: 'movie', movie: { title: '', ids: { trakt: 101 } } }] },
    ]) {
      const res = parse(files);
      expect(res.records.some((r) => r.viewingsComplete)).toBe(false);
      applyImport(db, res.records, { mode: 'merge' });
      expect(refs()).toEqual(['2', '1']);
    }
  });

  it('a movie still in the export with no play left in a whole history loses its Trakt plays', () => {
    const res = parse({ 'watched-history.json': [play(5, '2020-01-01T12:00:00.000Z', SALT)], 'ratings-movies.json': [{ rated_at: '2024-01-01T00:00:00.000Z', rating: 7, type: 'movie', movie: GLASS }] });
    expect(rec(res.records, 101)).toMatchObject({ viewings: [], viewingsComplete: true, myRating: 7 });
    applyImport(db, res.records, { mode: 'merge' });
    expect(refs()).toEqual([]);
    expect(byTitle('The Glass Harbor')[0]).toMatchObject({ status: 'watched', watchedAt: null });
  });

  it('without a whole history, a bulk-logged play is left out so a date an older release kept is not counted twice', () => {
    db.sql.exec('DELETE FROM library_items');
    applyImport(db, [{ sourceTitle: 'Bulk Reel 1', sourceYear: 2001, status: 'watched', source: 'trakt', externalIds: { trakt: '600' } }], { mode: 'merge' });
    const id = (byTitle('Bulk Reel 1')[0] as LibraryItem).id;
    addViewing(db, id, { watchedAt: '2019-01-01', source: 'trakt' });
    const files = { 'watched-history.json': bulkPlays(10, '2019-01-01T00:00:00.000Z'), '_errors.json': [{ endpoint: 'users/someone/history', error: 'HTTP 500' }] };
    const res = parse(files);
    expect(res.notices.join('\n')).toMatch(/Left out 10 bulk-logged plays/);
    applyImport(db, res.records, { mode: 'merge' });
    expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([['2019-01-01', null]]);
    // A whole export settles it: the play by its ref, without the fake date.
    applyImport(db, parse({ 'watched-history.json': bulkPlays(10, '2019-01-01T00:00:00.000Z') }).records, { mode: 'merge' });
    expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([[null, '20000']]);
  });
});

describe('readTraktExport says whether it read a whole export', () => {
  it('a folder or a ZIP is whole; loose files are not', () => {
    const dir = folder(exportFiles());
    expect(readTraktExport([dir]).whole).toBe(true);
    expect(readTraktExport([join(dir, 'watched-history.json'), join(dir, 'watched-history-2.json')]).whole).toBe(false);
    const zip = join(tmp, `whole-${++n}.zip`);
    writeFileSync(zip, makeZip(toBytes(exportFiles())));
    expect(readTraktExport([zip]).whole).toBe(true);
  });
});

describe('more doubtful input (0.4.0, Astra r2)', () => {
  const play = (id: number, at: string, m: unknown = GLASS) => ({ id, watched_at: at, action: 'watch', type: 'movie', movie: m });
  const refs = () => viewingsOf(db, (byTitle('The Glass Harbor')[0] as LibraryItem).id).map((v) => v.sourceRef);
  beforeEach(() => applyImport(db, parse({ 'watched-history.json': [play(1, '2018-04-04T12:00:00.000Z'), play(2, '2022-02-02T12:00:00.000Z')] }).records, { mode: 'merge' }));

  it('an _errors.json entry that names no endpoint, or a history row with no movie, removes nothing', () => {
    const one = [play(1, '2018-04-04T12:00:00.000Z')];
    for (const files of [
      { 'watched-history.json': one, '_errors.json': [null] },
      { 'watched-history.json': one, '_errors.json': [{ error: 'HTTP 500' }] },
      { 'watched-history.json': [...one, { id: 7, watched_at: '2023-01-01T00:00:00.000Z', action: 'watch', type: 'movie' }] },
    ]) {
      const res = parse(files);
      expect(res.records.some((r) => r.viewingsComplete), JSON.stringify(files)).toBe(false);
      applyImport(db, res.records, { mode: 'merge' });
      expect(refs()).toEqual(['2', '1']);
    }
    // An explicit null movie is a title deleted from Trakt: the rest stays a whole history.
    expect(parse({ 'watched-history.json': [...one, { id: 8, watched_at: '2023-01-01T00:00:00.000Z', action: 'watch', type: 'movie', movie: null }] }).records[0]?.viewingsComplete).toBe(true);
  });

  it('a bulk-logged last_watched_at is left out of the fallback too', () => {
    db.sql.exec('DELETE FROM library_items');
    applyImport(db, [{ sourceTitle: 'Bulk Reel 1', sourceYear: 2001, status: 'watched', source: 'trakt', externalIds: { trakt: '600' } }], { mode: 'merge' });
    const id = (byTitle('Bulk Reel 1')[0] as LibraryItem).id;
    addViewing(db, id, { watchedAt: '2019-01-01', source: 'trakt' });
    const at = '2019-01-01T00:00:00.000Z';
    const wm = (bulkPlays(10, at) as { movie: unknown }[]).map((p) => ({ plays: 1, last_watched_at: at, movie: p.movie }));
    const res = parse({ 'watched-movies.json': wm });
    expect(res.records.every((r) => r.viewings?.length === 0 && !r.viewingsComplete)).toBe(true);
    applyImport(db, res.records, { mode: 'merge' });
    expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([['2019-01-01', null]]);
  });
});

describe('the fallback never adds a play it could not match later (0.4.0, Astra r3)', () => {
  it('watched-movies with no usable last date gives no play, so the history play is not counted twice', () => {
    const wm = { 'watched-movies.json': [{ plays: 1, last_watched_at: '1970-01-01T00:00:00.000Z', movie: GLASS }] };
    const first = parse(wm);
    expect(rec(first.records, 101)).toMatchObject({ status: 'watched', viewings: [] });
    applyImport(db, first.records, { mode: 'merge' });
    const loose = parse({ 'watched-history.json': [{ id: 123, watched_at: '1970-01-01T00:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS }] }, { wholeExport: false });
    applyImport(db, loose.records, { mode: 'merge' });
    const id = (byTitle('The Glass Harbor')[0] as LibraryItem).id;
    expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([[null, '123']]);
  });
});

describe('plays with nothing to match them by later (0.4.0, Astra r4)', () => {
  it('loose watched-movies never adds a play beside one the history kept without its bulk date', () => {
    const at = '2019-01-01T00:00:00.000Z';
    applyImport(db, parse({ 'watched-history.json': bulkPlays(10, at) }).records, { mode: 'merge' });
    const id = (byTitle('Bulk Reel 1')[0] as LibraryItem).id;
    expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([[null, '20000']]);
    const one = (bulkPlays(1, at) as { movie: unknown }[]).map((p) => ({ plays: 1, last_watched_at: at, movie: p.movie }));
    for (const opts of [{ wholeExport: false }, {}]) {
      applyImport(db, parse({ 'watched-movies.json': one }, opts).records, { mode: 'merge' });
      expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([[null, '20000']]);
    }
  });

  it('a history row with no play id is watched but not kept as a play, and the history is not whole', () => {
    const row = (id?: number) => ({ ...(id !== undefined ? { id } : {}), watched_at: '1970-01-01T00:00:00.000Z', action: 'watch', type: 'movie', movie: GLASS });
    const res = parse({ 'watched-history.json': [row(), row(0)] }, { wholeExport: false });
    expect(rec(res.records, 101)).toMatchObject({ status: 'watched', viewings: [] });
    expect(rec(res.records, 101)?.viewingsComplete).toBeUndefined();
    expect(res.warnings.filter((w) => /no Trakt play id/.test(w))).toHaveLength(2);
    expect(parse({ 'watched-history.json': [row(5), row()] }).records[0]?.viewingsComplete).toBeUndefined();
    applyImport(db, res.records, { mode: 'merge' });
    applyImport(db, parse({ 'watched-history.json': [row(123)] }, { wholeExport: false }).records, { mode: 'merge' });
    const id = (byTitle('The Glass Harbor')[0] as LibraryItem).id;
    expect(viewingsOf(db, id).map((v) => [v.watchedAt, v.sourceRef])).toEqual([[null, '123']]);
  });
});

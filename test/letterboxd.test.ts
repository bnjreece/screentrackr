/**
 * The Letterboxd export importer: a ZIP, its folder, or loose CSV files.
 * Every title, URI and person in the fixtures is invented; none of it comes
 * from a real export.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { applyImport, detectFormat, ImportError, parseImportDetailed, type ImportRecord } from '../src/core/importers/index.js';
import {
  exportRoot,
  folderSource,
  parseLetterboxdExport,
  parseLetterboxdFiles,
  chooseLooseFiles,
  reviewText,
  zipSource,
  type LetterboxdOptions,
  type LetterboxdSource,
} from '../src/core/importers/letterboxd.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';
import { folderFiles } from './fixtures/folder-files.js';
import { makeZip } from './fixtures/make-zip.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const EXPORT = join(import.meta.dirname, 'fixtures', 'letterboxd', 'export');
const text = (name: string) => readFileSync(join(EXPORT, name), 'utf8');
const crlf = (t: string) => t.replace(/\r?\n/g, '\r\n');

let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-letterboxd-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: IMDB });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');
});

function items(): LibraryItem[] {
  return (db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[]).map(rowToItem);
}
const item = (title: string, year?: number) => items().filter((i) => i.sourceTitle === title && (year === undefined || i.sourceYear === year));
const uri = (code: string) => `https://boxd.it/${code}`;
const rec = (records: ImportRecord[], code: string) => records.find((r) => r.externalIds?.letterboxd === uri(code));

/** A source over the fixture folder that records every file it is asked to read. */
function spySource(): LetterboxdSource & { reads: string[] } {
  const inner = folderSource(EXPORT);
  const reads: string[] = [];
  return {
    paths: inner.paths,
    reads,
    read: (p) => {
      reads.push(p);
      return inner.read(p);
    },
  };
}
const parseFolder = (opts: LetterboxdOptions = {}) => parseLetterboxdExport(folderSource(EXPORT), opts);

describe('reading an export', () => {
  it('builds one record per film URI from watched, ratings and the watchlist', () => {
    const { records } = parseFolder();
    expect(records).toHaveLength(12);
    expect(new Set(records.map((r) => r.externalIds?.letterboxd)).size).toBe(12);
    for (const r of records) {
      expect(r).toMatchObject({ source: 'letterboxd', fillOnly: true, ownedIfNew: false });
      expect(r.owned).toBeUndefined();
      expect(r.sourceOwnedRaw).toBeUndefined();
    }
  });

  it('stores half stars times two, so 0.5 to 5 become 1 to 10', () => {
    const { records } = parseFolder();
    expect(rec(records, 'zZ4d')?.myRating).toBe(1);
    expect(rec(records, 'zZ2b')?.myRating).toBe(6);
    expect(rec(records, 'zZ9i')?.myRating).toBe(5);
    expect(rec(records, 'zZ1a')?.myRating).toBe(9);
    expect(rec(records, 'zZ5e')?.myRating).toBe(10);
  });

  it('prefers ratings.csv over the diary, and falls back to the latest diary rating', () => {
    const { records } = parseFolder();
    // The latest diary entry says 3.5 stars; ratings.csv says 4.5.
    expect(rec(records, 'zZ1a')?.myRating).toBe(9);
    // No ratings row: the diary's 2 stars.
    expect(rec(records, 'zZ8h')?.myRating).toBe(4);
  });

  it('takes the watched date and era from the latest diary Watched Date only', () => {
    const { records } = parseFolder();
    expect(rec(records, 'zZ1a')).toMatchObject({ status: 'watched', watchedAt: '2025-01-10', watchedEra: '2020s' });
    expect(rec(records, 'zZ1b')).toMatchObject({ watchedAt: '2009-06-01', watchedEra: 'long-ago' });
    // Logged 2016-01-01, watched 2015-12-31.
    expect(rec(records, 'zZ4d')).toMatchObject({ watchedAt: '2015-12-31', watchedEra: '2010s' });
    // In watched.csv with no diary entry: watched, no date (watched.csv's Date is when it was logged).
    const quiet = rec(records, 'zZ5e');
    expect(quiet?.status).toBe('watched');
    expect(quiet?.watchedAt).toBeUndefined();
    expect(quiet?.watchedEra).toBeUndefined();
  });

  it('puts watchlist-only films in the queue only as new items, and watched wins over the watchlist', () => {
    const { records } = parseFolder();
    const winter = rec(records, 'zZ3c');
    expect(winter).toMatchObject({ sourceTitle: "Orrin Vale's Last Winter", statusIfNew: 'queue' });
    expect(winter?.status).toBeUndefined();
    expect(winter?.sourceYear).toBeUndefined();
    const dune = rec(records, 'zZ9i');
    expect(dune?.status).toBe('watched');
    expect(dune?.statusIfNew).toBeUndefined();
  });

  it('keeps a remake pair apart by URI and leaves a diary entry unattached when Name and Year fit two films', () => {
    const { records, warnings } = parseFolder();
    expect(rec(records, 'zZ1a')?.sourceYear).toBe(1978);
    expect(rec(records, 'zZ1b')?.sourceYear).toBe(2009);
    for (const code of ['zZ7a', 'zZ7b']) {
      const twin = rec(records, code);
      expect(twin?.status).toBe('watched');
      expect(twin?.watchedAt).toBeUndefined();
      expect(twin?.myRating).toBeUndefined();
    }
    expect(warnings.join('\n')).toMatch(/2 films are called "Twin Rivers" \(2001\)/);
  });

  it('reads titles with commas, doubled quotes, accents and emoji', () => {
    const { records } = parseFolder();
    expect(rec(records, 'zZ2b')?.sourceTitle).toBe('Salt, Smoke and Static');
    expect(rec(records, 'zZ6f')?.sourceTitle).toBe('Café Lumière "Noir" \u{1F3AC}');
  });

  it('reads reviews only with withReviews, joined by entry URI, latest non-blank first', () => {
    expect(parseFolder().records.some((r) => r.notes !== undefined)).toBe(false);
    const { records } = parseFolder({ withReviews: true });
    expect(rec(records, 'zZ1a')?.notes).toBe('Better the second time.\nThe "harbor" shot holds.');
    expect(rec(records, 'zZ4d')?.notes).toBeUndefined();
  });

  it('turns review HTML into plain text', () => {
    expect(reviewText('<p>One &amp; two</p><p>three<br/>four &#233; &#x1F3AC; &bogus;</p>')).toBe('One & two\n\nthree\nfour é \u{1F3AC} &bogus;');
  });

  it('skips deleted/ and orphaned/ with counts, and never opens profile, comments, likes or unnamed lists', () => {
    const source = spySource();
    const res = parseLetterboxdExport(source, { withReviews: true });
    expect(res.skipped).toEqual({ deleted: 2, orphaned: 3 });
    expect(res.notices.join('\n')).toMatch(/Skipped 2 deleted diary entries/);
    expect(res.notices.join('\n')).toMatch(/Skipped 3 diary entries for films Letterboxd no longer lists/);
    expect([...source.reads].sort()).toEqual(
      ['deleted/diary.csv', 'diary.csv', 'orphaned/diary.csv', 'ratings.csv', 'reviews.csv', 'watched.csv', 'watchlist.csv'].sort(),
    );
    // Paper Engine is only in deleted/.
    expect(res.records.some((r) => r.sourceTitle === 'Paper Engine')).toBe(false);
  });

  it('does not open reviews.csv without withReviews, nor watchlist.csv with watchlist false', () => {
    const source = spySource();
    const res = parseLetterboxdExport(source, { watchlist: false });
    expect(source.reads).not.toContain('reviews.csv');
    expect(source.reads).not.toContain('watchlist.csv');
    expect(rec(res.records, 'zZ3c')).toBeUndefined();
    expect(rec(res.records, 'zZ0k')).toBeUndefined();
    expect(rec(res.records, 'zZ9i')?.status).toBe('watched');
  });

  it('marks the films of a named owned list owned, with the list name, parsing a multiline description', () => {
    const source = spySource();
    const { records, notices } = parseLetterboxdExport(source, { ownedLists: ['my-blu-rays'] });
    expect(source.reads).toContain('lists/my-blu-rays.csv');
    expect(source.reads).not.toContain('lists/favourites.csv');
    expect(rec(records, 'zZ1a')).toMatchObject({ owned: true, sourceOwnedRaw: 'My Blu-rays', status: 'watched' });
    expect(rec(records, 'zZ1a')?.ownedIfNew).toBeUndefined();
    const ferry = rec(records, 'zZ0n');
    expect(ferry).toMatchObject({ sourceTitle: 'Night Ferry', sourceYear: 2002, owned: true, statusIfNew: 'queue' });
    expect(ferry?.status).toBeUndefined();
    // Not in the named list.
    expect(rec(records, 'zZ5e')).toMatchObject({ ownedIfNew: false });
    expect(rec(records, 'zZ5e')?.owned).toBeUndefined();
    expect(records).toHaveLength(13);
    expect(notices.join('\n')).toMatch(/2 films marked owned \(list "My Blu-rays"\)/);
  });

  it('skips a named list of an unknown version with a warning', () => {
    const { records, warnings } = parseFolder({ ownedLists: ['old-shelf.csv'] });
    expect(warnings.join('\n')).toMatch(/lists\/old-shelf.csv: a Letterboxd list export of a version .* \(v6\)/);
    expect(records.some((r) => r.owned === true)).toBe(false);
  });

  it('refuses a named list that is missing or is not a plain slug', () => {
    expect(() => parseFolder({ ownedLists: ['no-such-list'] })).toThrow(/No list "no-such-list"/);
    for (const bad of ['../profile', 'lists/x', '', '.hidden']) {
      expect(() => parseFolder({ ownedLists: [bad] })).toThrow(ImportError);
    }
  });

  it('warns about ratings that are not half stars and leaves them out', () => {
    const res = parseLetterboxdFiles([
      { name: 'watched.csv', text: 'Date,Name,Year,Letterboxd URI\n2024-01-01,Night Ferry,2002,https://boxd.it/zZ0n\n' },
      { name: 'ratings.csv', text: 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Night Ferry,2002,https://boxd.it/zZ0n,4.25\n' },
    ]);
    expect(res.records[0]?.myRating).toBeUndefined();
    expect(res.records[0]?.status).toBe('watched');
    expect(res.warnings.join('\n')).toMatch(/"4.25" is not a half-star rating/);
    for (const bad of ['0', '6', '5.5', 'x']) {
      const r = parseLetterboxdFiles([{ name: 'ratings.csv', text: `Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Night Ferry,2002,https://boxd.it/zZ0n,${bad}\n` }]);
      expect(r.records[0]?.myRating, bad).toBeUndefined();
    }
  });

  it('reads an empty or header-only watchlist', () => {
    for (const watchlist of ['', 'Date,Name,Year,Letterboxd URI\n']) {
      const res = parseLetterboxdExport(zipSource(makeZip({ ...folderFiles(EXPORT), 'watchlist.csv': Buffer.from(watchlist) })));
      expect(res.records).toHaveLength(10);
    }
  });
});

describe('ZIP exports', () => {
  const byUri = (rs: ImportRecord[]) => [...rs].sort((a, b) => String(a.externalIds?.letterboxd).localeCompare(String(b.externalIds?.letterboxd)));

  it('reads a flat ZIP, a nested one and CRLF files exactly like the folder', () => {
    const folder = byUri(parseFolder({ withReviews: true, ownedLists: ['my-blu-rays'] }).records);
    const variants = [
      makeZip(folderFiles(EXPORT)),
      makeZip(folderFiles(EXPORT, 'letterboxd-example-2026-01-01-00-00-utc/')),
      makeZip(folderFiles(EXPORT, '', crlf)),
      makeZip(folderFiles(EXPORT), { store: true }),
    ];
    for (const zip of variants) {
      expect(byUri(parseLetterboxdExport(zipSource(zip), { withReviews: true, ownedLists: ['my-blu-rays'] }).records)).toEqual(folder);
    }
  });

  it('finds the shallowest folder with watched.csv, outside deleted/ and orphaned/', () => {
    expect(exportRoot(['a/watched.csv', 'a/deleted/watched.csv', 'b/c/watched.csv'])).toBe('a/');
    expect(exportRoot(['deleted/watched.csv', 'x/watched.csv'])).toBe('x/');
    expect(() => exportRoot(['ratings.csv'])).toThrow(/No watched.csv/);
    expect(() => exportRoot(['a/watched.csv', 'b/watched.csv'])).toThrow(/More than one/);
  });

  // The reader itself (ZIP64, encryption, CRC, bombs) is tested in zip.test.ts; these cover how the importer uses it.
  it('refuses a damaged archive and caps each entry and the total read', () => {
    expect(() => zipSource(Buffer.from('PK\u0003\u0004 not really a zip'))).toThrow(ImportError);
    const damaged = makeZip({ 'watched.csv': Buffer.from(text('watched.csv')) }, { store: true });
    const at = 30 + 'watched.csv'.length;
    damaged.writeUInt8((damaged.readUInt8(at) ^ 0xff) & 0xff, at);
    expect(() => zipSource(damaged).read('watched.csv')).toThrow(/checksum|damaged/);
    const limits = { maxEntryBytes: 100, maxTotalBytes: 150 };
    expect(() => zipSource(makeZip({ 'watched.csv': Buffer.alloc(101, 0x78) }), limits).read('watched.csv')).toThrow(/too large/);
    const two = zipSource(makeZip({ 'a.csv': Buffer.alloc(100, 0x78), 'b.csv': Buffer.alloc(100, 0x78) }), limits);
    two.read('a.csv');
    expect(() => two.read('b.csv')).toThrow(/too large/);
  });

  it('ignores entries whose names point outside the archive, and refuses a name listed twice', () => {
    const z = zipSource(makeZip({ '../watched.csv': Buffer.from('x'), '/etc/x.csv': Buffer.from('x'), 'ok/watched.csv': Buffer.from('x') }));
    expect(z.paths).toEqual(['ok/watched.csv']);
    expect(() => zipSource(makeZip({ 'watched.csv': Buffer.from('x'), 'WATCHED.csv': Buffer.from('y') }))).toThrow(/more than once/);
  });
});

describe('loose files and detection', () => {
  it('detects export files by their columns and file name', () => {
    expect(detectFormat(text('watched.csv'), 'watched.csv')).toBe('letterboxd');
    expect(detectFormat(text('ratings.csv'), 'ratings.csv')).toBe('letterboxd');
    expect(detectFormat(text('diary.csv'), 'diary.csv')).toBe('letterboxd');
    expect(detectFormat(crlf(text('watchlist.csv')), 'watchlist.csv')).toBe('letterboxd');
    expect(detectFormat(text('lists/favourites.csv'), 'favourites.csv')).toBe('letterboxd');
    expect(detectFormat('title,year\nNight Ferry,2002\n', 'x.csv')).toBe('csv');
  });

  it('reads a watchlist passed to plain import as queue-if-new, never watched', () => {
    const res = parseImportDetailed(text('watchlist.csv'), undefined, 'watchlist.csv');
    expect(res.format).toBe('letterboxd');
    expect(res.records).toHaveLength(3);
    for (const r of res.records) {
      expect(r.status).toBeUndefined();
      expect(r.statusIfNew).toBe('queue');
    }
  });

  it('refuses a watched or watchlist file whose name does not say which it is', () => {
    expect(() => parseImportDetailed(text('watched.csv'), undefined, 'export.csv')).toThrow(/file name has to say/);
  });

  it('reads several loose files together, and named list files', () => {
    const files = ['watched.csv', 'ratings.csv', 'diary.csv', 'lists/my-blu-rays.csv', 'lists/favourites.csv'].map((n) => ({ name: n, text: text(n) }));
    const res = parseLetterboxdFiles(files, { ownedLists: ['my-blu-rays'] });
    expect(rec(res.records, 'zZ1a')).toMatchObject({ myRating: 9, watchedAt: '2025-01-10', owned: true });
    expect(res.warnings.join('\n')).toMatch(/favourites.csv: a list that --owned-list does not name/); // chooseLooseFiles keeps the CLI from opening it
    expect(() => parseLetterboxdFiles(files.slice(0, 2), { ownedLists: ['my-blu-rays'] })).toThrow(/pass its file/);
    expect(() => parseLetterboxdFiles([files[0] as { name: string; text: string }, files[0] as { name: string; text: string }])).toThrow(/two watched files/);
  });

  it('chooses loose files by path alone, before opening any', () => {
    const paths = ['x/watched.csv', 'x/Ratings.csv', 'x/diary.csv', 'x/watchlist.csv', 'x/reviews.csv', 'x/profile.csv', 'x/comments.csv', 'x/likes/films.csv', 'x/lists/My-Blu-Rays.csv', 'x/lists/favourites.csv', 'x/deleted/diary.csv', 'x\\orphaned\\diary.csv'];
    const c = chooseLooseFiles(paths, { ownedLists: ['my-blu-rays'] });
    expect(c.open).toEqual(['x/watched.csv', 'x/Ratings.csv', 'x/diary.csv', 'x/watchlist.csv', 'x/lists/My-Blu-Rays.csv']);
    expect(chooseLooseFiles(paths, { withReviews: true, watchlist: false }).open).toEqual(['x/watched.csv', 'x/Ratings.csv', 'x/diary.csv', 'x/reviews.csv']);
    // Plain import already read its one file to detect it, so only folders and options decide.
    expect(chooseLooseFiles(['my-ratings.csv'], {}, false).open).toEqual(['my-ratings.csv']);
    expect(() => chooseLooseFiles(['deleted/diary.csv'], {}, false)).toThrow(ImportError);
    expect(() => chooseLooseFiles(['profile.csv'])).toThrow(/None of the files/);
  });

  it('admits a named list only from a lists/ folder, so a list name can never open a private file', () => {
    expect(() => chooseLooseFiles(['x/profile.csv', 'x/comments.csv'], { ownedLists: ['profile', 'comments'] })).toThrow(/None of the files/);
    expect(chooseLooseFiles(['x/profile.csv', 'x/lists/profile.csv', 'x/watched.csv'], { ownedLists: ['profile'] }).open).toEqual(['x/lists/profile.csv', 'x/watched.csv']);
  });

  it('takes the latest diary entry rating as is: a blank one never brings back an older rating', () => {
    const res = parseLetterboxdFiles([
      { name: 'watched.csv', text: 'Date,Name,Year,Letterboxd URI\n2024-01-01,Night Ferry,2002,https://boxd.it/zZ0n\n' },
      {
        name: 'diary.csv',
        text: 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2020-01-01,Night Ferry,2002,https://boxd.it/aB0000,1,,,2020-01-01\n2025-01-01,Night Ferry,2002,https://boxd.it/aB0001,,Yes,,2025-01-01\n',
      },
    ]);
    expect(res.records[0]?.myRating).toBeUndefined();
    applyImport(db, [{ sourceTitle: 'Night Ferry', sourceYear: 2002, status: 'watched', myRating: 9, source: 'paste' }], { mode: 'merge' });
    applyImport(db, res.records, { mode: 'merge' });
    expect(item('Night Ferry')[0]?.myRating).toBe(9);
  });

  it('treats every file in lists/ as a list, gated only by --owned-list', () => {
    const lists = ['x/lists/watchlist.csv', 'x/lists/ratings.csv', 'x/lists/diary.csv', 'x/lists/watched.csv', 'x/lists/reviews.csv'];
    const none = chooseLooseFiles([...lists, 'x/watched.csv']);
    expect(none.open).toEqual(['x/watched.csv']);
    expect(none.warnings.filter((w) => /--owned-list does not name/.test(w))).toHaveLength(5);
    expect(chooseLooseFiles(lists, { ownedLists: ['reviews', 'watchlist'], watchlist: false }).open).toEqual(['x/lists/watchlist.csv', 'x/lists/reviews.csv']);
  });

  it('detects a header with quoted cells and imports it as Letterboxd', () => {
    const quoted = '"Date","Name","Year","Letterboxd URI","Rating"\n"2024-01-01","Night Ferry","2002","https://boxd.it/zZ0n","4"\n';
    expect(detectFormat(quoted, 'ratings.csv')).toBe('letterboxd');
    const res = parseImportDetailed(quoted, undefined, 'ratings.csv');
    expect(res.format).toBe('letterboxd');
    expect(res.records[0]).toMatchObject({ myRating: 8, status: 'watched', ownedIfNew: false, externalIds: { letterboxd: 'https://boxd.it/zZ0n' } });
    expect(detectFormat('"Letterboxd list export v7"\n', 'x.csv')).toBe('letterboxd');
  });

  it('matches a loose list file to --owned-list without case', () => {
    const res = parseLetterboxdFiles([{ name: 'My-Blu-Rays.csv', text: text('lists/my-blu-rays.csv') }], { ownedLists: ['my-blu-rays'] });
    expect(res.records.some((r) => r.owned === true)).toBe(true);
  });

  it('never falls back to a diary rating for a film whose ratings row is blank', () => {
    const res = parseLetterboxdFiles([
      { name: 'ratings.csv', text: 'Date,Name,Year,Letterboxd URI,Rating\n2024-01-01,Night Ferry,2002,https://boxd.it/zZ0n,\n' },
      { name: 'diary.csv', text: 'Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n2020-01-01,Night Ferry,2002,https://boxd.it/aB0000,1,,,2020-01-01\n' },
    ]);
    expect(res.records[0]?.myRating).toBeUndefined();
    applyImport(db, [{ sourceTitle: 'Night Ferry', sourceYear: 2002, status: 'watched', myRating: 9, source: 'paste' }], { mode: 'merge' });
    applyImport(db, res.records, { mode: 'merge' });
    expect(item('Night Ferry')[0]?.myRating).toBe(9);
  });

  it('does not use diary entries for films missing from the files given', () => {
    const res = parseLetterboxdFiles([{ name: 'diary.csv', text: text('diary.csv') }]);
    expect(res.records).toHaveLength(0);
    expect(res.warnings.join('\n')).toMatch(/6 diary entries have no film/);
  });
});

describe('importing into a library', () => {
  const importExport = (opts: LetterboxdOptions = {}) => applyImport(db, parseFolder(opts).records, { mode: 'merge' });

  it('adds every film as not owned, matched by title and year, and counts unmatched ones for review', () => {
    const summary = importExport();
    expect(summary.added).toBe(12);
    expect(items().every((i) => i.owned === false && i.source === 'letterboxd' && i.sourceOwnedRaw === null)).toBe(true);
    expect(item('The Glass Harbor', 1978)[0]).toMatchObject({ tconst: 'tt9000001', status: 'watched', myRating: 9, watchedEra: '2020s' });
    expect(item('The Glass Harbor', 2009)[0]).toMatchObject({ tconst: 'tt9000002', status: 'watched' });
    expect(item("Orrin Vale's Last Winter")[0]).toMatchObject({ status: 'queue', sourceYear: null });
    // A TV-like title the movie catalog doesn't have.
    expect(item('Harbor Patrol')[0]?.matchStatus).toBe('unmatched');
    expect(summary.needsReview).toBeGreaterThanOrEqual(1);
    const ids = db.sql.prepare("SELECT value FROM item_external_ids WHERE kind = 'letterboxd'").all() as { value: string }[];
    expect(ids).toHaveLength(12);
  });

  it('changes nothing when the same export is imported again', () => {
    importExport({ withReviews: true, ownedLists: ['my-blu-rays'] });
    const again = importExport({ withReviews: true, ownedLists: ['my-blu-rays'] });
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 13 });
  });

  it('never moves an existing item for a watchlist row, nor changes owned without --owned-list', () => {
    applyImport(
      db,
      [
        { sourceTitle: 'Copper Sky', sourceYear: 2018, status: 'priority', owned: true, source: 'paste' },
        { sourceTitle: 'Orrin Vale’s Last Winter', status: 'watched', owned: false, source: 'manual' },
        { sourceTitle: 'The Glass Harbor', sourceYear: 1978, sourceDirector: 'Orrin Vale', status: 'queue', owned: true, sourceOwnedRaw: 'Yes', source: 'paste' },
      ],
      { mode: 'merge' },
    );
    importExport();
    expect(item('Copper Sky')).toHaveLength(1);
    expect(item('Copper Sky')[0]).toMatchObject({ status: 'priority', owned: true });
    expect(item('Orrin Vale’s Last Winter')).toHaveLength(1);
    expect(item("Orrin Vale's Last Winter")).toHaveLength(0);
    expect(item('Orrin Vale’s Last Winter')[0]).toMatchObject({ status: 'watched', owned: false, source: 'manual' });
    const glass = item('The Glass Harbor', 1978);
    expect(glass).toHaveLength(1);
    expect(glass[0]).toMatchObject({ status: 'watched', owned: true, sourceOwnedRaw: 'Yes', source: 'paste', myRating: 9, sourceDirector: 'Orrin Vale' });
  });

  it('keeps an existing watched item watched and never clears a rating or notes', () => {
    applyImport(
      db,
      [
        { sourceTitle: 'Dune Static', sourceYear: 2016, status: 'watched', watchedEra: 'long-ago', myRating: 8, owned: false, source: 'paste' },
        { sourceTitle: 'The Glass Harbor', sourceYear: 2009, status: 'watched', myRating: 6, notes: 'My own note', owned: true, source: 'paste' },
        { sourceTitle: 'The Glass Harbor', sourceYear: 1978, status: 'watched', notes: 'Older note', owned: true, source: 'paste' },
        { sourceTitle: 'Seven Lanterns', sourceYear: 1995, status: 'watched', owned: true, source: 'paste' },
      ],
      { mode: 'merge' },
    );
    importExport({ withReviews: true });
    // Watchlist row and ratings row for one film: watched stays, the rating is updated (documented).
    expect(item('Dune Static')[0]).toMatchObject({ status: 'watched', myRating: 5, watchedEra: 'long-ago' });
    // No rating in the export for the 2009 film: its rating stays.
    expect(item('The Glass Harbor', 2009)[0]).toMatchObject({ myRating: 6, notes: 'My own note', watchedEra: 'long-ago' });
    // A review only fills blank notes.
    expect(item('The Glass Harbor', 1978)[0]?.notes).toBe('Older note');
    expect(item('Seven Lanterns')[0]?.notes).toBeNull();
  });

  it('marks owned-list films owned on insert and on merge', () => {
    applyImport(db, [{ sourceTitle: 'The Glass Harbor', sourceYear: 1978, status: 'watched', owned: false, source: 'paste' }], { mode: 'merge' });
    importExport({ ownedLists: ['my-blu-rays'] });
    expect(item('The Glass Harbor', 1978)[0]).toMatchObject({ owned: true, sourceOwnedRaw: 'My Blu-rays' });
    expect(item('Night Ferry')[0]).toMatchObject({ owned: true, status: 'queue', tconst: 'tt9000010' });
    expect(item('Quiet Ledger')[0]?.owned).toBe(false);
  });

  it('finds an item again by its Letterboxd URI after the title changed', () => {
    importExport();
    const renamed = parseLetterboxdFiles([
      { name: 'watched.csv', text: 'Date,Name,Year,Letterboxd URI\n2024-04-02,Quiet Ledger (Restored),1999,https://boxd.it/zZ5e\n' },
    ]);
    const s = applyImport(db, renamed.records, { mode: 'merge' });
    expect(s.added).toBe(0);
    expect(item('Quiet Ledger')).toHaveLength(1);
  });

  it('asks to clear a watched date only when the diary was read and has no entry for the film', () => {
    const { records } = parseFolder();
    expect(rec(records, 'zZ5e')?.clearWatchedAtIfOwn).toBe(true); // Quiet Ledger: watched, no diary entry
    expect(rec(records, 'zZ1a')?.clearWatchedAtIfOwn).toBeUndefined(); // has a diary date
    expect(rec(records, 'zZ7a')?.clearWatchedAtIfOwn).toBeUndefined(); // Twin Rivers: its entry fits two films
    expect(rec(records, 'zZ7b')?.clearWatchedAtIfOwn).toBeUndefined();
    const loose = parseLetterboxdFiles([{ name: 'watched.csv', text: text('watched.csv') }]);
    expect(loose.records.some((r) => r.clearWatchedAtIfOwn)).toBe(false);
  });

  it('clears a date an earlier Letterboxd import set once its diary entry is gone, and keeps any other date', () => {
    const diary = (date: string) => ({
      name: 'diary.csv',
      text: `Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n${date},Quiet Ledger,1999,https://boxd.it/aB5555,,,,${date}\n`,
    });
    const watched = { name: 'watched.csv', text: 'Date,Name,Year,Letterboxd URI\n2024-04-02,Quiet Ledger,1999,https://boxd.it/zZ5e\n' };
    applyImport(db, parseLetterboxdFiles([watched, diary('2024-04-02')]).records, { mode: 'merge' });
    expect(item('Quiet Ledger')[0]?.watchedAt).toBe('2024-04-02');
    const s = applyImport(db, parseFolder().records, { mode: 'merge' });
    expect(s.added).toBe(11);
    expect(item('Quiet Ledger')[0]?.watchedAt).toBeNull();
    expect(item('Quiet Ledger')[0]?.status).toBe('watched');

    db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');
    applyImport(db, [{ sourceTitle: 'Quiet Ledger', sourceYear: 1999, status: 'watched', watchedAt: '2023-05-05', source: 'paste' }], { mode: 'merge' });
    applyImport(db, parseFolder().records, { mode: 'merge' });
    expect(item('Quiet Ledger')[0]?.watchedAt).toBe('2023-05-05');
  });
});

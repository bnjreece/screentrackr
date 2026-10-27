/**
 * Letterboxd exports, as the user downloads them from letterboxd.com
 * (Settings, Data, Export your data): a ZIP of CSV files, the folder it
 * unzips to, or some of its CSV files. Nothing here fetches anything:
 * Letterboxd's terms forbid scraping, and its API is not open to projects
 * like this one. Film URIs are never resolved.
 *
 * Files read, and nothing else:
 * - watched.csv, ratings.csv, watchlist.csv: one row per film, keyed by the
 *   film's short URI (https://boxd.it/...), which becomes the item's
 *   `letterboxd` external id;
 * - diary.csv: one row per logged viewing, keyed by the entry's own URI; an
 *   entry belongs to the film with exactly its Name and Year;
 * - reviews.csv, with `withReviews` only: joined to diary entries by entry URI;
 * - lists/<slug>.csv, only for the lists named in `ownedLists`;
 * - deleted/diary.csv and orphaned/diary.csv, only to count their rows.
 * profile.csv, comments.csv, likes/ and other lists are never opened.
 *
 * Rules (each one keeps a Letterboxd import from damaging a library it merges into):
 * - A film in watched.csv or ratings.csv, or with a diary entry, is watched.
 *   A watchlist-only film goes in the queue only when it is new
 *   (`statusIfNew`), so it never moves an existing item.
 * - Ratings are half stars from 0.5 to 5, stored times two (1 to 10), which
 *   is Letterboxd's own 10-point conversion. ratings.csv wins; the latest
 *   diary rating is used only for a film with no ratings row.
 * - The watched date and era come from the latest diary Watched Date only,
 *   never from watched.csv's Date (when the row was logged). When the diary
 *   was read and a watched film has no entry in it, the record asks to clear
 *   the date only if an earlier Letterboxd import set it (clearWatchedAtIfOwn).
 * - Letterboxd has no idea of ownership in the export: `ownedIfNew: false`,
 *   never `owned`, except for films in a list the user names as owned.
 * - Descriptive fields (year, notes) only fill blanks (`fillOnly`).
 * - Tags, likes, rewatch flags and other lists are dropped.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WatchedEra } from '../types.js';
import { cleanText, ImportError, type ImportRecord, type ParsedImport } from './common.js';
import { parseCsvRows } from './csv.js';
import { decodeImdbFile } from './imdb.js';
import { listZip } from '../zip.js';

export interface LetterboxdOptions {
  /** Take each film's latest non-blank review as its notes (fills blank notes only). */
  withReviews?: boolean;
  /** Read watchlist.csv (default true). */
  watchlist?: boolean;
  /** Slugs of lists (lists/<slug>.csv) whose films are marked owned. */
  ownedLists?: readonly string[];
}

export interface LetterboxdParse extends ParsedImport {
  /** What was read and skipped, one line each. */
  notices: string[];
  /** Rows skipped in deleted/ and orphaned/ (diary entries). */
  skipped: { deleted: number; orphaned: number };
}

/** Where an export's files come from: a ZIP, a folder or loose files. */
export interface LetterboxdSource {
  /** Every file path, POSIX style, relative to the archive or folder. */
  paths: string[];
  read(path: string): Uint8Array;
}

const FILM_HEADER = ['Date', 'Name', 'Year', 'Letterboxd URI'];
const RATINGS_HEADER = [...FILM_HEADER, 'Rating'];
const DIARY_HEADER = [...FILM_HEADER, 'Rating', 'Rewatch', 'Tags', 'Watched Date'];
const REVIEWS_HEADER = [...FILM_HEADER, 'Rating', 'Rewatch', 'Review', 'Tags', 'Watched Date'];
const LIST_META_HEADER = ['Date', 'Name', 'Tags', 'URL', 'Description'];
const LIST_FILMS_HEADER = ['Position', 'Name', 'Year', 'URL', 'Description'];
const LIST_PREAMBLE = /^Letterboxd list export v(\d+)$/;
const LIST_VERSION = '7';

type Kind = 'watched' | 'ratings' | 'diary' | 'watchlist' | 'reviews' | 'list';

const sameCells = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((c, i) => c.trim() === b[i]);

/** Whether a file's first line is a Letterboxd export header (watched, ratings, diary, watchlist, reviews or a list). */
export function isLetterboxdHeader(firstLine: string): boolean {
  const line = firstLine.replace(/^\ufeff/, '').trim();
  if (LIST_PREAMBLE.test(line)) return true;
  const cells = line.split(',');
  return [FILM_HEADER, RATINGS_HEADER, DIARY_HEADER, REVIEWS_HEADER].some((h) => sameCells(cells, h));
}

function kindOf(name: string, rows: string[][]): Kind | null {
  const first = rows[0];
  if (first && first.length === 1 && LIST_PREAMBLE.test((first[0] ?? '').trim())) return 'list';
  if (sameCells(first, RATINGS_HEADER)) return 'ratings';
  if (sameCells(first, DIARY_HEADER)) return 'diary';
  if (sameCells(first, REVIEWS_HEADER)) return 'reviews';
  if (sameCells(first, FILM_HEADER)) {
    const base = basename(name).toLowerCase();
    if (base === 'watched.csv') return 'watched';
    if (base === 'watchlist.csv') return 'watchlist';
    throw new ImportError(
      `${name}: watched.csv and watchlist.csv have the same columns, so the file name has to say which one this is. Keep the export's file name (watched.csv or watchlist.csv).`,
    );
  }
  return null;
}

/** A film or diary entry URI as https://boxd.it/<code>, or null. */
function boxdUri(v: string | undefined): string | null {
  const m = /^https?:\/\/boxd\.it\/([A-Za-z0-9]+)\/?$/.exec((v ?? '').trim());
  return m ? `https://boxd.it/${m[1] as string}` : null;
}

/** A YYYY-MM-DD calendar date, or null. */
function isoDate(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : null;
}

/** Half stars (0.5 to 5) as 1 to 10; undefined for blank; null for anything else. */
function halfStars(v: string | undefined): number | undefined | null {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  if (!/^\d(\.\d+)?$/.test(s)) return null;
  const n = Number(s) * 2;
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

const eraOf = (date: string): WatchedEra => {
  const y = Number(date.slice(0, 4));
  return y >= 2020 ? '2020s' : y >= 2010 ? '2010s' : 'long-ago';
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** A review's HTML as plain text: line breaks and paragraphs kept, tags dropped, entities decoded. */
export function reviewText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
      if (code[0] === '#') {
        const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[code.toLowerCase()] ?? all;
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** A list slug as given on the command line (`my-blu-rays` or `my-blu-rays.csv`), checked so it names one file in lists/. */
export function cleanListSlug(v: string): string {
  const s = v.trim().replace(/\.csv$/i, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) throw new ImportError(`"${v}" is not a list slug (the file name of a list in the export's lists folder, such as my-blu-rays)`);
  return s;
}

interface Table {
  name: string;
  rows: string[][];
}

interface Film {
  uri: string;
  title: string;
  year: number | null;
  rawYear: string;
  watched: boolean;
  watchlist: boolean;
  rating?: number;
  ownedList?: string;
}

interface DiaryEntry {
  uri: string | null;
  title: string;
  rawYear: string;
  watchedDate: string | null;
  date: string | null;
  rating?: number;
  order: number;
}

const decode = (name: string, bytes: Uint8Array, warnings: string[]) => {
  const d = decodeImdbFile(bytes);
  if (d.warning) warnings.push(`${name}: ${d.warning}`);
  return d.text;
};

function table(name: string, text: string): Table {
  return { name, rows: parseCsvRows(text) };
}

/** Column accessor by header name. */
const reader = (header: string[]) => {
  const idx = new Map(header.map((h, i) => [h.trim(), i]));
  return (cells: string[], col: string) => {
    const i = idx.get(col);
    return i === undefined ? undefined : cells[i];
  };
};

interface Inputs {
  watched?: Table;
  ratings?: Table;
  diary?: Table;
  watchlist?: Table;
  reviews?: Table;
  lists: { slug: string; table: Table }[];
}

function buildRecords(inp: Inputs, opts: LetterboxdOptions, warnings: string[], notices: string[]): ImportRecord[] {
  const films = new Map<string, Film>();
  const filmRows = (t: Table | undefined, apply: (f: Film, cells: string[], at: ReturnType<typeof reader>, where: string) => void) => {
    if (!t) return;
    const at = reader(t.rows[0] ?? []);
    t.rows.slice(1).forEach((cells, i) => {
      const title = cleanText(at(cells, 'Name'));
      const where = `${t.name} row ${i + 1}${title ? ` ("${title}")` : ''}`;
      const uri = boxdUri(at(cells, 'Letterboxd URI'));
      if (!title) return warnings.push(`${where}: no title, skipped`);
      if (!uri) return warnings.push(`${where}: no Letterboxd film URI, skipped`);
      const rawYear = (at(cells, 'Year') ?? '').trim();
      const year = /^\d{4}$/.test(rawYear) ? Number(rawYear) : null;
      let f = films.get(uri);
      if (!f) {
        f = { uri, title, year, rawYear, watched: false, watchlist: false };
        films.set(uri, f);
      }
      apply(f, cells, at, where);
    });
  };

  filmRows(inp.watched, (f) => {
    f.watched = true;
  });
  filmRows(inp.ratings, (f, cells, at, where) => {
    const r = halfStars(at(cells, 'Rating'));
    if (r === null) warnings.push(`${where}: rating "${at(cells, 'Rating') ?? ''}" is not a half-star rating from 0.5 to 5, so it was left out`);
    else if (r !== undefined) f.rating = r;
    f.watched = true;
  });
  if (opts.watchlist !== false) {
    filmRows(inp.watchlist, (f) => {
      f.watchlist = true;
    });
  }

  for (const { slug, table: t } of inp.lists) {
    const rows = t.rows;
    const version = LIST_PREAMBLE.exec((rows[0]?.[0] ?? '').trim())?.[1];
    if (version !== LIST_VERSION) {
      warnings.push(`${t.name}: a Letterboxd list export of a version this tool doesn't know (v${version ?? '?'}), so the list was skipped and nothing in it was marked owned`);
      continue;
    }
    const split = rows.findIndex((r) => sameCells(r, LIST_FILMS_HEADER));
    if (split < 0) {
      warnings.push(`${t.name}: no film rows found, so the list was skipped`);
      continue;
    }
    const metaHeader = rows.findIndex((r) => sameCells(r, LIST_META_HEADER));
    const meta = metaHeader >= 0 && metaHeader + 1 < split ? rows[metaHeader + 1] : undefined;
    const listName = (meta ? cleanText(reader(LIST_META_HEADER)(meta, 'Name')) : null) ?? slug;
    const at = reader(LIST_FILMS_HEADER);
    let n = 0;
    rows.slice(split + 1).forEach((cells, i) => {
      const title = cleanText(at(cells, 'Name'));
      const where = `${t.name} film ${i + 1}${title ? ` ("${title}")` : ''}`;
      const uri = boxdUri(at(cells, 'URL'));
      if (!title) return warnings.push(`${where}: no title, skipped`);
      if (!uri) return warnings.push(`${where}: no Letterboxd film URI, skipped`);
      const rawYear = (at(cells, 'Year') ?? '').trim();
      let f = films.get(uri);
      if (!f) {
        f = { uri, title, year: /^\d{4}$/.test(rawYear) ? Number(rawYear) : null, rawYear, watched: false, watchlist: false };
        films.set(uri, f);
      }
      f.ownedList ??= listName;
      n++;
    });
    notices.push(`${t.name}: ${n} film${n === 1 ? '' : 's'} marked owned (list "${listName}")`);
  }

  // Diary entries attach to the film with exactly their Name and Year.
  const byNameYear = new Map<string, Film[]>();
  for (const f of films.values()) {
    const key = `${f.title}\u0000${f.rawYear}`;
    byNameYear.set(key, [...(byNameYear.get(key) ?? []), f]);
  }
  const entriesOf = new Map<string, DiaryEntry[]>();
  const entryFilm = new Map<string, string>();
  // Films a diary entry may belong to but could not be attached to: their date is unknown, not absent.
  const unsure = new Set<string>();
  let unplaced = 0;
  if (inp.diary) {
    const at = reader(inp.diary.rows[0] ?? []);
    inp.diary.rows.slice(1).forEach((cells, i) => {
      const title = cleanText(at(cells, 'Name'));
      if (!title) return;
      const rawYear = (at(cells, 'Year') ?? '').trim();
      const where = `${inp.diary?.name ?? 'diary.csv'} row ${i + 1} ("${title}")`;
      const entry: DiaryEntry = {
        uri: boxdUri(at(cells, 'Letterboxd URI')),
        title,
        rawYear,
        watchedDate: isoDate(at(cells, 'Watched Date')),
        date: isoDate(at(cells, 'Date')),
        order: i,
      };
      const r = halfStars(at(cells, 'Rating'));
      if (r === null) warnings.push(`${where}: rating "${at(cells, 'Rating') ?? ''}" is not a half-star rating from 0.5 to 5, so it was left out`);
      else if (r !== undefined) entry.rating = r;
      const matches = byNameYear.get(`${title}\u0000${rawYear}`) ?? [];
      if (matches.length > 1) {
        for (const m of matches) unsure.add(m.uri);
        warnings.push(`${where}: ${matches.length} films are called "${title}"${rawYear ? ` (${rawYear})` : ''}, so this diary entry was not attached to either`);
        return;
      }
      const film = matches[0];
      if (!film) {
        unplaced++;
        return;
      }
      entriesOf.set(film.uri, [...(entriesOf.get(film.uri) ?? []), entry]);
      if (entry.uri) entryFilm.set(entry.uri, film.uri);
    });
  }
  if (unplaced) {
    warnings.push(
      `${unplaced} diary entr${unplaced === 1 ? 'y has' : 'ies have'} no film with the same name and year in watched.csv, ratings.csv or the watchlist, so ${unplaced === 1 ? 'it was' : 'they were'} not used. Import the whole export to include ${unplaced === 1 ? 'it' : 'them'}.`,
    );
  }

  // Reviews join diary entries by the entry's URI, never by title.
  const reviewOf = new Map<string, string>();
  if (opts.withReviews && inp.reviews) {
    const at = reader(inp.reviews.rows[0] ?? []);
    let unjoined = 0;
    for (const cells of inp.reviews.rows.slice(1)) {
      const text = reviewText(at(cells, 'Review') ?? '');
      if (!text) continue;
      const uri = boxdUri(at(cells, 'Letterboxd URI'));
      if (!uri || !entryFilm.has(uri)) {
        unjoined++;
        continue;
      }
      reviewOf.set(uri, text);
    }
    if (unjoined) warnings.push(`${unjoined} review${unjoined === 1 ? '' : 's'} could not be joined to a diary entry, so ${unjoined === 1 ? 'it was' : 'they were'} not used`);
  }

  const latestFirst = (a: DiaryEntry, b: DiaryEntry) => {
    const ka = a.watchedDate ?? a.date ?? '';
    const kb = b.watchedDate ?? b.date ?? '';
    return ka === kb ? b.order - a.order : kb > ka ? 1 : -1;
  };

  const records: ImportRecord[] = [];
  for (const f of films.values()) {
    const entries = [...(entriesOf.get(f.uri) ?? [])].sort(latestFirst);
    const rec: ImportRecord = { sourceTitle: f.title, source: 'letterboxd', fillOnly: true, externalIds: { letterboxd: f.uri } };
    if (f.year !== null) rec.sourceYear = f.year;
    if (f.ownedList !== undefined) {
      rec.owned = true;
      rec.sourceOwnedRaw = f.ownedList;
    } else rec.ownedIfNew = false;

    if (f.watched || entries.length) {
      rec.status = 'watched';
      const watchedAt = entries.map((e) => e.watchedDate).find((d) => d !== null);
      if (watchedAt) {
        rec.watchedAt = watchedAt;
        rec.watchedEra = eraOf(watchedAt);
      } else if (inp.diary && !entries.length && !unsure.has(f.uri)) {
        // The diary was read and has no entry for this film (the user deleted
        // it), so a date an earlier Letterboxd import set is cleared. A date
        // the user or another source set is kept (see clearWatchedAtIfOwn).
        rec.clearWatchedAtIfOwn = true;
      }
    } else rec.statusIfNew = 'queue';

    const rating = f.rating ?? entries.find((e) => e.rating !== undefined)?.rating;
    if (rating !== undefined) rec.myRating = rating;

    if (opts.withReviews) {
      const review = entries.map((e) => (e.uri ? reviewOf.get(e.uri) : undefined)).find((t) => t !== undefined);
      if (review) rec.notes = review;
    }
    records.push(rec);
  }
  return records;
}

function countRows(source: LetterboxdSource, path: string, warnings: string[]): number {
  if (!source.paths.includes(path)) return 0;
  return Math.max(0, parseCsvRows(decode(path, source.read(path), warnings)).length - 1);
}

/**
 * The folder inside an export that holds its CSV files: the shallowest one
 * with a watched.csv, outside deleted/ and orphaned/.
 */
export function exportRoot(paths: string[]): string {
  const skip = new Set(['deleted', 'orphaned', '__macosx']);
  const roots = paths
    .filter((p) => basename(p).toLowerCase() === 'watched.csv')
    .map((p) => p.slice(0, p.length - 'watched.csv'.length))
    .filter((dir) => !dir.split('/').some((s) => skip.has(s.toLowerCase())));
  if (!roots.length) throw new ImportError('No watched.csv found, so this does not look like a Letterboxd export. Export your data from letterboxd.com (Settings, Data) and import the ZIP or its folder.');
  const depth = (d: string) => d.split('/').length;
  const min = Math.min(...roots.map(depth));
  const shallowest = roots.filter((d) => depth(d) === min);
  if (shallowest.length > 1) throw new ImportError('More than one Letterboxd export was found side by side. Import one export at a time.');
  return shallowest[0] as string;
}

/** Parse a whole Letterboxd export (a ZIP or a folder, see zipSource and folderSource). */
export function parseLetterboxdExport(source: LetterboxdSource, opts: LetterboxdOptions = {}): LetterboxdParse {
  const root = exportRoot(source.paths);
  const warnings: string[] = [];
  const notices: string[] = [];
  const has = (name: string) => source.paths.find((p) => p.toLowerCase() === (root + name).toLowerCase());
  const open = (name: string): Table | undefined => {
    const path = has(name);
    if (!path) return undefined;
    const t = table(name, decode(name, source.read(path), warnings));
    const kind = kindOf(name, t.rows);
    if (!t.rows.length) return undefined;
    if (kind !== name.replace(/\.csv$/, '')) throw new ImportError(`${name}: not the columns a Letterboxd ${name} has`);
    return t;
  };

  const inputs: Inputs = { lists: [] };
  inputs.watched = open('watched.csv');
  inputs.ratings = open('ratings.csv');
  inputs.diary = open('diary.csv');
  if (opts.watchlist !== false) inputs.watchlist = open('watchlist.csv');
  if (opts.withReviews) inputs.reviews = open('reviews.csv');
  for (const raw of opts.ownedLists ?? []) {
    const slug = cleanListSlug(raw);
    const name = `lists/${slug}.csv`;
    const path = has(name);
    if (!path) throw new ImportError(`No list "${slug}" in the export (looked for ${name}). Nothing was imported.`);
    inputs.lists.push({ slug, table: table(name, decode(name, source.read(path), warnings)) });
  }

  const skipped = {
    deleted: countRows(source, `${root}deleted/diary.csv`, warnings),
    orphaned: countRows(source, `${root}orphaned/diary.csv`, warnings),
  };
  if (skipped.deleted) notices.push(`Skipped ${skipped.deleted} deleted diary entr${skipped.deleted === 1 ? 'y' : 'ies'} (deleted/).`);
  if (skipped.orphaned) notices.push(`Skipped ${skipped.orphaned} diary entr${skipped.orphaned === 1 ? 'y' : 'ies'} for films Letterboxd no longer lists (orphaned/).`);

  const records = buildRecords(inputs, opts, warnings, notices);
  return { records, warnings, notices, skipped };
}

/** Parse loose CSV files from an export (watched.csv, ratings.csv, diary.csv, watchlist.csv, reviews.csv, list files). */
export function parseLetterboxdFiles(files: { name: string; text: string }[], opts: LetterboxdOptions = {}): LetterboxdParse {
  const warnings: string[] = [];
  const notices: string[] = [];
  const inputs: Inputs = { lists: [] };
  const owned = new Set((opts.ownedLists ?? []).map(cleanListSlug));
  const found = new Set<string>();
  for (const f of files) {
    const t = table(f.name, f.text);
    const kind = kindOf(f.name, t.rows);
    if (kind === null) throw new ImportError(`${f.name}: not a Letterboxd export file (watched, ratings, diary, watchlist, reviews or a list)`);
    if (kind === 'list') {
      const slug = basename(f.name).replace(/\.csv$/i, '');
      if (owned.has(slug)) {
        inputs.lists.push({ slug, table: t });
        found.add(slug);
      } else warnings.push(`${f.name}: a list that --owned-list does not name, so it was ignored`);
      continue;
    }
    if (inputs[kind]) throw new ImportError(`${f.name}: two ${kind} files were given; import one export at a time`);
    if (kind === 'watchlist' && opts.watchlist === false) continue;
    if (kind === 'reviews' && !opts.withReviews) {
      notices.push(`${f.name}: reviews are read only with --with-reviews, so it was ignored`);
      continue;
    }
    inputs[kind] = t;
  }
  for (const slug of owned) {
    if (!found.has(slug)) throw new ImportError(`--owned-list ${slug}: pass its file (lists/${slug}.csv) too, or import the whole export folder or ZIP. Nothing was imported.`);
  }
  const records = buildRecords(inputs, opts, warnings, notices);
  return { records, warnings, notices, skipped: { deleted: 0, orphaned: 0 } };
}

/** Size caps for reading an export ZIP: one entry, and all the entries read together. */
export interface ZipLimits {
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };

/** Whether the bytes start like a ZIP archive. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * An export ZIP held in memory, read with the shared ZIP reader
 * (core/zip.ts) without extracting anything to disk. Entries whose names
 * point outside the archive are skipped; an archive that names one file
 * twice is refused, since either copy could be the one read.
 */
export function zipSource(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): LetterboxdSource {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, ReturnType<typeof listZip>[number]>();
  const seen = new Set<string>();
  for (const e of listZip(buf)) {
    if (e.unsafe) continue;
    const path = e.name.replace(/\\/g, '/');
    const key = path.toLowerCase();
    if (seen.has(key)) throw new ImportError(`The ZIP lists ${path} more than once, so it is not clear which copy to read.`);
    seen.add(key);
    entries.set(path, e);
  }
  let total = 0;
  return {
    paths: [...entries.keys()],
    read: (p) => {
      const e = entries.get(p);
      if (!e) throw new ImportError(`${p} is not in the archive`);
      if (total + e.size > limits.maxTotalBytes) throw new ImportError(`The archive is too large to read (over ${limits.maxTotalBytes} bytes)`);
      const data = e.read(limits.maxEntryBytes);
      total += data.length;
      return data;
    },
  };
}

/**
 * An unzipped export folder. Lists .csv files up to a few folders deep,
 * never following symbolic links; a file is read only when asked for.
 */
export function folderSource(dir: string): LetterboxdSource {
  const paths: string[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 4) return;
    for (const d of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(p, depth + 1);
      else if (d.isFile() && d.name.toLowerCase().endsWith('.csv')) paths.push(p);
    }
  };
  walk('', 0);
  return {
    paths,
    read: (p) => {
      const full = join(dir, ...p.split('/'));
      if (!lstatSync(full).isFile()) throw new ImportError(`${p} is not a file`);
      return readFileSync(full);
    },
  };
}

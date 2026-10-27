/**
 * IMDb CSV exports, as the user downloads them by hand from imdb.com (Your
 * Ratings or a list's Export button, then the exports page). Nothing here
 * fetches anything: IMDb's Conditions of Use forbid robots and scraping.
 *
 * Two header shapes:
 * - ratings (14 columns): Const, Your Rating, Date Rated, Title, Original
 *   Title, URL, Title Type, IMDb Rating, Runtime (mins), Year, Genres, Num
 *   Votes, Release Date, Directors;
 * - list (18 columns, the watchlist, check-ins and custom lists alike):
 *   Position, Const, Created, Modified, Description, then the same title
 *   columns, then Your Rating and Date Rated.
 *
 * Rules (each one keeps an IMDb import from damaging a library it merges into):
 * - The Const is an exact `imdbIdHint` (`imdbIdExact`): the catalog's title
 *   when the catalog has it, otherwise an unmatched item that keeps the id,
 *   never another title found by name. It is never a JSON v1 style link.
 * - Only Movie rows (plus TV Movie, or other types, when asked) come in; the
 *   rest are counted by type and skipped.
 * - A rating means watched, with that rating. Date Rated is not a watch date.
 * - A watchlist row puts a NEW item in the queue (`statusIfNew`), so it never
 *   moves an existing item, a watched one included. A custom list sets no
 *   status. Check-ins are watched; their date is used only when asked.
 * - IMDb has no idea of ownership: `ownedIfNew: false`, never `owned`.
 * - Descriptive fields only fill blanks on an existing item (`fillOnly`).
 * - Runtime (mins) depends on the account's location, and a runtime more than
 *   3 minutes off the catalog can refute a correct Const or rule out the
 *   owner's own item, so it is never read. Neither are IMDb Rating, Num
 *   Votes, Release Date, URL or the list Description.
 * - Rows for one Const, across every file of one import, fold into one record.
 */
import { cleanText, cleanTconst, cleanYear, foldRecords, ImportError, type ImportRecord, type ParsedImport } from './common.js';
import { parseCsvRows } from './csv.js';

/** How to read a list export (the header doesn't say which list it is). */
export const IMDB_LIST_KINDS = ['watchlist', 'checkins', 'list'] as const;
export type ImdbListKind = (typeof IMDB_LIST_KINDS)[number];

/** Title types besides Movie that `includeTypes` may bring in. TV series, episodes, games and podcasts never come in. */
export const IMDB_INCLUDE_TYPES = ['tvMovie', 'short', 'video', 'tvSpecial', 'tvShort'] as const;
export type ImdbIncludeType = (typeof IMDB_INCLUDE_TYPES)[number];

export interface ImdbOptions {
  /** How to read list exports. Default `watchlist`, with a notice. Ratings exports are always ratings. */
  as?: ImdbListKind;
  /** With `as: 'list'`: the collection name for the list's movies (fills a blank collection only). */
  collection?: string;
  /** Title types to bring in besides Movie. */
  includeTypes?: readonly ImdbIncludeType[];
  /** With `as: 'checkins'`: use each check-in's Created date as the watched date. */
  checkinDates?: boolean;
}

export interface ImdbFile {
  /** Shown in warnings. */
  name: string;
  text: string;
}

export interface ImdbParse extends ParsedImport {
  /** Rows skipped by title type, by IMDb's label (`TV Episode`). */
  skippedByType: Record<string, number>;
  /** One line describing skippedByType, or nothing. */
  skippedSummary: string[];
  /** How each list file was read when `as` was not given. */
  notices: string[];
}

const TYPE_LABELS: Record<string, string> = {
  movie: 'Movie',
  tvmovie: 'TV Movie',
  tvseries: 'TV Series',
  tvminiseries: 'TV Mini Series',
  tvepisode: 'TV Episode',
  tvshort: 'TV Short',
  tvspecial: 'TV Special',
  short: 'Short',
  video: 'Video',
  videogame: 'Video Game',
  musicvideo: 'Music Video',
  podcastseries: 'Podcast Series',
  podcastepisode: 'Podcast Episode',
};

/** IMDb writes "TV Movie"; other tools have written "tvMovie" or "tv-movie". */
const typeKey = (v: string) => v.toLowerCase().replace(/[\s_-]+/g, '');

function headerCells(line: string): { cells: string[]; delimiter: ',' | ';' } {
  const delimiter = (line.match(/;/g)?.length ?? 0) > (line.match(/,/g)?.length ?? 0) ? ';' : ',';
  return { cells: line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, '').trim().toLowerCase()), delimiter };
}

type Shape = 'ratings' | 'list' | 'old';

function shapeOf(cells: string[]): Shape | null {
  const has = (c: string) => cells.includes(c);
  if (has('const') && has('you rated')) return 'old';
  if (!has('const') || !has('title') || !has('title type')) return null;
  if (has('position')) return 'list';
  if (has('your rating') && has('date rated')) return 'ratings';
  return null;
}

/** Whether a file's first line is an IMDb ratings or list export header (or the old pre-2018 one). */
export function isImdbHeader(firstLine: string): boolean {
  return shapeOf(headerCells(firstLine.replace(/^\uFEFF/, '')).cells) !== null;
}

/**
 * Decode an export's bytes: UTF-8 (a byte order mark is dropped), or, when
 * the bytes aren't valid UTF-8 (a spreadsheet saved it again), Windows-1252.
 */
export function decodeImdbFile(bytes: Uint8Array): { text: string; warning?: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(bytes),
      warning: 'not valid UTF-8, so it was read as Windows-1252 (a spreadsheet may have saved it again); check accented titles',
    };
  }
}

const hasLatin = (s: string) => /\p{Script=Latin}/u.test(s);

/** "8" or "8.0" from 1 to 10; undefined for blank; null for anything else. */
function imdbRating(v: string | undefined): number | undefined | null {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  if (!/^\d{1,2}(\.0+)?$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 10 ? n : null;
}

type DateOrder = 'dmy' | 'mdy' | 'same' | null;

const SLASH_DATE = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/;

/** Day-first or month-first for a file's slash dates, decided by any field over 12. */
function slashOrder(values: string[]): DateOrder {
  let dayFirst = false;
  let monthFirst = false;
  let differ = false;
  for (const v of values) {
    const m = SLASH_DATE.exec(v.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12) dayFirst = true;
    if (b > 12) monthFirst = true;
    if (a !== b) differ = true;
  }
  if (dayFirst && !monthFirst) return 'dmy';
  if (monthFirst && !dayFirst) return 'mdy';
  if (!dayFirst && !monthFirst && !differ) return 'same';
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

function validDate(y: number, m: number, d: number): string | null {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** An ISO or slash date as YYYY-MM-DD, or null. */
function toIsoDate(v: string | undefined, order: DateOrder): string | null {
  const s = (v ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const m = SLASH_DATE.exec(s);
  if (!m || order === null) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return order === 'mdy' ? validDate(Number(m[3]), a, b) : validDate(Number(m[3]), b, a);
}

function parseFile(file: ImdbFile, opts: ImdbOptions, out: { records: ImportRecord[]; warnings: string[]; skipped: Map<string, number>; notices: string[] }): void {
  const text = file.text.replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const { cells: header, delimiter } = headerCells(firstLine);
  const shape = shapeOf(header);
  if (shape === 'old') {
    throw new ImportError(
      `${file.name}: this is the older IMDb export format (before 2018), which has no Title Type or rating date columns. Export the list again from imdb.com and import the new file.`,
    );
  }
  if (shape === null) {
    throw new ImportError(`${file.name}: not an IMDb ratings or list export (expected Const, Title and Title Type columns)`);
  }
  const rows = parseCsvRows(text, delimiter);
  const col = (name: string) => header.indexOf(name);
  const at = (cells: string[], name: string): string | undefined => {
    const i = col(name);
    return i === -1 ? undefined : cells[i];
  };

  let kind: ImdbListKind | 'ratings' = 'ratings';
  if (shape === 'list') {
    kind = opts.as ?? 'watchlist';
    if (!opts.as) {
      out.notices.push(
        `${file.name}: an IMDb list export, read as your watchlist (new movies go in the queue; movies you have keep their status). Pass --as checkins or --as list for other lists.`,
      );
    }
  }
  const include = new Set((opts.includeTypes ?? []).map(typeKey));
  const body = rows.slice(1);

  let order: DateOrder = 'same';
  if (kind === 'checkins' && opts.checkinDates) {
    order = slashOrder(body.map((c) => at(c, 'created') ?? ''));
    if (order === null && body.some((c) => SLASH_DATE.test((at(c, 'created') ?? '').trim()))) {
      out.warnings.push(`${file.name}: could not tell whether its dates are day-first or month-first, so they were left out`);
    }
  }

  body.forEach((cells, i) => {
    const line = i + 2;
    const tconst = cleanTconst(at(cells, 'const'));
    const title = cleanText(at(cells, 'title'));
    const original = cleanText(at(cells, 'original title'));
    const where = `${file.name} line ${line}${title ? ` ("${title}")` : ''}`;
    if (!tconst) {
      out.warnings.push(`${where}: no valid Const (IMDb id), skipped`);
      return;
    }
    const sourceTitle = title && (hasLatin(title) || !original || !hasLatin(original)) ? title : original;
    if (!sourceTitle) {
      out.warnings.push(`${where}: no title, skipped`);
      return;
    }

    const rawType = cleanText(at(cells, 'title type')) ?? '';
    const tk = typeKey(rawType);
    if (tk !== 'movie' && !include.has(tk)) {
      const label = TYPE_LABELS[tk] ?? (rawType || '(blank)');
      if (!TYPE_LABELS[tk]) out.warnings.push(`${where}: unknown title type "${rawType}", skipped`);
      out.skipped.set(label, (out.skipped.get(label) ?? 0) + 1);
      return;
    }

    const rating = imdbRating(at(cells, 'your rating'));
    if (rating === null) {
      out.warnings.push(`${where}: rating "${at(cells, 'your rating') ?? ''}" is not a whole number from 1 to 10, skipped`);
      return;
    }
    if (kind === 'ratings' && rating === undefined) {
      out.warnings.push(`${where}: no rating in a ratings export, skipped`);
      return;
    }

    const rec: ImportRecord = { sourceTitle, imdbIdHint: tconst, imdbIdExact: true, source: 'imdb', ownedIfNew: false, fillOnly: true };
    const year = cleanYear(at(cells, 'year'));
    if (year !== null) rec.sourceYear = year;
    const directors = (at(cells, 'directors') ?? '')
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean)
      .join(', ');
    if (directors) rec.sourceDirector = directors;
    const genres = cleanText(at(cells, 'genres'));
    if (genres) rec.sourceGenre = genres;

    if (rating !== undefined) {
      rec.status = 'watched';
      rec.myRating = rating;
    }
    if (kind === 'watchlist' && rating === undefined) rec.statusIfNew = 'queue';
    if (kind === 'checkins') {
      rec.status = 'watched';
      if (opts.checkinDates) {
        const date = toIsoDate(at(cells, 'created'), order);
        if (date) rec.watchedAt = date;
      }
    }
    if (kind === 'list' && opts.collection?.trim()) rec.collection = opts.collection.trim();
    out.records.push(rec);
  });
}

/**
 * Parse one or more IMDb exports into records, one per Const across all the
 * files (see the module comment for the rules).
 */
export function parseImdb(files: ImdbFile[], opts: ImdbOptions): ImdbParse {
  if (opts.as !== undefined && !(IMDB_LIST_KINDS as readonly string[]).includes(opts.as)) {
    throw new ImportError(`Unknown IMDb list kind "${String(opts.as)}" (expected ${IMDB_LIST_KINDS.join(', ')})`);
  }
  for (const t of opts.includeTypes ?? []) {
    if (!(IMDB_INCLUDE_TYPES as readonly string[]).includes(t)) {
      throw new ImportError(`Unknown IMDb title type "${String(t)}" (expected ${IMDB_INCLUDE_TYPES.join(', ')})`);
    }
  }
  const acc = { records: [] as ImportRecord[], warnings: [] as string[], skipped: new Map<string, number>(), notices: [] as string[] };
  for (const f of files) parseFile(f, opts, acc);
  const records = foldRecords(acc.records, (r) => r.imdbIdHint, (w) => acc.warnings.push(w));
  const skippedByType = Object.fromEntries(acc.skipped);
  const total = [...acc.skipped.values()].reduce((a, b) => a + b, 0);
  const skippedSummary = total
    ? [
        `Skipped ${total} row${total === 1 ? '' : 's'} that ${total === 1 ? 'is' : 'are'} not a movie: ${[...acc.skipped].map(([k, n]) => `${k} ${n}`).join(', ')}. --include-type brings in ${IMDB_INCLUDE_TYPES.join(', ')}.`,
      ]
    : [];
  return { records, warnings: acc.warnings, skippedByType, skippedSummary, notices: acc.notices };
}

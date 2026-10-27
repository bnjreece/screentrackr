/**
 * Trakt's own data export: the "Raw export" ZIP from Settings > Data on
 * app.trakt.tv, the folder it unpacks to, or single files from it. Nothing
 * here calls Trakt; there is no API sync in this release.
 *
 * The export is one JSON array per page, `<name>.json` or `<name>-<n>.json`.
 * Only these files are ever read (an allow-list, by basename): watched-history,
 * watched-movies, ratings-movies, lists-watchlist, collection-movies, plus
 * `_errors.json`, the export's list of sections it could not fetch. The rest
 * (account settings with personal data, the people you follow, comments,
 * lists, paused playback, TV) are never opened.
 *
 * Rules:
 * - Rows fold into one record per Trakt movie id, across every file and page.
 *   The Trakt id is stored as the `trakt` external id, so a later import
 *   finds the same item; the IMDb id is a hint, checked against the catalog.
 * - Only movies come in. TV rows are counted; a row whose movie is null (a
 *   title deleted from Trakt) is skipped with a warning.
 * - Watched: any play in the history, or plays in watched-movies. The date is
 *   the latest play, as a local date. Plays dated at the epoch or before 1900
 *   are watched with no date, and when 10 or more plays share one second
 *   (a bulk "I've seen these" log) those dates are dropped too, unless asked.
 * - The watchlist puts a NEW movie in the queue (`statusIfNew`), so it never
 *   moves an existing item, a watched one included. Watched beats watchlist.
 * - A rating is just a rating (1 to 10); it never means watched.
 * - Only the collection means owned. Everything else sends `ownedIfNew:
 *   false`, so it never changes whether an existing item is owned.
 * - Title, year and watchlist notes only fill blanks (`fillOnly`). No Trakt
 *   catalog metadata (overviews, images, genres, tmdb ids) is kept.
 * - A movie that is only rated or only collected arrives in the queue when
 *   it is new (the importer's default status); an existing one keeps its own.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Status, WatchedEra } from '../types.js';
import { listZip } from '../zip.js';
import { cleanTconst, ImportError, type ImportRecord, type ParsedImport } from './common.js';

/** The export files the importer reads, by name stem. */
export const TRAKT_KINDS = ['watched-history', 'watched-movies', 'ratings-movies', 'lists-watchlist', 'collection-movies'] as const;
export type TraktKind = (typeof TRAKT_KINDS)[number];

export interface TraktFile {
  /** The file's name (a path is fine; only the basename counts). */
  name: string;
  text: string;
  /** Which export file it is, when its name doesn't say (a renamed single file). */
  kind?: TraktKind;
}

export interface TraktOptions {
  /** Keep the dates of bulk-logged plays (10 or more at one second). */
  keepBulkDates?: boolean;
  /** IANA time zone for watch dates. Default: this machine's. */
  timeZone?: string;
}

export interface TraktParse extends ParsedImport {
  /** One-line notes for the summary (bulk-logged dates dropped). */
  notices: string[];
  /** TV rows skipped (episodes, shows, seasons). */
  skippedTv: number;
  /** Entries in `_errors.json` (an unreadable `_errors.json` counts as one). */
  exportErrors: number;
  /** The parts this importer reads that the export says are incomplete. */
  incomplete: string[];
  /** Watched movies whose date was left out because it was bulk-logged. */
  bulkDated: number;
}

const FILE_RE = new RegExp(`^(${TRAKT_KINDS.join('|')})(?:-([1-9]\\d{0,5}))?\\.json$`, 'i');

/** Which allow-listed export file a name is (`errors` for `_errors.json`), or null. */
export function traktFileOf(name: string): { kind: TraktKind | 'errors'; page: number } | null {
  const base = basename(name.replace(/\\/g, '/'));
  if (base.toLowerCase() === '_errors.json') return { kind: 'errors', page: 1 };
  const m = FILE_RE.exec(base);
  if (!m) return null;
  return { kind: (m[1] as string).toLowerCase() as TraktKind, page: m[2] ? Number(m[2]) : 1 };
}

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Which export file a page of rows is, from the first row's fields, or null. */
function kindOfRows(rows: unknown[]): TraktKind | null {
  const r = rows.find(isObj);
  if (!r) return null;
  if ('watched_at' in r && 'action' in r) return 'watched-history';
  if ('plays' in r && 'last_watched_at' in r) return 'watched-movies';
  if ('rating' in r && 'rated_at' in r) return 'ratings-movies';
  if ('listed_at' in r && 'rank' in r) return 'lists-watchlist';
  if ('collected_at' in r) return 'collection-movies';
  return null;
}

const hasTraktId = (v: unknown) => isObj(v) && isObj(v.ids) && typeof v.ids.trakt === 'number';

/** Whether parsed JSON is a page of a Trakt export this importer reads (rows with `movie.ids.trakt` and a known shape). */
export function isTraktJson(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const sample = data.slice(0, 20).filter(isObj);
  return sample.some((r) => hasTraktId(r.movie) || hasTraktId(r.show) || hasTraktId(r.episode)) && kindOfRows(data) !== null;
}

/** Bytes per file, and in all, this reads from an export. Trakt pages are 250 rows, far below either. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export interface TraktExport {
  files: TraktFile[];
  /** Files (or archive entries) skipped because they are not on the allow-list. */
  skippedFiles: number;
}

const ALLOWED_NAMES = `${TRAKT_KINDS.join(', ')} (.json, also as numbered pages) and _errors.json`;

/**
 * Read an export from disk: a `.zip`, a folder (or the one folder inside it),
 * or single export files. Only allow-listed files are read; a ZIP's other
 * entries are never inflated, and a folder's symlinks and other files are
 * never opened.
 */
export function readTraktExport(paths: string[]): TraktExport {
  const files: TraktFile[] = [];
  let skippedFiles = 0;
  let total = 0;
  const seen = new Set<string>();
  const add = (where: string, name: string, data: Buffer, kind?: TraktKind) => {
    const key = (kind ?? basename(name)).toLowerCase();
    if (seen.has(key)) throw new ImportError(`${where}: ${basename(name)} appears more than once, so it is not clear which one to read`);
    seen.add(key);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new ImportError(`${where}: the export is too large to read (over ${MAX_TOTAL_BYTES} bytes)`);
    files.push({ name: basename(name), text: data.toString('utf8'), ...(kind ? { kind } : {}) });
  };
  const readFile = (path: string): Buffer => {
    try {
      return readFileSync(path);
    } catch (err) {
      throw new ImportError(`Could not read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
  };

  for (const path of paths) {
    let st;
    try {
      st = statSync(path);
    } catch (err) {
      throw new ImportError(`Could not read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    }
    const before = files.length;
    if (st.isDirectory()) {
      const readDir = (dir: string, depth: number): void => {
        const entries = readdirSync(dir, { withFileTypes: true });
        const wanted = entries.filter((e) => e.isFile() && traktFileOf(e.name));
        if (!wanted.length && depth === 0) {
          const dirs = entries.filter((e) => e.isDirectory());
          if (dirs.length === 1 && entries.filter((e) => !e.name.startsWith('.')).length === 1) {
            readDir(join(dir, (dirs[0] as { name: string }).name), 1);
            return;
          }
        }
        skippedFiles += entries.filter((e) => !e.isDirectory() && !e.name.startsWith('.')).length - wanted.length;
        for (const e of wanted) {
          const p = join(dir, e.name);
          if (statSync(p).size > MAX_FILE_BYTES) throw new ImportError(`${e.name}: too large to read (over ${MAX_FILE_BYTES} bytes)`);
          add(path, e.name, readFile(p));
        }
      };
      readDir(path, 0);
    } else if (st.isFile()) {
      if (st.size > MAX_ZIP_BYTES) throw new ImportError(`${path}: too large to read (over ${MAX_ZIP_BYTES} bytes)`);
      const data = readFile(path);
      const isZip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
      if (isZip || path.toLowerCase().endsWith('.zip')) {
        for (const entry of listZip(data)) {
          if (entry.unsafe || !traktFileOf(entry.name)) {
            skippedFiles++;
            continue;
          }
          add(path, entry.name, entry.read(MAX_FILE_BYTES));
        }
      } else {
        if (data.length > MAX_FILE_BYTES) throw new ImportError(`${path}: too large to read (over ${MAX_FILE_BYTES} bytes)`);
        if (traktFileOf(path)) add(path, path, data);
        else {
          const kind = kindOfJson(data.toString('utf8'));
          if (!kind) throw new ImportError(`${basename(path)}: not a Trakt export file this reads (expected ${ALLOWED_NAMES})`);
          add(path, path, data, kind);
        }
      }
    } else {
      throw new ImportError(`${path}: not a file or folder`);
    }
    if (files.length === before) throw new ImportError(`${path}: no Trakt export files found (expected ${ALLOWED_NAMES})`);
  }
  return { files, skippedFiles };
}

function kindOfJson(text: string): TraktKind | null {
  try {
    const data = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
    return isTraktJson(data) ? kindOfRows(data as unknown[]) : null;
  } catch {
    return null;
  }
}

/** One movie, gathered across every file. */
interface Acc {
  title: string;
  year: number | null;
  imdb: string | null;
  traktId: number;
  /** History plays: epoch ms, or null for an unknown date. */
  plays: (number | null)[];
  /** watched-movies: plays and its last-watched time. */
  wmPlays: number;
  wmLast: number | null;
  ratings: number[];
  watchlist: boolean;
  notes: string | null;
  collected: boolean;
}

/** Epoch ms for a Trakt timestamp, or null when it is missing, invalid, at the epoch or before 1900 (an unknown date). */
function playTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || ms === 0 || new Date(ms).getUTCFullYear() < 1900) return null;
  return ms;
}

function localDate(ms: number, fmt: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function eraOf(date: string): WatchedEra {
  const y = Number(date.slice(0, 4));
  return y < 2010 ? 'long-ago' : y < 2020 ? '2010s' : '2020s';
}

/** The 10-plays-in-one-second threshold for a bulk log. */
const BULK_PLAYS = 10;

const CATEGORIES: [RegExp, string][] = [
  [/\/history(\/movies)?$/, 'watch history'],
  [/\/watched\/movies$/, 'watched movies'],
  [/\/ratings(\/movies)?$/, 'ratings'],
  [/\/watchlist(\/movies)?$/, 'watchlist'],
  [/\/collection\/movies$/, 'collection'],
];

/** The endpoint without the username or query, as `users/<you>/history`. */
function redactEndpoint(endpoint: string): string {
  return endpoint
    .split('?')[0]!
    .replace(/^\/+/, '')
    .replace(/^users\/[^/]+/i, 'users/<you>')
    .replace(/[^\w/<>.-]/g, '')
    .slice(0, 80);
}

/**
 * Parse a Trakt export's files (already limited to the allow-list) into one
 * record per movie. See the module comment for the rules.
 */
export function parseTrakt(files: TraktFile[], opts: TraktOptions = {}): TraktParse {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: opts.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    throw new ImportError(`Unknown time zone "${String(opts.timeZone)}"`);
  }
  const warnings: string[] = [];
  const notices: string[] = [];
  const incomplete = new Set<string>();
  let exportErrors = 0;
  let skippedTv = 0;

  const pages = new Map<TraktKind, { page: number; name: string; text: string }[]>();
  for (const f of files) {
    const id = f.kind ? { kind: f.kind, page: 1 } : traktFileOf(f.name);
    if (!id) continue;
    const name = basename(f.name);
    if (id.kind === 'errors') {
      let list: unknown;
      try {
        list = JSON.parse(f.text.replace(/^\uFEFF/, ''));
      } catch {
        list = undefined;
      }
      if (!Array.isArray(list)) {
        exportErrors++;
        warnings.push(`${name}: could not be read, so your Trakt export may be incomplete. Export it again on app.trakt.tv if movies are missing.`);
        continue;
      }
      for (const e of list) {
        exportErrors++;
        const endpoint = isObj(e) && typeof e.endpoint === 'string' ? e.endpoint : '';
        const path = endpoint.split('?')[0]!.toLowerCase();
        const category = CATEGORIES.find(([re]) => re.test(path))?.[1];
        const fetched = isObj(e) && Number.isInteger(e.fetchedPages) ? Number(e.fetchedPages) : null;
        const pagesTotal = isObj(e) && Number.isInteger(e.totalPages) ? Number(e.totalPages) : null;
        const howMuch = fetched !== null && pagesTotal !== null ? ` (${fetched} of ${pagesTotal} pages)` : '';
        if (category) {
          incomplete.add(category);
          const then =
            category === 'watch history'
              ? 'Watched movies and dates also come from watched-movies.json, where it has them.'
              : 'Movies missing from it are left as they are; export again later to bring in the rest.';
          warnings.push(`Your Trakt export's ${category} is incomplete: Trakt could not export all of it${howMuch}. ${then}`);
        } else {
          warnings.push(
            `Trakt could not export one section of your data (${redactEndpoint(endpoint) || 'unnamed'}${howMuch}). screentrackr does not read that section, so this import is not affected.`,
          );
        }
      }
      continue;
    }
    const list = pages.get(id.kind) ?? [];
    list.push({ page: id.page, name, text: f.text });
    pages.set(id.kind, list);
  }

  const accs = new Map<number, Acc>();
  const seenPlays = new Set<number>();

  /** The movie a row is about, or null (TV, deleted, malformed: counted or warned). */
  const movieOf = (row: unknown, where: string, deleted: { n: number }): Acc | null => {
    if (!isObj(row)) {
      warnings.push(`${where}: not a Trakt row, skipped`);
      return null;
    }
    if (typeof row.type === 'string' && row.type !== 'movie') {
      skippedTv++;
      return null;
    }
    const m = row.movie;
    if (m === null || m === undefined) {
      if (row.show || row.episode || row.season) skippedTv++;
      else deleted.n++;
      return null;
    }
    const title = isObj(m) && typeof m.title === 'string' ? m.title.trim() : '';
    const ids = isObj(m) && isObj(m.ids) ? m.ids : {};
    const traktId = ids.trakt;
    if (!title || typeof traktId !== 'number' || !Number.isSafeInteger(traktId) || traktId <= 0) {
      warnings.push(`${where}${title ? ` ("${title}")` : ''}: no title or Trakt id, skipped`);
      return null;
    }
    let acc = accs.get(traktId);
    if (!acc) {
      const year = isObj(m) && Number.isInteger(m.year) && Number(m.year) >= 1000 && Number(m.year) <= 9999 ? Number(m.year) : null;
      acc = {
        title,
        year,
        imdb: typeof ids.imdb === 'string' ? cleanTconst(ids.imdb) : null,
        traktId,
        plays: [],
        wmPlays: 0,
        wmLast: null,
        ratings: [],
        watchlist: false,
        notes: null,
        collected: false,
      };
      accs.set(traktId, acc);
    }
    return acc;
  };

  for (const kind of TRAKT_KINDS) {
    const list = (pages.get(kind) ?? []).sort((a, b) => a.page - b.page || a.name.localeCompare(b.name));
    for (const page of list) {
      let rows: unknown;
      try {
        rows = JSON.parse(page.text.replace(/^\uFEFF/, ''));
      } catch {
        warnings.push(`${page.name}: not valid JSON, skipped`);
        continue;
      }
      if (!Array.isArray(rows)) {
        warnings.push(`${page.name}: not a page of a Trakt export (expected a JSON array), skipped`);
        continue;
      }
      const deleted = { n: 0 };
      rows.forEach((row, i) => {
        const where = `${page.name} row ${i + 1}`;
        if (kind === 'watched-history') {
          // A repeated play (the export can fetch past the last page) counts once.
          const id = isObj(row) ? row.id : undefined;
          if (typeof id === 'number' && Number.isSafeInteger(id)) {
            if (seenPlays.has(id)) return;
            seenPlays.add(id);
          }
          const acc = movieOf(row, where, deleted);
          if (acc) acc.plays.push(playTime((row as Row).watched_at));
        } else if (kind === 'watched-movies') {
          const plays = isObj(row) ? row.plays : undefined;
          if (typeof plays !== 'number' || !(plays > 0)) return;
          const acc = movieOf(row, where, deleted);
          if (!acc) return;
          acc.wmPlays += plays;
          const last = playTime((row as Row).last_watched_at);
          if (last !== null && (acc.wmLast === null || last > acc.wmLast)) acc.wmLast = last;
        } else if (kind === 'ratings-movies') {
          const rating = isObj(row) ? row.rating : undefined;
          const valid = typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 10;
          if (!valid && isObj(row) && row.movie && (row.type === undefined || row.type === 'movie')) {
            const t = isObj(row.movie) && typeof row.movie.title === 'string' ? ` ("${row.movie.title}")` : '';
            warnings.push(`${where}${t}: rating ${JSON.stringify(rating)} is not a whole number from 1 to 10, skipped`);
            return;
          }
          const acc = movieOf(row, where, deleted);
          if (acc && valid) acc.ratings.push(rating);
        } else if (kind === 'lists-watchlist') {
          const acc = movieOf(row, where, deleted);
          if (!acc) return;
          acc.watchlist = true;
          const notes = (row as Row).notes;
          if (acc.notes === null && typeof notes === 'string' && notes.trim()) acc.notes = notes.trim();
        } else {
          const acc = movieOf(row, where, deleted);
          if (acc) acc.collected = true;
        }
      });
      if (deleted.n) {
        warnings.push(`${page.name}: ${deleted.n} row${deleted.n === 1 ? '' : 's'} with no movie (a title deleted from Trakt), skipped`);
      }
    }
  }

  // Bulk logs: 10 or more plays (or last-watched times) at the same second.
  const bulk = new Set<number>();
  if (!opts.keepBulkDates) {
    const count = (times: number[]) => {
      const n = new Map<number, number>();
      for (const t of times) n.set(Math.floor(t / 1000), (n.get(Math.floor(t / 1000)) ?? 0) + 1);
      for (const [s, c] of n) if (c >= BULK_PLAYS) bulk.add(s);
    };
    const all = [...accs.values()];
    count(all.flatMap((a) => a.plays.filter((t): t is number => t !== null)));
    count(all.map((a) => a.wmLast).filter((t): t is number => t !== null));
  }

  let bulkDated = 0;
  const records: ImportRecord[] = [];
  for (const a of accs.values()) {
    const rec: ImportRecord = { sourceTitle: a.title, source: 'trakt', externalIds: { trakt: String(a.traktId) }, fillOnly: true };
    if (a.year !== null) rec.sourceYear = a.year;
    if (a.imdb) rec.imdbIdHint = a.imdb;
    if (a.collected) {
      rec.owned = true;
      rec.sourceOwnedRaw = 'trakt:collection';
    } else rec.ownedIfNew = false;

    const watched = a.plays.length > 0 || a.wmPlays > 0;
    if (watched) {
      rec.status = 'watched' satisfies Status;
      const known = [...a.plays, a.wmLast].filter((t): t is number => t !== null);
      const usable = known.filter((t) => !bulk.has(Math.floor(t / 1000)));
      if (known.length && !usable.length) bulkDated++;
      if (usable.length) {
        const date = localDate(Math.max(...usable), fmt);
        rec.watchedAt = date;
        rec.watchedEra = eraOf(date);
      }
    } else if (a.watchlist) rec.statusIfNew = 'queue';

    if (a.ratings.length) {
      if (a.ratings.some((r) => r !== a.ratings[0])) {
        warnings.push(`"${a.title}" has different ratings in the export (${[...new Set(a.ratings)].join(', ')}); its rating was left out`);
      } else rec.myRating = a.ratings[0] as number;
    }
    if (a.notes) rec.notes = a.notes;
    if (!watched && !a.watchlist && !a.ratings.length && !a.collected) continue;
    records.push(rec);
  }

  if (bulkDated) {
    notices.push(
      `${bulkDated} watched movie${bulkDated === 1 ? ' was' : 's were'} logged in bulk on Trakt (${BULK_PLAYS} or more plays at the same second), so ${bulkDated === 1 ? 'its watch date was' : 'their watch dates were'} left out. --keep-bulk-dates keeps them.`,
    );
  }
  if (skippedTv) notices.push(`Skipped ${skippedTv} TV row${skippedTv === 1 ? '' : 's'} (only movies are imported).`);
  return { records, warnings, notices, skippedTv, exportErrors, incomplete: [...incomplete], bulkDated };
}

/**
 * Parse one export file's text (the library API and `screentrackr import
 * <file>`): its name says which file it is, or else its rows' shape does.
 */
export function parseTraktFile(text: string, filename?: string, opts: TraktOptions = {}): TraktParse {
  const name = filename ?? 'file.json';
  if (traktFileOf(name)) return parseTrakt([{ name, text }], opts);
  const kind = kindOfJson(text);
  if (!kind) throw new ImportError(`${basename(name)}: not a Trakt export file this reads (expected ${ALLOWED_NAMES})`);
  return parseTrakt([{ name, text, kind }], opts);
}

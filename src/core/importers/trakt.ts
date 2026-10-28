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
 * - Watched: any play in the history, or plays in watched-movies. Every
 *   history play is a play (`viewings`) on its local date, with its history
 *   id as its ref, a decimal string read from the JSON text itself (the ids
 *   are int64 and can pass 2^53, so they are never parsed to a number).
 *   Plays dated at the epoch or before 1900 are plays with no date, and when
 *   10 or more plays share one second (a bulk "I've seen these" log) those
 *   dates are dropped too, unless asked. The history is the movie's whole
 *   Trakt history (`viewingsComplete`), so a play deleted on Trakt goes,
 *   unless the export cannot show it is whole (loose files, a missing page, a
 *   row or error list that can't be read, or `_errors.json` naming the
 *   history): then no play is added or removed (movies are still watched),
 *   since part of a history can't be told from plays stored earlier.
 *   watched-movies says a movie was watched, but its last_watched_at never
 *   becomes a play (it has no play id, so the same play seen later in the
 *   history could not be told from it). A history row with no play id is not kept as a play (it could never be
 *   told from the same play once it has one).
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
import type { Status } from '../types.js';
import { listZip } from '../zip.js';
import { cleanTconst, ImportError, type ImportRecord, type ParsedImport } from './common.js';

/** The export files the importer reads, by name stem. */
export const TRAKT_KINDS = ['watched-history', 'watched-movies', 'ratings-movies', 'lists-watchlist', 'collection-movies'] as const;
export type TraktKind = (typeof TRAKT_KINDS)[number];

export interface TraktFile {
  /** The file's name (a path is fine; only the basename counts). */
  name: string;
  text: string;
}

export interface TraktOptions {
  /** Keep the dates of bulk-logged plays (10 or more at one second). */
  keepBulkDates?: boolean;
  /** IANA time zone for watch dates. Default: this machine's. */
  timeZone?: string;
  /**
   * The files are a whole export (its ZIP or folder), so a full history in
   * them is each movie's whole Trakt history. Default true; pass false for
   * loose files, which may be some of its pages only. Either way the history
   * pages must run 1, 2, 3 and so on with none missing.
   */
  wholeExport?: boolean;
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

/**
 * The other files of a Trakt export, by name: account and personal data
 * (user-settings), other people (network-*), comments, likes, lists, notes,
 * TV and playback. A plain import refuses these before opening them.
 */
const EXCLUDED_RE = /^(user|network|comments|likes|hidden|notes|lists|ratings|watched|collection)-[^/]*\.json$/i;

/** Whether a name is a Trakt export file this never reads (not on the allow-list, but named like the export's other files). */
export function isExcludedTraktName(name: string): boolean {
  const base = basename(name.replace(/\\/g, '/'));
  return EXCLUDED_RE.test(base) && traktFileOf(base) === null;
}

type Row = Record<string, unknown>;
const isObj = (v: unknown): v is Row => typeof v === 'object' && v !== null && !Array.isArray(v);

const hasTraktId = (v: unknown) => isObj(v) && isObj(v.ids) && typeof v.ids.trakt === 'number';

/** Whether a row has the shape of one of the export files this reads. */
const knownShape = (r: Row) =>
  ('watched_at' in r && 'action' in r) ||
  ('plays' in r && 'last_watched_at' in r) ||
  ('rating' in r && 'rated_at' in r) ||
  ('listed_at' in r && 'rank' in r) ||
  'collected_at' in r;

/**
 * Whether parsed JSON looks like a page of a Trakt export: some row (among
 * the first few hundred, so a few odd rows don't hide it) has a Trakt id on
 * its movie, show or episode and the shape of a file this reads. Detection
 * only: the page is read only under its export name.
 */
export function isTraktJson(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  return data
    .slice(0, 500)
    .some((r) => isObj(r) && knownShape(r) && (hasTraktId(r.movie) || hasTraktId(r.show) || hasTraktId(r.episode)));
}

/** Bytes per file, and in all, this reads from an export. Trakt pages are 250 rows, far below either. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
/** The largest export ZIP read at all; also checked before a plain import lists a ZIP to tell its kind. */
export const MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export interface TraktExport {
  files: TraktFile[];
  /** Files (or archive entries) skipped because they are not on the allow-list. */
  skippedFiles: number;
  /** One ZIP or one folder was read, not loose files (see TraktOptions.wholeExport). */
  whole: boolean;
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
  const add = (where: string, name: string, data: Buffer) => {
    const key = basename(name).toLowerCase();
    if (seen.has(key)) throw new ImportError(`${where}: ${basename(name)} appears more than once, so it is not clear which one to read`);
    seen.add(key);
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new ImportError(`${where}: the export is too large to read (over ${MAX_TOTAL_BYTES} bytes)`);
    files.push({ name: basename(name), text: data.toString('utf8') });
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
      // Decided from the name alone: a file that is neither a .zip nor on the
      // allow-list is never opened.
      if (path.toLowerCase().endsWith('.zip')) {
        if (st.size > MAX_ZIP_BYTES) throw new ImportError(`${path}: too large to read (over ${MAX_ZIP_BYTES} bytes)`);
        for (const entry of listZip(readFile(path))) {
          if (entry.unsafe || !traktFileOf(entry.name)) {
            skippedFiles++;
            continue;
          }
          add(path, entry.name, entry.read(Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total)));
        }
      } else {
        if (!traktFileOf(path)) {
          throw new ImportError(
            `${basename(path)}: not a Trakt export file this reads (expected the export's .zip, its folder, or ${ALLOWED_NAMES}, under their export names)`,
          );
        }
        if (st.size > MAX_FILE_BYTES) throw new ImportError(`${path}: too large to read (over ${MAX_FILE_BYTES} bytes)`);
        add(path, path, readFile(path));
      }
    } else {
      throw new ImportError(`${path}: not a file or folder`);
    }
    if (files.length === before) throw new ImportError(`${path}: no Trakt export files found (expected ${ALLOWED_NAMES})`);
  }
  let whole = false;
  if (paths.length === 1) {
    const only = paths[0] as string;
    whole = statSync(only).isDirectory() || only.toLowerCase().endsWith('.zip');
  }
  return { files, skippedFiles, whole };
}

/** A short, safe description of a value for a warning (never serializes a nested value). */
function describe(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}...` : v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return String(v);
  return Array.isArray(v) ? 'a list' : 'an object';
}

const yearOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1000 && v <= 9999 ? v : null);

/** One movie, gathered across every file. */
interface Acc {
  title: string;
  year: number | null;
  imdb: string | null;
  traktId: number;
  /** History plays: epoch ms (null for an unknown date) and the play's history id as a decimal string. */
  plays: { t: number | null; ref: string | null }[];
  /** watched-movies: plays and its last-watched time. */
  wmPlays: number;
  wmLast: number | null;
  ratings: number[];
  watchlist: boolean;
  notes: string | null;
  collected: boolean;
  /** History rows of this movie with no usable play id: watched, but not kept as plays. */
  idless: number;
}

/** Epoch ms for a Trakt timestamp, or null when it is missing, invalid, at the epoch or before 1900 (an unknown date). */
function playTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || ms === 0) return null;
  const year = new Date(ms).getUTCFullYear();
  // Before 1900 is a placeholder; past 9998 the local date could leave YYYY-MM-DD.
  if (year < 1900 || year > 9998) return null;
  return ms;
}

function localDate(ms: number, fmt: Intl.DateTimeFormat): string {
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * JSON.parse reviver for history pages: a row's own `id` (the play's int64
 * history id, the only `id` beside `watched_at`) is replaced by its exact
 * source text, so an id past 2^53 is never rounded.
 */
function keepPlayIds(this: unknown, key: string, value: unknown, context?: { source?: string }): unknown {
  if (key === 'id' && typeof value === 'number' && isObj(this) && 'watched_at' in this && typeof context?.source === 'string') return context.source;
  return value;
}

/** A history id as a decimal string (its source text, or a safe integer), or null. */
function playRef(v: unknown): string | null {
  if (typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  return null;
}

/** The 10-plays-in-one-second threshold for a bulk log. */
const BULK_PLAYS = 10;

/** How the summary names what each export file holds. */
const KIND_LABEL: Record<TraktKind, string> = {
  'watched-history': 'watch history',
  'watched-movies': 'watched movies',
  'ratings-movies': 'ratings',
  'lists-watchlist': 'watchlist',
  'collection-movies': 'collection',
};

const CATEGORIES: [RegExp, string][] = [
  [/\/history(\/movies)?$/, 'watch history'],
  [/\/watched\/movies$/, 'watched movies'],
  [/\/ratings(\/movies)?$/, 'ratings'],
  [/\/watchlist(\/movies)?$/, 'watchlist'],
  [/\/collection\/movies$/, 'collection'],
];

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
  /**
   * Something the history may be missing that no part of the export names:
   * an unreadable _errors.json, a history row that could not be read, a
   * missing page, or loose files. The plays are then added, never removed.
   */
  let historyDoubt = opts.wholeExport === false;
  let exportErrors = 0;
  let skippedTv = 0;

  const pages = new Map<TraktKind, { page: number; name: string; text: string }[]>();
  for (const f of files) {
    const id = traktFileOf(f.name);
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
        historyDoubt = true;
        warnings.push(`${name}: could not be read, so your Trakt export may be incomplete. Export it again on app.trakt.tv if movies are missing.`);
        continue;
      }
      for (const e of list) {
        exportErrors++;
        // An entry that doesn't name its endpoint could be the history's.
        if (!isObj(e) || typeof e.endpoint !== 'string' || !e.endpoint.trim()) historyDoubt = true;
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
              ? 'Movies watched-movies.json lists are still marked watched; their plays come in with a complete export.'
              : 'Movies missing from it are left as they are; export again later to bring in the rest.';
          warnings.push(`Your Trakt export's ${category} is incomplete: Trakt could not export all of it${howMuch}. ${then}`);
        } else {
          warnings.push(`Trakt could not export one section of your data${howMuch}. screentrackr does not read that section, so this import is not affected.`);
        }
      }
      continue;
    }
    const list = pages.get(id.kind) ?? [];
    list.push({ page: id.page, name, text: f.text });
    pages.set(id.kind, list);
  }

  const accs = new Map<number, Acc>();
  /** Play ids of history rows whose title was deleted from Trakt: a complete set never removes them. */
  const unplaced = new Set<string>();
  /** Each play id seen in the history, with the Trakt id of its film. */
  const seenPlays = new Map<string, number>();

  let historyRead = false;

  /**
   * The movie a row is about, or null (TV, deleted, malformed: counted or
   * warned). History, ratings and watchlist rows carry a `type`, which must
   * be `movie`; watched-movies and collection rows have none.
   */
  /** A row skipped with a warning: in the history, it may have been a play of any movie. */
  let unread = 0;
  const movieOf = (row: unknown, where: string, deleted: { n: number }, typed: boolean): Acc | null => {
    if (!isObj(row)) {
      warnings.push(`${where}: not a Trakt row, skipped`);
      unread++;
      return null;
    }
    if (typed ? row.type !== 'movie' : row.type !== undefined && row.type !== 'movie') {
      if (row.type === 'episode' || row.type === 'show' || row.type === 'season') skippedTv++;
      else {
        warnings.push(`${where}: ${row.type === undefined ? 'no row type' : `unknown row type ${describe(row.type)}`}, skipped`);
        unread++;
      }
      return null;
    }
    const m = row.movie;
    if (m === null || m === undefined) {
      if (row.show || row.episode || row.season) skippedTv++;
      // An explicit null is a title deleted from Trakt; a missing movie is a row that could not be read.
      else if (m === null) deleted.n++;
      else {
        warnings.push(`${where}: no movie, skipped`);
        unread++;
      }
      return null;
    }
    const title = isObj(m) && typeof m.title === 'string' ? m.title.trim() : '';
    const ids = isObj(m) && isObj(m.ids) ? m.ids : {};
    const traktId = ids.trakt;
    if (!title || typeof traktId !== 'number' || !Number.isSafeInteger(traktId) || traktId <= 0) {
      warnings.push(`${where}${title ? ` (${describe(title)})` : ''}: no title or Trakt id, skipped`);
      unread++;
      return null;
    }
    let acc = accs.get(traktId);
    if (acc) {
      // A later row can fill what an earlier one lacked (a null year or IMDb id), so the match uses it.
      if (acc.year === null && isObj(m)) acc.year = yearOf(m.year);
      if (acc.imdb === null && typeof ids.imdb === 'string') acc.imdb = cleanTconst(ids.imdb);
    } else {
      acc = {
        title,
        year: isObj(m) ? yearOf(m.year) : null,
        imdb: typeof ids.imdb === 'string' ? cleanTconst(ids.imdb) : null,
        traktId,
        plays: [],
        wmPlays: 0,
        wmLast: null,
        ratings: [],
        watchlist: false,
        notes: null,
        collected: false,
        idless: 0,
      };
      accs.set(traktId, acc);
    }
    return acc;
  };

  for (const kind of TRAKT_KINDS) {
    const list = (pages.get(kind) ?? []).sort((a, b) => a.page - b.page || a.name.localeCompare(b.name));
    // History pages must run 1, 2, 3...: a gap is a page the history is missing.
    if (kind === 'watched-history' && list.some((p, i) => p.page !== i + 1)) historyDoubt = true;
    const unreadBefore = unread;
    for (const page of list) {
      let rows: unknown;
      try {
        // A history row's own id is kept as its source text (an int64 can pass 2^53).
        rows = kind === 'watched-history' ? JSON.parse(page.text.replace(/^\uFEFF/, ''), keepPlayIds) : JSON.parse(page.text.replace(/^\uFEFF/, ''));
      } catch {
        warnings.push(`${page.name}: not valid JSON, so your ${KIND_LABEL[kind]} from it were skipped and the import is incomplete`);
        incomplete.add(KIND_LABEL[kind]);
        continue;
      }
      if (!Array.isArray(rows)) {
        warnings.push(`${page.name}: not a page of a Trakt export (expected a JSON array), so it was skipped and the import is incomplete`);
        incomplete.add(KIND_LABEL[kind]);
        continue;
      }
      if (kind === 'watched-history') historyRead = true;
      const deleted = { n: 0 };
      rows.forEach((row, i) => {
        const where = `${page.name} row ${i + 1}`;
        if (kind === 'watched-history') {
          if (isObj(row) && row.type === 'movie' && row.movie === null) {
            // A play of a title deleted from Trakt: kept safe by its id; without one, it could be any stored play.
            const gone = playRef(row.id);
            if (gone !== null) unplaced.add(gone);
            else historyDoubt = true;
          }
          // The movie first, so even a repeated row can fill a year or IMDb id.
          const acc = movieOf(row, where, deleted, true);
          if (!acc) return;
          // A repeated play (the export can fetch past the last page) counts once.
          const ref = playRef((row as Row).id);
          if (ref === null) {
            // A play with no id could never be told from the same play once it
            // has one, so it is not kept; the movie still counts as watched, and
            // the history can't be whole.
            acc.idless++;
            unread++;
            warnings.push(`${where} (${describe(acc.title)}): a play with no Trakt play id, so it was not kept as a play`);
            return;
          }
          const film = seenPlays.get(ref);
          if (film !== undefined) {
            // The export can repeat a play; one play id on two films is damage, so the history is not whole.
            if (film !== acc.traktId) {
              historyDoubt = true;
              warnings.push(`${where} (${describe(acc.title)}): play id ${ref} is listed for two different movies, so this import adds and removes no play`);
            }
            return;
          }
          seenPlays.set(ref, acc.traktId);
          acc.plays.push({ t: playTime((row as Row).watched_at), ref });
        } else if (kind === 'watched-movies') {
          const plays = isObj(row) ? row.plays : undefined;
          if (typeof plays !== 'number' || !(plays > 0)) return;
          const acc = movieOf(row, where, deleted, false);
          if (!acc) return;
          acc.wmPlays += plays;
          const last = playTime((row as Row).last_watched_at);
          if (last !== null && (acc.wmLast === null || last > acc.wmLast)) acc.wmLast = last;
        } else if (kind === 'ratings-movies') {
          const rating = isObj(row) ? row.rating : undefined;
          const valid = typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 10;
          if (!valid && isObj(row) && row.movie && row.type === 'movie') {
            const t = isObj(row.movie) && typeof row.movie.title === 'string' ? ` (${describe(row.movie.title)})` : '';
            warnings.push(`${where}${t}: rating ${describe(rating)} is not a whole number from 1 to 10, skipped`);
            return;
          }
          const acc = movieOf(row, where, deleted, true);
          if (acc && valid) acc.ratings.push(rating);
        } else if (kind === 'lists-watchlist') {
          const acc = movieOf(row, where, deleted, true);
          if (!acc) return;
          acc.watchlist = true;
          const notes = (row as Row).notes;
          if (acc.notes === null && typeof notes === 'string' && notes.trim()) acc.notes = notes.trim();
        } else {
          const acc = movieOf(row, where, deleted, false);
          if (acc) acc.collected = true;
        }
      });
      if (deleted.n) {
        warnings.push(`${page.name}: ${deleted.n} row${deleted.n === 1 ? '' : 's'} with no movie (a title deleted from Trakt), skipped`);
      }
    }
    if (kind === 'watched-history' && unread > unreadBefore) historyDoubt = true;
  }

  // Bulk logs: 10 or more plays (or last-watched times) at the same second.
  const bulk = new Set<number>();
  if (!opts.keepBulkDates) {
    // Every distinct history play counts, plus watched-movies' last play
    // when the movie has no history play at that second (the same play
    // usually appears in both).
    const n = new Map<number, number>();
    const bump = (sec: number) => n.set(sec, (n.get(sec) ?? 0) + 1);
    for (const a of accs.values()) {
      const secs = new Set<number>();
      for (const { t } of a.plays) {
        if (t === null) continue;
        const sec = Math.floor(t / 1000);
        secs.add(sec);
        bump(sec);
      }
      if (a.wmLast !== null && !secs.has(Math.floor(a.wmLast / 1000))) bump(Math.floor(a.wmLast / 1000));
    }
    for (const [sec, c] of n) if (c >= BULK_PLAYS) bulk.add(sec);
  }
  const usable = (t: number | null): t is number => t !== null && !bulk.has(Math.floor(t / 1000));

  // The history is each movie's whole Trakt history only when it was read and
  // nothing says or suggests it is incomplete. Plays come only from such a
  // history: from part of one, a play could be the one an earlier import
  // holds under another date or without its ref (a release before 0.4.0
  // kept none), and nothing here could tell, so it would count twice.
  const historyComplete = historyRead && !incomplete.has('watch history') && !historyDoubt;
  // One list for every record (a big export can hold many such rows).
  const unplacedRefs = [...unplaced];
  let heldBack = 0;
  let noHistoryPlay = 0;
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

    const watched = a.plays.length > 0 || a.wmPlays > 0 || a.idless > 0;
    if (watched) {
      rec.status = 'watched' satisfies Status;
      if (!historyComplete) heldBack += a.plays.length;
      else if (a.plays.length) {
        const day = (t: number | null) => (usable(t) ? localDate(t, fmt) : null);
        rec.viewings = a.plays.map((p) => ({ watchedAt: day(p.t), sourceRef: p.ref }));
        rec.viewingsComplete = true;
        // Every date it had was left out as bulk-logged (counted once per movie).
        const known = a.plays.filter((p) => p.t !== null);
        if (known.length && known.every((p) => !usable(p.t))) bulkDated++;
      } else {
        // watched-movies' last play never becomes a play: it has no play id,
        // so the same play seen later in the history could not be told from
        // it. The movie is watched; its plays come from the history.
        noHistoryPlay++;
      }
    } else {
      if (a.watchlist) rec.statusIfNew = 'queue';
      // In the export but with no play in a whole history: no Trakt play of it is left.
      if (historyComplete) {
        rec.viewings = [];
        rec.viewingsComplete = true;
      }
    }

    if (a.ratings.length) {
      if (a.ratings.some((r) => r !== a.ratings[0])) {
        warnings.push(`"${a.title}" has different ratings in the export (${[...new Set(a.ratings)].join(', ')}); its rating was left out`);
      } else rec.myRating = a.ratings[0] as number;
    }
    if (a.notes) rec.notes = a.notes;
    if (rec.viewingsComplete && unplacedRefs.length) rec.keepRefs = unplacedRefs;
    if (!watched && !a.watchlist && !a.ratings.length && !a.collected) continue;
    records.push(rec);
  }

  if (bulkDated) {
    notices.push(
      `${bulkDated} watched movie${bulkDated === 1 ? ' was' : 's were'} logged in bulk on Trakt (${BULK_PLAYS} or more plays at the same second), so ${bulkDated === 1 ? 'its watch date was' : 'their watch dates were'} left out. --keep-bulk-dates keeps them.`,
    );
  }
  if (noHistoryPlay) {
    notices.push(
      `${noHistoryPlay} watched movie${noHistoryPlay === 1 ? ' has' : 's have'} no play in the history this export holds, so ${noHistoryPlay === 1 ? 'it is' : 'they are'} marked watched with no play or date. A complete export brings the plays in.`,
    );
  }
  if (historyRead && !historyComplete) {
    notices.push(
      `The Trakt history here can't be shown to be whole (loose files, a missing page, rows or an error list that could not be read, a play of a title deleted from Trakt with no play id, or _errors.json naming the history), so none of its ${heldBack} play${heldBack === 1 ? '' : 's'} were imported and no play was removed; the movies are still marked watched. Import the export's ZIP or folder to bring your plays in.`,
    );
  }
  if (skippedTv) notices.push(`Skipped ${skippedTv} TV row${skippedTv === 1 ? '' : 's'} (only movies are imported).`);
  return { records, warnings, notices, skippedTv, exportErrors, incomplete: [...incomplete], bulkDated };
}

/**
 * Parse one export file's text (the library API and `screentrackr import
 * <file>`). It must carry its export name, so a file outside the allow-list
 * (lists-favorites.json has the watchlist's shape) is never read as another.
 */
export function parseTraktFile(text: string, filename?: string, opts: TraktOptions = {}): TraktParse {
  const name = filename ?? '';
  if (!traktFileOf(name)) {
    throw new ImportError(
      `${basename(name) || 'This file'}: looks like a Trakt export file, but only ${ALLOWED_NAMES} are read, under their export names. Use \`screentrackr import trakt <the export ZIP>\`.`,
    );
  }
  // One file is never a whole export.
  return parseTrakt([{ name, text }], { ...opts, wholeExport: false });
}

/**
 * Letterboxd's import CSV (letterboxd.com/about/importing-data/). One format
 * serves three uploads: the account import (watched films and diary
 * entries), the watchlist import and a list import.
 *
 * Columns: imdbID (linked items only), Title, Year, Directors (only the
 * item's own credit, only without an imdbID), LetterboxdURI (an item's
 * `letterboxd` id, which makes a Letterboxd round trip exact), and for the
 * watched export WatchedDate, Rewatch, Rating10 and Tags. A value with a
 * comma or a quote is quoted, an inner quote is escaped with a backslash, and
 * no space follows a comma. Files are split by bytes below Letterboxd's 1 MB
 * limit, each with the header.
 */
import { LibraryError } from '../errors.js';
import { deriveRewatch, groupSameNight } from '../viewings.js';
import { filmOnWatchlist, filmViewings, filmWatched, films, firstWith, imdbIdOf, oneLine, titleOf, yearOf, type CsvFile, type ExportSource, type Film } from './common.js';

export type LetterboxdWhat = 'watched' | 'watchlist' | 'list';
export const LETTERBOXD_WHATS = ['watched', 'watchlist', 'list'] as const satisfies readonly LetterboxdWhat[];

/** Under Letterboxd's 1 MB per file, with room to spare. */
export const LETTERBOXD_MAX_BYTES = 950_000;

export interface LetterboxdOptions {
  what: LetterboxdWhat;
  /** For `what: 'list'`: the list's stored name. */
  list?: string;
  /** Put each film's lists in Tags (diary rows only; Letterboxd ignores Tags without WatchedDate). */
  listsAsTags?: boolean;
  /** Byte limit per file (tests). */
  maxBytes?: number;
}

export interface LetterboxdResult {
  files: CsvFile[];
  rows: number;
  /** Rows dropped for having nothing Letterboxd can match on (no id, no link, a blank title). */
  skipped: number;
}

const IDENTITY = ['imdbID', 'Title', 'Year', 'Directors', 'LetterboxdURI'] as const;
const DIARY = ['WatchedDate', 'Rewatch', 'Rating10', 'Tags'] as const;

/** One field: line breaks flattened; quoted when it holds a comma or a quote, inner quotes backslash-escaped. */
export function letterboxdField(v: string): string {
  const s = oneLine(v);
  return /[",]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

/** A comma list with no space after each comma; an entry's own commas become spaces. */
function commaList(names: readonly string[]): string {
  return names
    .map((n) => oneLine(n).replace(/\s*,\s*/g, ' ').trim())
    .filter((n) => n !== '')
    .join(',');
}

/** The item's own director credit, as a comma list without spaces after commas. */
function directorsOf(s: ExportSource): string | null {
  const d = s.item.sourceDirector;
  if (d === null || !d.trim()) return null;
  return d
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .join(',');
}

interface Row {
  /** Item id the row is named by in errors. */
  itemId: number;
  sortDate: string | null;
  cells: Record<string, string>;
}

function identity(f: Film): { itemId: number; cells: Record<string, string> } {
  const rep = f.items[0] as ExportSource;
  const imdb = imdbIdOf(rep);
  const year = yearOf(rep);
  return {
    itemId: rep.item.id,
    cells: {
      imdbID: imdb ?? '',
      Title: titleOf(rep),
      Year: year === null ? '' : String(year),
      // Only to help Letterboxd match by title when there is no IMDb id.
      Directors: imdb === null ? (directorsOf(rep) ?? '') : '',
      LetterboxdURI: firstWith(f, (s) => s.externalIds.letterboxd ?? null) ?? '',
    },
  };
}

/** The film's rows for the watched export: one per dated night, or one with no date when it has none. */
function watchedRows(f: Film, listsAsTags: boolean): Row[] {
  if (!filmWatched(f)) return [];
  const id = identity(f);
  const owner = new Map<number, ExportSource>();
  for (const s of f.items) for (const v of s.viewings) owner.set(v.id, s);
  const vs = filmViewings(f);
  const derived = deriveRewatch(vs);
  const nights = groupSameNight(vs).filter((g) => g.date !== null);
  const tags = listsAsTags ? commaList([...new Set(f.items.flatMap((s) => s.lists))].sort()) : '';
  const itemRating = (s: ExportSource | undefined) => s?.item.myRating ?? null;
  const filmRating = (): number | null => firstWith(f, (s) => s.item.myRating);
  if (nights.length === 0) {
    const r = filmRating();
    return [{ itemId: id.itemId, sortDate: null, cells: { ...id.cells, Rating10: r === null ? '' : String(r) } }];
  }
  const latest = nights.reduce((a, b) => ((b.date as string) > (a.date as string) ? b : a));
  return nights.map((g) => {
    const explicit = g.viewings.filter((v) => v.rewatch !== null);
    const rewatch = explicit.length ? explicit.some((v) => v.rewatch === true) : g.viewings.some((v) => derived.get(v.id) === true);
    let rating: number | null = g.viewings.find((v) => v.rating !== null)?.rating ?? null;
    if (rating === null && g === latest) {
      // The item's rating goes on the latest night only: the item that was played that night, else the film's.
      rating = g.viewings.map((v) => itemRating(owner.get(v.id))).find((x) => x !== null) ?? filmRating();
    }
    return {
      itemId: id.itemId,
      sortDate: g.date,
      cells: { ...id.cells, WatchedDate: g.date as string, Rewatch: rewatch ? 'true' : 'false', Rating10: rating === null ? '' : String(rating), Tags: tags },
    };
  });
}

/** Split rows into files below the byte limit, each with the header, never mid-row. */
function split(prefix: string, header: string, lines: { itemId: number; line: string }[], maxBytes: number): CsvFile[] {
  const headBytes = Buffer.byteLength(`${header}\n`, 'utf8');
  const files: CsvFile[] = [];
  let body: string[] = [];
  let bytes = headBytes;
  const flush = () => {
    if (!body.length) return;
    files.push({ name: `${prefix}-${files.length + 1}.csv`, content: `${header}\n${body.join('')}`, rows: body.length });
    body = [];
    bytes = headBytes;
  };
  for (const { itemId, line } of lines) {
    const b = Buffer.byteLength(line, 'utf8');
    if (headBytes + b > maxBytes) throw new LibraryError(`The Letterboxd row for item ${itemId} is over ${maxBytes} bytes on its own, so no file can hold it`);
    if (bytes + b > maxBytes) flush();
    body.push(line);
    bytes += b;
  }
  flush();
  return files;
}

/** The Letterboxd import CSV for the chosen export. Pure; an empty selection gives no files. */
export function letterboxdCsv(sources: readonly ExportSource[], opts: LetterboxdOptions): LetterboxdResult {
  const all = films(sources);
  let rows: Row[];
  let columns: readonly string[];
  if (opts.what === 'watched') {
    columns = [...IDENTITY, ...DIARY];
    const dated: Row[] = [];
    const undated: Row[] = [];
    for (const f of all) for (const r of watchedRows(f, opts.listsAsTags === true)) (r.sortDate === null ? undated : dated).push(r);
    // Diary entries oldest first, so Letterboxd logs them in order; films with no dated play after.
    dated.sort((a, b) => (a.sortDate as string).localeCompare(b.sortDate as string) || a.itemId - b.itemId);
    rows = [...dated, ...undated];
  } else {
    columns = IDENTITY;
    let chosen: Film[];
    if (opts.what === 'watchlist') chosen = all.filter(filmOnWatchlist);
    else {
      const list = opts.list;
      if (list === undefined) throw new LibraryError('A list export needs the list name');
      chosen = all.filter((f) => f.items.some((s) => s.lists.includes(list)));
    }
    rows = chosen.map((f) => ({ ...identity(f), sortDate: null }));
  }
  const before = rows.length;
  rows = rows.filter((r) => r.cells.imdbID || r.cells.LetterboxdURI || r.cells.Title);
  const header = columns.join(',');
  const lines = rows.map((r) => ({ itemId: r.itemId, line: `${columns.map((c) => letterboxdField(r.cells[c] ?? '')).join(',')}\n` }));
  const files = split(`letterboxd-${opts.what}`, header, lines, opts.maxBytes ?? LETTERBOXD_MAX_BYTES);
  return { files, rows: lines.length, skipped: before - rows.length };
}

/**
 * A CSV for Trakt's importer (one file; trakt-web's TraktCsvParser, which
 * reads it with PapaParse's defaults, so quoting is RFC 4180: inner quotes
 * doubled). Columns: type, action, title, year, imdb, trakt, watched_at,
 * rating, rated_at, listed_at. Every row names its action.
 *
 * - history: one row per play, editions of a film and the same night from
 *   several sources collapsed into one (the read-side rule). `watched_at` is
 *   the stored date (a bare date, which Trakt reads as noon local) or
 *   `unknown` for a play with no date.
 * - ratings: one per rated film, `rated_at` the rated item's `updated_at`.
 * - watchlist: queue, priority and someday films never watched, `listed_at`
 *   the earliest edition's `added_at`.
 *
 * `imdb` only for linked items, `trakt` when the item has a Trakt id. A row
 * with no id and no year is dropped and counted: Trakt's parser would drop
 * it too.
 */
import { calendarDate, groupSameNight, type Viewing } from '../viewings.js';
import { filmOnWatchlist, filmViewings, films, firstWith, imdbIdOf, oneLine, titleOf, yearOf, type ExportSource, type Film } from './common.js';

export type TraktWhat = 'all' | 'history' | 'ratings' | 'watchlist';
export const TRAKT_WHATS = ['all', 'history', 'ratings', 'watchlist'] as const satisfies readonly TraktWhat[];

export const TRAKT_COLUMNS = ['type', 'action', 'title', 'year', 'imdb', 'trakt', 'watched_at', 'rating', 'rated_at', 'listed_at'] as const;
type Column = (typeof TRAKT_COLUMNS)[number];

export interface TraktResult {
  content: string;
  rows: { history: number; ratings: number; watchlist: number };
  /** Rows dropped for having no id and no year. */
  skipped: number;
  /** History rows written as `watched_at` = `unknown`. */
  dateless: number;
}

/** One field, RFC 4180: quoted when it holds a comma, a quote or leading/trailing space; inner quotes doubled. */
export function traktField(v: string): string {
  const s = oneLine(v);
  return /[",]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A stored play's date as Trakt reads it: a bare date stays bare; a date-time gets a `T`. */
function watchedAtOf(v: Viewing): string {
  const w = v.watchedAt as string;
  return w.length > 10 ? `${calendarDate(w)}T${w.slice(11)}` : w;
}

/** The play to write for one night: one with a time when any has one, else the first. */
function nightPlay(vs: readonly Viewing[]): Viewing {
  return [...vs].sort((a, b) => Number((b.watchedAt?.length ?? 0) > 10) - Number((a.watchedAt?.length ?? 0) > 10) || a.id - b.id)[0] as Viewing;
}

function identity(f: Film): Partial<Record<Column, string>> {
  const rep = f.items[0] as ExportSource;
  const year = yearOf(rep);
  return {
    type: 'movie',
    title: titleOf(rep),
    year: year === null ? '' : String(year),
    imdb: imdbIdOf(rep) ?? '',
    trakt: firstWith(f, (s) => s.externalIds.trakt ?? null) ?? '',
  };
}

const hasKey = (c: Partial<Record<Column, string>>): boolean => Boolean(c.imdb || c.trakt || (c.title && c.year));

/** The Trakt import CSV. Pure. */
export function traktCsv(sources: readonly ExportSource[], opts: { what: TraktWhat }): TraktResult {
  const all = films(sources);
  const want = (a: Exclude<TraktWhat, 'all'>) => opts.what === 'all' || opts.what === a;
  const out: { cells: Partial<Record<Column, string>>; action: 'history' | 'ratings' | 'watchlist' }[] = [];
  let skipped = 0;
  let dateless = 0;
  const push = (action: 'history' | 'ratings' | 'watchlist', cells: Partial<Record<Column, string>>) => {
    if (!hasKey(cells)) {
      skipped++;
      return false;
    }
    out.push({ action, cells: { ...cells, action } });
    return true;
  };

  if (want('history')) {
    const dated: { date: string; id: number; cells: Partial<Record<Column, string>> }[] = [];
    const undated: Partial<Record<Column, string>>[] = [];
    for (const f of all) {
      const id = identity(f);
      for (const g of groupSameNight(filmViewings(f))) {
        if (g.date === null) undated.push({ ...id, watched_at: 'unknown' });
        else dated.push({ date: g.date, id: (f.items[0] as ExportSource).item.id, cells: { ...id, watched_at: watchedAtOf(nightPlay(g.viewings)) } });
      }
    }
    dated.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    for (const d of dated) push('history', d.cells);
    for (const u of undated) if (push('history', u)) dateless++;
  }
  if (want('ratings')) {
    for (const f of all) {
      // The edition rated most recently speaks for the film.
      const rated = f.items.filter((s) => s.item.myRating !== null).sort((a, b) => b.item.updatedAt.localeCompare(a.item.updatedAt) || a.item.id - b.item.id)[0];
      if (!rated) continue;
      push('ratings', { ...identity(f), rating: String(rated.item.myRating), rated_at: rated.item.updatedAt });
    }
  }
  if (want('watchlist')) {
    for (const f of all) {
      if (!filmOnWatchlist(f)) continue;
      const listedAt = f.items.map((s) => s.item.addedAt).sort()[0] as string;
      push('watchlist', { ...identity(f), listed_at: listedAt });
    }
  }
  const lines = out.map((r) => TRAKT_COLUMNS.map((c) => traktField(r.cells[c] ?? '')).join(','));
  const count = (a: string) => out.filter((r) => r.action === a).length;
  return {
    content: `${[TRAKT_COLUMNS.join(','), ...lines].join('\n')}\n`,
    rows: { history: count('history'), ratings: count('ratings'), watchlist: count('watchlist') },
    skipped,
    dateless,
  };
}

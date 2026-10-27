/**
 * Library counts and watch stats.
 *
 * `libraryStats` counts library items (editions): each counts once. Genres,
 * directors and years come from the catalog for linked items and from the
 * source fields otherwise, the same rule search uses.
 *
 * `watchStats` counts films and plays. A film is a tconst for linked items
 * (every edition together), else the item. A film is watched when any edition
 * has status `watched` or any play. Plays use the cross-source same-night
 * collapse (groupSameNight): one night from two sources, or on two editions,
 * is one play, and dateless plays count as the largest per-source count. A
 * film's rating is its most recently updated rated edition's. Calendar years
 * are the watched date string's own (its first 10 characters), so no time
 * zone conversion happens.
 */
import type { Db } from './db.js';
import { LibraryError } from './errors.js';
import { LIST_MODES } from './filters.js';
import { normListName, requireList } from './lists.js';
import { splitPeople } from './match.js';
import { STATUSES, type Status } from './types.js';
import { calendarDate, deriveRewatch, groupSameNight, viewingsByItem, type Viewing } from './viewings.js';

export interface LibraryStats {
  total: number;
  byStatus: Record<Status, number>;
  unmatched: number;
  ambiguous: number;
  topGenres: [string, number][];
  topDirectors: [string, number][];
  byDecade: [string, number][];
  /** Plays this calendar year (0.4.0). */
  playsThisYear: number;
  /** Films with your rating (0.4.0). */
  rated: number;
}

const TOP_N = 10;

function top(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_N);
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

const decadeOf = (year: number) => `${Math.floor(year / 10) * 10}s`;

interface ItemRow {
  id: number;
  status: Status;
  match_status: string;
  /** The item's tconst when it is linked (matched or manual), with or without a catalog row: the film's identity. */
  linked_tconst: string | null;
  source_director: string | null;
  source_genre: string | null;
  genres_csv: string | null;
  year: number | null;
  directors: string | null;
  my_rating: number | null;
  updated_at: string;
  imdb_rating: number | null;
}

function itemRows(db: Db): ItemRow[] {
  return db.sql
    .prepare(
      `SELECT li.id AS id, li.status AS status, li.match_status AS match_status,
              CASE WHEN li.tconst IS NOT NULL AND li.match_status IN ('matched', 'manual') THEN li.tconst END AS linked_tconst,
              li.source_director AS source_director, li.source_genre AS source_genre,
              t.genres_csv AS genres_csv, COALESCE(t.year, li.source_year) AS year,
              (SELECT group_concat(p.name, char(31)) FROM (SELECT p.name FROM title_people tp JOIN people p ON p.nconst = tp.nconst
                WHERE tp.tconst = t.tconst AND tp.role = 'director' ORDER BY tp.ord) p) AS directors,
              li.my_rating AS my_rating, li.updated_at AS updated_at, r.rating AS imdb_rating
       FROM library_items li
       LEFT JOIN titles t ON t.tconst = li.tconst AND li.tconst IS NOT NULL AND li.match_status IN ('matched', 'manual')
       LEFT JOIN ratings r ON r.tconst = t.tconst
       ORDER BY li.id`,
    )
    .all() as unknown as ItemRow[];
}

const genresOf = (r: ItemRow) => [...new Set((r.genres_csv ?? r.source_genre ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
const directorsOf = (r: ItemRow) => [...new Set(r.directors ? r.directors.split('\u001f') : splitPeople(r.source_director))];

export function libraryStats(db: Db, opts: { now?: Date } = {}): LibraryStats {
  const rows = itemRows(db);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const genres = new Map<string, number>();
  const directors = new Map<string, number>();
  const decades = new Map<string, number>();
  let unmatched = 0;
  let ambiguous = 0;

  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.match_status === 'unmatched') unmatched++;
    if (r.match_status === 'ambiguous') ambiguous++;
    for (const name of genresOf(r)) bump(genres, name);
    for (const d of directorsOf(r)) bump(directors, d);
    if (r.year !== null) bump(decades, decadeOf(r.year));
  }

  const summary = watchSummary(db, opts);
  return {
    total: rows.length,
    byStatus,
    unmatched,
    ambiguous,
    topGenres: top(genres),
    topDirectors: top(directors),
    byDecade: [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    playsThisYear: summary.playsThisYear,
    rated: summary.rated,
  };
}

// ---------------------------------------------------------------------------
// Watch stats

export const WATCH_STATS_BY = ['year', 'decade', 'genre', 'director', 'rating'] as const;
export type WatchStatsBy = (typeof WATCH_STATS_BY)[number];

/** How many genres and directors the summary shows. */
export const WATCH_STATS_TOP = 10;
export const WATCH_STATS_MAX_LIMIT = 1000;
const MIN_YEAR = 1800;
const MAX_YEAR = 2200;

export interface WatchStatsOptions {
  /** Limit the "watched in" measures (and every block) to films played in this calendar year. */
  year?: number;
  /** The block shown in full: its rows are capped only by an explicit `limit`. */
  by?: WatchStatsBy;
  /** Rows in the genre and director blocks (default 10), or in the `by` block when given. The rating distribution always has ten rows. */
  limit?: number;
  /** Only films with an edition in these lists (any of them, or all with listMode `all`), as in search. */
  lists?: string[];
  listMode?: (typeof LIST_MODES)[number];
  /** For tests: "this year". */
  now?: Date;
}

export interface YearRow {
  year: number;
  plays: number;
  films: number;
  rewatches: number;
}

export interface NamedRow {
  name: string;
  films: number;
  /** Of those films, how many you rated. */
  rated: number;
  /** Your average rating over the rated ones, to two decimals, or null. */
  averageRating: number | null;
}

export interface WatchStats {
  year: number | null;
  by: WatchStatsBy | null;
  lists: string[] | null;
  plays: number;
  films: number;
  rewatches: number;
  /** Watched films with no dated play (status watched with no play, or only dateless plays). Null with `year`. */
  undatedFilms: number | null;
  /** Calendar years watched, newest first. */
  byYear: YearRow[];
  /** Watched films by release decade, oldest first. */
  byDecade: { decade: string; films: number }[];
  byGenre: NamedRow[];
  byDirector: NamedRow[];
  /** Watched films by your rating, 1 to 10 (always ten rows). */
  ratings: { rating: number; films: number }[];
  rated: number;
  averageRating: number | null;
  /** Your average against IMDb's, over watched films you rated that have an IMDb rating. */
  vsImdb: { films: number; myAverage: number; imdbAverage: number; difference: number } | null;
}

export interface WatchSummary {
  year: number;
  playsThisYear: number;
  playsLastYear: number;
  filmsThisYear: number;
  rewatchesThisYear: number;
  /** Films with your rating, watched or not. */
  rated: number;
  averageRating: number | null;
}

interface Film {
  key: string;
  rows: ItemRow[];
  year: number | null;
  genres: string[];
  directors: string[];
  rating: number | null;
  imdbRating: number | null;
  statusWatched: boolean;
}

interface Night {
  key: string;
  year: number | null;
  rewatch: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const average = (ns: number[]) => (ns.length ? round2(ns.reduce((a, b) => a + b, 0) / ns.length) : null);

const filmKeyOf = (r: ItemRow) => r.linked_tconst ?? `#${r.id}`;

/** Every film, and every play (night) after the cross-source collapse. */
function loadFilms(db: Db): { films: Map<string, Film>; nights: Night[] } {
  const films = new Map<string, Film>();
  const keyById = new Map<number, string>();
  for (const r of itemRows(db)) {
    const key = filmKeyOf(r);
    keyById.set(r.id, key);
    const f = films.get(key);
    if (f) {
      f.rows.push(r);
      f.statusWatched ||= r.status === 'watched';
    } else {
      films.set(key, {
        key,
        rows: [r],
        year: r.year,
        genres: genresOf(r),
        directors: directorsOf(r),
        rating: null,
        imdbRating: r.imdb_rating,
        statusWatched: r.status === 'watched',
      });
    }
  }
  for (const f of films.values()) {
    const rated = f.rows.filter((r) => r.my_rating !== null).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
    f.rating = rated[0]?.my_rating ?? null;
  }

  const viewings: Viewing[] = [...viewingsByItem(db).values()].flat();
  const keyOf = (v: Viewing) => keyById.get(v.itemId) as string;
  const derived = deriveRewatch(viewings, keyOf);
  const nights = groupSameNight(viewings, keyOf).map((g): Night => {
    // A source's own flag wins (any of them saying rewatch); else the derived one.
    const explicit = g.viewings.filter((v) => v.rewatch !== null);
    const rewatch = explicit.length ? explicit.some((v) => v.rewatch === true) : g.viewings.some((v) => derived.get(v.id) === true);
    return { key: g.key, year: g.date === null ? null : Number(calendarDate(g.date).slice(0, 4)), rewatch };
  });
  return { films, nights };
}

/** Film keys with an edition in the lists, item by item as search's list filter. */
function filmsInLists(db: Db, names: string[], mode: 'any' | 'all'): Set<string> {
  for (const n of names) requireList(db, n);
  const norms = [...new Set(names.map(normListName))];
  const rows = db.sql
    .prepare(
      `SELECT li.item_id AS item_id, COUNT(DISTINCT l.id) AS n FROM list_items li JOIN lists l ON l.id = li.list_id
       WHERE l.norm_name IN (SELECT value FROM json_each(?)) GROUP BY li.item_id`,
    )
    .all(JSON.stringify(norms)) as { item_id: number; n: number }[];
  const ids = new Set(rows.filter((r) => mode === 'any' || Number(r.n) === norms.length).map((r) => r.item_id));
  const out = new Set<string>();
  for (const r of itemRows(db)) if (ids.has(r.id)) out.add(filmKeyOf(r));
  return out;
}

function validate(opts: WatchStatsOptions): void {
  if (opts.year !== undefined && (!Number.isInteger(opts.year) || opts.year < MIN_YEAR || opts.year > MAX_YEAR)) {
    throw new LibraryError(`year must be a calendar year from ${MIN_YEAR} to ${MAX_YEAR}`);
  }
  if (opts.by !== undefined && !(WATCH_STATS_BY as readonly string[]).includes(opts.by)) {
    throw new LibraryError(`by must be one of ${WATCH_STATS_BY.join(', ')}`);
  }
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > WATCH_STATS_MAX_LIMIT)) {
    throw new LibraryError(`limit must be a whole number from 1 to ${WATCH_STATS_MAX_LIMIT}`);
  }
  if (opts.listMode !== undefined && !(LIST_MODES as readonly string[]).includes(opts.listMode)) {
    throw new LibraryError(`listMode must be one of ${LIST_MODES.join(', ')}`);
  }
}

function named(films: Film[], namesOf: (f: Film) => string[]): NamedRow[] {
  const groups = new Map<string, Film[]>();
  for (const f of films) for (const n of namesOf(f)) groups.set(n, [...(groups.get(n) ?? []), f]);
  return [...groups.entries()]
    .map(([name, fs]): NamedRow => {
      const ratings = fs.map((f) => f.rating).filter((r): r is number => r !== null);
      return { name, films: fs.length, rated: ratings.length, averageRating: average(ratings) };
    })
    .sort((a, b) => b.films - a.films || a.name.localeCompare(b.name));
}

/** Watch stats: what you watched, when, and how you rated it. */
export function watchStats(db: Db, opts: WatchStatsOptions = {}): WatchStats {
  validate(opts);
  const { films: all, nights: allNights } = loadFilms(db);
  const lists = opts.lists?.length ? opts.lists : null;
  const inLists = lists ? filmsInLists(db, lists, opts.listMode ?? 'any') : null;
  const keep = (key: string) => inLists === null || inLists.has(key);

  const year = opts.year ?? null;
  const nights = allNights.filter((n) => keep(n.key) && (year === null || n.year === year));
  const played = new Set(nights.map((n) => n.key));
  const datedKeys = new Set(allNights.filter((n) => n.year !== null).map((n) => n.key));
  const films = [...all.values()].filter((f) => keep(f.key) && (year === null ? f.statusWatched || played.has(f.key) : played.has(f.key)));

  const years = new Map<number, { plays: number; films: Set<string>; rewatches: number }>();
  for (const n of nights) {
    if (n.year === null) continue;
    const y = years.get(n.year) ?? { plays: 0, films: new Set<string>(), rewatches: 0 };
    y.plays++;
    y.films.add(n.key);
    if (n.rewatch) y.rewatches++;
    years.set(n.year, y);
  }

  const decades = new Map<string, number>();
  for (const f of films) if (f.year !== null) bump(decades, decadeOf(f.year));

  const ratings = Array.from({ length: 10 }, (_, i) => ({ rating: i + 1, films: 0 }));
  const rated = films.filter((f) => f.rating !== null);
  for (const f of rated) (ratings[(f.rating as number) - 1] as { films: number }).films++;

  const vs = rated.filter((f) => f.imdbRating !== null);
  const mine = vs.map((f) => f.rating as number);
  const imdb = vs.map((f) => f.imdbRating as number);
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

  const by = opts.by ?? null;
  const cap = <T>(rows: T[], block: WatchStatsBy, summaryCap: number | null): T[] => {
    const n = by === block ? (opts.limit ?? null) : summaryCap;
    return n === null ? rows : rows.slice(0, n);
  };
  const topN = opts.limit ?? WATCH_STATS_TOP;

  const byYear = [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([y, v]): YearRow => ({ year: y, plays: v.plays, films: v.films.size, rewatches: v.rewatches }));

  return {
    year,
    by,
    lists,
    plays: nights.length,
    films: films.length,
    rewatches: nights.filter((n) => n.rewatch).length,
    undatedFilms: year === null ? films.filter((f) => !datedKeys.has(f.key)).length : null,
    byYear: cap(byYear, 'year', null),
    byDecade: cap(
      [...decades.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([decade, n]) => ({ decade, films: n })),
      'decade',
      null,
    ),
    byGenre: cap(named(films, (f) => f.genres), 'genre', topN),
    byDirector: cap(named(films, (f) => f.directors), 'director', topN),
    ratings,
    rated: rated.length,
    averageRating: average(rated.map((f) => f.rating as number)),
    vsImdb: vs.length
      ? { films: vs.length, myAverage: round2(sum(mine) / vs.length), imdbAverage: round2(sum(imdb) / vs.length), difference: round2((sum(mine) - sum(imdb)) / vs.length) }
      : null,
  };
}

/** The short "watching" block of `stats`: this year and last year, and your ratings. */
export function watchSummary(db: Db, opts: { now?: Date } = {}): WatchSummary {
  const year = (opts.now ?? new Date()).getFullYear();
  const { films, nights } = loadFilms(db);
  const thisYear = nights.filter((n) => n.year === year);
  const ratings = [...films.values()].map((f) => f.rating).filter((r): r is number => r !== null);
  return {
    year,
    playsThisYear: thisYear.length,
    playsLastYear: nights.filter((n) => n.year === year - 1).length,
    filmsThisYear: new Set(thisYear.map((n) => n.key)).size,
    rewatchesThisYear: thisYear.filter((n) => n.rewatch).length,
    rated: ratings.length,
    averageRating: average(ratings),
  };
}

/**
 * The single filter-to-SQL compiler behind every search (CLI, MCP, any future
 * UI). Every user value is a bound parameter; sort columns and directions come
 * from fixed maps.
 *
 * Library scope reads library_items LEFT JOIN titles, with each field taken
 * from the catalog when the item is linked and from its source fields
 * otherwise, so an unmatched movie you own is never hidden. Editions of one
 * tconst collapse into one result. Scope `all` reads titles LEFT JOIN the
 * library and needs a built catalog.
 */
import { catalogReady, type Db } from './db.js';
import { FilterSchema, type Filter } from './filters.js';
import { LibraryError } from './library.js';
import { getList, normListName } from './lists.js';
import { splitPeople } from './match.js';
import { UNWATCHED_STATUSES, type MatchStatus, type Status, type WatchedEra } from './types.js';

export class CatalogMissingError extends LibraryError {
  constructor() {
    super('Catalog not built. Run `screentrackr setup`.');
    this.name = 'CatalogMissingError';
  }
}

/** Invalid search input. The message names each offending field. */
export class FilterError extends LibraryError {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'FilterError';
  }
}

export interface MovieResult {
  tconst: string | null;
  title: string;
  year: number | null;
  runtimeMin: number | null;
  genres: string[];
  directors: string[];
  cast: string[];
  rating: number | null;
  votes: number | null;
  library: null | {
    id: number;
    status: Status;
    watchedEra: WatchedEra | null;
    myRating: number | null;
    owned: boolean;
    matchStatus: MatchStatus;
    editions: number;
  };
}

type Param = string | number | null;

export interface CompiledSearch {
  sql: string;
  /** Parameters for `sql`; the last two are limit and offset. */
  params: Param[];
  countSql: string;
  /** Parameters for `countSql` (the same as `params` without limit and offset). */
  countParams: Param[];
}

/** An item counts as linked to the catalog only when matched or linked by hand. */
const LINKED = "li.tconst IS NOT NULL AND li.match_status IN ('matched', 'manual')";

const SORT_COLUMNS: Record<Exclude<Filter['sort'], 'random'>, string> = {
  rating: 'rating',
  votes: 'votes',
  year: 'year',
  runtime: 'runtime_min',
  title: 'title',
  my_rating: 'my_rating',
};

const CAST_LIMIT = 3;

function likeParam(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Quote each word as an FTS5 prefix term, so user text can never be FTS syntax. */
function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  return words && words.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

function orLike(col: string, values: string[], params: Param[]): string {
  for (const v of values) params.push(likeParam(v));
  return `(${values.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`;
}

function peopleIn(role: 'director' | 'actor', names: string[], params: Param[]): string {
  const cond = orLike('p.name', names, params);
  return `cat_tconst IN (SELECT tp.tconst FROM title_people tp JOIN people p ON p.nconst = tp.nconst WHERE tp.role = '${role}' AND ${cond})`;
}

function genresIn(genres: string[], params: Param[]): string {
  for (const g of genres) params.push(g.toLowerCase());
  return `cat_tconst IN (SELECT tconst FROM title_genres WHERE lower(genre) IN (${genres.map(() => '?').join(', ')}))`;
}

/**
 * Conditions on the movie itself, over the columns cat_tconst, title,
 * original_title, year, runtime_min, rating, votes and (library scope)
 * source_title, source_director, source_genre and cat_genres_csv.
 */
function movieConditions(f: Filter, library: boolean, fts: boolean, params: Param[]): string[] {
  const where: string[] = [];

  if (f.directors) {
    const catalog = peopleIn('director', f.directors, params);
    if (library) {
      const fallback = orLike('source_director', f.directors, params);
      where.push(
        `(${catalog} OR (NOT EXISTS (SELECT 1 FROM title_people d WHERE d.tconst = cat_tconst AND d.role = 'director') AND ${fallback}))`,
      );
    } else where.push(catalog);
  }

  if (f.actors) where.push(peopleIn('actor', f.actors, params));

  if (f.genres) {
    const groups = f.genreMode === 'all' ? f.genres.map((g) => [g]) : [f.genres];
    for (const group of groups) {
      const catalog = genresIn(group, params);
      if (library) {
        const fallback = orLike('source_genre', group, params);
        // IMDb lists at most three genres per title, so for owned movies the
        // store's own genre (e.g. Apple TV's) counts too.
        where.push(`(${catalog} OR ${fallback})`);
      } else where.push(catalog);
    }
  }

  if (f.minRating !== undefined) {
    where.push('rating >= ?');
    params.push(f.minRating);
  }
  if (f.minVotes > 0) {
    where.push('votes >= ?');
    params.push(f.minVotes);
  }
  if (f.minRuntime !== undefined) {
    where.push('runtime_min >= ?');
    params.push(f.minRuntime);
  }
  if (f.maxRuntime !== undefined) {
    where.push('runtime_min <= ?');
    params.push(f.maxRuntime);
  }
  if (f.yearFrom !== undefined) {
    where.push('year >= ?');
    params.push(f.yearFrom);
  }
  if (f.yearTo !== undefined) {
    where.push('year <= ?');
    params.push(f.yearTo);
  }
  if (f.maxVotes !== undefined) {
    where.push('votes <= ?');
    params.push(f.maxVotes);
  }
  if (f.decades) {
    const starts = [...new Set(f.decades.map((d) => Number(d.slice(0, 4))))];
    where.push(`(${starts.map(() => '(year BETWEEN ? AND ?)').join(' OR ')})`);
    for (const y of starts) params.push(y, y + 9);
  }

  if (f.text) {
    const q = !library && fts ? ftsQuery(f.text) : null;
    if (q) {
      where.push('cat_tconst IN (SELECT tconst FROM titles_fts WHERE titles_fts MATCH ?)');
      params.push(q);
    } else {
      const cols = library ? ['title', 'original_title', 'source_title'] : ['title', 'original_title'];
      const p = likeParam(f.text);
      where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
      for (let i = 0; i < cols.length; i++) params.push(p);
    }
  }
  return where;
}

/** A list membership condition on the item id column `idCol`. */
function inLists(idCol: string, names: string[], params: Param[]): string {
  params.push(JSON.stringify(names.map(normListName)));
  return `${idCol} IN (SELECT li.item_id FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.norm_name IN (SELECT value FROM json_each(?)))`;
}

/** A library item that counts as seen: status watched, or any recorded play. Over the library_items alias `x`. */
const SEEN = "(x.status = 'watched' OR EXISTS (SELECT 1 FROM viewings v WHERE v.item_id = x.id))";

/**
 * Conditions on the library item (status, personal rating, owned, lists,
 * never seen), over `prefix` columns; `idCol` is the item's id column.
 */
function itemConditions(f: Filter, prefix: string, idCol: string, params: Param[]): string[] {
  const where: string[] = [];
  const statuses = f.unwatched ? [...UNWATCHED_STATUSES] : f.status;
  if (statuses) {
    where.push(`${prefix}status IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (f.myRatingMin !== undefined) {
    where.push(`${prefix}my_rating >= ?`);
    params.push(f.myRatingMin);
  }
  if (f.owned !== undefined) {
    where.push(`${prefix}owned = ?`);
    params.push(f.owned ? 1 : 0);
  }
  if (f.lists) {
    const groups = f.listMode === 'all' ? f.lists.map((l) => [l]) : [f.lists];
    for (const g of groups) where.push(inLists(idCol, g, params));
  }
  return where;
}

function orderBy(f: Filter): string {
  if (f.sort === 'random') return 'random()';
  const col = SORT_COLUMNS[f.sort];
  const dir = (f.order ?? (f.sort === 'title' ? 'asc' : 'desc')) === 'asc' ? 'ASC' : 'DESC';
  const keyed = f.sort === 'title' ? `${col} COLLATE NOCASE ${dir}` : `${col} ${dir}`;
  const parts = [`${col} IS NULL`, keyed];
  if (f.sort === 'rating') parts.push('votes DESC');
  if (f.sort !== 'title') parts.push('title COLLATE NOCASE ASC');
  parts.push('tconst ASC', 'item_id ASC');
  return parts.join(', ');
}

const where = (conds: string[]) => (conds.length ? `WHERE ${conds.join(' AND ')}` : '');

const RESULT_COLS =
  'tconst, title, year, runtime_min, genres_csv, source_director, rating, votes, item_id, status, watched_era, my_rating, owned, match_status';

/**
 * Compile a parsed filter to SQL. Throws CatalogMissingError for scope `all`
 * when no catalog has been built.
 */
export function compileSearch(f: Filter, ctx: { fts: boolean; catalog: boolean }): CompiledSearch {
  const params: Param[] = [];
  let withSql: string;

  if (f.scope === 'library') {
    const itemConds = itemConditions(f, '', 'items.item_id', params);
    // neverSeen is about this item; excludeWatched about the film, any edition.
    // Qualified with `items.`: inside the subqueries a bare tconst would be x's.
    if (f.neverSeen) itemConds.push(`NOT EXISTS (SELECT 1 FROM library_items x WHERE x.id = items.item_id AND ${SEEN})`);
    if (f.excludeWatched) {
      itemConds.push(
        `NOT EXISTS (SELECT 1 FROM library_items x WHERE (x.id = items.item_id OR (items.tconst IS NOT NULL AND x.tconst = items.tconst AND x.match_status IN ('matched', 'manual'))) AND ${SEEN})`,
      );
    }
    const movieConds = movieConditions(f, true, false, params);
    withSql = `WITH items AS (
  SELECT li.id AS item_id,
         CASE WHEN ${LINKED} THEN li.tconst END AS tconst,
         t.tconst AS cat_tconst,
         COALESCE(t.title, li.source_title) AS title,
         t.original_title AS original_title,
         li.source_title AS source_title,
         COALESCE(t.year, li.source_year) AS year,
         COALESCE(t.runtime_min, li.source_runtime_min) AS runtime_min,
         t.genres_csv AS cat_genres_csv,
         COALESCE(t.genres_csv, li.source_genre) AS genres_csv,
         li.source_genre AS source_genre,
         li.source_director AS source_director,
         r.rating AS rating, r.votes AS votes,
         li.status AS status, li.watched_era AS watched_era, li.my_rating AS my_rating,
         li.owned AS owned, li.match_status AS match_status
  FROM library_items li
  LEFT JOIN titles t ON t.tconst = li.tconst AND ${LINKED}
  LEFT JOIN ratings r ON r.tconst = t.tconst
), hits AS (
  SELECT items.*, ROW_NUMBER() OVER (PARTITION BY COALESCE(tconst, '#' || item_id) ORDER BY item_id) AS rn
  FROM items
  ${where([...itemConds, ...movieConds])}
), page AS (SELECT * FROM hits WHERE rn = 1)`;
  } else {
    if (!ctx.catalog) throw new CatalogMissingError();
    // With notInLibrary every result is a movie you do not have, which is unwatched by
    // definition, so unwatched must not turn into a "library items only" condition.
    const itemConds = itemConditions(f.notInLibrary ? { ...f, unwatched: undefined } : f, 'li.', 'li.id', params);
    const movieConds = movieConditions(f, false, ctx.fts, params);
    if (itemConds.length) movieConds.push('item_id IS NOT NULL');
    // In the whole catalog a movie you do not have is unseen; one you have is
    // seen when any linked edition is (neverSeen and excludeWatched agree here).
    if (f.neverSeen || f.excludeWatched) {
      movieConds.push(`NOT EXISTS (SELECT 1 FROM library_items x WHERE x.tconst = cat_tconst AND x.match_status IN ('matched', 'manual') AND ${SEEN})`);
    }
    if (f.notInLibrary) {
      movieConds.push(
        "NOT EXISTS (SELECT 1 FROM library_items x WHERE x.tconst = cat_tconst AND x.match_status IN ('matched', 'manual'))",
      );
    }
    withSql = `WITH lib AS (
  SELECT li.id AS item_id, li.tconst AS tconst, li.status AS status, li.watched_era AS watched_era,
         li.my_rating AS my_rating, li.owned AS owned, li.match_status AS match_status,
         ROW_NUMBER() OVER (PARTITION BY li.tconst ORDER BY li.id) AS rn
  FROM library_items li
  ${where([LINKED, ...itemConds])}
), joined AS (
  SELECT t.tconst AS tconst, t.tconst AS cat_tconst, t.title AS title, t.original_title AS original_title,
         t.year AS year, t.runtime_min AS runtime_min, t.genres_csv AS genres_csv, NULL AS source_director,
         r.rating AS rating, r.votes AS votes,
         lib.item_id AS item_id, lib.status AS status, lib.watched_era AS watched_era,
         lib.my_rating AS my_rating, lib.owned AS owned, lib.match_status AS match_status
  FROM titles t
  LEFT JOIN ratings r ON r.tconst = t.tconst
  LEFT JOIN lib ON lib.tconst = t.tconst AND lib.rn = 1
), page AS (SELECT * FROM joined ${where(movieConds)})`;
  }

  const countParams = [...params];
  return {
    sql: `${withSql}\nSELECT ${RESULT_COLS} FROM page ORDER BY ${orderBy(f)} LIMIT ? OFFSET ?`,
    params: [...params, f.limit, f.offset],
    countSql: `${withSql}\nSELECT COUNT(*) AS n FROM page`,
    countParams,
  };
}

/** Validate unknown input as a Filter, throwing FilterError with readable messages. */
export function parseFilter(input: unknown): Filter {
  const parsed = FilterSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'filter', message: i.message }));
  throw new FilterError(`Invalid search: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, issues);
}

interface PageRow {
  tconst: string | null;
  title: string;
  year: number | null;
  runtime_min: number | null;
  genres_csv: string | null;
  source_director: string | null;
  rating: number | null;
  votes: number | null;
  item_id: number | null;
  status: string | null;
  watched_era: string | null;
  my_rating: number | null;
  owned: number | null;
  match_status: string | null;
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Run a search. `input` is parsed with FilterSchema. */
/** Throws LibraryError for a list name the filter uses that no list has. */
export function assertFilterLists(db: Db, f: Pick<Filter, 'lists'>): void {
  for (const name of f.lists ?? []) if (!getList(db, name)) throw new LibraryError(`No list named "${name}"`);
}

export function searchMovies(db: Db, input: unknown): { total: number; results: MovieResult[] } {
  const f = parseFilter(input);
  assertFilterLists(db, f);
  const q = compileSearch(f, { fts: db.fts, catalog: f.scope === 'all' ? catalogReady(db) : true });
  const total = Number((db.sql.prepare(q.countSql).get(...q.countParams) as { n: number }).n);
  const rows = db.sql.prepare(q.sql).all(...q.params) as unknown as PageRow[];

  const linked = [...new Set(rows.map((r) => r.tconst).filter((t): t is string => t !== null))];
  const directors = new Map<string, string[]>();
  const cast = new Map<string, string[]>();
  const editions = new Map<string, number>();
  if (linked.length) {
    const people = db.sql
      .prepare(
        `SELECT tp.tconst AS tconst, tp.role AS role, p.name AS name FROM title_people tp JOIN people p ON p.nconst = tp.nconst
         WHERE tp.tconst IN (${placeholders(linked.length)}) ORDER BY tp.tconst, tp.role, tp.ord`,
      )
      .all(...linked) as { tconst: string; role: string; name: string }[];
    for (const p of people) {
      const map = p.role === 'director' ? directors : cast;
      const list = map.get(p.tconst) ?? [];
      if (p.role === 'director' || list.length < CAST_LIMIT) list.push(p.name);
      map.set(p.tconst, list);
    }
    const counts = db.sql
      .prepare(
        `SELECT tconst, COUNT(*) AS n FROM library_items
         WHERE tconst IN (${placeholders(linked.length)}) AND match_status IN ('matched', 'manual') GROUP BY tconst`,
      )
      .all(...linked) as { tconst: string; n: number }[];
    for (const c of counts) editions.set(c.tconst, Number(c.n));
  }

  const results = rows.map((r): MovieResult => {
    const catDirectors = r.tconst ? directors.get(r.tconst) : undefined;
    return {
      tconst: r.tconst,
      title: r.title,
      year: r.year,
      runtimeMin: r.runtime_min,
      genres: (r.genres_csv ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean),
      directors: catDirectors?.length ? catDirectors : splitPeople(r.source_director),
      cast: (r.tconst ? cast.get(r.tconst) : undefined) ?? [],
      rating: r.rating,
      votes: r.votes,
      library:
        r.item_id === null
          ? null
          : {
              id: r.item_id,
              status: r.status as Status,
              watchedEra: r.watched_era as WatchedEra | null,
              myRating: r.my_rating,
              owned: r.owned === 1,
              matchStatus: r.match_status as MatchStatus,
              editions: r.tconst ? (editions.get(r.tconst) ?? 1) : 1,
            },
    };
  });
  return { total, results };
}

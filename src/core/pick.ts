/**
 * `pick`: what to watch tonight. A random draw within the shared search
 * filter (core/filters.ts), compiled by the same `compileSearch` every search
 * uses, so a pick never sees a movie the same search would not.
 *
 * Defaults: library scope, and unwatched (queue, priority or someday). In
 * scope `all` the unwatched default means "not watched" (excludeWatched: no
 * edition watched or played), because a status filter there would keep only
 * library movies. `anyStatus` drops the default; an explicit `status` or
 * `unwatched` replaces it.
 *
 * The draw: count the matches, choose `count` distinct offsets (seeded
 * mulberry32 with `seed`, else crypto.randomInt), and fetch the rows at those
 * offsets under a fixed order (tconst, then item id). Only the chosen rows
 * are read, so a 300,000-title catalog costs the same memory as a small
 * library. One row per film (editions collapse, as in search). The same seed
 * over an unchanged library gives the same picks; a changed library can give
 * different ones.
 */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { catalogReady, type Db } from './db.js';
import { FilterShape, type FilterInput } from './filters.js';
import { stripTitleSuffixes } from './normalize.js';
import { assertFilterLists, compileSearch, FilterError, parseFilter, RESULT_COLS, toMovieResults, type MovieResult, type PageRow } from './search.js';
import { STATUSES, UNWATCHED_STATUSES, type Status } from './types.js';
import { DEFAULT_COUNTRY, whereFor } from './where.js';

export const PICK_MAX_COUNT = 10;
export const MAX_SEED = 2 ** 32 - 1;

// The search fields that make no sense for a random pick (it has its own order and count).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { sort, order, limit, offset, ...pickFilterShape } = FilterShape;

/** The input shape of a pick: every search filter, plus count, seed, priorityFirst and anyStatus. */
export const PickShape = {
  ...pickFilterShape,
  count: z.number().int().min(1).max(PICK_MAX_COUNT).default(1).describe(`How many distinct movies to pick, 1 to ${PICK_MAX_COUNT} (default 1).`),
  seed: z.number().int().min(0).max(MAX_SEED).optional().describe('A seed for a repeatable pick: the same seed over an unchanged library gives the same movies.'),
  priorityFirst: z.boolean().optional().describe('Draw from your priority movies when any match, else from every match.'),
  anyStatus: z
    .boolean()
    .optional()
    .describe('Drop the default of unwatched movies only (queue, priority or someday; in scope all, movies you have not watched).'),
};

export const PickSchema = z.strictObject(PickShape);
export type PickInput = z.input<typeof PickSchema>;

export type Pick = MovieResult & { whereToWatch: string };

export interface PickResult {
  /** How many movies the picks were drawn from. */
  total: number;
  picks: Pick[];
  /** With priorityFirst: whether the draw was from priority movies only. */
  priorityOnly?: boolean;
  /** With priorityFirst: how many movies match the filter in all. */
  matched?: number;
}

/** A small seeded PRNG (mulberry32): floats in [0, 1), the same sequence for the same seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RANDOM_RANGE = 2 ** 48 - 1;
const cryptoRandom = (): number => randomInt(RANDOM_RANGE) / RANDOM_RANGE;

/**
 * `min(k, n)` distinct offsets in [0, n), in draw order: a partial
 * Fisher-Yates shuffle over a sparse map, so memory is O(k) whatever `n` is.
 */
export function chooseOffsets(n: number, k: number, rand: () => number): number[] {
  const take = Math.max(0, Math.min(k, n));
  const swapped = new Map<number, number>();
  const out: number[] = [];
  for (let i = 0; i < take; i++) {
    const j = i + Math.min(n - i - 1, Math.floor(rand() * (n - i)));
    const atJ = swapped.get(j) ?? j;
    swapped.set(j, swapped.get(i) ?? i);
    out.push(atJ);
  }
  return out;
}

function parsePick(input: unknown): z.output<typeof PickSchema> {
  const parsed = PickSchema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'pick', message: i.message }));
  throw new FilterError(`Invalid pick: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`, issues);
}

/** The statuses a filter allows (all of them when it names none). */
function allowedStatuses(f: { unwatched?: boolean | undefined; status?: Status[] | undefined }): readonly Status[] {
  if (f.unwatched) return UNWATCHED_STATUSES;
  return f.status ?? STATUSES;
}

/**
 * Pick `count` distinct movies at random within the filter. Throws
 * FilterError for invalid input, LibraryError for a list that doesn't exist,
 * and CatalogMissingError for scope `all` before setup. `country` is the
 * JustWatch country of each pick's link (default us).
 */
export function pickMovies(db: Db, input: unknown, opts: { country?: string } = {}): PickResult {
  const { count, seed, priorityFirst, anyStatus, ...rest } = parsePick(input);
  if (anyStatus && (rest.status !== undefined || rest.unwatched === true)) {
    throw new FilterError('Use anyStatus or status/unwatched, not both', [{ path: 'anyStatus', message: 'conflicts with status or unwatched' }]);
  }
  const base: FilterInput = { ...rest };
  if (!anyStatus && rest.status === undefined && rest.unwatched === undefined) {
    if (rest.scope === 'all') base.excludeWatched = true;
    else base.unwatched = true;
  }
  const filter = parseFilter({ ...base, limit: 1 });
  assertFilterLists(db, filter);
  const catalog = filter.scope === 'all' ? catalogReady(db) : true;

  const countOf = (f: typeof filter) => {
    const q = compileSearch(f, { fts: db.fts, catalog });
    return { q, n: Number((db.sql.prepare(q.countSql).get(...q.countParams) as { n: number }).n) };
  };

  let pool = countOf(filter);
  const matched = pool.n;
  let priorityOnly = false;
  if (priorityFirst && !filter.notInLibrary && allowedStatuses(filter).includes('priority')) {
    const prio = countOf(parseFilter({ ...base, unwatched: undefined, status: ['priority'], limit: 1 }));
    if (prio.n > 0) {
      pool = prio;
      priorityOnly = true;
    }
  }

  const offsets = chooseOffsets(pool.n, count, seed !== undefined ? mulberry32(seed) : cryptoRandom);
  let picks: Pick[] = [];
  if (offsets.length) {
    const sql = `${pool.q.withSql}, ordered AS (
  SELECT ${RESULT_COLS}, ROW_NUMBER() OVER (ORDER BY tconst, item_id) - 1 AS pos FROM page
)
SELECT ${RESULT_COLS}, pos FROM ordered WHERE pos IN (SELECT value FROM json_each(?))`;
    const rows = db.sql.prepare(sql).all(...pool.q.countParams, JSON.stringify(offsets)) as unknown as (PageRow & { pos: number })[];
    const byPos = new Map(rows.map((r) => [Number(r.pos), r]));
    const ordered = offsets.map((o) => byPos.get(o)).filter((r): r is PageRow & { pos: number } => r !== undefined);
    const country = opts.country ?? DEFAULT_COUNTRY;
    picks = toMovieResults(db, ordered).map((m) => ({
      ...m,
      // A linked result's title is the catalog's; an unlinked one's is its source title.
      whereToWatch: whereFor(m.tconst ? m.title : stripTitleSuffixes(m.title), country).url,
    }));
  }
  return { total: pool.n, picks, ...(priorityFirst ? { priorityOnly, matched } : {}) };
}

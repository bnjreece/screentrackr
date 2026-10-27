/**
 * Logging and listing plays: the one core behind `screentrackr log`,
 * `screentrackr history` and the MCP tools log_viewing, list_viewings and
 * remove_viewing, so the CLI and MCP always agree.
 *
 * - logViewing records a hand-logged play (source `manual`, a fresh
 *   `manual:<hex>` ref, so two logged on one day stay two), sets status
 *   `watched` unless asked not to, and with a rating also sets the item's
 *   rating, like a Letterboxd diary entry. A date more than a day ahead is
 *   refused (isFutureDate).
 * - historyPlays lists plays newest first after the cross-source collapse:
 *   one night of one film recorded by two sources (Letterboxd and Trakt) is
 *   one play with both sources and both viewing ids. A play is a rewatch when
 *   its source says so, or when the source says nothing and an earlier play of
 *   the same film (any edition, any source) exists (deriveRewatch), judged
 *   against the whole history, not only the plays a filter keeps.
 * - removePlay deletes one viewing by its id, never by title.
 */
import type { Db } from './db.js';
import { getItem, LibraryError, updateItemDetailed, type ItemPatch } from './library.js';
import type { ItemSource, LibraryItem } from './types.js';
import {
  addViewing,
  atomic,
  countPlays,
  deriveRewatch,
  filmKey,
  groupSameNight,
  isFutureDate,
  isValidWatchedAt,
  listViewings,
  manualRef,
  removeViewing,
  viewingsByItem,
  viewingsOf,
  type ListViewingsOptions,
  type Viewing,
} from './viewings.js';

/** Today's calendar date in this machine's time zone, YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export interface LogViewingOptions {
  /** The play's date (YYYY-MM-DD or an ISO date-time). Default: today, local time. */
  date?: string;
  /** The play's rewatch flag. Omitted or null: not said, so it is derived from earlier plays. */
  rewatch?: boolean | null;
  /** The rating given at this play, 1 to 10. Also becomes the item's rating. */
  rating?: number | null;
  /** Leave the item's status as it is (default: set it to watched). */
  keepStatus?: boolean;
  /** The clock, for tests. */
  now?: Date;
}

export interface LogViewingResult {
  viewing: Viewing;
  item: LibraryItem;
  /** The item's plays after this one (cross-source collapse). */
  plays: number;
}

/** Record one hand-logged play of a library item. Throws LibraryError on bad input or a missing item; a refusal writes nothing. */
export function logViewing(db: Db, itemId: number, opts: LogViewingOptions = {}): LogViewingResult {
  const date = opts.date === undefined ? localToday(opts.now) : String(opts.date).trim();
  if (!isValidWatchedAt(date)) throw new LibraryError(`Invalid date "${String(opts.date)}" (expected YYYY-MM-DD or an ISO date-time)`);
  if (isFutureDate(date, opts.now)) throw new LibraryError(`Date ${date} is in the future`);
  if (opts.rating != null && !(Number.isInteger(opts.rating) && opts.rating >= 1 && opts.rating <= 10)) {
    throw new LibraryError(`Rating must be a whole number from 1 to 10 (got ${String(opts.rating)})`);
  }
  if (opts.rewatch != null && typeof opts.rewatch !== 'boolean') throw new LibraryError('rewatch must be true, false or null');
  if (!Number.isSafeInteger(itemId) || !getItem(db, itemId)) throw new LibraryError(`Item ${String(itemId)} not found`);
  return atomic(db, () => {
    // The status first, so the play's date can set the era of a newly watched item.
    const patch: ItemPatch = {};
    if (!opts.keepStatus) patch.status = 'watched';
    if (opts.rating != null) patch.myRating = opts.rating;
    if (Object.keys(patch).length) updateItemDetailed(db, itemId, patch);
    const viewing = addViewing(db, itemId, {
      watchedAt: date,
      source: 'manual',
      sourceRef: manualRef(),
      rewatch: opts.rewatch ?? null,
      rating: opts.rating ?? null,
    });
    return { viewing, item: getItem(db, itemId) as LibraryItem, plays: countPlays(viewingsOf(db, itemId)) };
  });
}

/** How many plays `history` prints and list_viewings returns when not told. */
export const HISTORY_DEFAULT_LIMIT = 50;

/** What historyPlays lists: listViewings' filters (one item, a year, a date range, a source) and how many plays. */
export interface HistoryQuery {
  itemId?: number;
  year?: number;
  /** Inclusive calendar dates, YYYY-MM-DD. */
  from?: string;
  to?: string;
  source?: ItemSource;
  /** The most plays to return (newest first). Default: all. */
  limit?: number;
}

/** One play as `history` shows it: one night of one film, every source that recorded it. */
export interface HistoryPlay {
  /** The calendar date, or null for a play with no known date. */
  date: string | null;
  /** The source's own flag, else derived from earlier plays of the film. */
  rewatch: boolean;
  /** Distinct sources, sorted. */
  sources: ItemSource[];
  /** The item the newest of its viewings belongs to. */
  itemId: number;
  title: string;
  year: number | null;
  tconst: string | null;
  /** The rating given at this play, when a viewing has one. */
  rating: number | null;
  /** The viewings this play is made of (each one removable by id). */
  viewings: Viewing[];
}

export interface HistoryResult {
  /** Plays matching the filters, before the limit. */
  total: number;
  plays: HistoryPlay[];
}

interface ItemKeyRow {
  id: number;
  tconst: string | null;
  match_status: string;
  source_title: string;
  source_year: number | null;
}

/** Plays newest first (dateless last), after the cross-source collapse. See the module comment. */
export function historyPlays(db: Db, q: HistoryQuery = {}): HistoryResult {
  if (q.limit !== undefined && !(Number.isInteger(q.limit) && q.limit >= 1)) throw new LibraryError(`Invalid limit ${String(q.limit)} (expected a whole number from 1)`);
  if (q.itemId !== undefined && (!Number.isSafeInteger(q.itemId) || !getItem(db, q.itemId))) throw new LibraryError(`Item ${String(q.itemId)} not found`);
  const filter: ListViewingsOptions = {};
  if (q.itemId !== undefined) filter.itemId = q.itemId;
  if (q.year !== undefined) filter.year = q.year;
  if (q.from !== undefined) filter.from = q.from;
  if (q.to !== undefined) filter.to = q.to;
  if (q.source !== undefined) filter.source = q.source;
  const rows = listViewings(db, filter);
  if (!rows.length) return { total: 0, plays: [] };

  const items = new Map<number, ItemKeyRow>();
  for (const r of db.sql.prepare('SELECT id, tconst, match_status, source_title, source_year FROM library_items').all() as unknown as ItemKeyRow[]) items.set(r.id, r);
  const keyOfItem = (id: number) => {
    const it = items.get(id);
    return it ? filmKey({ id, tconst: it.tconst, matchStatus: it.match_status }) : `#${id}`;
  };
  const keyOf = (v: Viewing) => keyOfItem(v.itemId);
  // Rewatches are judged against every play of the film, not only those the filters keep.
  const films = new Set(rows.map(keyOf));
  const ids = [...items.keys()].filter((id) => films.has(keyOfItem(id)));
  const all = [...viewingsByItem(db, ids).values()].flat();
  const rewatch = deriveRewatch(all, keyOf);

  const newest = (vs: Viewing[]) => vs.reduce((a, b) => (b.addedAt > a.addedAt || (b.addedAt === a.addedAt && b.id > a.id) ? b : a));
  const groups = groupSameNight(rows, keyOf).map((g) => ({ g, top: newest(g.viewings) }));
  groups.sort((a, b) => {
    if ((a.g.date === null) !== (b.g.date === null)) return a.g.date === null ? 1 : -1;
    if (a.g.date !== b.g.date) return (b.g.date as string).localeCompare(a.g.date as string);
    return b.top.addedAt.localeCompare(a.top.addedAt) || b.top.id - a.top.id;
  });
  const plays = groups.map(({ g, top }): HistoryPlay => {
    const it = items.get(top.itemId);
    const viewings = [...g.viewings].sort((a, b) => b.id - a.id);
    return {
      date: g.date,
      rewatch: g.viewings.some((v) => rewatch.get(v.id) === true),
      sources: g.sources,
      itemId: top.itemId,
      title: it?.source_title ?? '',
      year: it?.source_year ?? null,
      tconst: it && (it.match_status === 'matched' || it.match_status === 'manual') ? it.tconst : null,
      rating: viewings.find((v) => v.rating !== null)?.rating ?? null,
      viewings,
    };
  });
  return { total: plays.length, plays: q.limit === undefined ? plays : plays.slice(0, q.limit) };
}

export interface RemovePlayResult {
  removed: Viewing;
  /** The item after the removal (its watched date is the latest play left). */
  item: LibraryItem;
}

/** Delete one viewing by its id (never by title). Throws LibraryError when there is none. */
export function removePlay(db: Db, viewingId: number): RemovePlayResult {
  if (!Number.isSafeInteger(viewingId) || viewingId < 1) throw new LibraryError(`Invalid viewing id ${String(viewingId)}`);
  return atomic(db, () => {
    const removed = removeViewing(db, viewingId);
    return { removed, item: getItem(db, removed.itemId) as LibraryItem };
  });
}

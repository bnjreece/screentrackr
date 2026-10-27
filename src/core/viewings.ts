/**
 * Watch history: one row per play in `viewings` (schema V4), and the watched
 * date cache on library_items that it keeps.
 *
 * `library_items.watched_at` and `watched_at_source` are a cache of the latest
 * dated viewing: by calendar date (the first ten characters of the stored
 * string, so no time zone conversion ever happens on read), ties broken by the
 * most recently added viewing. A `manual` viewing caches as a NULL source, as
 * a date the user set always did in 0.3.0. refreshWatched is the only writer
 * of those two columns, and every viewing write here calls it in the same
 * transaction.
 *
 * The watched era moves with the date only when it was null or the era of the
 * old date (eraOf), and only on a watched item: an era the user set that
 * disagrees with the date is kept.
 *
 * Read paths that count plays collapse dated viewings by (film, calendar date)
 * across sources, so one night recorded by Letterboxd and Trakt is one play,
 * and count dateless viewings as the largest per-source dateless count.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { LibraryError } from './errors.js';
import { ITEM_SOURCES, type ItemSource, type WatchedEra } from './types.js';

/** A date (`YYYY-MM-DD`) or an ISO-style date-time, with an optional offset. */
export const WATCHED_AT_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** One play. `watchedAt` null is a real play with no real date. */
export interface Viewing {
  id: number;
  itemId: number;
  watchedAt: string | null;
  /** The source's own rewatch flag; null when it didn't say (see deriveRewatch). */
  rewatch: boolean | null;
  /** The rating given at this play (a diary entry's), 1 to 10. */
  rating: number | null;
  source: ItemSource;
  /** The source's own id for this play, always a string (Trakt's are int64). */
  sourceRef: string | null;
  addedAt: string;
}

/** A play to record. */
export interface NewViewing {
  watchedAt: string | null;
  source: ItemSource;
  rewatch?: boolean | null;
  rating?: number | null;
  sourceRef?: string | null;
}

/** The fields an import or a sync may change on a stored viewing. */
export interface ViewingUpdate {
  id: number;
  watchedAt?: string | null;
  sourceRef?: string;
  rewatch?: boolean | null;
  rating?: number | null;
}

/** What planViewingSync decides for one item. */
export interface ViewingPlan {
  inserts: NewViewing[];
  updates: ViewingUpdate[];
  deletes: number[];
}

/** The watched era a watched date falls in. */
export function eraOf(date: string): WatchedEra {
  const y = Number(date.slice(0, 4));
  return y < 2010 ? 'long-ago' : y < 2020 ? '2010s' : '2020s';
}

/** A stored date's calendar date: its first ten characters. */
export function calendarDate(watchedAt: string): string {
  return watchedAt.slice(0, 10);
}

/**
 * A watched date as imports accept it (the 0.3.0 rule): WATCHED_AT_RE and a
 * time Date can read. Date reads some days no calendar has (2023-02-29), and
 * 0.3.0 stored them, so a library migrated from it, and its backups, must
 * still import. New dates the user types are checked with isValidWatchedAt.
 */
export function isReadableWatchedAt(v: string): boolean {
  return WATCHED_AT_RE.test(v) && !Number.isNaN(Date.parse(v));
}

/** A well-formed watched date: WATCHED_AT_RE, a real calendar day, and a time Date can read. For dates the user enters. */
export function isValidWatchedAt(v: string): boolean {
  if (!WATCHED_AT_RE.test(v) || Number.isNaN(Date.parse(v))) return false;
  const [y, m, d] = calendarDate(v).split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/**
 * Whether a date is in the future by more than a day (time zones put "today"
 * up to a day ahead of UTC). Compared by calendar date. `log` and `set` refuse
 * such a date; importers warn and drop it.
 */
export function isFutureDate(watchedAt: string, now: Date = new Date()): boolean {
  const limit = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
  return calendarDate(watchedAt) > limit;
}

/** A fresh ref for a hand-logged play, so two logged on one day stay two. */
export function manualRef(): string {
  return `manual:${randomBytes(8).toString('hex')}`;
}

/** Run fn atomically, inside the caller's transaction when there is one (a savepoint nests). */
export function atomic<T>(db: Db, fn: () => T): T {
  const name = `st_${randomBytes(4).toString('hex')}`;
  db.sql.exec(`SAVEPOINT ${name}`);
  try {
    const out = fn();
    db.sql.exec(`RELEASE ${name}`);
    return out;
  } catch (err) {
    try {
      db.sql.exec(`ROLLBACK TO ${name}`);
      db.sql.exec(`RELEASE ${name}`);
    } catch {
      // The failure may already have ended the transaction.
    }
    throw err;
  }
}

/** Throws LibraryError naming the first bad field. `where` prefixes the message. */
export function validateViewing(v: NewViewing, where = 'Viewing'): void {
  const fail = (msg: string): never => {
    throw new LibraryError(`${where}: ${msg}`);
  };
  if (v.watchedAt !== null && (typeof v.watchedAt !== 'string' || !isValidWatchedAt(v.watchedAt))) {
    fail(`invalid watched date "${String(v.watchedAt)}" (expected YYYY-MM-DD or an ISO date-time)`);
  }
  if (!(ITEM_SOURCES as readonly string[]).includes(v.source)) fail(`invalid source "${String(v.source)}"`);
  if (v.rewatch != null && typeof v.rewatch !== 'boolean') fail('rewatch must be true, false or null');
  if (v.rating != null && !(Number.isInteger(v.rating) && v.rating >= 1 && v.rating <= 10)) {
    fail(`rating must be a whole number from 1 to 10 (got ${String(v.rating)})`);
  }
  if (v.sourceRef != null && (typeof v.sourceRef !== 'string' || !v.sourceRef.trim() || v.sourceRef.length > 1000)) fail('invalid source ref');
}

interface ViewingRow {
  id: number;
  item_id: number;
  watched_at: string | null;
  rewatch: number | null;
  rating: number | null;
  source: string;
  source_ref: string | null;
  added_at: string;
}

const COLUMNS = 'id, item_id, watched_at, rewatch, rating, source, source_ref, added_at';
/** Newest first: dated before dateless, then by calendar date, then most recently added. */
const NEWEST_FIRST = 'watched_at IS NULL, substr(watched_at, 1, 10) DESC, added_at DESC, id DESC';

function toViewing(r: ViewingRow): Viewing {
  return {
    id: r.id,
    itemId: r.item_id,
    watchedAt: r.watched_at,
    rewatch: r.rewatch === null ? null : r.rewatch === 1,
    rating: r.rating,
    source: r.source as ItemSource,
    sourceRef: r.source_ref,
    addedAt: r.added_at,
  };
}

function requireItemId(db: Db, itemId: number): void {
  if (!Number.isSafeInteger(itemId) || db.sql.prepare('SELECT 1 FROM library_items WHERE id = ?').get(itemId) === undefined) {
    throw new LibraryError(`Item ${String(itemId)} not found`);
  }
}

/** One item's viewings, newest first. */
export function viewingsOf(db: Db, itemId: number): Viewing[] {
  return (db.sql.prepare(`SELECT ${COLUMNS} FROM viewings WHERE item_id = ? ORDER BY ${NEWEST_FIRST}`).all(itemId) as unknown as ViewingRow[]).map(
    toViewing,
  );
}

/** Viewings by item id (all items, or the ones given), each newest first. */
export function viewingsByItem(db: Db, itemIds?: readonly number[]): Map<number, Viewing[]> {
  const out = new Map<number, Viewing[]>();
  if (itemIds && itemIds.length === 0) return out;
  const rows = itemIds
    ? (db.sql
        .prepare(`SELECT ${COLUMNS} FROM viewings WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, ${NEWEST_FIRST}`)
        .all(JSON.stringify(itemIds)) as unknown as ViewingRow[])
    : (db.sql.prepare(`SELECT ${COLUMNS} FROM viewings ORDER BY item_id, ${NEWEST_FIRST}`).all() as unknown as ViewingRow[]);
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push(toViewing(r));
    out.set(r.item_id, list);
  }
  return out;
}

export interface ListViewingsOptions {
  itemId?: number;
  itemIds?: readonly number[];
  /** Calendar year of the play. Dateless plays never match a year or a range. */
  year?: number;
  /** Inclusive calendar dates, YYYY-MM-DD. */
  from?: string;
  to?: string;
  source?: ItemSource;
  limit?: number;
  offset?: number;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Viewings matching every filter given, newest first (dateless last). */
export function listViewings(db: Db, opts: ListViewingsOptions = {}): Viewing[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.itemId !== undefined) {
    where.push('item_id = ?');
    params.push(opts.itemId);
  }
  if (opts.itemIds !== undefined) {
    where.push('item_id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(opts.itemIds));
  }
  if (opts.year !== undefined) {
    if (!Number.isInteger(opts.year) || opts.year < 1000 || opts.year > 9999) throw new LibraryError(`Invalid year ${String(opts.year)}`);
    where.push('substr(watched_at, 1, 4) = ?');
    params.push(String(opts.year));
  }
  for (const [key, op] of [['from', '>='], ['to', '<=']] as const) {
    const d = opts[key];
    if (d === undefined) continue;
    if (!DAY_RE.test(d) || !isValidWatchedAt(d)) throw new LibraryError(`Invalid ${key} date "${d}" (expected YYYY-MM-DD)`);
    where.push(`watched_at IS NOT NULL AND substr(watched_at, 1, 10) ${op} ?`);
    params.push(d);
  }
  if (opts.source !== undefined) {
    if (!(ITEM_SOURCES as readonly string[]).includes(opts.source)) throw new LibraryError(`Invalid source "${String(opts.source)}"`);
    where.push('source = ?');
    params.push(opts.source);
  }
  let sql = `SELECT ${COLUMNS} FROM viewings ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${NEWEST_FIRST}`;
  if (opts.limit !== undefined) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(opts.limit, opts.offset ?? 0);
  }
  return (db.sql.prepare(sql).all(...params) as unknown as ViewingRow[]).map(toViewing);
}

/** One viewing by id, or null. */
export function getViewing(db: Db, viewingId: number): Viewing | null {
  if (!Number.isSafeInteger(viewingId)) return null;
  const row = db.sql.prepare(`SELECT ${COLUMNS} FROM viewings WHERE id = ?`).get(viewingId) as ViewingRow | undefined;
  return row ? toViewing(row) : null;
}

/** The viewing the cache should name: the latest dated one. */
function latestDated(db: Db, itemId: number): { watched_at: string; source: string } | undefined {
  return db.sql
    .prepare(
      'SELECT watched_at, source FROM viewings WHERE item_id = ? AND watched_at IS NOT NULL ORDER BY substr(watched_at, 1, 10) DESC, added_at DESC, id DESC LIMIT 1',
    )
    .get(itemId) as { watched_at: string; source: string } | undefined;
}

/** A viewing source as the watched_at_source cache stores it: `manual` is NULL, as user-set dates were in 0.3.0. */
const cachedSource = (source: string): string | null => (source === 'manual' ? null : source);

export interface RefreshOptions {
  /** The caller sets the era itself (an explicit era in the same write), so leave it. */
  eraLocked?: boolean;
}

/**
 * Rewrite one item's watched-date cache from its viewings. The only writer of
 * library_items.watched_at and watched_at_source. Returns whether the date
 * changed. Call it in the same transaction as the viewing write.
 */
export function refreshWatched(db: Db, itemId: number, opts: RefreshOptions = {}): { watchedAt: string | null; changed: boolean } {
  const cur = db.sql.prepare('SELECT watched_at, watched_at_source, watched_era, status FROM library_items WHERE id = ?').get(itemId) as
    | { watched_at: string | null; watched_at_source: string | null; watched_era: string | null; status: string }
    | undefined;
  if (!cur) return { watchedAt: null, changed: false };
  const latest = latestDated(db, itemId);
  const at = latest?.watched_at ?? null;
  const src = latest ? cachedSource(latest.source) : null;
  if (at === cur.watched_at && src === cur.watched_at_source) return { watchedAt: at, changed: false };
  let era = cur.watched_era;
  if (!opts.eraLocked && at !== cur.watched_at && cur.status === 'watched') {
    const oldEra = cur.watched_at === null ? null : eraOf(cur.watched_at);
    if (era === null || era === oldEra) era = at === null ? null : eraOf(at);
  }
  db.sql.prepare('UPDATE library_items SET watched_at = ?, watched_at_source = ?, watched_era = ? WHERE id = ?').run(at, src, era, itemId);
  return { watchedAt: at, changed: at !== cur.watched_at };
}

/**
 * Items whose cached watched date or source disagrees with their viewings
 * (for `doctor`). Empty when the cache is sound.
 */
export function checkWatchedCache(db: Db): { itemId: number; cached: { watchedAt: string | null; source: string | null }; expected: { watchedAt: string | null; source: string | null } }[] {
  const rows = db.sql
    .prepare(
      `SELECT li.id AS id, li.watched_at AS at, li.watched_at_source AS src,
              (SELECT v.watched_at FROM viewings v WHERE v.item_id = li.id AND v.watched_at IS NOT NULL
                ORDER BY substr(v.watched_at, 1, 10) DESC, v.added_at DESC, v.id DESC LIMIT 1) AS v_at,
              (SELECT v.source FROM viewings v WHERE v.item_id = li.id AND v.watched_at IS NOT NULL
                ORDER BY substr(v.watched_at, 1, 10) DESC, v.added_at DESC, v.id DESC LIMIT 1) AS v_src
       FROM library_items li ORDER BY li.id`,
    )
    .all() as { id: number; at: string | null; src: string | null; v_at: string | null; v_src: string | null }[];
  return rows
    .map((r) => ({ itemId: r.id, cached: { watchedAt: r.at, source: r.src }, expected: { watchedAt: r.v_at, source: r.v_src === null ? null : cachedSource(r.v_src) } }))
    .filter((r) => r.cached.watchedAt !== r.expected.watchedAt || r.cached.source !== r.expected.source);
}

/** Insert one viewing row, already validated. No cache refresh. */
export function insertViewingRow(db: Db, itemId: number, v: NewViewing): number {
  const res = db.sql
    .prepare('INSERT INTO viewings (item_id, watched_at, rewatch, rating, source, source_ref) VALUES (?, ?, ?, ?, ?, ?)')
    .run(itemId, v.watchedAt, v.rewatch == null ? null : v.rewatch ? 1 : 0, v.rating ?? null, v.source, v.sourceRef ?? null);
  return Number(res.lastInsertRowid);
}

/** A stored play this one would duplicate: the same ref, or (no ref) the same source and calendar date. */
function sameStoredPlay(db: Db, itemId: number, v: NewViewing): ViewingRow | undefined {
  if (v.sourceRef != null) {
    return db.sql.prepare(`SELECT ${COLUMNS} FROM viewings WHERE item_id = ? AND source = ? AND source_ref = ?`).get(itemId, v.source, v.sourceRef) as
      | ViewingRow
      | undefined;
  }
  if (v.watchedAt === null) return undefined;
  return db.sql
    .prepare(`SELECT ${COLUMNS} FROM viewings WHERE item_id = ? AND source = ? AND source_ref IS NULL AND watched_at IS NOT NULL AND substr(watched_at, 1, 10) = ?`)
    .get(itemId, v.source, calendarDate(v.watchedAt)) as ViewingRow | undefined;
}

/**
 * Record one play and refresh the item's watched date. A play already stored
 * (the same ref, or with no ref the same source and calendar date) is not
 * added twice: the stored one is returned. Throws LibraryError on bad input or
 * a missing item. Future dates are the caller's to refuse (isFutureDate).
 */
export function addViewing(db: Db, itemId: number, v: NewViewing, opts: RefreshOptions = {}): Viewing {
  const clean: NewViewing = { ...v, watchedAt: v.watchedAt === null ? null : v.watchedAt.trim(), sourceRef: v.sourceRef == null ? null : v.sourceRef.trim() };
  validateViewing(clean);
  return atomic(db, () => {
    requireItemId(db, itemId);
    const dup = sameStoredPlay(db, itemId, clean);
    if (dup) return toViewing(dup);
    const id = insertViewingRow(db, itemId, clean);
    refreshWatched(db, itemId, opts);
    return getViewing(db, id) as Viewing;
  });
}

/** Delete one viewing by id (never by title) and refresh its item's watched date. */
export function removeViewing(db: Db, viewingId: number): Viewing {
  return atomic(db, () => {
    const v = getViewing(db, viewingId);
    if (!v) throw new LibraryError(`Viewing ${String(viewingId)} not found`);
    db.sql.prepare('DELETE FROM viewings WHERE id = ?').run(viewingId);
    refreshWatched(db, v.itemId);
    return v;
  });
}

/** Delete every viewing of one item, returning how many went. */
export function removeAllViewings(db: Db, itemId: number, opts: RefreshOptions = {}): number {
  return atomic(db, () => {
    requireItemId(db, itemId);
    const n = Number(db.sql.prepare('DELETE FROM viewings WHERE item_id = ?').run(itemId).changes);
    refreshWatched(db, itemId, opts);
    return n;
  });
}

/** Apply a plan to one item and refresh its watched date. Inside the caller's transaction. */
export function applyViewingPlan(db: Db, itemId: number, plan: ViewingPlan, opts: RefreshOptions = {}): void {
  const del = db.sql.prepare('DELETE FROM viewings WHERE id = ? AND item_id = ?');
  for (const id of plan.deletes) del.run(id, itemId);
  for (const u of plan.updates) {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (u.watchedAt !== undefined) {
      sets.push('watched_at = ?');
      params.push(u.watchedAt);
    }
    if (u.sourceRef !== undefined) {
      sets.push('source_ref = ?');
      params.push(u.sourceRef);
    }
    if (u.rewatch !== undefined) {
      sets.push('rewatch = ?');
      params.push(u.rewatch === null ? null : u.rewatch ? 1 : 0);
    }
    if (u.rating !== undefined) {
      sets.push('rating = ?');
      params.push(u.rating);
    }
    if (sets.length) db.sql.prepare(`UPDATE viewings SET ${sets.join(', ')} WHERE id = ? AND item_id = ?`).run(...params, u.id, itemId);
  }
  for (const v of plan.inserts) insertViewingRow(db, itemId, v);
  refreshWatched(db, itemId, opts);
}

export const planIsEmpty = (p: ViewingPlan): boolean => p.inserts.length === 0 && p.updates.length === 0 && p.deletes.length === 0;

/**
 * Decide how an import's plays for one item meet the stored ones. Pure.
 *
 * Per source: an incoming play with a ref matches the stored play with that
 * ref (taking its date, which may be null: a play found to have no real
 * date), else a stored play of the same source and calendar date that has no
 * ref (which it upgrades with its ref, date string, flag and rating). A dated play with no
 * ref is one per source and calendar date: it matches a stored play of that
 * day or is added once (the days counted are those the plan leaves, so a
 * play moved off a day frees it). Dateless plays with no ref match stored
 * dateless ones one for one, so a source's dateless count only grows to what
 * it sends. Matched plays take the incoming rewatch flag and rating when
 * given (undefined leaves them; the import core passes a null as undefined,
 * so an import never clears one).
 *
 * With `exact` (a ScreenTrackr JSON v1 file, ScreenTrackr's own record of
 * these plays) a play only matches the very same stored play: the same ref,
 * or no ref and the same day (the unique index). A ref never upgrades a
 * ref-less play and a ref-less play never folds into one with a ref, so a
 * restore keeps every play the file lists.
 *
 * For each source in `complete`, the stored plays of that source that nothing
 * matched are deleted: the incoming set is that source's whole history of the
 * film. `manual` plays are never deleted, and no other source's plays are
 * ever touched.
 */
export function planViewingSync(
  stored: readonly Viewing[],
  incoming: readonly NewViewing[],
  complete: ReadonlySet<string>,
  opts: { exact?: boolean } = {},
): ViewingPlan {
  const exact = opts.exact === true;
  const plan: ViewingPlan = { inserts: [], updates: [], deletes: [] };
  // Inserts keep the incoming order across sources, so a restore adds plays in
  // the order the file lists them and same-day ties resolve as they did.
  const order = new Map(incoming.map((v, i) => [v, i]));
  const insertedFrom = new Map<NewViewing, number>();
  const sources = [...new Set([...incoming.map((v) => v.source), ...complete])] as ItemSource[];
  const dayOf = (d: string | null) => (d === null ? null : calendarDate(d));
  for (const source of sources) {
    const mine = stored.filter((v) => v.source === source);
    const inc = incoming.filter((v) => v.source === source);
    const used = new Set<number>();
    /** Where each matched stored play ends up (its date after this plan). */
    const resultDay = new Map<number, string | null>();
    /** Days this plan inserts a play on (in exact mode, ref-less plays only). */
    const insertedDays = new Set<string>();
    const refs = new Set<string>();
    const free = (pred: (v: Viewing) => boolean) => mine.find((v) => !used.has(v.id) && pred(v));
    /** Whether a ref-less play on `day` would duplicate one the plan leaves for this source. */
    const dayTaken = (day: string) =>
      insertedDays.has(day) ||
      mine.some((v) => (used.has(v.id) ? resultDay.get(v.id) === day && (!exact || v.sourceRef === null) : !exact && dayOf(v.watchedAt) === day));
    const insert = (v: NewViewing) => {
      const row: NewViewing = { watchedAt: v.watchedAt, source, rewatch: v.rewatch ?? null, rating: v.rating ?? null, sourceRef: v.sourceRef ?? null };
      insertedFrom.set(row, order.get(v) ?? 0);
      plan.inserts.push(row);
      if (row.watchedAt !== null && (!exact || row.sourceRef === null)) insertedDays.add(calendarDate(row.watchedAt));
    };
    const update = (cur: Viewing, v: NewViewing, how: 'ref' | 'upgrade' | 'day') => {
      used.add(cur.id);
      const u: ViewingUpdate = { id: cur.id };
      if (how === 'ref' && v.watchedAt !== cur.watchedAt) u.watchedAt = v.watchedAt;
      if (how === 'upgrade' && v.sourceRef != null) {
        u.sourceRef = v.sourceRef;
        // The same day: the play with a ref brings its own date string (a time, say), so a repeat matches it as is.
        if (v.watchedAt !== null && v.watchedAt !== cur.watchedAt) u.watchedAt = v.watchedAt;
      }
      if (v.rewatch !== undefined && v.rewatch !== cur.rewatch) u.rewatch = v.rewatch;
      if (v.rating !== undefined && v.rating !== cur.rating) u.rating = v.rating;
      resultDay.set(cur.id, dayOf(u.watchedAt !== undefined ? u.watchedAt : cur.watchedAt));
      if (Object.keys(u).length > 1) plan.updates.push(u);
    };

    for (const v of inc.filter((x) => x.sourceRef != null)) {
      const ref = v.sourceRef as string;
      if (refs.has(ref)) continue;
      refs.add(ref);
      const byRef = free((s) => s.sourceRef === ref);
      if (byRef) {
        update(byRef, v, 'ref');
        continue;
      }
      const day = dayOf(v.watchedAt);
      const sameDay = exact || day === null ? undefined : free((s) => s.sourceRef === null && dayOf(s.watchedAt) === day);
      if (sameDay) update(sameDay, v, 'upgrade');
      else insert(v);
    }
    for (const v of inc.filter((x) => x.sourceRef == null && x.watchedAt !== null)) {
      const day = calendarDate(v.watchedAt as string);
      const hit = free((s) => s.sourceRef === null && dayOf(s.watchedAt) === day) ?? (exact ? undefined : free((s) => dayOf(s.watchedAt) === day));
      if (hit) update(hit, v, 'day');
      else if (!dayTaken(day)) insert(v);
    }
    for (const v of inc.filter((x) => x.sourceRef == null && x.watchedAt === null)) {
      const hit = free((s) => s.watchedAt === null && s.sourceRef === null) ?? (exact ? undefined : free((s) => s.watchedAt === null));
      if (hit) update(hit, v, 'day');
      else insert(v);
    }
    if (complete.has(source) && source !== 'manual') for (const s of mine) if (!used.has(s.id)) plan.deletes.push(s.id);
  }
  plan.inserts.sort((x, y) => (insertedFrom.get(x) ?? 0) - (insertedFrom.get(y) ?? 0));
  return plan;
}

/** The fields the read-side helpers need. */
export type ViewingLike = Pick<Viewing, 'id' | 'watchedAt' | 'source' | 'rewatch'>;

/** One night (or one dateless play) as read paths see it, after the cross-source collapse. */
export interface PlayGroup<V extends ViewingLike = Viewing> {
  key: string;
  date: string | null;
  /** Distinct sources, sorted. */
  sources: ItemSource[];
  viewings: V[];
}

/**
 * Collapse viewings into plays: dated ones by (film key, calendar date)
 * across sources, newest first; dateless ones paired across sources (the
 * first dateless play of each source together, then the second), so their
 * count is the largest per-source count. `keyOf` names the film (see
 * filmKey); by default every viewing is one film.
 */
export function groupSameNight<V extends ViewingLike>(viewings: readonly V[], keyOf: (v: V) => string = () => ''): PlayGroup<V>[] {
  const dated = new Map<string, PlayGroup<V>>();
  const dateless = new Map<string, Map<string, V[]>>();
  for (const v of viewings) {
    const key = keyOf(v);
    if (v.watchedAt !== null) {
      const date = calendarDate(v.watchedAt);
      const k = `${key}\u0000${date}`;
      const g = dated.get(k) ?? { key, date, sources: [], viewings: [] };
      g.viewings.push(v);
      dated.set(k, g);
    } else {
      const bySource = dateless.get(key) ?? new Map<string, V[]>();
      bySource.set(v.source, [...(bySource.get(v.source) ?? []), v]);
      dateless.set(key, bySource);
    }
  }
  const out = [...dated.values()].sort((a, b) => (b.date as string).localeCompare(a.date as string) || a.key.localeCompare(b.key));
  for (const [key, bySource] of dateless) {
    const depth = Math.max(...[...bySource.values()].map((l) => l.length));
    for (let i = 0; i < depth; i++) {
      const vs = [...bySource.values()].map((l) => l[i]).filter((v): v is V => v !== undefined);
      out.push({ key, date: null, sources: [], viewings: vs });
    }
  }
  for (const g of out) g.sources = [...new Set<ItemSource>(g.viewings.map((v) => v.source))].sort();
  return out;
}

/** Plays after the cross-source collapse (see groupSameNight). */
export function countPlays<V extends ViewingLike>(viewings: readonly V[], keyOf?: (v: V) => string): number {
  return groupSameNight(viewings, keyOf).length;
}

/**
 * Each viewing's rewatch flag: the source's own when it gave one, otherwise
 * true for a dated play with an earlier dated play of the same film (any
 * source, any edition the caller groups under one key). A dateless play the
 * source didn't flag is not a rewatch. Keyed by viewing id.
 */
export function deriveRewatch<V extends ViewingLike>(viewings: readonly V[], keyOf: (v: V) => string = () => ''): Map<number, boolean> {
  const first = new Map<string, string>();
  for (const v of viewings) {
    if (v.watchedAt === null) continue;
    const key = keyOf(v);
    const d = calendarDate(v.watchedAt);
    const have = first.get(key);
    if (have === undefined || d < have) first.set(key, d);
  }
  const out = new Map<number, boolean>();
  for (const v of viewings) {
    if (v.rewatch !== null) out.set(v.id, v.rewatch);
    else out.set(v.id, v.watchedAt !== null && calendarDate(v.watchedAt) > (first.get(keyOf(v)) as string));
  }
  return out;
}

/** The film an item is, for counting: its tconst when linked (editions collapse), else the item itself. */
export function filmKey(item: { id: number; tconst: string | null; matchStatus: string }): string {
  return item.tconst !== null && (item.matchStatus === 'matched' || item.matchStatus === 'manual') ? item.tconst : `#${item.id}`;
}

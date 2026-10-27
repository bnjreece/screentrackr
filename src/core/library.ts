/**
 * Library operations. Every write targets a `library_items.id` (or, for
 * adding, a catalog tconst), never a title string. Titles are only resolved to
 * items through `resolveRef`, which reports every candidate so a caller can
 * refuse to write when a title is ambiguous.
 */
import { transaction, type Db } from './db.js';
import { LibraryError } from './errors.js';
import { identityOf, parseTitleRef } from './identity.js';
import { normalizeTitle } from './normalize.js';
import { yearsConflict } from './match.js';
import { addViewing, atomic, calendarDate, isFutureDate, isValidWatchedAt, refreshWatched, removeAllViewings, WATCHED_AT_RE } from './viewings.js';
import {
  STATUSES,
  WATCHED_ERAS,
  type ItemSource,
  type LibraryItem,
  type MatchStatus,
  type Status,
  type WatchedEra,
} from './types.js';

/** A user-facing error (bad input, missing item). The CLI maps it to exit code 1. */
export { LibraryError };

const LEGACY_STATUS: Record<string, { status: Status; watchedEra: WatchedEra | null }> = {
  'to-watch': { status: 'queue', watchedEra: null },
  next: { status: 'priority', watchedEra: null },
  later: { status: 'someday', watchedEra: null },
  'watched-young': { status: 'watched', watchedEra: 'long-ago' },
  'watched-2010s': { status: 'watched', watchedEra: '2010s' },
  'watched-2020s': { status: 'watched', watchedEra: '2020s' },
};

/**
 * Map an old web app status to a status and watched era. A missing or blank
 * value becomes `queue` (the old app's default). Current status names pass
 * through unchanged. Anything else throws, so an import never guesses.
 */
export function mapLegacyStatus(s?: string | null): { status: Status; watchedEra: WatchedEra | null } {
  const v = (s ?? '').trim().toLowerCase();
  if (!v) return { status: 'queue', watchedEra: null };
  const legacy = LEGACY_STATUS[v];
  if (legacy) return { ...legacy };
  if ((STATUSES as readonly string[]).includes(v)) return { status: v as Status, watchedEra: null };
  throw new LibraryError(`Unknown status "${s}"`);
}

/** The raw library_items row. */
export interface LibraryRow {
  id: number;
  tconst: string | null;
  source_title: string;
  source_year: number | null;
  source_director: string | null;
  source_runtime_min: number | null;
  source_genre: string | null;
  collection: string | null;
  owned: number;
  source_owned_raw: string | null;
  status: string;
  watched_era: string | null;
  watched_at: string | null;
  my_rating: number | null;
  notes: string | null;
  match_status: string;
  match_score: number | null;
  source: string;
  apple_persistent_id: string | null;
  added_at: string;
  updated_at: string;
}

export const LIBRARY_COLUMNS =
  'id, tconst, source_title, source_year, source_director, source_runtime_min, source_genre, collection, owned, source_owned_raw, status, watched_era, watched_at, my_rating, notes, match_status, match_score, source, apple_persistent_id, added_at, updated_at';

/** Convert a library_items row to the camelCase LibraryItem. */
export function rowToItem(r: LibraryRow): LibraryItem {
  return {
    id: r.id,
    tconst: r.tconst,
    sourceTitle: r.source_title,
    sourceYear: r.source_year,
    sourceDirector: r.source_director,
    sourceRuntimeMin: r.source_runtime_min,
    sourceGenre: r.source_genre,
    collection: r.collection,
    owned: r.owned === 1,
    sourceOwnedRaw: r.source_owned_raw,
    status: r.status as Status,
    watchedEra: r.watched_era as WatchedEra | null,
    watchedAt: r.watched_at,
    myRating: r.my_rating,
    notes: r.notes,
    matchStatus: r.match_status as MatchStatus,
    matchScore: r.match_score,
    source: r.source as ItemSource,
    applePersistentId: r.apple_persistent_id,
    addedAt: r.added_at,
    updatedAt: r.updated_at,
  };
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
/**
 * An item's tconst is an identity only when a match or the owner vouches for
 * it. An unmatched or ambiguous item can hold an unchecked hint (one saved
 * before `setup`, say), which may name a different movie.
 */
const LINKED_SQL = (alias: string) => `${alias}.tconst IS NOT NULL AND ${alias}.match_status IN ('matched', 'manual')`;
const TCONST_RE = /^tt\d{7,}$/;

function assertId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) throw new LibraryError(`Invalid item id: ${String(id)}`);
}

function assertTconst(tconst: string): void {
  if (!TCONST_RE.test(tconst)) throw new LibraryError(`Invalid IMDb id "${tconst}" (expected tt followed by digits)`);
}

function requireItem(db: Db, id: number): LibraryItem {
  const item = getItem(db, id);
  if (!item) throw new LibraryError(`Item ${id} not found`);
  return item;
}

function requireCatalogTitle(db: Db, tconst: string): { tconst: string; title: string; year: number | null; runtime_min: number | null; genres_csv: string | null } {
  assertTconst(tconst);
  const row = db.sql
    .prepare('SELECT tconst, title, year, runtime_min, genres_csv FROM titles WHERE tconst = ?')
    .get(tconst) as { tconst: string; title: string; year: number | null; runtime_min: number | null; genres_csv: string | null } | undefined;
  if (!row) throw new LibraryError(`Movie ${tconst} is not in the catalog`);
  return row;
}

/** One library item by id, or null. */
export function getItem(db: Db, id: number): LibraryItem | null {
  if (!Number.isSafeInteger(id)) return null;
  const row = db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items WHERE id = ?`).get(id) as
    | LibraryRow
    | undefined;
  return row ? rowToItem(row) : null;
}

export type RefResult = { kind: 'one'; item: LibraryItem } | { kind: 'many'; items: LibraryItem[] } | { kind: 'none' };

function toResult(items: LibraryItem[]): RefResult {
  if (items.length === 0) return { kind: 'none' };
  if (items.length === 1) return { kind: 'one', item: items[0] as LibraryItem };
  return { kind: 'many', items };
}

function itemsByTitle(db: Db, ref: string): LibraryItem[] {
  const { norm, year } = parseTitleRef(ref);
  if (!norm) return [];
  // The library is small (thousands of rows), so normalize in JS with the one
  // shared normalizer rather than keeping a second normalized column in sync.
  const rows = db.sql
    .prepare(
      `SELECT ${LIBRARY_COLUMNS.split(', ')
        .map((c) => `li.${c}`)
        .join(', ')}, t.norm_title AS catalog_norm
       FROM library_items li LEFT JOIN titles t ON t.tconst = li.tconst AND ${LINKED_SQL('li')} ORDER BY li.id`,
    )
    .all() as unknown as (LibraryRow & { catalog_norm: string | null })[];
  // A year the reference names ("Title (2009)", also beneath edition tags)
  // rules out an item whose own year, or its linked catalog title's when its
  // source has none, is more than one off. An item with no known year stays.
  return rows
    .filter((r) => normalizeTitle(r.source_title) === norm || (r.catalog_norm !== null && r.catalog_norm === norm))
    .map(rowToItem)
    .filter((item) => !yearsConflict(year, identityOf(db, item).year));
}

/**
 * Resolve a user reference to library items.
 *
 * - `#123` is always an id.
 * - Plain digits are an id. If a library title also normalizes to the same
 *   digits (a movie called "1917"), every such item is returned as `many`, so
 *   a write never silently picks one. Digits that are not an id fall back to a
 *   title compare.
 * - `tt…` is a tconst of a linked item (`matched` or `manual`); two editions
 *   of one tconst give `many`. An unresolved item's stored tconst is only an
 *   unchecked hint, so it never answers here: reach that item by id or title.
 * - Anything else is a title, compared after normalization against the source
 *   title and, for linked items only, the catalog title. A "(yyyy)" in it
 *   (beneath edition tags too) rules out items whose year is more than one off.
 */
export function resolveRef(db: Db, ref: string): RefResult {
  const r = ref.trim();
  if (!r) return { kind: 'none' };

  const explicit = /^#(\d+)$/.exec(r);
  if (explicit) {
    const item = getItem(db, Number(explicit[1]));
    return item ? { kind: 'one', item } : { kind: 'none' };
  }

  if (/^\d+$/.test(r)) {
    const byId = getItem(db, Number(r));
    const byTitle = itemsByTitle(db, r).filter((i) => i.id !== byId?.id);
    return toResult(byId ? [byId, ...byTitle].sort((a, b) => a.id - b.id) : byTitle);
  }

  if (/^tt\d+$/i.test(r)) {
    const rows = db.sql
      .prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items li WHERE li.tconst = ? AND ${LINKED_SQL('li')} ORDER BY id`)
      .all(r.toLowerCase()) as unknown as LibraryRow[];
    return toResult(rows.map(rowToItem));
  }

  return toResult(itemsByTitle(db, r));
}

/**
 * Add a catalog movie to the library. Source fields are copied from the
 * catalog, and the item is `manual` (the user chose the tconst), so rematching
 * never moves it. Adding a tconst already in the library adds another edition.
 * `owned` defaults to true (a movie you add is one you have); `list add
 * --add-missing` adds not-owned queue items.
 */
export function addFromCatalog(db: Db, tconst: string, opts: { status?: Status; owned?: boolean } = {}): LibraryItem {
  const status = opts.status ?? 'queue';
  if (!(STATUSES as readonly string[]).includes(status)) throw new LibraryError(`Invalid status "${String(status)}"`);
  if (opts.owned !== undefined && typeof opts.owned !== 'boolean') throw new LibraryError('owned must be true or false');
  const t = requireCatalogTitle(db, tconst);
  const directors = (
    db.sql
      .prepare(
        "SELECT p.name FROM title_people tp JOIN people p ON p.nconst = tp.nconst WHERE tp.tconst = ? AND tp.role = 'director' ORDER BY tp.ord",
      )
      .all(tconst) as { name: string }[]
  ).map((d) => d.name);
  const res = db.sql
    .prepare(
      `INSERT INTO library_items (tconst, source_title, source_year, source_director, source_runtime_min, source_genre, status, owned, match_status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual')`,
    )
    .run(t.tconst, t.title, t.year, directors.length ? directors.join(', ') : null, t.runtime_min, t.genres_csv, status, opts.owned === false ? 0 : 1);
  return requireItem(db, Number(res.lastInsertRowid));
}

export interface ItemPatch {
  status?: Status;
  watchedEra?: WatchedEra | null;
  watchedAt?: string | null;
  myRating?: number | null;
  notes?: string | null;
}

export { WATCHED_AT_RE };

/**
 * Update one item's status, era, watched date, rating or notes. Only the
 * fields present in `patch` change. `myRating` is a whole number from 1 to 10,
 * or null to clear. A watched era only applies to `watched`; moving an item
 * off `watched` clears its era. `updated_at` is bumped on every update.
 *
 * `watchedAt` is "this is the movie's watched date" on top of the play log
 * (core/viewings.ts): a date adds a `manual` viewing on that day (once; the
 * same day again changes nothing). A date earlier than a viewing the item
 * already has is refused, naming that viewing, since the watched date is the
 * latest play; remove it first with `history --remove`. A date more than a day
 * in the future is refused. `null` removes every viewing of the item. The
 * cached watched date follows (refreshWatched), and the era with it unless
 * the patch sets the era itself. Everything is written in one transaction, so
 * a refusal writes nothing.
 */
export function updateItem(db: Db, id: number, patch: ItemPatch): LibraryItem {
  return updateItemDetailed(db, id, patch).item;
}

/** updateItem, also reporting how many viewings a cleared watched date removed. */
export function updateItemDetailed(db: Db, id: number, patch: ItemPatch): { item: LibraryItem; viewingsRemoved: number } {
  assertId(id);
  const current = requireItem(db, id);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const set = (col: string, v: string | number | null) => {
    sets.push(`${col} = ?`);
    params.push(v);
  };

  if (patch.status !== undefined) {
    if (!(STATUSES as readonly string[]).includes(patch.status)) {
      throw new LibraryError(`Invalid status "${String(patch.status)}" (expected ${STATUSES.join(', ')})`);
    }
    set('status', patch.status);
  }
  const nextStatus = patch.status ?? current.status;

  if (patch.watchedEra !== undefined && patch.watchedEra !== null) {
    if (!(WATCHED_ERAS as readonly string[]).includes(patch.watchedEra)) {
      throw new LibraryError(`Invalid watched era "${String(patch.watchedEra)}" (expected ${WATCHED_ERAS.join(', ')})`);
    }
    if (nextStatus !== 'watched') throw new LibraryError('A watched era only applies to watched movies');
  }
  if (patch.watchedEra !== undefined) set('watched_era', patch.watchedEra);
  else if (nextStatus !== 'watched' && current.watchedEra !== null) set('watched_era', null);

  let watchedAt: string | null | undefined;
  if (patch.watchedAt !== undefined) {
    watchedAt = patch.watchedAt === null ? null : String(patch.watchedAt).trim();
    if (watchedAt !== null && !isValidWatchedAt(watchedAt)) {
      throw new LibraryError(`Invalid watched date "${String(patch.watchedAt)}" (expected YYYY-MM-DD or an ISO date-time)`);
    }
    if (watchedAt !== null && isFutureDate(watchedAt)) throw new LibraryError(`Watched date ${watchedAt} is in the future`);
  }

  if (patch.myRating !== undefined) {
    const r = patch.myRating;
    if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 10)) {
      throw new LibraryError(`Rating must be a whole number from 1 to 10 (got ${String(r)})`);
    }
    set('my_rating', r);
  }

  if (patch.notes !== undefined) set('notes', patch.notes);

  if (sets.length === 0 && watchedAt === undefined) return { item: current, viewingsRemoved: 0 };
  return atomic(db, () => {
    let viewingsRemoved = 0;
    if (typeof watchedAt === 'string') {
      const day = calendarDate(watchedAt);
      const later = db.sql
        .prepare(
          'SELECT id, watched_at, source FROM viewings WHERE item_id = ? AND watched_at IS NOT NULL AND substr(watched_at, 1, 10) > ? ORDER BY substr(watched_at, 1, 10) DESC, id DESC LIMIT 1',
        )
        .get(id, day) as { id: number; watched_at: string; source: string } | undefined;
      if (later) {
        throw new LibraryError(
          `Item ${id} has a later play (viewing ${later.id}, ${later.watched_at}, from ${later.source}), and the watched date is the latest play. Remove it first with \`screentrackr history --remove ${later.id}\`, or log this play with \`screentrackr log\`.`,
        );
      }
    }
    db.sql.prepare(`UPDATE library_items SET ${[...sets, `updated_at = ${NOW_SQL}`].join(', ')} WHERE id = ?`).run(...params, id);
    // An era set in this same patch is the caller's word; otherwise it follows the date (see refreshWatched).
    const eraLocked = patch.watchedEra !== undefined;
    if (typeof watchedAt === 'string') addViewing(db, id, { watchedAt, source: 'manual' }, { eraLocked });
    else if (watchedAt === null) viewingsRemoved = removeAllViewings(db, id, { eraLocked });
    else refreshWatched(db, id, { eraLocked });
    return { item: requireItem(db, id), viewingsRemoved };
  });
}

/** Remove one library item (and its stored match candidates). */
export function removeItem(db: Db, id: number): void {
  assertId(id);
  const res = db.sql.prepare('DELETE FROM library_items WHERE id = ?').run(id);
  if (Number(res.changes) === 0) throw new LibraryError(`Item ${id} not found`);
}

/**
 * Link an item to a catalog tconst by hand. The item becomes `manual`, which
 * rematching never overwrites, and its stored candidates are cleared. An
 * `imdb` external id naming another title (an IMDb export's id the owner has
 * just corrected) is dropped, so a later IMDb import of the linked title
 * finds this item.
 */
export function linkItem(db: Db, id: number, tconst: string): LibraryItem {
  assertId(id);
  requireItem(db, id);
  requireCatalogTitle(db, tconst);
  transaction(db.sql, () => {
    db.sql
      .prepare(`UPDATE library_items SET tconst = ?, match_status = 'manual', match_score = NULL, updated_at = ${NOW_SQL} WHERE id = ?`)
      .run(tconst, id);
    db.sql.prepare('DELETE FROM match_candidates WHERE item_id = ?').run(id);
    db.sql.prepare("DELETE FROM item_external_ids WHERE item_id = ? AND kind = 'imdb' AND value <> ?").run(id, tconst);
  });
  return requireItem(db, id);
}

/**
 * What the Letterboxd and Trakt writers read: each library item with its own
 * external ids, plays and lists, plus the catalog's title and year for a
 * linked item (only to fill a blank). The writers are pure functions over
 * these, so their tests need no database. Read-only.
 *
 * Exports carry the user's own records plus an id. Never IMDb ratings, votes,
 * cast or genres, and never a catalog value the item has of its own.
 */
import type { Db } from '../db.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../library.js';
import { listsByItem } from '../lists.js';
import { EXTERNAL_ID_KINDS, type ExternalIdKind, type ExternalIds, type LibraryItem, type Status } from '../types.js';
import { filmKey, viewingsByItem, type Viewing } from '../viewings.js';

export interface ExportSource {
  item: LibraryItem;
  externalIds: ExternalIds;
  /** The catalog's title and year, only for an item linked to it (matched or manual). */
  catalog: { title: string; year: number | null } | null;
  /** Every play of the item. */
  viewings: Viewing[];
  /** The item's list names. */
  lists: string[];
}

/** One file a writer produced. */
export interface CsvFile {
  name: string;
  content: string;
  rows: number;
}

/** Whether a match or the owner vouches for the item's tconst (an unmatched or ambiguous one is a hint). */
export function isLinked(item: LibraryItem): boolean {
  return item.tconst !== null && (item.matchStatus === 'matched' || item.matchStatus === 'manual');
}

/** The IMDb id to write, only for a linked item. */
export function imdbIdOf(s: ExportSource): string | null {
  return isLinked(s.item) ? s.item.tconst : null;
}

/** The item's own title; the catalog's only when the item's is blank. */
export function titleOf(s: ExportSource): string {
  const own = s.item.sourceTitle.trim();
  return own || (s.catalog?.title ?? '');
}

/** The item's own year; the catalog's only when the item has none. */
export function yearOf(s: ExportSource): number | null {
  return s.item.sourceYear ?? s.catalog?.year ?? null;
}

export const isUnwatchedStatus = (st: Status): boolean => st === 'queue' || st === 'priority' || st === 'someday';

/** A film: one or more items that are the same movie (editions linked to one tconst), lowest id first. */
export interface Film {
  key: string;
  items: ExportSource[];
}

/** Group items into films by filmKey (editions collapse; unlinked items stay alone), in order of each film's lowest item id. */
export function films(sources: readonly ExportSource[]): Film[] {
  const byKey = new Map<string, Film>();
  for (const s of [...sources].sort((a, b) => a.item.id - b.item.id)) {
    const key = filmKey(s.item);
    const f = byKey.get(key) ?? { key, items: [] };
    f.items.push(s);
    byKey.set(key, f);
  }
  return [...byKey.values()];
}

/** The film's first item that has a value for `pick`, else the first item's. */
export function firstWith<T>(f: Film, pick: (s: ExportSource) => T | null): T | null {
  for (const s of f.items) {
    const v = pick(s);
    if (v !== null && v !== '') return v;
  }
  return null;
}

/** All plays of a film, across its editions. */
export function filmViewings(f: Film): Viewing[] {
  return f.items.flatMap((s) => s.viewings);
}

/** A film was watched when any edition is `watched` or has a play. */
export function filmWatched(f: Film): boolean {
  return f.items.some((s) => s.item.status === 'watched' || s.viewings.length > 0);
}

/**
 * A film is on the watchlist when an edition is unwatched (queue, priority,
 * someday) and no edition is `watched`. Status decides, not plays: a film
 * queued again after it was watched is on it; a film you watched with a new
 * edition still in the queue is not.
 */
export function filmOnWatchlist(f: Film): boolean {
  return f.items.some((s) => isUnwatchedStatus(s.item.status)) && !f.items.some((s) => s.item.status === 'watched');
}

/** Every library item with what the writers need, in id order. Read-only. */
export function loadExportSources(db: Db): ExportSource[] {
  const rows = db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[];
  const ext = new Map<number, ExternalIds>();
  for (const r of db.sql.prepare('SELECT item_id, kind, value FROM item_external_ids ORDER BY item_id, kind').all() as { item_id: number; kind: string; value: string }[]) {
    if (!(EXTERNAL_ID_KINDS as readonly string[]).includes(r.kind)) continue;
    const m = ext.get(r.item_id) ?? {};
    m[r.kind as ExternalIdKind] = r.value;
    ext.set(r.item_id, m);
  }
  const catalog = new Map<string, { title: string; year: number | null }>();
  for (const r of db.sql
    .prepare(
      `SELECT DISTINCT t.tconst, t.title, t.year FROM library_items li JOIN titles t ON t.tconst = li.tconst
       WHERE li.match_status IN ('matched', 'manual')`,
    )
    .all() as { tconst: string; title: string; year: number | null }[]) {
    catalog.set(r.tconst, { title: r.title, year: r.year });
  }
  const plays = viewingsByItem(db);
  const lists = listsByItem(db);
  return rows.map((r) => {
    const item = rowToItem(r);
    return {
      item,
      externalIds: ext.get(item.id) ?? {},
      catalog: isLinked(item) ? (catalog.get(item.tconst as string) ?? null) : null,
      viewings: plays.get(item.id) ?? [],
      lists: lists.get(item.id) ?? [],
    };
  });
}

/** Line breaks never belong in one CSV field of these formats: they become spaces. */
export function oneLine(v: string): string {
  return v.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
}

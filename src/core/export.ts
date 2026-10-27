/**
 * ScreenTrackr JSON v1: the tool's own lossless library format. `exportLibrary`
 * writes it and the `json-v1` importer reads it back.
 */
import type { Db } from './db.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from './library.js';
import { listLists, listsByItem } from './lists.js';
import type { ExternalIds, ItemSource, LibraryItem } from './types.js';
import { viewingsByItem, type Viewing } from './viewings.js';

export const LIBRARY_FORMAT = 'screentrackr-library';
export const LIBRARY_FORMAT_VERSION = 1;

/** One play as JSON v1 carries it (0.4.0, additive). */
export interface ExportViewing {
  watchedAt: string | null;
  rewatch: boolean | null;
  rating: number | null;
  source: ItemSource;
  sourceRef: string | null;
}

/** A list as the JSON v1 envelope carries it, so empty lists and descriptions survive. */
export interface ExportList {
  name: string;
  description: string | null;
  createdAt: string;
}

/**
 * A library item without its local id. `tconst` is included (null when
 * unlinked). `externalIds` is present only when the item has any, and
 * `watchedAtSource` only when an import source set the watched date.
 * `viewings` (every play, oldest first) and `lists` (list names) are present
 * only when the item has any. `watchedAt` and `watchedAtSource` are still
 * written, derived from the plays, so a 0.3.x reader keeps the date.
 */
export type ExportItem = Omit<LibraryItem, 'id'> & {
  externalIds?: ExternalIds;
  watchedAtSource?: ItemSource;
  viewings?: ExportViewing[];
  lists?: string[];
};

export interface LibraryJsonV1 {
  format: typeof LIBRARY_FORMAT;
  version: typeof LIBRARY_FORMAT_VERSION;
  exportedAt: string;
  items: ExportItem[];
  /** Every list, by name (0.4.0, additive). exportLibrary always writes it; older files lack it. */
  lists?: ExportList[];
}

/** Oldest first: dated plays by calendar date, then the order they were added; dateless last. */
function chronological(vs: readonly Viewing[]): Viewing[] {
  return [...vs].sort((x, y) => {
    if ((x.watchedAt === null) !== (y.watchedAt === null)) return x.watchedAt === null ? 1 : -1;
    const d = (x.watchedAt ?? '').slice(0, 10).localeCompare((y.watchedAt ?? '').slice(0, 10));
    return d || x.addedAt.localeCompare(y.addedAt) || x.id - y.id;
  });
}

/** Every library item, in id order, as ScreenTrackr JSON v1. Read-only. */
export function exportLibrary(db: Db): LibraryJsonV1 {
  const rows = db.sql
    .prepare(`SELECT ${LIBRARY_COLUMNS}, watched_at_source FROM library_items ORDER BY id`)
    .all() as unknown as (LibraryRow & { watched_at_source: string | null })[];
  const ids = new Map<number, Record<string, string>>();
  for (const row of db.sql.prepare('SELECT item_id, kind, value FROM item_external_ids ORDER BY item_id, kind').all() as {
    item_id: number;
    kind: string;
    value: string;
  }[]) {
    const m = ids.get(row.item_id) ?? {};
    m[row.kind] = row.value;
    ids.set(row.item_id, m);
  }
  const plays = viewingsByItem(db);
  const memberships = listsByItem(db);
  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    items: rows.map((r) => {
      const item: Partial<LibraryItem> & Omit<ExportItem, keyof LibraryItem> = rowToItem(r);
      delete item.id;
      const ext = ids.get(r.id);
      if (ext) item.externalIds = ext as ExternalIds;
      if (r.watched_at !== null && r.watched_at_source !== null) item.watchedAtSource = r.watched_at_source as ItemSource;
      const vs = plays.get(r.id);
      if (vs?.length) {
        item.viewings = chronological(vs).map((v) => ({ watchedAt: v.watchedAt, rewatch: v.rewatch, rating: v.rating, source: v.source, sourceRef: v.sourceRef }));
      }
      const ls = memberships.get(r.id);
      if (ls?.length) item.lists = ls;
      return item as ExportItem;
    }),
    lists: listLists(db).map((l) => ({ name: l.name, description: l.description, createdAt: l.createdAt })),
  };
}

/**
 * ScreenTrackr JSON v1: the tool's own lossless library format. `exportLibrary`
 * writes it and the `json-v1` importer reads it back.
 */
import type { Db } from './db.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from './library.js';
import type { ExternalIds, ItemSource, LibraryItem } from './types.js';

export const LIBRARY_FORMAT = 'screentrackr-library';
export const LIBRARY_FORMAT_VERSION = 1;

/**
 * A library item without its local id. `tconst` is included (null when
 * unlinked). `externalIds` is present only when the item has any, and
 * `watchedAtSource` only when an import source set the watched date.
 */
export type ExportItem = Omit<LibraryItem, 'id'> & { externalIds?: ExternalIds; watchedAtSource?: ItemSource };

export interface LibraryJsonV1 {
  format: typeof LIBRARY_FORMAT;
  version: typeof LIBRARY_FORMAT_VERSION;
  exportedAt: string;
  items: ExportItem[];
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
  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    items: rows.map((r) => {
      const item: Partial<LibraryItem> & { externalIds?: ExternalIds; watchedAtSource?: ItemSource } = rowToItem(r);
      delete item.id;
      const ext = ids.get(r.id);
      if (ext) item.externalIds = ext as ExternalIds;
      if (r.watched_at !== null && r.watched_at_source !== null) item.watchedAtSource = r.watched_at_source as ItemSource;
      return item as ExportItem;
    }),
  };
}

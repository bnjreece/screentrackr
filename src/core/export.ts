/**
 * ScreenTrackr JSON v1: the tool's own lossless library format. `exportLibrary`
 * writes it and the `json-v1` importer reads it back.
 */
import type { Db } from './db.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from './library.js';
import type { LibraryItem } from './types.js';

export const LIBRARY_FORMAT = 'screentrackr-library';
export const LIBRARY_FORMAT_VERSION = 1;

/** A library item without its local id. `tconst` is included (null when unlinked). */
export type ExportItem = Omit<LibraryItem, 'id'>;

export interface LibraryJsonV1 {
  format: typeof LIBRARY_FORMAT;
  version: typeof LIBRARY_FORMAT_VERSION;
  exportedAt: string;
  items: ExportItem[];
}

/** Every library item, in id order, as ScreenTrackr JSON v1. Read-only. */
export function exportLibrary(db: Db): LibraryJsonV1 {
  const rows = db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[];
  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    items: rows.map((r) => {
      const item: Partial<LibraryItem> = rowToItem(r);
      delete item.id;
      return item as ExportItem;
    }),
  };
}

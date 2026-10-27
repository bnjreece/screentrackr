/**
 * User lists ("Halloween"), many-to-many with library items (schema V4).
 * Distinct from `collection`, which is a source's own folder name and stays
 * read-only from imports.
 *
 * Names are any Unicode up to 100 characters, unique case-insensitively:
 * `norm_name` is the name in NFC, trimmed and case-folded, so "halloween" is
 * "Halloween". Every function takes a list by name; membership writes take
 * item ids (titles are resolved by the caller, through resolveRef). Deleting a
 * list never deletes a movie, and removing a movie drops its memberships.
 */
import type { Db } from './db.js';
import { LibraryError } from './errors.js';
import { atomic } from './viewings.js';

export const MAX_LIST_NAME = 100;
export const MAX_LIST_DESCRIPTION = 1000;

export interface List {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  /** Library items in the list. */
  count: number;
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Unicode full case folding beyond lowercasing: the letters whose fold
 * differs from their lowercase (CaseFolding.txt, status C and F, for the
 * scripts a list name is likely to use).
 */
const FOLD: Record<string, string> = {
  '\u00df': 'ss', // sharp s (a capital sharp s lowercases to it)
  '\u017f': 's', // long s
  '\u03c2': '\u03c3', // final sigma
  '\u03d0': '\u03b2',
  '\u03d1': '\u03b8',
  '\u03d5': '\u03c6',
  '\u03d6': '\u03c0',
  '\u03f0': '\u03ba',
  '\u03f1': '\u03c1',
  '\u03f5': '\u03b5',
  '\u1e9b': '\u1e61',
  '\u1e9e': 'ss',
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'gu');

/**
 * The key a name is unique by: NFC, trimmed and case-folded (lowercase, then
 * the letters whose fold differs, such as a sharp s to "ss" and a final
 * sigma to a sigma). A dotless i stays its own letter, as in Unicode folding.
 */
export function normListName(name: string): string {
  return name
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(FOLD_RE, (c) => FOLD[c] as string)
    .normalize('NFC');
}

/** A list name as stored: NFC and trimmed. Throws LibraryError when empty, too long or holding control characters. */
export function cleanListName(name: unknown): string {
  if (typeof name !== 'string') throw new LibraryError('A list name must be text');
  const s = name.normalize('NFC').trim();
  if (!s) throw new LibraryError('A list needs a name');
  if ([...s].length > MAX_LIST_NAME) throw new LibraryError(`A list name can be at most ${MAX_LIST_NAME} characters`);
  if (CONTROL_RE.test(s)) throw new LibraryError('A list name cannot contain control characters');
  return s;
}

function cleanDescription(d: string | null | undefined): string | null {
  if (d == null) return null;
  const s = d.trim();
  if (!s) return null;
  if ([...s].length > MAX_LIST_DESCRIPTION) throw new LibraryError(`A list description can be at most ${MAX_LIST_DESCRIPTION} characters`);
  return s;
}

interface ListRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  count: number;
}

const SELECT = `SELECT l.id, l.name, l.description, l.created_at, l.updated_at,
  (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS count FROM lists l`;

const toList = (r: ListRow): List => ({
  id: r.id,
  name: r.name,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  count: Number(r.count),
});

/** One list by name (case-insensitive), or null. */
export function getList(db: Db, name: string): List | null {
  if (typeof name !== 'string') return null;
  const row = db.sql.prepare(`${SELECT} WHERE l.norm_name = ?`).get(normListName(name)) as ListRow | undefined;
  return row ? toList(row) : null;
}

/** One list by name, or a LibraryError naming it. */
export function requireList(db: Db, name: string): List {
  const l = getList(db, name);
  if (!l) throw new LibraryError(`No list named "${String(name).trim()}"`);
  return l;
}

/** Every list, by name (case-insensitive), with its item count. */
export function listLists(db: Db): List[] {
  return (db.sql.prepare(`${SELECT} ORDER BY l.norm_name, l.id`).all() as unknown as ListRow[]).map(toList);
}

/** Create a list. A name already taken (in any case) is refused. `createdAt` is for a JSON v1 restore. */
export function createList(db: Db, name: string, opts: { description?: string | null; createdAt?: string | null } = {}): List {
  const clean = cleanListName(name);
  const description = cleanDescription(opts.description);
  if (getList(db, clean)) throw new LibraryError(`A list named "${clean}" already exists`);
  const createdAt = opts.createdAt && !Number.isNaN(Date.parse(opts.createdAt)) ? opts.createdAt : null;
  db.sql
    .prepare(`INSERT INTO lists (name, norm_name, description, created_at, updated_at) VALUES (?, ?, ?, COALESCE(?, ${NOW_SQL}), ${NOW_SQL})`)
    .run(clean, normListName(clean), description, createdAt);
  return requireList(db, clean);
}

/** The list with this name, created when missing. */
export function ensureList(db: Db, name: string, opts: { description?: string | null; createdAt?: string | null } = {}): { list: List; created: boolean } {
  const have = getList(db, cleanListName(name));
  if (have) return { list: have, created: false };
  return { list: createList(db, name, opts), created: true };
}

/** Rename a list. A case-only change of its own name is allowed; another list's name is refused. */
export function renameList(db: Db, name: string, newName: string): List {
  const list = requireList(db, name);
  const clean = cleanListName(newName);
  const other = getList(db, clean);
  if (other && other.id !== list.id) throw new LibraryError(`A list named "${other.name}" already exists`);
  db.sql.prepare(`UPDATE lists SET name = ?, norm_name = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(clean, normListName(clean), list.id);
  return requireList(db, clean);
}

/** Set (or with null, clear) a list's description. */
export function updateListDescription(db: Db, name: string, description: string | null): List {
  const list = requireList(db, name);
  db.sql.prepare(`UPDATE lists SET description = ?, updated_at = ${NOW_SQL} WHERE id = ?`).run(cleanDescription(description), list.id);
  return requireList(db, list.name);
}

/** Delete a list and its memberships, never the movies. Returns the list as it was and how many memberships went. */
export function deleteList(db: Db, name: string): { list: List; memberships: number } {
  const list = requireList(db, name);
  db.sql.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
  return { list, memberships: list.count };
}

function assertItems(db: Db, itemIds: readonly number[]): void {
  const has = db.sql.prepare('SELECT 1 FROM library_items WHERE id = ?');
  for (const id of itemIds) {
    if (!Number.isSafeInteger(id) || id < 1 || has.get(id) === undefined) throw new LibraryError(`Item ${String(id)} not found`);
  }
}

/** Add items (by id) to a list. Every id must exist, or nothing is added. */
export function addToList(db: Db, name: string, itemIds: readonly number[]): { added: number[]; already: number[] } {
  return atomic(db, () => {
    const list = requireList(db, name);
    assertItems(db, itemIds);
    const ins = db.sql.prepare('INSERT OR IGNORE INTO list_items (list_id, item_id) VALUES (?, ?)');
    const added: number[] = [];
    const already: number[] = [];
    for (const id of [...new Set(itemIds)]) (Number(ins.run(list.id, id).changes) ? added : already).push(id);
    if (added.length) db.sql.prepare(`UPDATE lists SET updated_at = ${NOW_SQL} WHERE id = ?`).run(list.id);
    return { added, already };
  });
}

/** Remove items (by id) from a list. Ids not in it are reported, not an error. */
export function removeFromList(db: Db, name: string, itemIds: readonly number[]): { removed: number[]; notMember: number[] } {
  return atomic(db, () => {
    const list = requireList(db, name);
    const del = db.sql.prepare('DELETE FROM list_items WHERE list_id = ? AND item_id = ?');
    const removed: number[] = [];
    const notMember: number[] = [];
    for (const id of [...new Set(itemIds)]) (Number(del.run(list.id, id).changes) ? removed : notMember).push(id);
    if (removed.length) db.sql.prepare(`UPDATE lists SET updated_at = ${NOW_SQL} WHERE id = ?`).run(list.id);
    return { removed, notMember };
  });
}

/** Item ids in a list, ascending. */
export function listItemIds(db: Db, name: string): number[] {
  const list = requireList(db, name);
  return (db.sql.prepare('SELECT item_id FROM list_items WHERE list_id = ? ORDER BY item_id').all(list.id) as { item_id: number }[]).map((r) => r.item_id);
}

/** The names of the lists an item is in, by name. */
export function listsOfItem(db: Db, itemId: number): string[] {
  return (
    db.sql
      .prepare('SELECT l.name FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.item_id = ? ORDER BY l.norm_name')
      .all(itemId) as { name: string }[]
  ).map((r) => r.name);
}

/** List names by item id (every item in any list), each sorted by name. */
export function listsByItem(db: Db): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const r of db.sql
    .prepare('SELECT li.item_id, l.name FROM list_items li JOIN lists l ON l.id = li.list_id ORDER BY li.item_id, l.norm_name')
    .all() as { item_id: number; name: string }[]) {
    out.set(r.item_id, [...(out.get(r.item_id) ?? []), r.name]);
  }
  return out;
}

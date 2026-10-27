/** core/lists.ts: user lists, many-to-many with library items. All titles are made up. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { LibraryError, removeItem } from '../src/core/library.js';
import {
  addToList,
  createList,
  deleteList,
  ensureList,
  getList,
  listItemIds,
  listLists,
  listsByItem,
  listsOfItem,
  normListName,
  removeFromList,
  renameList,
  updateListDescription,
} from '../src/core/lists.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-lists-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM list_items; DELETE FROM lists; DELETE FROM library_items;');
});

function item(title: string): number {
  return Number(
    db.sql.prepare("INSERT INTO library_items (source_title, match_status, source) VALUES (?, 'unmatched', 'paste')").run(title).lastInsertRowid,
  );
}

describe('lists', () => {
  it('normalizes names: NFC, trimmed, case-insensitive', () => {
    expect(normListName('  Halloween ')).toBe('halloween');
    expect(normListName('Café')).toBe(normListName('Café'));
    // Case-insensitive beyond lowercasing: a final sigma, a sharp s.
    expect(normListName('ΟΣ')).toBe(normListName('οσ'));
    expect(normListName('Straße')).toBe(normListName('STRASSE'));
  });

  it('creates, finds case-insensitively, and refuses a duplicate', () => {
    const l = createList(db, 'Halloween', { description: 'October' });
    expect(l).toMatchObject({ name: 'Halloween', description: 'October', count: 0 });
    expect(getList(db, 'halloween')?.id).toBe(l.id);
    expect(() => createList(db, 'HALLOWEEN')).toThrow(LibraryError);
    expect(() => createList(db, '   ')).toThrow(LibraryError);
    expect(() => createList(db, 'x'.repeat(101))).toThrow(LibraryError);
    expect(createList(db, '1917').name).toBe('1917');
    expect(listLists(db).map((x) => x.name)).toEqual(['1917', 'Halloween']);
  });

  it('finds a Greek name in any case and refuses its twin', () => {
    createList(db, 'ΟΣ');
    expect(getList(db, 'οσ')?.name).toBe('ΟΣ');
    expect(() => createList(db, 'οσ')).toThrow(/already exists/);
  });

  it('ensureList creates once', () => {
    expect(ensureList(db, 'Spooky').created).toBe(true);
    expect(ensureList(db, 'spooky')).toMatchObject({ created: false, list: { name: 'Spooky' } });
  });

  it('adds and removes members, reporting what changed', () => {
    const a = item('A');
    const b = item('B');
    createList(db, 'Halloween');
    expect(addToList(db, 'halloween', [a, b])).toEqual({ added: [a, b], already: [] });
    expect(addToList(db, 'Halloween', [a])).toEqual({ added: [], already: [a] });
    expect(() => addToList(db, 'Halloween', [9999])).toThrow(/not found/);
    expect(() => addToList(db, 'Nope', [a])).toThrow(/No list/);
    expect(listItemIds(db, 'Halloween')).toEqual([a, b]);
    expect(listsOfItem(db, a)).toEqual(['Halloween']);
    expect(listsByItem(db).get(b)).toEqual(['Halloween']);
    expect(removeFromList(db, 'Halloween', [a, 9999])).toEqual({ removed: [a], notMember: [9999] });
    expect(getList(db, 'Halloween')?.count).toBe(1);
  });

  it('renames, refusing a collision but allowing a case change', () => {
    createList(db, 'Halloween');
    createList(db, 'Winter');
    expect(() => renameList(db, 'Halloween', 'winter')).toThrow(/already/);
    expect(renameList(db, 'Halloween', 'HALLOWEEN').name).toBe('HALLOWEEN');
    expect(renameList(db, 'halloween', 'Spooky season').name).toBe('Spooky season');
    expect(getList(db, 'Halloween')).toBeNull();
  });

  it('deletes a list and says how many memberships went, never the movies', () => {
    const a = item('A');
    createList(db, 'Halloween');
    addToList(db, 'Halloween', [a]);
    expect(deleteList(db, 'Halloween')).toMatchObject({ memberships: 1 });
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM library_items').get()).toEqual({ n: 1 });
    expect(() => deleteList(db, 'Halloween')).toThrow(/No list/);
  });

  it('drops memberships when an item is removed', () => {
    const a = item('A');
    createList(db, 'Halloween');
    addToList(db, 'Halloween', [a]);
    removeItem(db, a);
    expect(getList(db, 'Halloween')?.count).toBe(0);
  });

  it('sets and clears a description', () => {
    createList(db, 'Halloween');
    expect(updateListDescription(db, 'Halloween', 'Spooky').description).toBe('Spooky');
    expect(updateListDescription(db, 'Halloween', null).description).toBeNull();
  });
});

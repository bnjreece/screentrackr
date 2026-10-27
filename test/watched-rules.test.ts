/**
 * The watched-date rules of `set --watched-at` / `--clear-watched-at` and MCP
 * update_movie, on top of the play log (0.4.0). All titles are made up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { getItem, LibraryError, updateItem, updateItemDetailed } from '../src/core/library.js';
import { addViewing, viewingsOf } from '../src/core/viewings.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-rules-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => db.sql.exec('DELETE FROM viewings; DELETE FROM library_items;'));

const item = (status = 'queue') =>
  Number(
    db.sql.prepare("INSERT INTO library_items (source_title, status, match_status, source) VALUES ('Pale Rooftops', ?, 'unmatched', 'paste')").run(status)
      .lastInsertRowid,
  );

describe('set watchedAt', () => {
  it('adds a manual viewing on that date, once', () => {
    const id = item();
    expect(updateItem(db, id, { watchedAt: '2021-03-04' }).watchedAt).toBe('2021-03-04');
    updateItem(db, id, { watchedAt: '2021-03-04' });
    expect(viewingsOf(db, id)).toMatchObject([{ watchedAt: '2021-03-04', source: 'manual', sourceRef: null }]);
  });

  it('refuses a date earlier than a play you have, naming it, and writes nothing', () => {
    const id = item();
    const later = addViewing(db, id, { watchedAt: '2022-05-05', source: 'trakt' });
    const before = getItem(db, id);
    expect(() => updateItem(db, id, { status: 'watched', watchedAt: '2021-01-01' })).toThrow(LibraryError);
    expect(() => updateItem(db, id, { watchedAt: '2021-01-01' })).toThrow(new RegExp(`viewing ${later.id}.*2022-05-05.*history --remove`));
    expect(getItem(db, id)).toEqual(before);
    expect(viewingsOf(db, id)).toHaveLength(1);
  });

  it('accepts the same day as the latest play, and a later one', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2022-05-05T20:00:00Z', source: 'trakt' });
    expect(updateItem(db, id, { watchedAt: '2022-05-05' }).watchedAt).toBe('2022-05-05');
    expect(updateItem(db, id, { watchedAt: '2023-01-01' }).watchedAt).toBe('2023-01-01');
    expect(viewingsOf(db, id)).toHaveLength(3);
  });

  it('refuses a future date and an impossible one', () => {
    const id = item();
    expect(() => updateItem(db, id, { watchedAt: '2999-01-01' })).toThrow(/future/);
    expect(() => updateItem(db, id, { watchedAt: '2021-02-30' })).toThrow(/YYYY-MM-DD/);
  });

  it('clears every viewing and reports how many', () => {
    const id = item('watched');
    addViewing(db, id, { watchedAt: '2019-01-01', source: 'trakt' });
    addViewing(db, id, { watchedAt: null, source: 'trakt' });
    addViewing(db, id, { watchedAt: '2020-01-01', source: 'manual' });
    const res = updateItemDetailed(db, id, { watchedAt: null });
    expect(res.viewingsRemoved).toBe(3);
    expect(res.item.watchedAt).toBeNull();
    expect(viewingsOf(db, id)).toEqual([]);
  });

  it('lets an explicit era in the same patch win over the date era', () => {
    const id = item();
    const it1 = updateItem(db, id, { status: 'watched', watchedEra: 'long-ago', watchedAt: '2021-03-04' });
    expect(it1).toMatchObject({ watchedEra: 'long-ago', watchedAt: '2021-03-04' });
    const it2 = updateItem(db, item(), { status: 'watched', watchedAt: '2021-03-04' });
    expect(it2.watchedEra).toBe('2020s');
  });

  it('bumps updated_at when only the date changes', () => {
    const id = item();
    db.sql.prepare("UPDATE library_items SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    expect(updateItem(db, id, { watchedAt: '2021-03-04' }).updatedAt > '2000-01-01T00:00:00.000Z').toBe(true);
  });
});

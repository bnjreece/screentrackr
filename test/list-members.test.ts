/** core/list-members.ts: adding and removing list members by reference. All titles are made up. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { addFromCatalog, getItem } from '../src/core/library.js';
import { addMembers, ListRefError, removeMembers } from '../src/core/list-members.js';
import { createList, listItemIds } from '../src/core/lists.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let db: Db;
let ids: Record<string, number>;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-list-members-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: FIXTURES });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM list_items; DELETE FROM lists; DELETE FROM viewings; DELETE FROM match_candidates; DELETE FROM library_items;');
  ids = {
    q3: addFromCatalog(db, 'tt9000003').id,
    s4a: addFromCatalog(db, 'tt9000004').id,
    s4b: addFromCatalog(db, 'tt9000004').id,
    g1: addFromCatalog(db, 'tt9000001').id,
  };
  createList(db, 'Halloween');
});

describe('addMembers', () => {
  it('adds by id, title and tconst, and reports what was already there', () => {
    const r = addMembers(db, 'halloween', [`#${ids.q3}`, 'The Glass Harbor (1978)']);
    expect(r).toMatchObject({ list: { name: 'Halloween', count: 2 }, added: [ids.q3, ids.g1], already: [], created: [] });
    const again = addMembers(db, 'Halloween', ['tt9000003']);
    expect(again).toMatchObject({ added: [], already: [ids.q3] });
  });

  it('an ambiguous or unknown ref adds nothing at all, and names every problem', () => {
    let err: unknown;
    try {
      addMembers(db, 'Halloween', ['Quiet Ledger', 'tt9000004', 'Nothing Like It', 'tt9000099']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ListRefError);
    const problems = (err as ListRefError).problems;
    expect(problems.map((p) => [p.ref, p.reason])).toEqual([
      ['tt9000004', 'ambiguous'],
      ['Nothing Like It', 'not-found'],
      ['tt9000099', 'not-in-library'],
    ]);
    expect(problems[0]?.candidates?.map((i) => i.id)).toEqual([ids.s4a, ids.s4b]);
    expect(listItemIds(db, 'Halloween')).toEqual([]);
  });

  it('addMissing adds a catalog movie as a not-owned queue item, once', () => {
    const r = addMembers(db, 'Halloween', ['tt9000030', 'TT9000030'], { addMissing: true });
    expect(r.created).toHaveLength(1);
    const item = getItem(db, r.created[0]!.id)!;
    expect(item).toMatchObject({ tconst: 'tt9000030', status: 'queue', owned: false, matchStatus: 'manual' });
    expect(r.added).toEqual([item.id]);
  });

  it('addMissing still refuses a tconst the catalog lacks, and creates nothing', () => {
    expect(() => addMembers(db, 'Halloween', ['tt9000030', 'tt9999999'], { addMissing: true })).toThrow(ListRefError);
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM library_items WHERE tconst = 'tt9000030'").get()).toEqual({ n: 0 });
  });

  it('a missing list is refused before anything is added', () => {
    expect(() => addMembers(db, 'Nope', ['tt9000030'], { addMissing: true })).toThrow(/No list named "Nope"/);
    expect(db.sql.prepare("SELECT COUNT(*) AS n FROM library_items WHERE tconst = 'tt9000030'").get()).toEqual({ n: 0 });
  });

  it('needs at least one ref', () => {
    expect(() => addMembers(db, 'Halloween', [])).toThrow(/at least one/);
  });
});

describe('removeMembers', () => {
  it('removes by ref and reports non-members; an ambiguous ref removes nothing', () => {
    addMembers(db, 'Halloween', [`#${ids.q3}`, `#${ids.s4a}`]);
    expect(() => removeMembers(db, 'Halloween', [`#${ids.q3}`, 'tt9000004'])).toThrow(ListRefError);
    expect(listItemIds(db, 'Halloween')).toEqual([ids.q3, ids.s4a]);
    const r = removeMembers(db, 'Halloween', [`#${ids.q3}`, `#${ids.g1}`]);
    expect(r).toMatchObject({ list: { count: 1 }, removed: [ids.q3], notMember: [ids.g1] });
  });
});

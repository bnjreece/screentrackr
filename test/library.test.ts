import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import {
  addFromCatalog,
  getItem,
  LibraryError,
  linkItem,
  mapLegacyStatus,
  removeItem,
  resolveRef,
  updateItem,
} from '../src/core/library.js';
import { findCatalogByTitle } from '../src/core/movie.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-library-'));
  db = openDb(join(tmp, 'home'));
  await buildCatalog(db, { cacheDir: FIXTURES });
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items;');
});

/** Insert a raw library row the way an importer would, returning its id. */
function insertRaw(fields: { title: string; tconst?: string | null; matchStatus?: string; director?: string | null }): number {
  const r = db.sql
    .prepare(
      "INSERT INTO library_items (source_title, tconst, match_status, source_director, source) VALUES (?, ?, ?, ?, 'paste')",
    )
    .run(fields.title, fields.tconst ?? null, fields.matchStatus ?? 'unmatched', fields.director ?? null);
  return Number(r.lastInsertRowid);
}

describe('mapLegacyStatus', () => {
  it('maps all 7 legacy values', () => {
    expect(mapLegacyStatus('to-watch')).toEqual({ status: 'queue', watchedEra: null });
    expect(mapLegacyStatus('next')).toEqual({ status: 'priority', watchedEra: null });
    expect(mapLegacyStatus('later')).toEqual({ status: 'someday', watchedEra: null });
    expect(mapLegacyStatus('watched-young')).toEqual({ status: 'watched', watchedEra: 'long-ago' });
    expect(mapLegacyStatus('watched-2010s')).toEqual({ status: 'watched', watchedEra: '2010s' });
    expect(mapLegacyStatus('watched-2020s')).toEqual({ status: 'watched', watchedEra: '2020s' });
    expect(mapLegacyStatus(undefined)).toEqual({ status: 'queue', watchedEra: null });
  });

  it('treats null and blank as missing', () => {
    expect(mapLegacyStatus(null)).toEqual({ status: 'queue', watchedEra: null });
    expect(mapLegacyStatus('  ')).toEqual({ status: 'queue', watchedEra: null });
  });

  it('passes through current statuses and rejects unknown values', () => {
    expect(mapLegacyStatus('priority')).toEqual({ status: 'priority', watchedEra: null });
    expect(mapLegacyStatus('watched')).toEqual({ status: 'watched', watchedEra: null });
    expect(() => mapLegacyStatus('bogus')).toThrow(/Unknown status "bogus"/);
  });
});

describe('getItem', () => {
  it('returns a camelCase item or null', () => {
    const id = insertRaw({ title: 'Some Home Video' });
    const item = getItem(db, id);
    expect(item).toMatchObject({
      id,
      tconst: null,
      sourceTitle: 'Some Home Video',
      owned: true,
      status: 'queue',
      matchStatus: 'unmatched',
      source: 'paste',
      myRating: null,
    });
    expect(getItem(db, 999999)).toBeNull();
  });
});

describe('addFromCatalog', () => {
  it('adds a catalog movie with source fields from the catalog', () => {
    const item = addFromCatalog(db, 'tt9000005', { status: 'priority' });
    expect(item).toMatchObject({
      tconst: 'tt9000005',
      sourceTitle: 'Salt & Signal',
      sourceYear: 2004,
      sourceRuntimeMin: 101,
      sourceDirector: 'Orrin Vale, Mira Calloway',
      sourceGenre: 'Adventure,Comedy',
      status: 'priority',
      matchStatus: 'manual',
      source: 'manual',
      owned: true,
    });
    expect(getItem(db, item.id)).toEqual(item);
  });

  it('defaults to queue', () => {
    expect(addFromCatalog(db, 'tt9000009').status).toBe('queue');
  });

  it('rejects a tconst that is not in the catalog', () => {
    expect(() => addFromCatalog(db, 'tt9999999')).toThrow(LibraryError);
    expect(() => addFromCatalog(db, 'tt9999999')).toThrow('Movie tt9999999 is not in the catalog');
    expect(() => addFromCatalog(db, 'not-a-tconst')).toThrow(/Invalid IMDb id/);
  });
});

describe('resolveRef', () => {
  it('resolves an id', () => {
    const id = insertRaw({ title: 'Night Ferry' });
    const r = resolveRef(db, String(id));
    expect(r.kind).toBe('one');
    if (r.kind === 'one') expect(r.item.id).toBe(id);
    expect(resolveRef(db, `#${id}`).kind).toBe('one');
    expect(resolveRef(db, '#424242').kind).toBe('none');
  });

  it('resolves a tconst, returning many for two editions', () => {
    const a = addFromCatalog(db, 'tt9000009');
    expect(resolveRef(db, 'tt9000009')).toEqual({ kind: 'one', item: a });
    const b = addFromCatalog(db, 'tt9000009');
    const r = resolveRef(db, 'tt9000009');
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(resolveRef(db, 'tt9000010').kind).toBe('none');
  });

  it('returns many for a title owned twice (two editions)', () => {
    const a = insertRaw({ title: 'Paper Engine' });
    const b = insertRaw({ title: "Paper Engine (Director's Cut)" });
    insertRaw({ title: 'Night Ferry' });
    const r = resolveRef(db, 'paper engine');
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.items.map((i) => i.id)).toEqual([a, b]);
  });

  it('matches titles by normalized compare, including the catalog title of a linked item', () => {
    const id = insertRaw({ title: 'Phare Noir', tconst: 'tt9000011', matchStatus: 'matched' });
    const byCatalog = resolveRef(db, 'The Black Lighthouse');
    expect(byCatalog.kind).toBe('one');
    if (byCatalog.kind === 'one') expect(byCatalog.item.id).toBe(id);
    const bySource = resolveRef(db, '  PHARE NOIR ');
    expect(bySource.kind).toBe('one');
    expect(resolveRef(db, 'No Such Movie').kind).toBe('none');
    expect(resolveRef(db, '   ').kind).toBe('none');
  });

  it('an unmatched or ambiguous item is never found by its stored tconst or that movie\'s catalog title', () => {
    const unmatched = insertRaw({ title: 'Glasshaven Quay', tconst: 'tt9000011', matchStatus: 'unmatched' });
    const ambiguous = insertRaw({ title: 'Glasshaven Pier', tconst: 'tt9000011', matchStatus: 'ambiguous' });
    expect(resolveRef(db, 'tt9000011').kind).toBe('none');
    expect(resolveRef(db, 'The Black Lighthouse').kind).toBe('none');
    expect(resolveRef(db, 'Glasshaven Quay')).toMatchObject({ kind: 'one', item: { id: unmatched } });
    expect(resolveRef(db, `#${ambiguous}`)).toMatchObject({ kind: 'one', item: { id: ambiguous } });
    const linked = insertRaw({ title: 'Phare Noir', tconst: 'tt9000011', matchStatus: 'manual' });
    expect(resolveRef(db, 'tt9000011')).toMatchObject({ kind: 'one', item: { id: linked } });
    expect(resolveRef(db, 'The Black Lighthouse')).toMatchObject({ kind: 'one', item: { id: linked } });
  });

  it('does not silently pick an id when a numeric title also matches', () => {
    const first = insertRaw({ title: 'Placeholder' });
    const numeric = insertRaw({ title: String(first) });
    const r = resolveRef(db, String(first));
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.items.map((i) => i.id)).toEqual([first, numeric]);
    // The explicit #id form always means an id.
    const explicit = resolveRef(db, `#${first}`);
    expect(explicit.kind === 'one' && explicit.item.id).toBe(first);
  });

  it('falls back to a title when a numeric ref is not an id', () => {
    const id = insertRaw({ title: '2047' });
    const r = resolveRef(db, '2047');
    expect(r.kind === 'one' && r.item.id).toBe(id);
  });
});

describe('updateItem', () => {
  it('rejects ratings outside 1..10 and non-integers; null clears', () => {
    const { id } = addFromCatalog(db, 'tt9000009');
    expect(() => updateItem(db, id, { myRating: 0 })).toThrow(LibraryError);
    expect(() => updateItem(db, id, { myRating: 11 })).toThrow(/Rating must be a whole number from 1 to 10/);
    expect(() => updateItem(db, id, { myRating: 7.5 })).toThrow(/Rating must be a whole number/);
    expect(updateItem(db, id, { myRating: 8 }).myRating).toBe(8);
    expect(updateItem(db, id, { myRating: null }).myRating).toBeNull();
  });

  it('changes updated_at', () => {
    const { id } = addFromCatalog(db, 'tt9000009');
    db.sql.prepare("UPDATE library_items SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    const before = getItem(db, id)?.updatedAt;
    const after = updateItem(db, id, { status: 'watched' });
    expect(after.status).toBe('watched');
    expect(after.updatedAt).not.toBe(before);
    expect(after.updatedAt > '2000-01-01T00:00:00.000Z').toBe(true);
  });

  it('sets watched era, watched_at and notes, and leaves unpatched fields alone', () => {
    const { id } = addFromCatalog(db, 'tt9000009');
    updateItem(db, id, { myRating: 9 });
    const it1 = updateItem(db, id, { status: 'watched', watchedEra: '2010s', watchedAt: '2026-10-01', notes: 'great' });
    expect(it1).toMatchObject({ status: 'watched', watchedEra: '2010s', watchedAt: '2026-10-01', notes: 'great', myRating: 9 });
  });

  it('clears the watched era when the status moves off watched', () => {
    const { id } = addFromCatalog(db, 'tt9000009');
    updateItem(db, id, { status: 'watched', watchedEra: '2020s' });
    expect(updateItem(db, id, { status: 'queue' }).watchedEra).toBeNull();
  });

  it('rejects invalid status, era, era without watched, and bad dates', () => {
    const { id } = addFromCatalog(db, 'tt9000009');
    expect(() => updateItem(db, id, { status: 'bogus' as never })).toThrow(/Invalid status/);
    expect(() => updateItem(db, id, { status: 'watched', watchedEra: '1990s' as never })).toThrow(/Invalid watched era/);
    expect(() => updateItem(db, id, { watchedEra: '2010s' })).toThrow(/only applies to watched/);
    expect(() => updateItem(db, id, { watchedAt: 'yesterday' })).toThrow(/YYYY-MM-DD/);
    expect(updateItem(db, id, { watchedAt: '2026-10-23T20:00:00Z' }).watchedAt).toBe('2026-10-23T20:00:00Z');
  });

  it('throws for a missing id', () => {
    expect(() => updateItem(db, 4242, { status: 'watched' })).toThrow('Item 4242 not found');
  });
});

describe('addFromCatalog owned option', () => {
  it('adds owned by default and not owned when asked', () => {
    expect(addFromCatalog(db, 'tt9000009').owned).toBe(true);
    expect(addFromCatalog(db, 'tt9000010', { owned: false })).toMatchObject({ owned: false, status: 'queue' });
  });
});

describe('removeItem', () => {
  it('removes an item and its match candidates', () => {
    const id = insertRaw({ title: 'The Glass Harbor', matchStatus: 'ambiguous' });
    db.sql.prepare('INSERT INTO match_candidates (item_id, tconst, score) VALUES (?, ?, 60)').run(id, 'tt9000001');
    removeItem(db, id);
    expect(getItem(db, id)).toBeNull();
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM match_candidates WHERE item_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('throws Item <id> not found on a missing id', () => {
    expect(() => removeItem(db, 777)).toThrow(LibraryError);
    expect(() => removeItem(db, 777)).toThrow('Item 777 not found');
  });
});

describe('linkItem', () => {
  it('sets the tconst and match_status manual, clearing candidates', () => {
    const id = insertRaw({ title: 'The Glass Harbor', matchStatus: 'ambiguous' });
    db.sql.prepare('INSERT INTO match_candidates (item_id, tconst, score) VALUES (?, ?, 60)').run(id, 'tt9000001');
    const item = linkItem(db, id, 'tt9000002');
    expect(item.tconst).toBe('tt9000002');
    expect(item.matchStatus).toBe('manual');
    expect(db.sql.prepare('SELECT COUNT(*) AS n FROM match_candidates WHERE item_id = ?').get(id)).toEqual({ n: 0 });
  });

  it('rejects a missing item or an unknown tconst', () => {
    const id = insertRaw({ title: 'Lost Reel' });
    expect(() => linkItem(db, 999, 'tt9000015')).toThrow('Item 999 not found');
    expect(() => linkItem(db, id, 'tt9999999')).toThrow('Movie tt9999999 is not in the catalog');
    expect(getItem(db, id)?.matchStatus).toBe('unmatched');
  });
});

describe('a year in a title reference', () => {
  const setYear = (id: number, year: number | null) => db.sql.prepare('UPDATE library_items SET source_year = ? WHERE id = ?').run(year, id);

  it('never resolves to an item whose year conflicts (the reviewer reproduction)', () => {
    const original = addFromCatalog(db, 'tt9000001');
    expect(resolveRef(db, 'The Glass Harbor (2009)')).toEqual({ kind: 'none' });
    expect(resolveRef(db, 'The Glass Harbor (2009) (4K)')).toEqual({ kind: 'none' });
    expect(resolveRef(db, 'The Glass Harbor (1978)')).toMatchObject({ kind: 'one', item: { id: original.id } });
    expect(resolveRef(db, 'The Glass Harbor (1979) (Special Edition)')).toMatchObject({ kind: 'one', item: { id: original.id } });
    expect(resolveRef(db, 'The Glass Harbor')).toMatchObject({ kind: 'one', item: { id: original.id } });
  });

  it('uses the catalog year of a linked item whose source has none', () => {
    const matched = insertRaw({ title: 'The Glass Harbor', tconst: 'tt9000001', matchStatus: 'matched' });
    expect(resolveRef(db, 'The Glass Harbor (2009)')).toEqual({ kind: 'none' });
    expect(resolveRef(db, 'The Glass Harbor (1978)')).toMatchObject({ kind: 'one', item: { id: matched } });
    // An unresolved item's stored hint is not its year: with no year of its own it stays a candidate.
    const hinted = insertRaw({ title: 'The Glass Harbor', tconst: 'tt9000001', matchStatus: 'unmatched' });
    expect(resolveRef(db, 'The Glass Harbor (2009)')).toMatchObject({ kind: 'one', item: { id: hinted } });
  });

  it('picks the edition of the named year out of a remake pair', () => {
    const a = insertRaw({ title: 'The Glass Harbor' });
    const b = insertRaw({ title: 'The Glass Harbor (2009)' });
    setYear(a, 1978);
    expect(resolveRef(db, 'The Glass Harbor')).toMatchObject({ kind: 'many' });
    expect(resolveRef(db, 'The Glass Harbor (1978)')).toMatchObject({ kind: 'one', item: { id: a } });
    expect(resolveRef(db, 'The Glass Harbor (2009)')).toMatchObject({ kind: 'one', item: { id: b } });
  });
});

describe('findCatalogByTitle with a year in the title', () => {
  it('never returns a movie whose year conflicts with the title year', () => {
    expect(findCatalogByTitle(db, 'Night Ferry (2026)')).toEqual([]);
    expect(findCatalogByTitle(db, 'Night Ferry (2026) (4K)')).toEqual([]);
    expect(findCatalogByTitle(db, 'Night Ferry (2002)').map((m) => m.tconst)).toEqual(['tt9000010']);
    expect(findCatalogByTitle(db, 'Night Ferry (2002) (4K)').map((m) => m.tconst)).toEqual(['tt9000010']);
    expect(findCatalogByTitle(db, 'The Glass Harbor (2009)').map((m) => m.tconst)).toEqual(['tt9000002']);
  });

  it('a title year and a conflicting year option find nothing', () => {
    expect(findCatalogByTitle(db, 'Night Ferry (2002)', { year: 2026 })).toEqual([]);
    expect(findCatalogByTitle(db, 'Night Ferry (2002)', { year: 2002 }).map((m) => m.tconst)).toEqual(['tt9000010']);
  });
});

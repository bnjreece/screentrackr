/**
 * core/viewings.ts: the play log and the watched-date cache it keeps on
 * library_items. All titles are made up. No catalog is built.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { getItem, LibraryError } from '../src/core/library.js';
import {
  addViewing,
  calendarDate,
  checkWatchedCache,
  countPlays,
  deriveRewatch,
  groupSameNight,
  isFutureDate,
  listViewings,
  planViewingSync,
  removeAllViewings,
  removeViewing,
  viewingsByItem,
  viewingsOf,
  type Viewing,
} from '../src/core/viewings.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-viewings-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  db.sql.exec('DELETE FROM viewings; DELETE FROM library_items;');
});

function item(title = 'Pale Rooftops', status = 'watched', era: string | null = null): number {
  const r = db.sql
    .prepare("INSERT INTO library_items (source_title, status, watched_era, match_status, source) VALUES (?, ?, ?, 'unmatched', 'paste')")
    .run(title, status, era);
  return Number(r.lastInsertRowid);
}

const cache = (id: number) =>
  db.sql.prepare('SELECT watched_at AS at, watched_at_source AS src, watched_era AS era FROM library_items WHERE id = ?').get(id) as {
    at: string | null;
    src: string | null;
    era: string | null;
  };

describe('helpers', () => {
  it('takes the calendar date as the first ten characters, with no time zone conversion', () => {
    expect(calendarDate('2019-04-02T23:30:00-07:00')).toBe('2019-04-02');
    expect(calendarDate('2019-04-02')).toBe('2019-04-02');
  });

  it('calls a date future only when it is more than a day ahead', () => {
    const now = new Date('2026-10-27T12:00:00Z');
    expect(isFutureDate('2026-10-28', now)).toBe(false);
    expect(isFutureDate('2026-10-29', now)).toBe(true);
    expect(isFutureDate('2026-10-28T23:00:00Z', now)).toBe(false);
    expect(isFutureDate('2026-10-29T13:00:00Z', now)).toBe(true);
  });
});

describe('addViewing and the cache', () => {
  it('sets watched_at to the latest calendar date and its source', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2019-04-02', source: 'trakt' });
    expect(cache(id)).toMatchObject({ at: '2019-04-02', src: 'trakt' });
    addViewing(db, id, { watchedAt: '2018-01-01', source: 'letterboxd' });
    expect(cache(id)).toMatchObject({ at: '2019-04-02', src: 'trakt' });
    addViewing(db, id, { watchedAt: '2020-03-03T21:00:00Z', source: 'plex' });
    expect(cache(id)).toMatchObject({ at: '2020-03-03T21:00:00Z', src: 'plex' });
  });

  it('records a manual viewing as a null source on the cache, as 0.3.0 did for dates you set', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2019-04-02', source: 'manual' });
    expect(cache(id)).toMatchObject({ at: '2019-04-02', src: null });
  });

  it('breaks a same-day tie by the most recently added viewing', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2019-04-02T08:00:00Z', source: 'trakt' });
    addViewing(db, id, { watchedAt: '2019-04-02', source: 'letterboxd' });
    expect(cache(id)).toMatchObject({ at: '2019-04-02', src: 'letterboxd' });
  });

  it('never sets watched_at from a dateless play', () => {
    const id = item();
    addViewing(db, id, { watchedAt: null, source: 'trakt' });
    expect(cache(id)).toMatchObject({ at: null, src: null });
    expect(viewingsOf(db, id)).toHaveLength(1);
  });

  it('validates every field', () => {
    const id = item();
    expect(() => addViewing(db, id, { watchedAt: 'yesterday', source: 'manual' })).toThrow(LibraryError);
    expect(() => addViewing(db, id, { watchedAt: '2019-02-30', source: 'manual' })).toThrow(LibraryError);
    expect(() => addViewing(db, id, { watchedAt: '2019-01-01', source: 'nope' as never })).toThrow(LibraryError);
    expect(() => addViewing(db, id, { watchedAt: '2019-01-01', source: 'manual', rating: 11 })).toThrow(LibraryError);
    expect(() => addViewing(db, 9999, { watchedAt: '2019-01-01', source: 'manual' })).toThrow(/not found/);
  });

  it('keeps an int64 ref as a string', () => {
    const id = item();
    const v = addViewing(db, id, { watchedAt: '2019-01-01', source: 'trakt', sourceRef: '9007199254740993' });
    expect(v.sourceRef).toBe('9007199254740993');
    expect(viewingsOf(db, id)[0]?.sourceRef).toBe('9007199254740993');
  });
});

describe('removing viewings', () => {
  it('removes one by id and moves the cache back', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2019-04-02', source: 'trakt' });
    const later = addViewing(db, id, { watchedAt: '2021-01-01', source: 'manual' });
    expect(removeViewing(db, later.id).id).toBe(later.id);
    expect(cache(id)).toMatchObject({ at: '2019-04-02', src: 'trakt' });
    expect(() => removeViewing(db, later.id)).toThrow(/not found/);
  });

  it('removes all of an item and reports the count', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2019-04-02', source: 'trakt' });
    addViewing(db, id, { watchedAt: null, source: 'trakt' });
    expect(removeAllViewings(db, id)).toBe(2);
    expect(cache(id)).toMatchObject({ at: null, src: null });
  });
});

describe('the watched era follows the date only when it matched', () => {
  it('derives the era of a watched item that had none', () => {
    const id = item('A', 'watched', null);
    addViewing(db, id, { watchedAt: '2015-05-05', source: 'manual' });
    expect(cache(id).era).toBe('2010s');
  });

  it('moves an era that was the old date era', () => {
    const id = item('A', 'watched', null);
    addViewing(db, id, { watchedAt: '2015-05-05', source: 'manual' });
    addViewing(db, id, { watchedAt: '2022-01-01', source: 'manual' });
    expect(cache(id).era).toBe('2020s');
    removeAllViewings(db, id);
    expect(cache(id).era).toBeNull();
  });

  it('keeps a hand-set era that disagrees with the old date', () => {
    const id = item('A', 'watched', 'long-ago');
    addViewing(db, id, { watchedAt: '2015-05-05', source: 'manual' });
    expect(cache(id).era).toBe('long-ago');
    addViewing(db, id, { watchedAt: '2022-01-01', source: 'manual' });
    expect(cache(id).era).toBe('long-ago');
  });

  it('never sets an era on an item that is not watched', () => {
    const id = item('A', 'queue', null);
    addViewing(db, id, { watchedAt: '2015-05-05', source: 'manual' });
    expect(cache(id)).toMatchObject({ at: '2015-05-05', era: null });
  });

  it('holds for random viewing sets (property style)', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const sources = ['trakt', 'letterboxd', 'plex', 'manual'] as const;
    for (let round = 0; round < 40; round++) {
      db.sql.exec('DELETE FROM viewings; DELETE FROM library_items;');
      const id = item('R', 'watched', null);
      const n = 1 + rand(6);
      for (let k = 0; k < n; k++) {
        const dated = rand(5) !== 0;
        const day = `20${String(rand(25)).padStart(2, '0')}-0${1 + rand(9)}-1${rand(9)}`;
        try {
          addViewing(db, id, { watchedAt: dated ? day : null, source: sources[rand(4)] as (typeof sources)[number] });
        } catch {
          // A same-day duplicate of one source is refused; skip it.
        }
      }
      const vs = viewingsOf(db, id);
      const dates = vs.map((v) => v.watchedAt).filter((d): d is string => d !== null).map(calendarDate);
      const max = dates.length ? dates.sort().at(-1) : null;
      expect(cache(id).at === null ? null : calendarDate(cache(id).at as string)).toBe(max ?? null);
      expect(checkWatchedCache(db)).toEqual([]);
    }
  });
});

describe('listing', () => {
  it('lists newest first with filters', () => {
    const a = item('A');
    const b = item('B');
    addViewing(db, a, { watchedAt: '2019-04-02', source: 'trakt' });
    addViewing(db, a, { watchedAt: '2021-01-01', source: 'manual' });
    addViewing(db, b, { watchedAt: '2021-06-01', source: 'letterboxd' });
    addViewing(db, b, { watchedAt: null, source: 'trakt' });
    expect(listViewings(db).map((v) => v.watchedAt)).toEqual(['2021-06-01', '2021-01-01', '2019-04-02', null]);
    expect(listViewings(db, { itemId: a }).map((v) => v.watchedAt)).toEqual(['2021-01-01', '2019-04-02']);
    expect(listViewings(db, { year: 2021 }).map((v) => v.itemId)).toEqual([b, a]);
    expect(listViewings(db, { from: '2020-01-01', to: '2021-03-01' }).map((v) => v.watchedAt)).toEqual(['2021-01-01']);
    expect(listViewings(db, { source: 'trakt' }).map((v) => v.watchedAt)).toEqual(['2019-04-02', null]);
    expect(listViewings(db, { limit: 1 })).toHaveLength(1);
    expect(viewingsByItem(db, [a]).get(a)).toHaveLength(2);
  });
});

const v = (id: number, watchedAt: string | null, source: Viewing['source'], extra: Partial<Viewing> = {}): Viewing => ({
  id,
  itemId: 1,
  watchedAt,
  rewatch: null,
  rating: null,
  source,
  sourceRef: null,
  addedAt: `2026-01-01T00:00:0${id}.000Z`,
  ...extra,
});

describe('cross-source collapse', () => {
  it('counts one play for the same night from two sources, and the largest per-source dateless count', () => {
    const vs = [
      v(1, '2020-01-01', 'letterboxd'),
      v(2, '2020-01-01T22:00:00Z', 'trakt'),
      v(3, '2020-02-01', 'trakt'),
      v(4, null, 'trakt'),
      v(5, null, 'trakt'),
      v(6, null, 'plex'),
    ];
    expect(countPlays(vs)).toBe(4);
    const nights = groupSameNight(vs);
    expect(nights.map((n) => [n.date, n.sources])).toEqual([
      ['2020-02-01', ['trakt']],
      ['2020-01-01', ['letterboxd', 'trakt']],
      [null, ['plex', 'trakt']],
      [null, ['trakt']],
    ]);
  });

  it('derives rewatch from the source flag, else from an earlier play', () => {
    const vs = [v(1, '2020-01-01', 'letterboxd'), v(2, '2020-01-01', 'trakt'), v(3, '2021-01-01', 'trakt'), v(4, '2022-01-01', 'letterboxd', { rewatch: false }), v(5, null, 'trakt')];
    const r = deriveRewatch(vs);
    expect([1, 2, 3, 4, 5].map((id) => r.get(id))).toEqual([false, false, true, false, false]);
  });
});

describe('planViewingSync', () => {
  const stored = [
    v(1, '2019-04-02', 'letterboxd'),
    v(2, '2020-05-05', 'letterboxd', { sourceRef: 'https://boxd.it/aaa' }),
    v(3, '2021-01-01', 'manual'),
    v(4, null, 'trakt'),
  ];

  it('adds what is new and leaves the rest when not complete', () => {
    const p = planViewingSync(stored, [{ watchedAt: '2022-02-02', source: 'letterboxd', sourceRef: 'https://boxd.it/bbb' }], new Set());
    expect(p.inserts).toHaveLength(1);
    expect(p.updates).toEqual([]);
    expect(p.deletes).toEqual([]);
  });

  it('upgrades a stored ref-less play of the same date, and deletes what a complete set leaves out', () => {
    const p = planViewingSync(
      stored,
      [
        { watchedAt: '2019-04-02', source: 'letterboxd', sourceRef: 'https://boxd.it/zzz', rewatch: true, rating: 8 },
        { watchedAt: '2023-03-03', source: 'letterboxd', sourceRef: 'https://boxd.it/ccc' },
      ],
      new Set(['letterboxd']),
    );
    expect(p.updates).toEqual([{ id: 1, sourceRef: 'https://boxd.it/zzz', rewatch: true, rating: 8 }]);
    expect(p.inserts.map((i) => i.watchedAt)).toEqual(['2023-03-03']);
    // The manual play and the other source's play are never touched.
    expect(p.deletes).toEqual([2]);
  });

  it('is empty for a re-import of the same set', () => {
    const p = planViewingSync(stored, [{ watchedAt: '2020-05-05', source: 'letterboxd', sourceRef: 'https://boxd.it/aaa' }, { watchedAt: '2019-04-02', source: 'letterboxd' }], new Set(['letterboxd']));
    expect(p).toEqual({ inserts: [], updates: [], deletes: [] });
  });

  it('treats ref-less dated plays of a source as one per day, and dateless ones by count', () => {
    const p = planViewingSync(
      stored,
      [
        { watchedAt: '2019-04-02T10:00:00Z', source: 'letterboxd' },
        { watchedAt: '2024-04-04', source: 'jellyfin' },
        { watchedAt: '2024-04-04', source: 'jellyfin' },
        { watchedAt: null, source: 'trakt' },
        { watchedAt: null, source: 'trakt' },
      ],
      new Set(),
    );
    expect(p.inserts.map((i) => [i.source, i.watchedAt])).toEqual([
      ['jellyfin', '2024-04-04'],
      ['trakt', null],
    ]);
  });

  it('takes the incoming date-time when it upgrades a ref-less play of that day, so a repeat is a no-op', () => {
    const stored = [v(1, '2020-01-01', 'letterboxd')];
    const incoming = [{ watchedAt: '2020-01-01T20:00:00Z', source: 'letterboxd' as const, sourceRef: 'A' }];
    expect(planViewingSync(stored, incoming, new Set()).updates).toEqual([{ id: 1, sourceRef: 'A', watchedAt: '2020-01-01T20:00:00Z' }]);
    const after = [v(1, '2020-01-01T20:00:00Z', 'letterboxd', { sourceRef: 'A' })];
    expect(planViewingSync(after, incoming, new Set())).toEqual({ inserts: [], updates: [], deletes: [] });
  });

  it('matches dateless plays to the stored ones they equal before any other', () => {
    const stored = [v(1, null, 'trakt'), v(2, null, 'trakt', { rating: 7, rewatch: true })];
    // Oldest first, as an export lists them; the stored order is newest first.
    const incoming = [
      { watchedAt: null, source: 'trakt' as const, rating: 7, rewatch: true },
      { watchedAt: null, source: 'trakt' as const },
    ];
    expect(planViewingSync(stored, incoming, new Set())).toEqual({ inserts: [], updates: [], deletes: [] });
    expect(planViewingSync(stored, incoming, new Set(['trakt']), { exact: true })).toEqual({ inserts: [], updates: [], deletes: [] });
  });

  it('keeps dateless plays stable when an import gives only some fields', () => {
    let stored: Viewing[] = [v(1, null, 'trakt', { rewatch: false, rating: 5 }), v(2, null, 'trakt', { rating: 7 })];
    const incoming = [true, false, true].map((rewatch) => ({ watchedAt: null, source: 'trakt' as const, rewatch }));
    const first = planViewingSync(stored, incoming, new Set());
    // Apply the plan by hand, then the same import again must change nothing.
    stored = stored.map((s) => ({ ...s, ...Object.fromEntries(Object.entries(first.updates.find((u) => u.id === s.id) ?? {}).filter(([k]) => k !== 'id')) }));
    first.inserts.forEach((ins, k) => stored.push(v(10 + k, null, 'trakt', { rewatch: ins.rewatch ?? null, rating: ins.rating ?? null })));
    expect(planViewingSync(stored, incoming, new Set())).toEqual({ inserts: [], updates: [], deletes: [] });
  });

  it('folds a ref-less play into a play with a ref that day without changing it', () => {
    const stored = [v(1, '2020-05-05', 'letterboxd', { sourceRef: 'a', rating: 7 }), v(2, '2020-05-05', 'letterboxd', { sourceRef: 'b', rating: 9 })];
    expect(planViewingSync(stored, [{ watchedAt: '2020-05-05', source: 'letterboxd', rating: 9 }], new Set())).toEqual({ inserts: [], updates: [], deletes: [] });
  });

  it('plans nothing when a stored set comes back in any order (property style)', () => {
    let seed = 11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const sources = ['trakt', 'letterboxd', 'manual'] as const;
    for (let round = 0; round < 300; round++) {
      const stored: Viewing[] = [];
      const taken = new Set<string>();
      for (let k = 0, n = 1 + rand(7); k < n; k++) {
        const source = sources[rand(3)] as (typeof sources)[number];
        const day = rand(4) === 0 ? null : `2020-0${1 + rand(3)}-0${1 + rand(3)}`;
        const ref = rand(2) === 0 ? `r${round}-${k}` : null;
        if (ref === null && day !== null) {
          if (taken.has(`${source}|${day}`)) continue;
          taken.add(`${source}|${day}`);
        }
        stored.push(v(100 + k, day, source, { sourceRef: ref, rating: rand(3) === 0 ? 1 + rand(10) : null, rewatch: rand(3) === 0 ? rand(2) === 0 : null }));
      }
      const incoming = [...stored]
        .sort(() => rand(3) - 1)
        .map((x) => ({ watchedAt: x.watchedAt, source: x.source, sourceRef: x.sourceRef, ...(x.rating !== null ? { rating: x.rating } : {}), ...(x.rewatch !== null ? { rewatch: x.rewatch } : {}) }));
      for (const exact of [false, true]) {
        expect(planViewingSync(stored, incoming, new Set(sources), { exact }), `round ${round} exact ${exact}`).toEqual({ inserts: [], updates: [], deletes: [] });
      }
    }
  });

  it('converges: the same import planned again after its plan is applied changes nothing (property style)', () => {
    let seed = 29;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pick = <T,>(xs: readonly T[]) => xs[rand(xs.length)] as T;
    const days = [null, null, '2020-01-01', '2020-01-02', '2020-01-02T21:00:00Z', '2020-01-03'];
    const apply = (stored: Viewing[], plan: ReturnType<typeof planViewingSync>, next: { id: number }) => {
      let out = stored.filter((x) => !plan.deletes.includes(x.id));
      out = out.map((x) => {
        const u = plan.updates.find((y) => y.id === x.id);
        if (!u) return x;
        const rest: Partial<Viewing> = { ...u };
        delete rest.id;
        return { ...x, ...rest } as Viewing;
      });
      for (const ins of plan.inserts) out.push(v(next.id++, ins.watchedAt, ins.source, { sourceRef: ins.sourceRef ?? null, rewatch: ins.rewatch ?? null, rating: ins.rating ?? null }));
      return out;
    };
    for (let round = 0; round < 400; round++) {
      const next = { id: 1000 };
      const exact = rand(2) === 0;
      const complete = new Set(rand(2) === 0 ? ['trakt'] : []);
      const incoming = Array.from({ length: 1 + rand(5) }, (_, k) => ({
        watchedAt: pick(days),
        source: pick(['trakt', 'letterboxd'] as const),
        sourceRef: rand(3) === 0 ? `r${k % 3}` : null,
        ...(rand(2) === 0 ? { rewatch: rand(2) === 0 } : {}),
        ...(rand(2) === 0 ? { rating: 1 + rand(3) } : {}),
      }));
      // A stored set the planner itself could have made, from an earlier import.
      const earlier = Array.from({ length: rand(5) }, () => ({ watchedAt: pick(days), source: pick(['trakt', 'letterboxd'] as const), ...(rand(2) === 0 ? { rating: 1 + rand(3) } : {}) }));
      let stored = apply([], planViewingSync([], earlier, new Set()), next);
      stored = apply(stored, planViewingSync(stored, incoming, complete, { exact }), next);
      expect(planViewingSync(stored, incoming, complete, { exact }), `round ${round}`).toEqual({ inserts: [], updates: [], deletes: [] });
    }
  });

  it('lets a play with a ref become dateless', () => {
    const p = planViewingSync([v(10, '2020-01-01', 'trakt', { sourceRef: 'R' })], [{ watchedAt: null, source: 'trakt', sourceRef: 'R' }], new Set(['trakt']));
    expect(p).toEqual({ inserts: [], updates: [{ id: 10, watchedAt: null }], deletes: [] });
  });

  it('counts the day a play moves to, not the day it left', () => {
    const p = planViewingSync(
      [v(10, '2020-01-01', 'trakt', { sourceRef: 'R' })],
      [
        { watchedAt: '2021-01-01', source: 'trakt', sourceRef: 'R' },
        { watchedAt: '2020-01-01', source: 'trakt' },
      ],
      new Set(['trakt']),
    );
    expect(p.updates).toEqual([{ id: 10, watchedAt: '2021-01-01' }]);
    expect(p.inserts.map((i) => [i.watchedAt, i.sourceRef])).toEqual([['2020-01-01', null]]);
    expect(p.deletes).toEqual([]);
  });

  it('in exact mode keeps a play with a ref and one without on the same day apart', () => {
    const incoming = [
      { watchedAt: '2020-01-01', source: 'manual' as const, sourceRef: 'manual:00aa', rating: 5 },
      { watchedAt: '2020-01-01', source: 'manual' as const, rating: 7 },
    ];
    expect(planViewingSync([], incoming, new Set(), { exact: true }).inserts).toHaveLength(2);
    // Not exact: one play per source and day without a ref.
    expect(planViewingSync([], incoming, new Set()).inserts).toHaveLength(1);
    // Exact mode never upgrades a stored ref-less play with an incoming ref.
    const p = planViewingSync([v(3, '2020-01-01', 'manual')], [incoming[0] as (typeof incoming)[number]], new Set(), { exact: true });
    expect(p.updates).toEqual([]);
    expect(p.inserts).toHaveLength(1);
  });

  it('never deletes manual plays even when manual is named complete', () => {
    const p = planViewingSync(stored, [], new Set(['manual']));
    expect(p.deletes).toEqual([]);
  });
});

it('getItem reflects the cache', () => {
  const id = item();
  addViewing(db, id, { watchedAt: '2019-04-02', source: 'trakt' });
  expect(getItem(db, id)?.watchedAt).toBe('2019-04-02');
});

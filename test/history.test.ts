/**
 * The history core (core/history.ts) behind `log`, `history` and the MCP
 * history tools. All titles are made up; no catalog is built.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { historyPlays, localToday, logViewing, removePlay } from '../src/core/history.js';
import { getItem, LibraryError } from '../src/core/library.js';
import { addViewing, checkWatchedCache, viewingsOf } from '../src/core/viewings.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-history-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => db.sql.exec('DELETE FROM viewings; DELETE FROM library_items;'));

const item = (title = 'Pale Rooftops', opts: { status?: string; tconst?: string; era?: string } = {}) =>
  Number(
    db.sql
      .prepare("INSERT INTO library_items (source_title, source_year, status, watched_era, tconst, match_status, source) VALUES (?, 1994, ?, ?, ?, ?, 'paste')")
      .run(title, opts.status ?? 'queue', opts.era ?? null, opts.tconst ?? null, opts.tconst ? 'matched' : 'unmatched').lastInsertRowid,
  );

const NOW = new Date(2026, 5, 15, 12, 0, 0);

describe('logViewing', () => {
  it('records a manual play today, sets watched and the era, and caches the date', () => {
    const id = item();
    const res = logViewing(db, id, { now: NOW });
    expect(res.viewing).toMatchObject({ watchedAt: '2026-06-15', source: 'manual', rewatch: null, rating: null });
    expect(res.viewing.sourceRef).toMatch(/^manual:[0-9a-f]{16}$/);
    expect(res.item).toMatchObject({ status: 'watched', watchedAt: '2026-06-15', watchedEra: '2020s' });
    expect(res.plays).toBe(1);
    expect(checkWatchedCache(db)).toEqual([]);
  });

  it('keeps two plays logged on one day as two', () => {
    const id = item();
    logViewing(db, id, { date: '2024-01-01', now: NOW });
    const second = logViewing(db, id, { date: '2024-01-01', now: NOW });
    expect(viewingsOf(db, id)).toHaveLength(2);
    // Read paths still collapse one night of one film into one play.
    expect(second.plays).toBe(1);
  });

  it('with a rating sets the play rating and the item rating; --rewatch is the flag', () => {
    const id = item();
    const res = logViewing(db, id, { date: '2023-05-05', rating: 8, rewatch: true, now: NOW });
    expect(res.viewing).toMatchObject({ rating: 8, rewatch: true });
    expect(res.item.myRating).toBe(8);
  });

  it('keepStatus leaves the status (and so the era) alone', () => {
    const id = item('Pale Rooftops', { status: 'priority' });
    const res = logViewing(db, id, { date: '2023-05-05', keepStatus: true, now: NOW });
    expect(res.item).toMatchObject({ status: 'priority', watchedEra: null, watchedAt: '2023-05-05' });
  });

  it('keeps an era you set that disagrees with the date', () => {
    const id = item('Pale Rooftops', { status: 'watched', era: 'long-ago' });
    expect(logViewing(db, id, { date: '2023-05-05', now: NOW }).item.watchedEra).toBe('long-ago');
  });

  it('an older play does not move the watched date', () => {
    const id = item();
    logViewing(db, id, { date: '2024-01-01', now: NOW });
    expect(logViewing(db, id, { date: '2010-01-01', now: NOW }).item.watchedAt).toBe('2024-01-01');
  });

  it('refuses a future date, a bad date, a bad rating and a missing item, writing nothing', () => {
    const id = item();
    const before = getItem(db, id);
    expect(() => logViewing(db, id, { date: '2026-06-17', now: NOW })).toThrow(/future/);
    expect(() => logViewing(db, id, { date: '2026-06-16', now: NOW })).not.toThrow();
    db.sql.exec('DELETE FROM viewings');
    db.sql.prepare("UPDATE library_items SET status = 'queue', watched_at = NULL, watched_era = NULL WHERE id = ?").run(id);
    expect(() => logViewing(db, id, { date: '2023-02-29', now: NOW })).toThrow(/Invalid date/);
    expect(() => logViewing(db, id, { date: 'yesterday', now: NOW })).toThrow(LibraryError);
    expect(() => logViewing(db, id, { rating: 11, now: NOW })).toThrow(/1 to 10/);
    expect(() => logViewing(db, 999999, { now: NOW })).toThrow(/not found/);
    expect(getItem(db, id)).toMatchObject({ status: before?.status, watchedAt: null, myRating: null });
    expect(viewingsOf(db, id)).toEqual([]);
  });

  it('localToday is the local calendar date', () => {
    expect(localToday(new Date(2026, 0, 2, 23, 59))).toBe('2026-01-02');
  });
});

describe('historyPlays', () => {
  it('lists newest first, dateless last, with derived rewatches', () => {
    const id = item();
    addViewing(db, id, { watchedAt: '2019-01-01', source: 'trakt', sourceRef: '1' });
    addViewing(db, id, { watchedAt: '2021-03-03', source: 'trakt', sourceRef: '2' });
    addViewing(db, id, { watchedAt: null, source: 'trakt', sourceRef: '3' });
    const res = historyPlays(db);
    expect(res.total).toBe(3);
    expect(res.plays.map((p) => [p.date, p.rewatch, p.sources])).toEqual([
      ['2021-03-03', true, ['trakt']],
      ['2019-01-01', false, ['trakt']],
      [null, false, ['trakt']],
    ]);
    expect(res.plays[0]).toMatchObject({ itemId: id, title: 'Pale Rooftops', year: 1994 });
  });

  it('collapses one night recorded by two sources into one play with both ids', () => {
    const id = item();
    const a = addViewing(db, id, { watchedAt: '2024-10-31', source: 'letterboxd', sourceRef: 'https://boxd.it/e1', rating: 8 });
    const b = addViewing(db, id, { watchedAt: '2024-10-31T21:00:00Z', source: 'trakt', sourceRef: '77' });
    const res = historyPlays(db);
    expect(res.total).toBe(1);
    expect(res.plays[0]).toMatchObject({ date: '2024-10-31', sources: ['letterboxd', 'trakt'], rating: 8 });
    expect(res.plays[0]?.viewings.map((v) => v.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('judges a rewatch against the whole history, editions included, even under a filter', () => {
    const one = item('Pale Rooftops', { tconst: 'tt9000001' });
    const two = item('Pale Rooftops (4K)', { tconst: 'tt9000001' });
    addViewing(db, one, { watchedAt: '2015-01-01', source: 'manual' });
    addViewing(db, two, { watchedAt: '2022-02-02', source: 'plex' });
    expect(historyPlays(db, { year: 2022 }).plays).toMatchObject([{ date: '2022-02-02', rewatch: true, itemId: two }]);
    expect(historyPlays(db, { itemId: two }).plays).toMatchObject([{ rewatch: true }]);
    // The source's own flag wins.
    addViewing(db, two, { watchedAt: '2023-03-03', source: 'letterboxd', rewatch: false });
    expect(historyPlays(db, { year: 2023 }).plays[0]?.rewatch).toBe(false);
  });

  it('filters by item, year, range and source, and limits after counting', () => {
    const a = item('Pale Rooftops');
    const b = item('Quiet Ledger');
    addViewing(db, a, { watchedAt: '2020-05-05', source: 'trakt' });
    addViewing(db, a, { watchedAt: '2021-05-05', source: 'letterboxd' });
    addViewing(db, b, { watchedAt: '2021-06-06', source: 'trakt' });
    expect(historyPlays(db, { itemId: a }).total).toBe(2);
    expect(historyPlays(db, { year: 2021 }).plays.map((p) => p.title)).toEqual(['Quiet Ledger', 'Pale Rooftops']);
    expect(historyPlays(db, { from: '2021-01-01', to: '2021-05-31' }).plays.map((p) => p.date)).toEqual(['2021-05-05']);
    expect(historyPlays(db, { source: 'trakt' }).total).toBe(2);
    const limited = historyPlays(db, { limit: 1 });
    expect(limited.total).toBe(3);
    expect(limited.plays).toHaveLength(1);
    expect(() => historyPlays(db, { limit: 0 })).toThrow(/limit/);
    expect(() => historyPlays(db, { itemId: 999999 })).toThrow(/not found/);
    expect(() => historyPlays(db, { from: '2021-13-01' })).toThrow(/from/);
  });

  it('is empty with no plays', () => {
    item();
    expect(historyPlays(db)).toEqual({ total: 0, plays: [] });
  });
});

describe('removePlay', () => {
  it('removes one viewing by id and moves the watched date back', () => {
    const id = item('Pale Rooftops', { status: 'watched' });
    addViewing(db, id, { watchedAt: '2019-01-01', source: 'manual' });
    const later = addViewing(db, id, { watchedAt: '2022-01-01', source: 'trakt' });
    const res = removePlay(db, later.id);
    expect(res.removed.id).toBe(later.id);
    expect(res.item.watchedAt).toBe('2019-01-01');
    expect(() => removePlay(db, later.id)).toThrow(/not found/);
    expect(() => removePlay(db, 0)).toThrow(/Invalid viewing id/);
  });
});

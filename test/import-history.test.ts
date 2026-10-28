/**
 * Plays from the single-date sources (Jellyfin, the TV app, a Plex listing,
 * a CSV `watched_at`): each new last-played date is a play, and history
 * accumulates across imports. Future-dated plays are dropped before they are
 * written. All titles are made up; no catalog is built.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { parseAppleTvJxaOutput } from '../src/core/importers/apple-tv.js';
import { parseCsv } from '../src/core/importers/csv.js';
import { applyImport, type ImportRecord } from '../src/core/importers/index.js';
import { mapJellyfinItems } from '../src/core/importers/jellyfin.js';
import { mapPlexItems } from '../src/core/importers/plex.js';
import { dropFutureDates } from '../src/cli/import-runner.js';
import { viewingsOf } from '../src/core/viewings.js';

let tmp: string;
let db: Db;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-imphist-'));
  db = openDb(join(tmp, 'home'));
});
afterAll(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;'));

const only = () => {
  const rows = db.sql.prepare('SELECT id, watched_at AS at, watched_at_source AS src FROM library_items').all() as { id: number; at: string | null; src: string | null }[];
  expect(rows).toHaveLength(1);
  return rows[0] as { id: number; at: string | null; src: string | null };
};
const plays = () => viewingsOf(db, only().id).map((v) => [v.watchedAt, v.source, v.sourceRef]);
const merge = (records: ImportRecord[]) => applyImport(db, records, { mode: 'merge' });

describe('single-date sources accumulate plays', () => {
  it('Jellyfin: a changed last-played date across two imports gives two plays', () => {
    const item = (last: string) => ({
      Id: 'a1',
      Name: 'Seven Lanterns',
      ProductionYear: 1995,
      RunTimeTicks: 117 * 600_000_000,
      Type: 'Movie',
      LocationType: 'FileSystem',
      ProviderIds: { Imdb: 'tt9000004' },
      UserData: { Played: true, PlayCount: 1, LastPlayedDate: last },
    });
    merge(mapJellyfinItems([item('2024-03-03T12:00:00Z')]).records);
    expect(merge(mapJellyfinItems([item('2024-03-03T12:00:00Z')]).records)).toMatchObject({ added: 0, updated: 0, unchanged: 1 });
    expect(merge(mapJellyfinItems([item('2025-01-20T12:00:00Z')]).records)).toMatchObject({ updated: 1 });
    expect(plays().map((p) => p[1])).toEqual(['jellyfin', 'jellyfin']);
    expect(plays()).toHaveLength(2);
    expect(only().src).toBe('jellyfin');
  });

  it('the TV app: a changed played date across two imports gives two plays', () => {
    const tv = (played: string) => JSON.stringify([{ name: 'Quiet Orbit', mediaKind: 'movie', persistentID: 'ABC123', playedCount: 1, playedDate: played }]);
    merge(parseAppleTvJxaOutput(tv('2023-06-01T20:00:00Z')));
    merge(parseAppleTvJxaOutput(tv('2023-06-01T20:00:00Z')));
    merge(parseAppleTvJxaOutput(tv('2024-07-02T20:00:00Z')));
    expect(plays()).toEqual([
      ['2024-07-02T20:00:00Z', 'apple-tv', null],
      ['2023-06-01T20:00:00Z', 'apple-tv', null],
    ]);
    expect(only().at).toBe('2024-07-02T20:00:00Z');
  });

  it('a Plex listing: each new lastViewedAt is a play, never a complete set', () => {
    const listing = (secs: number) => [{ type: 'movie', title: 'Night Ferry', year: 2002, viewCount: 1, lastViewedAt: secs, Guid: [{ id: 'imdb://tt9000010' }] }];
    merge(mapPlexItems(listing(Date.UTC(2022, 0, 10, 12) / 1000)).records);
    merge(mapPlexItems(listing(Date.UTC(2023, 4, 10, 12) / 1000)).records);
    expect(plays()).toHaveLength(2);
    expect(plays().every((p) => p[1] === 'plex' && p[2] === null)).toBe(true);
  });

  it('a CSV watched_at is one play of the csv source; an older date never replaces a newer one', () => {
    merge(parseCsv('title,year,status,watched_at\nPale Rooftops,1994,watched,2024-05-05\n').records);
    merge(parseCsv('title,year,status,watched_at\nPale Rooftops,1994,watched,2019-01-01\n').records);
    expect(plays()).toEqual([
      ['2024-05-05', 'csv', null],
      ['2019-01-01', 'csv', null],
    ]);
    expect(only().at).toBe('2024-05-05');
  });
});

describe('dropFutureDates', () => {
  const now = new Date(Date.UTC(2026, 5, 15, 12));
  it('drops plays and a watchedAt more than a day ahead, with a warning per movie', () => {
    const res = dropFutureDates(
      [
        { sourceTitle: 'Pale Rooftops', source: 'letterboxd', viewings: [{ watchedAt: '2026-06-16' }, { watchedAt: '2026-07-01', sourceRef: 'x' }, { watchedAt: null }] },
        { sourceTitle: 'Quiet Ledger', source: 'csv', watchedAt: '2027-01-01' },
        { sourceTitle: 'Night Ferry', source: 'csv', watchedAt: '2026-06-15' },
      ],
      now,
    );
    expect(res.records[0]?.viewings).toEqual([{ watchedAt: '2026-06-16' }, { watchedAt: null }]);
    expect(res.records[1]).not.toHaveProperty('watchedAt');
    expect(res.records[2]?.watchedAt).toBe('2026-06-15');
    expect(res.warnings).toEqual([
      '"Pale Rooftops": left out a play dated in the future (2026-07-01)',
      '"Quiet Ledger": left out a play dated in the future (2027-01-01)',
    ]);
  });

  it('leaves a date it cannot read for the import to refuse (Astra r6)', () => {
    const res = dropFutureDates([{ sourceTitle: 'Pale Rooftops', source: 'csv', watchedAt: 'tomorrow' }], now);
    expect(res.records[0]?.watchedAt).toBe('tomorrow');
    expect(res.warnings).toEqual([]);
    expect(() => applyImport(db, res.records, { mode: 'merge' })).toThrow(/invalid watched date/);
  });

  it('a complete set that loses a future play writes and removes no play (Astra r7, r8)', () => {
    const res = dropFutureDates(
      [{ sourceTitle: 'Pale Rooftops', source: 'trakt', viewings: [{ watchedAt: '2024-01-02', sourceRef: '1' }, { watchedAt: '2099-01-01', sourceRef: '12345' }], viewingsComplete: true }],
      now,
    );
    expect(res.records[0]?.viewings).toEqual([]);
    expect(res.records[0]).not.toHaveProperty('viewingsComplete');
  });

  it('end to end: a whole history with a future play neither duplicates nor deletes a migrated play', () => {
    merge([{ sourceTitle: 'Pale Rooftops', sourceYear: 1994, status: 'watched', source: 'trakt', externalIds: { trakt: '77' } }]);
    db.sql.prepare("INSERT INTO viewings (item_id, watched_at, source) VALUES (?, '2024-01-01', 'trakt')").run(only().id);
    const incoming: ImportRecord[] = [
      {
        sourceTitle: 'Pale Rooftops',
        sourceYear: 1994,
        status: 'watched',
        source: 'trakt',
        externalIds: { trakt: '77' },
        viewings: [{ watchedAt: '2024-01-02', sourceRef: '1' }, { watchedAt: '2099-01-01', sourceRef: '2' }],
        viewingsComplete: true,
      },
    ];
    merge(dropFutureDates(incoming, now).records);
    expect(plays()).toEqual([['2024-01-01', 'trakt', null]]);
  });

  it('leaves records without future dates as they are', () => {
    const recs: ImportRecord[] = [{ sourceTitle: 'Pale Rooftops', source: 'csv', watchedAt: '2020-01-01' }];
    const res = dropFutureDates(recs, now);
    expect(res.records[0]).toBe(recs[0]);
    expect(res.warnings).toEqual([]);
  });
});

/**
 * core/sync.ts: the sync lock, last-run records in meta, and running each
 * source with its failure kept to itself. Tokens here are invented.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { ImportError } from '../src/core/importers/common.js';
import { LibraryError } from '../src/core/library.js';
import {
  acquireSyncLock,
  readSyncStatus,
  recordSyncRun,
  redactSecrets,
  runSyncSources,
  SyncBusyError,
  syncTotals,
  tokenEnvOf,
  type SourceResult,
} from '../src/core/sync.js';
import type { SyncSource } from '../src/core/config.js';

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'st-sync-core-'));
  home = join(tmp, 'home');
  mkdirSync(home, { mode: 0o700 });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const summary = (n: Partial<{ added: number; updated: number; unchanged: number; needsReview: number }> = {}) => ({
  added: 0,
  updated: 0,
  unchanged: 0,
  needsReview: 0,
  reviews: [],
  backupPath: null,
  ...n,
});

describe('the sync lock', () => {
  it('lets one sync run at a time, and frees on release', () => {
    const release = acquireSyncLock(home);
    expect(() => acquireSyncLock(home)).toThrow(SyncBusyError);
    expect(() => acquireSyncLock(home)).toThrow(/A sync is already running \(process \d+\)/);
    expect(new SyncBusyError(null)).toBeInstanceOf(LibraryError);
    release();
    release();
    const again = acquireSyncLock(home);
    again();
  });
});

describe('redactSecrets', () => {
  it('replaces the token variables the environment holds', () => {
    const env = { PLEX_TOKEN: 'fake-plex-token-0001', JELLYFIN_TOKEN: 'fake-jf-token-0002', OTHER: 'not-a-token' };
    expect(redactSecrets('bad fake-plex-token-0001 and fake-jf-token-0002, not-a-token', env)).toBe('bad [redacted] and [redacted], not-a-token');
    expect(redactSecrets('nothing here', {})).toBe('nothing here');
    // A value too short to be a token is left alone (it would blank ordinary words).
    expect(redactSecrets('a b c', { PLEX_TOKEN: 'b' })).toBe('a b c');
  });
});

describe('tokenEnvOf', () => {
  it('names the variable each source reads', () => {
    expect(tokenEnvOf('plex')).toBe('PLEX_TOKEN');
    expect(tokenEnvOf('jellyfin')).toBe('JELLYFIN_TOKEN');
    expect(tokenEnvOf('apple-tv')).toBeNull();
  });
});

describe('runSyncSources', () => {
  const sources: SyncSource[] = [
    { kind: 'plex', url: 'http://127.0.0.1:32400' },
    { kind: 'jellyfin', url: 'http://localhost:8096' },
    { kind: 'apple-tv' },
  ];

  it('runs each source in order and keeps a failure to that source', async () => {
    const seen: string[] = [];
    const results = await runSyncSources(
      sources,
      async (s) => {
        seen.push(s.kind);
        if (s.kind === 'jellyfin') throw new ImportError('Could not reach the Jellyfin server at http://localhost:8096/: ECONNREFUSED');
        if (s.kind === 'apple-tv') throw new TypeError('boom');
        return { records: 3, summary: summary({ added: 1, unchanged: 2 }) };
      },
      { env: {} },
    );
    expect(seen).toEqual(['plex', 'jellyfin', 'apple-tv']);
    expect(results.map((r) => [r.kind, r.ok, r.unexpected ?? false])).toEqual([
      ['plex', true, false],
      ['jellyfin', false, false],
      ['apple-tv', false, true],
    ]);
    expect(results[0]).toMatchObject({ records: 3, added: 1, unchanged: 2 });
    expect(results[1]?.error).toMatch(/ECONNREFUSED/);
    expect(results[2]?.error).toBe('boom');
    expect(syncTotals(results)).toEqual({ added: 1, updated: 0, unchanged: 2, needsReview: 0 });
  });

  it('redacts a token from a failure message', async () => {
    const [r] = await runSyncSources(
      [sources[0] as SyncSource],
      async () => {
        throw new Error('server said no to fake-plex-token-0001');
      },
      { env: { PLEX_TOKEN: 'fake-plex-token-0001' } },
    );
    expect(r?.error).toBe('server said no to [redacted]');
  });

  it('calls before and after hooks around each source', async () => {
    const events: string[] = [];
    await runSyncSources(sources.slice(0, 2), async () => ({ records: 0, summary: summary() }), {
      env: {},
      before: (s) => events.push(`before ${s.kind}`),
      after: (r) => events.push(`after ${r.kind} ${r.ok}`),
    });
    expect(events).toEqual(['before plex', 'after plex true', 'before jellyfin', 'after jellyfin true']);
  });
});

describe('last-run records', () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(home);
  });
  afterEach(() => db.close());

  it('records a run per source, keeping the last success through a failure', () => {
    const ok: SourceResult = { kind: 'plex', ok: true, records: 4, added: 1, updated: 2, unchanged: 1, needsReview: 0 };
    recordSyncRun(db, ok, new Date('2026-01-02T03:04:05Z'));
    expect(readSyncStatus(db, ['plex', 'jellyfin'])).toEqual([
      { kind: 'plex', lastRun: { at: '2026-01-02T03:04:05.000Z', ok: true, records: 4, added: 1, updated: 2, unchanged: 1, needsReview: 0, lastOkAt: '2026-01-02T03:04:05.000Z' } },
      { kind: 'jellyfin', lastRun: null },
    ]);
    recordSyncRun(db, { kind: 'plex', ok: false, error: 'x'.repeat(2000) }, new Date('2026-01-03T00:00:00Z'));
    const [plex] = readSyncStatus(db, ['plex']);
    expect(plex?.lastRun).toMatchObject({ at: '2026-01-03T00:00:00.000Z', ok: false, lastOkAt: '2026-01-02T03:04:05.000Z' });
    expect(plex?.lastRun?.error?.length).toBeLessThanOrEqual(500);
    expect(db.sql.prepare("SELECT key FROM meta WHERE key LIKE 'sync_last:%'").all()).toEqual([{ key: 'sync_last:plex' }]);
  });

  it('reads an unreadable record as no record', () => {
    db.sql.prepare("INSERT INTO meta (key, value) VALUES ('sync_last:plex', 'not json')").run();
    expect(readSyncStatus(db, ['plex'])).toEqual([{ kind: 'plex', lastRun: null }]);
  });
});

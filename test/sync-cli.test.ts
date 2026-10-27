/**
 * `screentrackr sync`: saving sources, running them as merge imports with
 * one failure kept to its source, dry runs, status, the lock, and the
 * launchd instructions. Plex and Jellyfin are fake servers behind a stubbed
 * fetch; the TV app read is mocked. Every title, server and token is invented.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchdPaths, sync } from '../src/cli/commands/sync.js';
import { UserError, type Ctx } from '../src/cli/context.js';
import { configPath, loadConfig, saveConfig } from '../src/core/config.js';
import { openDb, type Db } from '../src/core/db.js';
import { acquireSetupLock } from '../src/core/setup.js';
import { acquireSyncLock } from '../src/core/sync.js';

const appleTv = vi.hoisted(() => ({ records: [] as unknown[], fail: null as Error | null }));
vi.mock('../src/core/importers/apple-tv.js', async (orig) => ({
  ...(await orig<typeof import('../src/core/importers/apple-tv.js')>()),
  readAppleTvLibrary: vi.fn(async () => {
    if (appleTv.fail) throw appleTv.fail;
    return appleTv.records;
  }),
}));

const PLEX_URL = 'http://plex.example.test:32400';
const JF_URL = 'http://jellyfin.example.test:8096';
const PLEX_TOKEN = 'invented-plex-token-Q7w2';
const JF_TOKEN = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

const plexMovies = [
  { ratingKey: '11', type: 'movie', guid: 'local://11', title: 'The Copper Orchard', year: 1981, duration: 100 * 60000, viewCount: 1, lastViewedAt: 1718020800 },
  { ratingKey: '12', type: 'movie', guid: 'local://12', title: 'Winter Signal', year: 1994, duration: 95 * 60000 },
];
const jfItems = [
  {
    Id: 'aaaa0000000000000000000000000001',
    Name: 'Paper Lighthouse',
    Type: 'Movie',
    ProductionYear: 2003,
    RunTimeTicks: 6000 * 10_000_000,
    ProviderIds: {},
    UserData: { Played: true, PlayCount: 1, LastPlayedDate: '2024-03-01T20:00:00.0000000Z', IsFavorite: false },
  },
];

/** A fetch that answers as a Plex server and a Jellyfin server would, by host. */
function fakeServers(opts: { plexDown?: boolean } = {}) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${url.host}${url.pathname}`);
    if (url.host === 'plex.example.test:32400') {
      if (opts.plexDown) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
      if (url.pathname === '/library/sections/all') return json({ MediaContainer: { size: 1, Directory: [{ key: '3', type: 'movie', title: 'Movies' }] } });
      if (url.pathname === '/library/sections/3/all') {
        const h = new Headers(init.headers);
        const start = Number(h.get('X-Plex-Container-Start') ?? 0);
        const size = Number(h.get('X-Plex-Container-Size') ?? plexMovies.length);
        const page = plexMovies.slice(start, start + size);
        return json(
          { MediaContainer: { size: page.length, totalSize: plexMovies.length, offset: start, librarySectionID: 3, Metadata: page } },
          { 'X-Plex-Container-Total-Size': String(plexMovies.length) },
        );
      }
    }
    if (url.host === 'jellyfin.example.test:8096') {
      if (url.pathname === '/Users/Me') return json({ Id: 'bbbb0000000000000000000000000002', Name: 'orrin' });
      if (url.pathname === '/Items') return json({ Items: jfItems, TotalRecordCount: jfItems.length, StartIndex: 0 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

let tmp: string;
let home: string;
let out: string[];
let log: string[];
let ctx: Ctx;
let jsonMode: boolean;

function makeCtx(): Ctx {
  let db: Db | undefined;
  return {
    home,
    get json() {
      return jsonMode;
    },
    tty: false,
    color: false,
    width: undefined,
    db: () => (db ??= openDb(home)),
    out: (t) => out.push(t),
    log: (t) => log.push(t),
    emit: (data, text) => out.push(jsonMode ? JSON.stringify(data) : text()),
    close: () => {
      db?.close();
      db = undefined;
    },
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'st-sync-cli-'));
  home = join(tmp, 'home');
  out = [];
  log = [];
  jsonMode = false;
  appleTv.records = [];
  appleTv.fail = null;
  ctx = makeCtx();
  vi.stubEnv('PLEX_TOKEN', '');
  vi.stubEnv('JELLYFIN_TOKEN', '');
});
afterEach(() => {
  ctx.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

const run = async (pos: string[], values: Record<string, string | boolean | string[]> = {}): Promise<void> => sync.run(ctx, pos, values);
const lastJson = () => JSON.parse(out[out.length - 1] as string) as Record<string, unknown>;
const rows = () => (ctx.db().sql.prepare('SELECT source_title FROM library_items ORDER BY source_title').all() as { source_title: string }[]).map((r) => r.source_title);

describe('sync add, list, remove', () => {
  it('saves each kind with the options its import takes, owner-only', async () => {
    await run(['add', 'plex'], { url: PLEX_URL, section: ['Movies'], 'no-ratings': true, 'unwatched-status': 'skip', history: true });
    await run(['add', 'jellyfin'], { url: JF_URL, user: 'orrin', ratings: true, timeout: '45' });
    await run(['add', 'apple-tv'], { timeout: '90' });
    expect(loadConfig(home).sync?.sources).toEqual([
      { kind: 'plex', url: PLEX_URL, sections: ['Movies'], includeOtherVideos: false, unwatchedStatus: 'skip', ratings: false, history: true },
      { kind: 'jellyfin', url: JF_URL, user: 'orrin', ratings: true, strictPlayed: false, timeoutSec: 45 },
      { kind: 'apple-tv', timeoutSec: 90 },
    ]);
    expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    expect(out.join('\n')).toMatch(/Saved the plex source/);
  });

  it('defaults the Plex address, and replaces a saved source of the same kind', async () => {
    await run(['add', 'plex']);
    expect(loadConfig(home).sync?.sources[0]).toMatchObject({ kind: 'plex', url: 'http://127.0.0.1:32400' });
    await run(['add', 'plex'], { url: PLEX_URL });
    expect(loadConfig(home).sync?.sources).toHaveLength(1);
    expect(loadConfig(home).sync?.sources[0]).toMatchObject({ url: PLEX_URL });
    expect(out.join('\n')).toMatch(/replaced the saved one/);
  });

  it('checks options the way import does, before saving anything', async () => {
    await expect(run(['add'])).rejects.toThrow(/sync add <plex\|jellyfin\|apple-tv>/);
    await expect(run(['add', 'trakt'])).rejects.toThrow(/Unknown source "trakt"/);
    await expect(run(['add', 'plex'], { url: 'http://me:pw@plex.example.test' })).rejects.toThrow(/user name or password/);
    await expect(run(['add', 'plex'], { url: `${PLEX_URL}/?X-Plex-Token=abc` })).rejects.toThrow(/query string/);
    await expect(run(['add', 'plex'], { 'unwatched-status': 'later' })).rejects.toThrow(/--unwatched-status expects/);
    await expect(run(['add', 'plex'], { user: 'orrin' })).rejects.toThrow(/--user does not apply to plex/);
    await expect(run(['add', 'plex'], { timeout: '30' })).rejects.toThrow(/--timeout does not apply to plex/);
    await expect(run(['add', 'jellyfin'])).rejects.toThrow(/--url <server>/);
    await expect(run(['add', 'jellyfin'], { url: JF_URL, 'no-ratings': true })).rejects.toThrow(/--no-ratings does not apply to jellyfin/);
    await expect(run(['add', 'jellyfin'], { url: JF_URL, timeout: '0' })).rejects.toThrow(/--timeout must be a positive number/);
    await expect(run(['add', 'apple-tv'], { url: JF_URL })).rejects.toThrow(/--url does not apply to apple-tv/);
    await expect(run(['add', 'apple-tv'], { 'dry-run': true })).rejects.toThrow(/--dry-run does not apply to `sync add`/);
    await expect(run(['add', 'plex', 'extra'])).rejects.toThrow(/Unexpected argument "extra"/);
    expect(existsSync(configPath(home))).toBe(false);
  });

  it('lists sources, saying whether each token is set and never what it is', async () => {
    await run(['add', 'plex'], { url: PLEX_URL });
    await run(['add', 'jellyfin'], { url: JF_URL });
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    out = [];
    await run(['list']);
    const text = out.join('\n');
    expect(text).toMatch(/plex\s+http:\/\/plex\.example\.test:32400.*PLEX_TOKEN is set/);
    expect(text).toMatch(/jellyfin\s+http:\/\/jellyfin\.example\.test:8096.*JELLYFIN_TOKEN is not set/);
    expect(text).not.toContain(PLEX_TOKEN);
    jsonMode = true;
    await run(['list']);
    const data = lastJson() as { sources: { kind: string; tokenEnv: string | null; tokenSet: boolean }[] };
    expect(data.sources.map((s) => [s.kind, s.tokenEnv, s.tokenSet])).toEqual([
      ['plex', 'PLEX_TOKEN', true],
      ['jellyfin', 'JELLYFIN_TOKEN', false],
    ]);
    expect(out.join('\n')).not.toContain(PLEX_TOKEN);
  });

  it('says how to add one when nothing is saved', async () => {
    await run(['list']);
    expect(out.join('\n')).toMatch(/No sync sources. Add one with `screentrackr sync add/);
  });

  it('removes a source, and refuses one that is not saved', async () => {
    await run(['add', 'plex'], { url: PLEX_URL });
    await run(['remove', 'plex']);
    expect(loadConfig(home).sync?.sources).toEqual([]);
    await expect(run(['remove', 'plex'])).rejects.toThrow(/No plex source is configured/);
    await expect(run(['remove'])).rejects.toThrow(/sync remove <plex\|jellyfin\|apple-tv>/);
  });

  it('refuses a config.json from a newer screentrackr, and one holding a token', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(configPath(home), JSON.stringify({ version: 2 }));
    await expect(run(['list'])).rejects.toThrow(/Upgrade screentrackr/);
    await expect(run([])).rejects.toThrow(/Upgrade screentrackr/);
    writeFileSync(configPath(home), JSON.stringify({ version: 1, sync: { sources: [{ kind: 'plex', url: PLEX_URL, token: 'x' }] } }));
    await expect(run([])).rejects.toThrow(/tokens are never stored|Tokens and passwords are never stored.*PLEX_TOKEN/i);
  });

  it('refuses an unknown subcommand and run flags on other subcommands', async () => {
    await expect(run(['start'])).rejects.toThrow(/Unknown sync command "start"/);
    await expect(run(['list'], { only: 'plex' })).rejects.toThrow(/--only does not apply to `sync list`/);
    await expect(run(['status'], { 'dry-run': true })).rejects.toThrow(/--dry-run does not apply to `sync status`/);
    await expect(run([], { url: PLEX_URL })).rejects.toThrow(/--url does not apply to `sync`/);
  });
});

describe('sync (running the sources)', () => {
  beforeEach(() => {
    saveConfig(home, {
      version: 1,
      sync: { sources: [{ kind: 'plex', url: PLEX_URL }, { kind: 'jellyfin', url: JF_URL }] },
    });
  });

  it('refuses when nothing is saved', async () => {
    saveConfig(home, { version: 1 });
    await expect(run([])).rejects.toThrow(/No sync sources/);
  });

  it('runs every source as a merge; one failing (no token) fails alone, exit 1', async () => {
    const servers = fakeServers();
    vi.stubGlobal('fetch', servers.fetch);
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    const err = await run([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/1 of 2 sources failed: jellyfin/);
    expect(rows()).toEqual(['The Copper Orchard', 'Winter Signal']);
    const text = out.join('\n');
    expect(text).toMatch(/== plex ==/);
    expect(text).toMatch(/plex: 2 records\. Added 2, updated 0, unchanged 0, needs review \d+\./);
    expect(text).toMatch(/jellyfin: failed: No Jellyfin token\. Set JELLYFIN_TOKEN/);
    expect(text).toMatch(/Total: added 2, updated 0, unchanged 0, needs review \d+\. 1 of 2 sources failed\./);
    expect([...out, ...log].join('\n')).not.toContain(PLEX_TOKEN);
    expect(servers.calls.every((c) => c.startsWith('plex.example.test'))).toBe(true);
  });

  it('exits 0 when every source succeeds, and a rerun changes nothing', async () => {
    vi.stubGlobal('fetch', fakeServers().fetch);
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    vi.stubEnv('JELLYFIN_TOKEN', JF_TOKEN);
    await run([]);
    expect(rows()).toEqual(['Paper Lighthouse', 'The Copper Orchard', 'Winter Signal']);
    out = [];
    jsonMode = true;
    await run([]);
    const data = lastJson() as { dryRun: boolean; ok: boolean; sources: { kind: string; ok: boolean; added: number; unchanged: number }[]; total: Record<string, number> };
    expect(data.ok).toBe(true);
    expect(data.dryRun).toBe(false);
    expect(data.sources.map((s) => [s.kind, s.ok, s.added, s.unchanged])).toEqual([
      ['plex', true, 0, 2],
      ['jellyfin', true, 0, 1],
    ]);
    expect(data.total).toMatchObject({ added: 0, updated: 0, unchanged: 3 });
    expect(out.join('\n')).not.toContain(JF_TOKEN);
  });

  it('keeps going when a server is down, and redacts its token from what is printed', async () => {
    vi.stubGlobal('fetch', fakeServers({ plexDown: true }).fetch);
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    vi.stubEnv('JELLYFIN_TOKEN', JF_TOKEN);
    jsonMode = true;
    const err = (await run([]).catch((e: unknown) => e)) as UserError;
    expect(err).toBeInstanceOf(UserError);
    const detail = err.details?.sync as { sources: { kind: string; ok: boolean; error?: string }[] };
    expect(detail.sources.map((s) => [s.kind, s.ok])).toEqual([
      ['plex', false],
      ['jellyfin', true],
    ]);
    expect(detail.sources[0]?.error).toBeTruthy();
    expect(rows()).toEqual(['Paper Lighthouse']);
    // In --json mode the result goes out once, inside the error object (none on stdout yet).
    expect(out).toEqual([]);
    expect(JSON.stringify(err.details)).not.toContain(PLEX_TOKEN);
  });

  it('--only runs one source, and refuses a kind that is not saved', async () => {
    vi.stubGlobal('fetch', fakeServers().fetch);
    vi.stubEnv('JELLYFIN_TOKEN', JF_TOKEN);
    await run([], { only: 'jellyfin' });
    expect(rows()).toEqual(['Paper Lighthouse']);
    expect(out.join('\n')).not.toMatch(/== plex ==/);
    await expect(run([], { only: 'apple-tv' })).rejects.toThrow(/No apple-tv source is configured/);
    await expect(run([], { only: 'trakt' })).rejects.toThrow(/Unknown source "trakt"/);
  });

  it('--dry-run reports what would change and writes nothing', async () => {
    vi.stubGlobal('fetch', fakeServers().fetch);
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    vi.stubEnv('JELLYFIN_TOKEN', JF_TOKEN);
    const before = ctx.db().sql.prepare('SELECT key, value FROM meta ORDER BY key').all();
    await run([], { 'dry-run': true });
    const text = out.join('\n');
    expect(text).toMatch(/plex: 2 records\. Would add 2, update 0, leave unchanged 0/);
    expect(text).toMatch(/Dry run: nothing was changed\./);
    expect(rows()).toEqual([]);
    expect(ctx.db().sql.prepare('SELECT key, value FROM meta ORDER BY key').all()).toEqual(before);
    expect(ctx.db().sql.prepare('SELECT COUNT(*) AS n FROM viewings').get()).toEqual({ n: 0 });
  });

  it('records each source run for sync status (not for a dry run)', async () => {
    vi.stubGlobal('fetch', fakeServers().fetch);
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    await run([], { 'dry-run': true }).catch(() => undefined);
    out = [];
    await run(['status']);
    expect(out.join('\n')).toMatch(/plex: never run/);
    await run([]).catch(() => undefined);
    out = [];
    await run(['status']);
    const text = out.join('\n');
    expect(text).toMatch(/plex: last run \S+ ok: added 2, updated 0, unchanged 0, needs review \d+/);
    expect(text).toMatch(/jellyfin: last run \S+ failed: No Jellyfin token/);
    jsonMode = true;
    await run(['status']);
    const data = lastJson() as { sources: { kind: string; lastRun: { ok: boolean; added?: number } | null }[] };
    expect(data.sources.map((s) => [s.kind, s.lastRun?.ok])).toEqual([
      ['plex', true],
      ['jellyfin', false],
    ]);
  });

  it('runs the TV app source too, and reports its failure without stopping the others', async () => {
    saveConfig(home, { version: 1, sync: { sources: [{ kind: 'apple-tv' }, { kind: 'jellyfin', url: JF_URL }] } });
    vi.stubGlobal('fetch', fakeServers().fetch);
    vi.stubEnv('JELLYFIN_TOKEN', JF_TOKEN);
    appleTv.records = [{ sourceTitle: 'Harbor of Echoes', sourceYear: 1999, source: 'apple-tv', status: 'watched', fromTvApp: true }];
    await run([]);
    expect(rows()).toEqual(['Harbor of Echoes', 'Paper Lighthouse']);
    appleTv.fail = new Error('The TV app did not answer in time');
    out = [];
    await expect(run([])).rejects.toThrow(/1 of 2 sources failed: apple-tv/);
    expect(out.join('\n')).toMatch(/apple-tv: failed unexpectedly: The TV app did not answer in time/);
  });

  it('exits 1 while another sync holds the lock, and while setup runs', async () => {
    mkdirSync(home, { recursive: true });
    const release = acquireSyncLock(home);
    try {
      await expect(run([])).rejects.toThrow(/A sync is already running/);
    } finally {
      release();
    }
    const releaseSetup = acquireSetupLock(home);
    try {
      await expect(run([])).rejects.toThrow(/Setup is running; try again when it finishes/);
    } finally {
      releaseSetup();
    }
  });
});

describe('sync launchd', () => {
  beforeEach(() => {
    vi.spyOn(launchdPaths, 'cli').mockReturnValue('/opt/invented/lib/node_modules/screentrackr/dist/cli/index.js');
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses to run from the npx cache', async () => {
    saveConfig(home, { version: 1, sync: { sources: [{ kind: 'apple-tv' }] } });
    vi.mocked(launchdPaths.cli).mockReturnValue('/home/someone/.npm/_npx/0a1b/node_modules/screentrackr/dist/cli/index.js');
    await expect(run(['launchd'])).rejects.toThrow(/npm install -g screentrackr/);
  });

  it('prints a plist on stdout and the steps on stderr, with no token value anywhere', async () => {
    saveConfig(home, { version: 1, sync: { sources: [{ kind: 'plex', url: PLEX_URL }, { kind: 'apple-tv' }] } });
    vi.stubEnv('PLEX_TOKEN', PLEX_TOKEN);
    await run(['launchd'], { every: '2h' });
    const plist = out.join('\n');
    expect(plist).toMatch(/^<\?xml/);
    expect(plist).toContain('<integer>7200</integer>');
    expect(plist).toContain('<string>/bin/sh</string>');
    expect(log.join('\n')).toMatch(/launchctl bootstrap gui\/\$\(id -u\)/);
    expect(log.join('\n')).toMatch(/--every 2h/);
    expect([...out, ...log].join('\n')).not.toContain(PLEX_TOKEN);
    expect(existsSync(join(home, 'sync-launchd.sh'))).toBe(false);
    out = [];
    await run(['launchd'], { wrapper: true });
    expect(out.join('\n')).toMatch(/^#!\/bin\/sh\n/);
    expect(out.join('\n')).toContain('find-generic-password -w -s screentrackr-plex');
    jsonMode = true;
    await run(['launchd']);
    const data = lastJson() as { plist: string; plistPath: string; wrapper?: string; steps: string[] };
    expect(data.plistPath).toMatch(/Library\/LaunchAgents\/org\.screentrackr\.sync\.plist$/);
    expect(data.wrapper).toContain('#!/bin/sh');
    expect(JSON.stringify(data)).not.toContain(PLEX_TOKEN);
  });

  it('needs a saved source, and --wrapper only when a source has a token', async () => {
    await expect(run(['launchd'])).rejects.toThrow(/No sync sources/);
    saveConfig(home, { version: 1, sync: { sources: [{ kind: 'apple-tv' }] } });
    await expect(run(['launchd'], { wrapper: true })).rejects.toThrow(/No saved source needs a token/);
    await expect(run(['launchd'], { every: '5m' })).rejects.toThrow(/at least 15 minutes/);
    await expect(run(['launchd'], { only: 'plex' })).rejects.toThrow(/--only does not apply to `sync launchd`/);
    await run(['launchd']);
    expect(out.join('\n')).toContain('<string>sync</string>');
  });
});

describe('sync through the built CLI', () => {
  const cli = (args: string[], env: Record<string, string | undefined> = {}) => {
    const res = spawnSync(process.execPath, [CLI, '--home', home, ...args], {
      env: { ...process.env, PLEX_TOKEN: undefined, JELLYFIN_TOKEN: undefined, SCREENTRACKR_HOME: undefined, ...env } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };

  it('exits 1 with a per-source reason when a source fails, and one JSON object in --json mode', () => {
    expect(cli(['sync', 'add', 'jellyfin', '--url', JF_URL]).code).toBe(0);
    const res = cli(['sync']);
    expect(res.code).toBe(1);
    expect(res.stdout).toMatch(/jellyfin: failed: No Jellyfin token/);
    expect(res.stderr).toMatch(/1 of 1 sources failed: jellyfin/);
    const j = cli(['sync', '--json']);
    expect(j.code).toBe(1);
    const parsed = JSON.parse(j.stdout) as { error: { sync: { sources: { kind: string; ok: boolean }[] } } };
    expect(parsed.error.sync.sources).toEqual([expect.objectContaining({ kind: 'jellyfin', ok: false })]);
  });

  it('a second sync exits 1 while one holds the lock', () => {
    mkdirSync(home, { recursive: true });
    expect(cli(['sync', 'add', 'jellyfin', '--url', JF_URL]).code).toBe(0);
    const release = acquireSyncLock(home);
    try {
      const res = cli(['sync']);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/A sync is already running \(process \d+\)/);
    } finally {
      release();
    }
  });

  it('documents its subcommands in help', () => {
    const res = cli(['sync', '--help']);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/sync add plex/);
    expect(readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8')).toContain('screentrackr sync launchd');
  });
});

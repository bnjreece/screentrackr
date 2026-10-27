/**
 * The Jellyfin importer: mapping `GET /Items` pages to records, the read-only
 * client (with fetch mocked, so nothing touches the network), and the
 * `import jellyfin` command in process. Every title, person, id, server
 * address and token here is invented.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importCmd } from '../src/cli/commands/import.js';
import type { Ctx } from '../src/cli/context.js';
import { promptHidden, type SecretInput } from '../src/cli/secret.js';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { applyImport, ImportError, type ImportRecord } from '../src/core/importers/index.js';
import { jellyfinDeviceId, mapJellyfinItems, readJellyfinItems, serverBase, type JellyfinReadOptions } from '../src/core/importers/jellyfin.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const FIX = join(import.meta.dirname, 'fixtures', 'jellyfin');
const page = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as { Items: Record<string, unknown>[]; TotalRecordCount: number };
const SERVER = 'https://jellyfin.example.test:8920/media';
const TOKEN = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const SESSION = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0';
const USER_ID = 'aaaa1111bbbb2222cccc3333dddd4444';

/** A movie item as `GET /Items` returns it, with overrides. */
const movie = (extra: Record<string, unknown> = {}, user: Record<string, unknown> = {}) => ({
  Id: `id-${Math.random().toString(16).slice(2)}`,
  Name: 'Seven Lanterns',
  ProductionYear: 1995,
  RunTimeTicks: 117 * 600_000_000,
  Type: 'Movie',
  LocationType: 'FileSystem',
  ...extra,
  UserData: { Played: false, PlayCount: 0, IsFavorite: false, ...user },
});

const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('mapJellyfinItems', () => {
  it('maps a 12.4 page: played is watched, IMDb id is a hint, the rest is fill-only and never owned or rated by default', () => {
    const res = mapJellyfinItems(page('items-12.4.json').Items);
    expect(res.records.map((r) => r.sourceTitle)).toEqual(['The Glass Harbor', 'Example Heist', 'Quiet Ledger', 'Night Ferry']);
    const [harbor, heist, ledger, ferry] = res.records as ImportRecord[];
    expect(harbor).toEqual({
      sourceTitle: 'The Glass Harbor',
      sourceYear: 1978,
      sourceRuntimeMin: 112,
      sourceGenre: 'Drama, Mystery',
      sourceDirector: 'Orrin Vale',
      imdbIdHint: 'tt9000001',
      fillOnly: true,
      source: 'jellyfin',
      status: 'watched',
      watchedAt: localDate('2025-03-14T12:07:33Z'),
    });
    for (const r of res.records) {
      expect(r).not.toHaveProperty('owned');
      expect(r).not.toHaveProperty('ownedIfNew');
      expect(r).not.toHaveProperty('myRating');
      expect(r).not.toHaveProperty('tconst');
      expect(r).not.toHaveProperty('externalIds');
      expect(r).not.toHaveProperty('imdbIdExact');
    }
    // In progress (PlayCount 1, not Played) says nothing about status.
    expect(heist).toMatchObject({ sourceTitle: 'Example Heist', sourceYear: 2011, sourceRuntimeMin: null, imdbIdHint: null });
    expect(heist).not.toHaveProperty('status');
    expect(heist).not.toHaveProperty('watchedAt');
    // A lowercase provider key still counts.
    expect(ledger).toMatchObject({ imdbIdHint: 'tt9000003', sourceRuntimeMin: 139, sourceDirector: 'Dana Fincher' });
    expect(ferry).toMatchObject({ status: 'watched', sourceRuntimeMin: 112, watchedAt: localDate('2024-11-02T12:30:00Z') });
    expect(res.skippedByType).toEqual({ BoxSet: 1, Episode: 1, Video: 1, 'missing file (virtual)': 1, extra: 1, placeholder: 1 });
    expect(res.skippedSummary[0]).toMatch(/Skipped 6 items/);
    expect(res.notices.join('\n')).toMatch(/2 movies are not played/);
  });

  it('reads a 10.11 page the same way', () => {
    const old = mapJellyfinItems(page('items-10.11.json').Items).records;
    const cur = mapJellyfinItems(page('items-12.4.json').Items).records.slice(0, 2);
    expect(old).toEqual(cur.map((r) => (r.sourceTitle === 'Example Heist' ? { ...r, imdbIdHint: null } : r)));
  });

  it('never infers watched from PlayCount or the play position', () => {
    const res = mapJellyfinItems([movie({}, { PlayCount: 7, PlaybackPositionTicks: 99_000_000_000, PlayedPercentage: 95, LastPlayedDate: '2025-01-01T12:00:00Z' })]);
    expect(res.records[0]).not.toHaveProperty('status');
    expect(res.records[0]).not.toHaveProperty('watchedAt');
  });

  it('warns about played movies with no runtime, and --strict-played leaves their status alone', () => {
    const items = [movie({ RunTimeTicks: null }, { Played: true, LastPlayedDate: '2025-02-01T12:00:00Z' })];
    const loose = mapJellyfinItems(items);
    expect(loose.records[0]).toMatchObject({ status: 'watched' });
    expect(loose.warnings.join('\n')).toMatch(/1 played movies have no known runtime.*--strict-played/);
    const strict = mapJellyfinItems(items, { strictPlayed: true });
    expect(strict.records[0]).not.toHaveProperty('status');
    expect(strict.records[0]).not.toHaveProperty('watchedAt');
  });

  it('drops the dates of a bulk "mark played" (5 within 60 s) and keeps fewer', () => {
    const at = (s: number) => `2025-06-01T12:00:${String(s).padStart(2, '0')}.1234567Z`;
    const five = [0, 10, 20, 30, 59].map((s, i) => movie({ Name: `Bulk ${i}` }, { Played: true, LastPlayedDate: at(s) }));
    const lone = movie({ Name: 'Lone' }, { Played: true, LastPlayedDate: '2025-06-03T12:00:00Z' });
    const res = mapJellyfinItems([...five, lone]);
    expect(res.records.slice(0, 5).every((r) => r.status === 'watched' && r.watchedAt === undefined)).toBe(true);
    expect(res.records[5]).toMatchObject({ watchedAt: localDate('2025-06-03T12:00:00Z') });
    expect(res.notices.join('\n')).toMatch(/watched date of 5 movies/);
    // A whole library marked at once is found quickly, every item once.
    const many = Array.from({ length: 20_000 }, (_, i) => movie({ Name: `Many ${i}` }, { Played: true, LastPlayedDate: at(0) }));
    const t0 = Date.now();
    const big = mapJellyfinItems(many);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(big.notices.join('\n')).toMatch(/watched date of 20000 movies/);
    const four = mapJellyfinItems(five.slice(0, 4)).records;
    expect(four.every((r) => typeof r.watchedAt === 'string')).toBe(true);
    // Five spread over two minutes are never 5 within one minute.
    const spread = [0, 30, 60, 90, 120].map((s, i) =>
      movie({ Name: `Spread ${i}` }, { Played: true, LastPlayedDate: new Date(Date.parse('2025-06-01T12:00:00Z') + s * 1000).toISOString() }),
    );
    expect(mapJellyfinItems(spread).records.every((r) => typeof r.watchedAt === 'string')).toBe(true);
  });

  it('counts a played movie of unknown runtime toward a bulk group even under --strict-played', () => {
    const at = '2025-06-01T12:00:00Z';
    const five = [0, 1, 2, 3].map((i) => movie({ Name: `Bulk ${i}` }, { Played: true, LastPlayedDate: at }));
    five.push(movie({ Name: 'No Runtime', RunTimeTicks: null }, { Played: true, LastPlayedDate: at }));
    const res = mapJellyfinItems(five, { strictPlayed: true });
    expect(res.records.filter((r) => r.status === 'watched')).toHaveLength(4);
    expect(res.records.some((r) => r.watchedAt !== undefined)).toBe(false);
  });

  it('brings ratings in only with ratings: rounded, thumbs warned, 0 and out of range left out', () => {
    const items = [
      movie({ Name: 'Thumb' }, { Rating: 10, Likes: true }),
      movie({ Name: 'Score' }, { Rating: 7.5 }),
      movie({ Name: 'Zero' }, { Rating: 0 }),
      movie({ Name: 'Tiny' }, { Rating: 0.4 }),
      movie({ Name: 'None' }, { Rating: null }),
      movie({ Name: 'Huge' }, { Rating: 11 }),
    ];
    expect(mapJellyfinItems(items).records.some((r) => 'myRating' in r)).toBe(false);
    const res = mapJellyfinItems(items, { ratings: true });
    expect(res.records.map((r) => r.myRating)).toEqual([10, 8, undefined, undefined, undefined, undefined]);
    const w = res.warnings.join('\n');
    expect(w).toMatch(/1 ratings were not whole numbers/);
    expect(w).toMatch(/1 ratings are exactly 10 or 1/);
    expect(w).toMatch(/2 ratings outside 1 to 10/);
    // A rating alone is not watched.
    expect(res.records[1]).not.toHaveProperty('status');
  });

  it('folds two versions with one IMDb id: played wins, the later date stays', () => {
    const res = mapJellyfinItems([
      movie({ Name: 'Seven Lanterns', ProviderIds: { Imdb: 'tt9000004' } }, { Played: false }),
      movie({ Name: 'Seven Lanterns (4K)', ProviderIds: { Imdb: 'tt9000004' } }, { Played: true, LastPlayedDate: '2024-01-05T12:00:00Z' }),
      movie({ Name: 'Seven Lanterns', ProviderIds: { IMDB: 'TT9000004' } }, { Played: true, LastPlayedDate: '2024-03-05T12:00:00Z' }),
    ]);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ sourceTitle: 'Seven Lanterns', status: 'watched', watchedAt: localDate('2024-03-05T12:00:00Z') });
    expect(res.notices.join('\n')).toMatch(/2 movies are on the server more than once/);
  });

  it('takes the played version whole, so its own runtime decides which item it is', () => {
    const res = mapJellyfinItems([
      movie({ Name: 'Seven Lanterns', RunTimeTicks: 90 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { Played: false, Rating: 3 }),
      movie({ Name: 'Seven Lanterns', RunTimeTicks: 120 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { Played: true, Rating: 9, LastPlayedDate: '2024-01-05T12:00:00Z' }),
    ], { ratings: true });
    expect(res.records).toEqual([expect.objectContaining({ sourceRuntimeMin: 120, status: 'watched', myRating: 9 })]);
  });

  it('picks between unplayed versions by the latest LastPlayedDate', () => {
    const res = mapJellyfinItems([
      movie({ RunTimeTicks: 90 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { LastPlayedDate: '2023-01-05T12:00:00Z' }),
      movie({ RunTimeTicks: 120 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { LastPlayedDate: '2024-01-05T12:00:00Z' }),
    ]);
    expect(res.records).toEqual([expect.objectContaining({ sourceRuntimeMin: 120 })]);
    expect(res.records[0]).not.toHaveProperty('status');
  });

  it('with --strict-played, a played version of unknown runtime still wins (its rating with it), with no status', () => {
    const res = mapJellyfinItems(
      [
        movie({ ProviderIds: { Imdb: 'tt9000004' } }, { Rating: 3 }),
        movie({ RunTimeTicks: null, ProviderIds: { Imdb: 'tt9000004' } }, { Played: true, Rating: 9, LastPlayedDate: '2024-01-05T12:00:00Z' }),
      ],
      { strictPlayed: true, ratings: true },
    );
    expect(res.records).toEqual([expect.objectContaining({ sourceRuntimeMin: null, myRating: 9 })]);
    expect(res.records[0]).not.toHaveProperty('status');
  });

  it('handles missing and odd fields, and refuses items without UserData', () => {
    const res = mapJellyfinItems([
      movie({ ProviderIds: null, ProductionYear: null, Genres: null, People: 'x' }),
      movie({ ProviderIds: { Imdb: 'not-an-id' }, Name: '  ' }),
      'junk',
    ]);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toMatchObject({ imdbIdHint: null, sourceYear: null, sourceGenre: null, sourceDirector: null });
    expect(res.warnings.join('\n')).toMatch(/Item 2: no name/);
    expect(() => mapJellyfinItems([{ Name: 'X', Type: 'Movie' }])).toThrow(ImportError);
  });
});

// ---------------------------------------------------------------------------

interface Call {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit['redirect'];
}

type Route = (call: Call) => Response | Promise<Response>;

const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake server: routes by `METHOD /path` (after the base path). Records every call. */
function fakeServer(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    const path = url.pathname.replace(/^\/media/, '');
    const route = routes[`${call.method} ${path}`];
    if (!route) return jsonRes({ error: 'not found' }, 404);
    return route(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const login: Route = (c) =>
  (c.body as { Username: string; Pw: string }).Pw === 'hunter2'
    ? jsonRes({ AccessToken: SESSION, User: { Id: USER_ID, Name: 'orrin' } })
    : jsonRes({}, 401);

const pagesOf = (items: unknown[], size: number, totals?: number[]): Route => {
  let n = 0;
  return (c) => {
    const start = Number(c.url.searchParams.get('startIndex'));
    const total = totals?.[n] ?? items.length;
    n++;
    return jsonRes({ Items: items.slice(start, start + size), TotalRecordCount: total, StartIndex: start });
  };
};

const opts = (fetch: typeof globalThis.fetch, extra: Partial<JellyfinReadOptions> = {}): JellyfinReadOptions => ({
  url: `${SERVER}/`,
  auth: { userName: 'orrin', password: 'hunter2' },
  version: '0.0.0-test',
  deviceId: jellyfinDeviceId('/invented/home'),
  fetch,
  ...extra,
});

describe('readJellyfinItems', () => {
  it('signs in as the user, reads /Items with userId and the MediaBrowser header only, then signs out', async () => {
    const server = fakeServer({
      'POST /Users/AuthenticateByName': login,
      'GET /Items': () => jsonRes(page('items-12.4.json')),
      'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
    });
    const res = await readJellyfinItems(opts(server.fetch));
    expect(res.items).toHaveLength(10);
    expect(res.userName).toBe('orrin');
    expect(server.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'POST /media/Users/AuthenticateByName',
      'GET /media/Items',
      'POST /media/Sessions/Logout',
    ]);
    for (const c of server.calls) {
      expect(c.url.origin).toBe('https://jellyfin.example.test:8920');
      expect(Object.keys(c.headers).some((h) => /^x-(emby|mediabrowser)/i.test(h))).toBe(false);
      expect(c.url.searchParams.has('api_key')).toBe(false);
      expect(c.url.searchParams.has('ApiKey')).toBe(false);
      // Redirects are never followed, so the token never goes to another address.
      expect(c.redirect).toBe('manual');
      expect(c.headers.Authorization).toMatch(/^MediaBrowser Client="screentrackr", Device="screentrackr-cli", DeviceId="[0-9a-f]{32}", Version="0.0.0-test"/);
    }
    const [auth, items] = server.calls as [Call, Call];
    expect(auth.body).toEqual({ Username: 'orrin', Pw: 'hunter2' });
    expect(auth.headers.Authorization).not.toMatch(/Token=/);
    expect(items.headers.Authorization).toMatch(new RegExp(`Token="${SESSION}"$`));
    const q = Object.fromEntries(items.url.searchParams);
    expect(q).toMatchObject({
      userId: USER_ID,
      includeItemTypes: 'Movie',
      recursive: 'true',
      excludeLocationTypes: 'Virtual',
      collapseBoxSetItems: 'false',
      fields: 'ProviderIds,Genres,People,OriginalTitle,MediaSourceCount',
      enableUserData: 'true',
      enableImages: 'false',
      startIndex: '0',
    });
    expect(q.fields).not.toMatch(/Overview|Path/);
  });

  it('joins paths onto a root URL without a double slash', async () => {
    for (const url of ['http://jellyfin.example.test:8096', 'http://jellyfin.example.test:8096/']) {
      const server = fakeServer({
        'POST /Users/AuthenticateByName': login,
        'GET /Items': () => jsonRes({ Items: [], TotalRecordCount: 0 }),
        'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
      });
      await readJellyfinItems(opts(server.fetch, { url }));
      expect(server.calls.map((c) => c.url.pathname)).toEqual(['/Users/AuthenticateByName', '/Items', '/Sessions/Logout']);
    }
  });

  it('says so in the error when reading and signing out both fail', async () => {
    const server = fakeServer({
      'POST /Users/AuthenticateByName': login,
      'GET /Items': () => jsonRes({}, 500),
      'POST /Sessions/Logout': () => jsonRes({}, 500),
    });
    await expect(readJellyfinItems(opts(server.fetch))).rejects.toThrow(/HTTP 500\..*Could not sign out/);
  });

  it('says so when signing out fails', async () => {
    const server = fakeServer({
      'POST /Users/AuthenticateByName': login,
      'GET /Items': () => jsonRes({ Items: [], TotalRecordCount: 0 }),
      'POST /Sessions/Logout': () => jsonRes({}, 500),
    });
    expect((await readJellyfinItems(opts(server.fetch))).warnings.join('\n')).toMatch(/Could not sign out/);
  });

  it('signs out a session whose login reply has no user, and reads nothing', async () => {
    const server = fakeServer({
      'POST /Users/AuthenticateByName': () => jsonRes({ AccessToken: SESSION, User: {} }),
      'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
    });
    await expect(readJellyfinItems(opts(server.fetch))).rejects.toThrow(/did not return a session/);
    expect(server.calls.map((c) => c.url.pathname)).toEqual(['/media/Users/AuthenticateByName', '/media/Sessions/Logout']);
  });

  it('accepts an empty password (an account without one)', async () => {
    const server = fakeServer({
      'POST /Users/AuthenticateByName': (c) => jsonRes({ AccessToken: SESSION, User: { Id: USER_ID, Name: (c.body as { Username: string }).Username } }),
      'GET /Items': () => jsonRes({ Items: [], TotalRecordCount: 0 }),
      'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
    });
    await readJellyfinItems(opts(server.fetch, { auth: { userName: 'kid', password: '' } }));
    expect(server.calls[0]?.body).toEqual({ Username: 'kid', Pw: '' });
  });

  it('pages until the count is reached, and reads again when the count changes mid-run', async () => {
    const items = Array.from({ length: 5 }, (_, i) => movie({ Id: `m${i}`, Name: `Movie ${i}` }));
    const server = fakeServer({
      'POST /Users/AuthenticateByName': login,
      // The count grows during the read, as in a library scan.
      'GET /Items': pagesOf(items, 2, [4, 5, 5, 5]),
      'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
    });
    const res = await readJellyfinItems(opts(server.fetch, { pageSize: 2 }));
    expect(res.items).toHaveLength(5);
    expect(server.calls.filter((c) => c.url.pathname.endsWith('/Items')).map((c) => c.url.searchParams.get('startIndex'))).toEqual([
      '0', '2', '4',
      '0', '2', '4',
    ]);
  });

  it('refuses a read that never comes back whole (shifted pages or an early empty page), and still signs out', async () => {
    const shifted = [movie({ Id: 'a' }), movie({ Id: 'b' }), movie({ Id: 'b' }), movie({ Id: 'd' })];
    const cases: Route[] = [
      (c) => jsonRes({ Items: c.url.searchParams.get('startIndex') === '0' ? shifted.slice(0, 2) : shifted.slice(2), TotalRecordCount: 4 }),
      (c) => jsonRes({ Items: c.url.searchParams.get('startIndex') === '0' ? [movie({ Id: 'a' })] : [], TotalRecordCount: 50 }),
    ];
    for (const items of cases) {
      const server = fakeServer({
        'POST /Users/AuthenticateByName': login,
        'GET /Items': items,
        'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
      });
      await expect(readJellyfinItems(opts(server.fetch, { pageSize: 2 }))).rejects.toThrow(/kept changing while it was read.*Nothing was imported/);
      expect(server.calls.filter((c) => c.url.pathname.endsWith('/Items')).length).toBeGreaterThanOrEqual(6);
      expect(server.calls.at(-1)?.url.pathname).toBe('/media/Sessions/Logout');
    }
  });

  it('reads until an empty page when the server sends no count', async () => {
    const server = fakeServer({
      'POST /Users/AuthenticateByName': login,
      'GET /Items': (c) => jsonRes({ Items: c.url.searchParams.get('startIndex') === '0' ? [movie({ Id: 'a' })] : [] }),
      'POST /Sessions/Logout': () => new Response(null, { status: 204 }),
    });
    expect((await readJellyfinItems(opts(server.fetch))).items).toHaveLength(1);
  });

  it('with a token, reads for the token\'s own user and never logs out', async () => {
    const server = fakeServer({
      'GET /Users/Me': () => jsonRes({ Id: USER_ID, Name: 'Orrin' }),
      'GET /Items': () => jsonRes({ Items: [], TotalRecordCount: 0 }),
    });
    const res = await readJellyfinItems(opts(server.fetch, { auth: { token: TOKEN, userName: 'orrin' } }));
    expect(res.userName).toBe('Orrin');
    expect(server.calls.map((c) => c.url.pathname)).toEqual(['/media/Users/Me', '/media/Items']);
    expect(server.calls[1]?.url.searchParams.get('userId')).toBe(USER_ID);
    expect(server.calls.every((c) => c.headers.Authorization?.endsWith(`Token="${TOKEN}"`))).toBe(true);
  });

  it('refuses a token that belongs to someone other than --user', async () => {
    const server = fakeServer({ 'GET /Users/Me': () => jsonRes({ Id: USER_ID, Name: 'mira' }) });
    await expect(readJellyfinItems(opts(server.fetch, { auth: { token: TOKEN, userName: 'orrin' } }))).rejects.toThrow(/different Jellyfin user/);
    expect(server.calls).toHaveLength(1);
  });

  it('with an admin API key, finds the user by name, or uses --user-id', async () => {
    const server = fakeServer({
      'GET /Users/Me': () => jsonRes({}, 400),
      'GET /Users': () => jsonRes([{ Id: 'other', Name: 'mira' }, { Id: USER_ID, Name: 'Orrin' }]),
      'GET /Items': () => jsonRes({ Items: [], TotalRecordCount: 0 }),
    });
    await readJellyfinItems(opts(server.fetch, { auth: { token: TOKEN, userName: 'orrin' } }));
    expect(server.calls.at(-1)?.url.searchParams.get('userId')).toBe(USER_ID);
    await expect(readJellyfinItems(opts(server.fetch, { auth: { token: TOKEN } }))).rejects.toThrow(/--user <name> or --user-id/);
    await expect(readJellyfinItems(opts(server.fetch, { auth: { token: TOKEN, userName: 'nobody' } }))).rejects.toThrow(/No single Jellyfin user/);
    const direct = fakeServer({ 'GET /Items': () => jsonRes({ Items: [], TotalRecordCount: 0 }) });
    await readJellyfinItems(opts(direct.fetch, { auth: { token: TOKEN, userId: USER_ID } }));
    expect(direct.calls.map((c) => c.url.pathname)).toEqual(['/media/Items']);
  });

  it('never puts the token or password in an error, and signs out when reading fails', async () => {
    const failures: [string, Record<string, Route>, Partial<JellyfinReadOptions>][] = [
      ['refused', { 'GET /Users/Me': () => jsonRes({}, 401) }, { auth: { token: TOKEN } }],
      ['bad password', { 'POST /Users/AuthenticateByName': () => jsonRes({}, 401) }, { auth: { userName: 'orrin', password: 'wrong-hunter2' } }],
      ['server error', { 'POST /Users/AuthenticateByName': login, 'GET /Items': () => jsonRes({}, 500), 'POST /Sessions/Logout': () => new Response(null, { status: 204 }) }, {}],
      ['redirect', { 'GET /Users/Me': () => new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example.test/' } }) }, { auth: { token: TOKEN } }],
      ['not json', { 'GET /Users/Me': () => jsonRes({ Id: USER_ID, Name: 'orrin' }), 'GET /Items': () => new Response('<html>', { status: 200 }) }, { auth: { token: TOKEN } }],
    ];
    for (const [name, routes, extra] of failures) {
      const server = fakeServer(routes);
      const err = (await readJellyfinItems(opts(server.fetch, extra)).catch((e: unknown) => e)) as Error;
      expect(err, name).toBeInstanceOf(ImportError);
      expect(err.message, name).not.toContain(TOKEN);
      expect(err.message, name).not.toContain(SESSION);
      expect(err.message, name).not.toContain('hunter2');
      expect(err.message, name).toContain('https://jellyfin.example.test:8920/media');
      if (name === 'server error') expect(server.calls.at(-1)?.url.pathname).toBe('/media/Sessions/Logout');
      // Never follows a redirect, so the token never goes to another host.
      expect(server.calls.every((c) => c.url.hostname === 'jellyfin.example.test'), name).toBe(true);
    }
  });

  it('turns a network failure or timeout into a plain message', async () => {
    const down = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    await expect(readJellyfinItems(opts(down as unknown as typeof fetch))).rejects.toThrow(/Could not reach the Jellyfin server at https:\/\/jellyfin\.example\.test:8920\/media: ECONNREFUSED/);
    const slow = vi.fn(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(readJellyfinItems(opts(slow as unknown as typeof fetch))).rejects.toThrow(/--timeout/);
  });

  it('refuses items without the user\'s UserData', async () => {
    const server = fakeServer({
      'GET /Items': () => jsonRes({ Items: [{ Id: 'x', Name: 'X', Type: 'Movie' }], TotalRecordCount: 1 }),
    });
    const read = await readJellyfinItems(opts(server.fetch, { auth: { token: TOKEN, userId: USER_ID } }));
    expect(() => mapJellyfinItems(read.items)).toThrow(/UserData/);
  });
});

describe('serverBase', () => {
  it('keeps a base path, drops trailing slashes, and refuses credentials, queries and other schemes', () => {
    expect(serverBase('http://localhost:8096').href).toBe('http://localhost:8096/');
    expect(serverBase(' https://jellyfin.example.test/jf// ').pathname).toBe('/jf');
    for (const bad of ['ftp://jellyfin.example.test', 'not a url', 'https://u:p@jellyfin.example.test', `https://jellyfin.example.test/?ApiKey=${TOKEN}`, 'https://jellyfin.example.test/#x']) {
      const err = (() => {
        try {
          serverBase(bad);
        } catch (e) {
          return e as Error;
        }
        return null;
      })();
      expect(err, bad).toBeInstanceOf(ImportError);
      expect(err?.message).not.toContain(TOKEN);
    }
  });

  it('derives a stable device id without storing anything', () => {
    expect(jellyfinDeviceId('/a')).toBe(jellyfinDeviceId('/a'));
    expect(jellyfinDeviceId('/a')).not.toBe(jellyfinDeviceId('/b'));
  });
});

// ---------------------------------------------------------------------------

describe('merging a Jellyfin import', () => {
  let tmp: string;
  let db: Db;
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'screentrackr-jellyfin-'));
    db = openDb(join(tmp, 'home'));
    await buildCatalog(db, { cacheDir: IMDB });
  });
  afterAll(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    db.sql.exec('DELETE FROM match_candidates; DELETE FROM item_external_ids; DELETE FROM library_items;');
  });
  const items = (): LibraryItem[] =>
    (db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[]).map(rowToItem);

  it('adds owned items matched by the IMDb hint, and a repeat changes nothing', () => {
    const records = mapJellyfinItems(page('items-12.4.json').Items).records;
    expect(applyImport(db, records, { mode: 'merge' })).toMatchObject({ added: 4 });
    const got = items();
    expect(got.map((i) => [i.sourceTitle, i.tconst, i.status, i.owned, i.source, i.myRating])).toEqual([
      ['The Glass Harbor', 'tt9000001', 'watched', true, 'jellyfin', null],
      ['Example Heist', null, 'queue', true, 'jellyfin', null],
      ['Quiet Ledger', 'tt9000003', 'queue', true, 'jellyfin', null],
      ['Night Ferry', 'tt9000010', 'watched', true, 'jellyfin', null],
    ]);
    expect(applyImport(db, records, { mode: 'merge' })).toMatchObject({ added: 0, updated: 0, unchanged: 4 });
  });

  it('never moves a watched movie out of watched, never clears a rating, and never changes owned', () => {
    applyImport(
      db,
      [
        { sourceTitle: 'Quiet Ledger', sourceYear: 1999, sourceDirector: 'Dana Fincher', status: 'watched', myRating: 9, owned: false, source: 'imdb' },
        { sourceTitle: 'The Glass Harbor', sourceYear: 1978, status: 'priority', owned: false, source: 'imdb', sourceGenre: 'Noir' },
      ],
      { mode: 'merge' },
    );
    const records = mapJellyfinItems(page('items-12.4.json').Items).records;
    applyImport(db, records, { mode: 'merge' });
    const byTitle = Object.fromEntries(items().map((i) => [i.sourceTitle, i]));
    expect(byTitle['Quiet Ledger']).toMatchObject({ status: 'watched', myRating: 9, owned: false });
    // Played upgrades priority to watched; the existing genre stays (fill only).
    expect(byTitle['The Glass Harbor']).toMatchObject({ status: 'watched', owned: false, sourceGenre: 'Noir', sourceDirector: 'Orrin Vale' });
    expect(items()).toHaveLength(4);
  });

  it('marks the existing item watched when only one of two versions is played, and adds no duplicate', () => {
    applyImport(db, [{ sourceTitle: 'Seven Lanterns', sourceYear: 1995, sourceRuntimeMin: 120, status: 'queue', source: 'paste' }], { mode: 'merge' });
    const records = mapJellyfinItems([
      movie({ Name: 'Seven Lanterns', RunTimeTicks: 90 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { Played: false }),
      movie({ Name: 'Seven Lanterns', RunTimeTicks: 120 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { Played: true, LastPlayedDate: '2024-01-05T12:00:00Z' }),
    ]).records;
    expect(applyImport(db, records, { mode: 'merge' })).toMatchObject({ added: 0, updated: 1 });
    expect(items().map((i) => [i.sourceRuntimeMin, i.status])).toEqual([[120, 'watched']]);
  });

  it('with two unplayed versions, the last played one stands for the film and adds no duplicate', () => {
    applyImport(db, [{ sourceTitle: 'Seven Lanterns', sourceYear: 1995, sourceRuntimeMin: 120, status: 'priority', source: 'paste' }], { mode: 'merge' });
    const records = mapJellyfinItems([
      movie({ RunTimeTicks: 90 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { LastPlayedDate: '2023-01-05T12:00:00Z' }),
      movie({ RunTimeTicks: 120 * 600_000_000, ProviderIds: { Imdb: 'tt9000004' } }, { LastPlayedDate: '2024-01-05T12:00:00Z' }),
    ]).records;
    applyImport(db, records, { mode: 'merge' });
    expect(items().map((i) => [i.sourceRuntimeMin, i.status])).toEqual([[120, 'priority']]);
  });
});

// ---------------------------------------------------------------------------

describe('import jellyfin (command)', () => {
  let tmp: string;
  let out: string[];
  let log: string[];
  let ctx: Ctx & { _db?: Db };
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'screentrackr-jellyfin-cmd-'));
    out = [];
    log = [];
    let db: Db | undefined;
    ctx = {
      home: join(tmp, 'home'),
      json: true,
      tty: false,
      color: false,
      width: undefined,
      db: () => (db ??= openDb(join(tmp, 'home'))),
      out: (t) => out.push(t),
      log: (t) => log.push(t),
      emit: (data) => out.push(JSON.stringify(data)),
      close: () => db?.close(),
    };
  });
  afterEach(() => {
    ctx.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  const run = (args: Record<string, string | boolean>) => importCmd.run(ctx, ['jellyfin'], args);

  it('imports with JELLYFIN_TOKEN and never prints the token', async () => {
    const server = fakeServer({
      'GET /Users/Me': () => jsonRes({ Id: USER_ID, Name: 'orrin' }),
      'GET /Items': () => jsonRes(page('items-12.4.json')),
    });
    vi.stubGlobal('fetch', server.fetch);
    vi.stubEnv('JELLYFIN_TOKEN', TOKEN);
    await run({ url: SERVER, user: 'orrin', ratings: true });
    const summary = JSON.parse(out[0] as string) as Record<string, unknown>;
    expect(summary).toMatchObject({ format: 'jellyfin', records: 4, added: 4 });
    expect(summary.skippedByType).toMatchObject({ BoxSet: 1 });
    const all = [...out, ...log].join('\n');
    expect(all).not.toContain(TOKEN);
    expect(all).toMatch(/Read 10 items for orrin/);
    expect(ctx.db().sql.prepare("SELECT my_rating FROM library_items WHERE source_title = 'Quiet Ledger'").get()).toEqual({ my_rating: 8 });
    expect(server.calls.every((c) => c.url.hostname === 'jellyfin.example.test')).toBe(true);
  });

  it('checks its flags before any request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('JELLYFIN_TOKEN', '');
    await expect(run({})).rejects.toThrow(/--url <server>/);
    await expect(run({ url: SERVER })).rejects.toThrow(/--user <name>/);
    await expect(run({ url: SERVER, user: 'orrin' })).rejects.toThrow(/--password-stdin/);
    await expect(run({ url: SERVER, user: 'orrin', 'user-id': USER_ID })).rejects.toThrow(/--user-id only applies with a token/);
    await expect(run({ url: SERVER, 'token-stdin': true, 'password-stdin': true })).rejects.toThrow(/not both/);
    await expect(run({ url: SERVER, format: 'csv' })).rejects.toThrow(/--format does not apply/);
    await expect(run({ url: SERVER, as: 'watchlist' })).rejects.toThrow(/only apply to IMDb/);
    await expect(importCmd.run(ctx, ['some.csv'], { ratings: true })).rejects.toThrow(/only apply to `import jellyfin`/);
    await expect(importCmd.run(ctx, ['some.csv'], { url: SERVER })).rejects.toThrow(/only apply to `import jellyfin`/);
    vi.stubEnv('JELLYFIN_TOKEN', TOKEN);
    await expect(run({ url: SERVER, user: 'orrin', 'password-stdin': true })).rejects.toThrow(/Unset JELLYFIN_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses to read a token or password typed at the terminal, where it would echo', async () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubEnv('JELLYFIN_TOKEN', '');
    const was = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(run({ url: SERVER, 'token-stdin': true })).rejects.toThrow(/from a pipe or file/);
      await expect(run({ url: SERVER, user: 'orrin', 'password-stdin': true })).rejects.toThrow(/from a pipe or file/);
    } finally {
      if (was) Object.defineProperty(process.stdin, 'isTTY', was);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it('refuses --replace before any request, so a watched movie or a rating is never lost', async () => {
    const db = ctx.db();
    applyImport(db, [{ sourceTitle: 'Quiet Ledger', sourceYear: 1999, status: 'watched', myRating: 9, source: 'paste' }], { mode: 'merge' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('JELLYFIN_TOKEN', TOKEN);
    await expect(run({ url: SERVER, 'user-id': USER_ID, replace: true })).rejects.toThrow(/--replace does not apply/);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.sql.prepare('SELECT status, my_rating FROM library_items').all()).toEqual([{ status: 'watched', my_rating: 9 }]);
  });
});

describe('promptHidden', () => {
  it('turns echo off before showing the question, never writes what is typed, and restores the terminal', async () => {
    const order: string[] = [];
    let listener: ((chunk: string) => void) | undefined;
    const input: SecretInput = {
      setRawMode: (m: boolean) => order.push(`raw:${m}`),
      resume: () => order.push('resume'),
      pause: () => order.push('pause'),
      setEncoding: () => undefined,
      on: (_e: 'data', l: (chunk: string) => void) => {
        listener = l;
      },
      removeListener: () => {
        listener = undefined;
      },
    };
    const written: string[] = [];
    const output = {
      write: (t: string) => {
        order.push(`write:${t}`);
        written.push(t);
        // A password manager types as soon as it sees the prompt.
        if (t.startsWith('Password')) listener?.('hunter\u007f2\r');
      },
    };
    await expect(promptHidden('Password: ', input, output)).resolves.toBe('hunte2');
    expect(order.indexOf('raw:true')).toBeLessThan(order.indexOf('write:Password: '));
    expect(order.slice(-3)).toEqual(['raw:false', 'pause', 'write:\n']);
    expect(written.join('')).not.toContain('hunte');
  });
});

/**
 * The Plex Media Server importer. Every request goes to a mocked fetch: no
 * test talks to a network. Every title, person, id, server and token here is
 * invented.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { applyImport, ImportError, type ImportRecord } from '../src/core/importers/index.js';
import { titleEditionTag } from '../src/core/normalize.js';
import {
  mapPlexItems,
  parsePlexDump,
  plexBaseUrl,
  readPlexLibrary,
  type PlexMetadata,
  type PlexReadOptions,
} from '../src/core/importers/plex.js';
import { LIBRARY_COLUMNS, rowToItem, type LibraryRow } from '../src/core/library.js';
import type { LibraryItem } from '../src/core/types.js';

const IMDB = join(import.meta.dirname, 'fixtures', 'imdb');
const TOKEN = 'fake-token-Zq81xP';
const SERVER = 'http://127.0.0.1:32400';
/** Noon UTC on a day, in epoch seconds, so the local calendar day is the same in most time zones. */
const noon = (day: string) => Math.floor(Date.parse(`${day}T12:00:00Z`) / 1000);

let tmp: string;
let db: Db;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-plex-'));
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

function items(): LibraryItem[] {
  return (db.sql.prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_items ORDER BY id`).all() as unknown as LibraryRow[]).map(rowToItem);
}

// ---------- a fake Plex Media Server ----------

interface Call {
  url: URL;
  init: RequestInit;
}

interface FakeServer {
  sections: unknown[];
  /** Section key to its movies. */
  movies: Record<string, PlexMetadata[]>;
  /** Extra detail for /library/metadata/{ids}, by ratingKey. */
  details?: Record<string, PlexMetadata>;
  /** Page size the server really uses, whatever was asked (default: as asked). */
  serverPageSize?: number;
  /** Leave totalSize out of the container (the header still carries it unless noTotal). */
  noContainerTotal?: boolean;
  noTotal?: boolean;
  /** Ignore paging entirely: every request gets the whole list. */
  ignorePaging?: boolean;
  /** Drop Guid from listings (includeGuids ignored). */
  ignoreIncludeGuids?: boolean;
}

function fakeFetch(server: FakeServer): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  const impl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const path = url.pathname;
    if (path === '/library/sections/all') return json({ MediaContainer: { size: server.sections.length, Directory: server.sections } });
    const list = /^\/library\/sections\/([^/]+)\/all$/.exec(path);
    if (list) {
      const all = (server.movies[decodeURIComponent(list[1] as string)] ?? []).map((m) =>
        server.ignoreIncludeGuids ? { ...m, Guid: undefined } : m,
      );
      const headers = new Headers(init.headers);
      const start = server.ignorePaging ? 0 : Number(headers.get('X-Plex-Container-Start') ?? 0);
      const asked = Number(headers.get('X-Plex-Container-Size') ?? all.length);
      const size = server.ignorePaging ? all.length : (server.serverPageSize ?? asked);
      const page = all.slice(start, start + size);
      const mc: Record<string, unknown> = { size: page.length, offset: start, librarySectionID: Number(list[1]), Metadata: page };
      if (!server.noContainerTotal && !server.noTotal) mc.totalSize = all.length;
      return json({ MediaContainer: mc }, server.noTotal ? {} : { 'X-Plex-Container-Total-Size': String(all.length) });
    }
    const meta = /^\/library\/metadata\/(.+)$/.exec(path);
    if (meta) {
      const keys = (meta[1] as string).split(',').map(decodeURIComponent);
      const found = keys.map((k) => server.details?.[k]).filter(Boolean);
      return json({ MediaContainer: { size: found.length, Metadata: found } });
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const SECTIONS = [
  { key: '3', type: 'movie', title: 'Movies', agent: 'tv.plex.agents.movie', uuid: 'u-3' },
  { key: '7', type: 'movie', title: 'Home Videos', agent: 'tv.plex.agents.none', uuid: 'u-7' },
  { key: '4', type: 'show', title: 'TV', agent: 'tv.plex.agents.series', uuid: 'u-4' },
];

const glassHarbor2009: PlexMetadata = {
  ratingKey: '5012',
  type: 'movie',
  guid: 'plex://movie/5d77aaaa0000000000000001',
  title: 'The Glass Harbor',
  year: 2009,
  duration: 128 * 60000,
  userRating: 7.0,
  viewCount: 2,
  lastViewedAt: noon('2024-06-10'),
  addedAt: 1600000000,
  summary: 'An invented summary that must never be stored.',
  thumb: '/library/metadata/5012/thumb/1',
  Guid: [{ id: 'imdb://tt9000002' }, { id: 'tmdb://900002' }],
  Director: [{ tag: 'Teodor Brask' }],
  Genre: [{ tag: 'Mystery' }, { tag: 'Thriller' }],
  Collection: [{ tag: 'Harbor Films' }],
  Media: [
    { id: 1, duration: 128 * 60000, videoResolution: '1080' },
    { id: 2, duration: 128 * 60000 + 1000, videoResolution: '4k' },
  ],
};
const lanternSeason: PlexMetadata = {
  ratingKey: '5013',
  type: 'movie',
  guid: 'local://5013',
  title: 'Lantern Season',
  year: 1978,
  duration: 90 * 60000,
  addedAt: 1600000100,
};

function opts(server: FakeServer, extra: Partial<PlexReadOptions> = {}): PlexReadOptions & { calls: Call[] } {
  const { fetch, calls } = fakeFetch(server);
  return { url: SERVER, token: TOKEN, clientId: 'client-0001', version: '0.0.0-test', fetch, calls, ...extra };
}

const read = (server: FakeServer, extra: Partial<PlexReadOptions> = {}) => {
  const o = opts(server, extra);
  return readPlexLibrary(o).then((res) => ({ ...res, calls: o.calls }));
};

const FORBIDDEN = ['checkFiles', 'asyncCheckFiles', 'asyncRefreshLocalMediaAgent', 'asyncRefreshAnalysis', 'asyncAugmentMetadata', 'skipRefresh', 'checkFileAvailability', 'augmentCount'];

function expectSafeRequests(calls: Call[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.url.href).not.toContain(TOKEN);
    for (const p of c.url.searchParams.keys()) {
      expect(FORBIDDEN.map((f) => f.toLowerCase())).not.toContain(p.toLowerCase());
      expect(p.toLowerCase().startsWith('async')).toBe(false);
      expect(p.toLowerCase()).not.toBe('x-plex-token');
    }
    expect(c.init.method ?? 'GET').toBe('GET');
    expect(c.init.redirect).toBe('error');
    const h = new Headers(c.init.headers);
    expect(h.get('X-Plex-Token')).toBe(TOKEN);
    expect(h.get('Accept')).toBe('application/json');
    expect(h.get('X-Plex-Product')).toBe('ScreenTrackr');
    expect(h.get('X-Plex-Client-Identifier')).toBe('client-0001');
  }
}

// ---------- the server URL ----------

describe('the server URL', () => {
  it('accepts http and https and drops a trailing slash', () => {
    expect(plexBaseUrl('http://127.0.0.1:32400/').href).toBe('http://127.0.0.1:32400/');
    expect(plexBaseUrl('https://plex.example.test:32400').origin).toBe('https://plex.example.test:32400');
  });

  it('refuses other schemes, credentials and a token in the query string', () => {
    expect(() => plexBaseUrl('ftp://127.0.0.1')).toThrow(ImportError);
    expect(() => plexBaseUrl('not a url')).toThrow(ImportError);
    expect(() => plexBaseUrl('http://user:pw@127.0.0.1:32400')).toThrow(/user name or password/);
    let msg = '';
    try {
      plexBaseUrl(`http://127.0.0.1:32400/?X-Plex-Token=${TOKEN}`);
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(/query string/);
    expect(msg).not.toContain(TOKEN);
  });
});

// ---------- reading the server ----------

describe('reading the server', () => {
  it('lists movie sections, skips other-videos and show sections, and sends only safe, read-only requests', async () => {
    const res = await read({ sections: SECTIONS, movies: { '3': [glassHarbor2009, lanternSeason], '7': [{ ...lanternSeason, ratingKey: 'h1', title: 'Beach Day' }] } });
    expect(res.records.map((r) => r.sourceTitle)).toEqual(['The Glass Harbor', 'Lantern Season']);
    expect(res.sections.map((s) => s.title)).toEqual(['Movies']);
    expect(res.notices.join('\n')).toMatch(/Home Videos/);
    expectSafeRequests(res.calls);
    expect(res.calls.some((c) => c.url.pathname.startsWith('/library/sections/4'))).toBe(false);
    const listing = res.calls.find((c) => c.url.pathname === '/library/sections/3/all') as Call;
    expect(listing.url.searchParams.get('type')).toBe('1');
    expect(listing.url.searchParams.get('includeGuids')).toBe('1');
    expect(listing.url.searchParams.get('excludeFields')).toMatch(/summary/);
  });

  it('includes other-videos sections when asked, and picks sections by name or key', async () => {
    const server = { sections: SECTIONS, movies: { '3': [glassHarbor2009], '7': [{ ...lanternSeason, ratingKey: 'h1', title: 'Beach Day' }] } };
    expect((await read(server, { includeOtherVideos: true })).records).toHaveLength(2);
    expect((await read(server, { sections: ['home videos'] })).records.map((r) => r.sourceTitle)).toEqual(['Beach Day']);
    expect((await read(server, { sections: ['3'] })).records.map((r) => r.sourceTitle)).toEqual(['The Glass Harbor']);
    await expect(read(server, { sections: ['Nope'] })).rejects.toThrow(/No movie library named "Nope".*Movies.*Home Videos/s);
    await expect(read(server, { sections: ['TV'] })).rejects.toThrow(/not a movie library/);
  });

  it('pages until the total, also when the server returns a different page size than asked', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...lanternSeason, ratingKey: `k${i}`, title: `Invented Film ${i}` }));
    for (const server of [
      { sections: SECTIONS.slice(0, 1), movies: { '3': many }, serverPageSize: 3 },
      { sections: SECTIONS.slice(0, 1), movies: { '3': many }, serverPageSize: 3, noContainerTotal: true },
    ]) {
      const res = await read(server, { pageSize: 5 });
      expect(res.records.map((r) => r.sourceTitle)).toEqual(many.map((m) => m.title));
      expect(res.calls.filter((c) => c.url.pathname.endsWith('/all') && c.url.pathname !== '/library/sections/all')).toHaveLength(3);
    }
  });

  it('stops on a server that ignores paging or gives no total, without repeating movies', async () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ ...lanternSeason, ratingKey: `k${i}`, title: `Invented Film ${i}` }));
    const ignoring = await read({ sections: SECTIONS.slice(0, 1), movies: { '3': many }, ignorePaging: true, noTotal: true }, { pageSize: 2 });
    expect(ignoring.records).toHaveLength(4);
    // A repeated page with no total can't show nothing is missing.
    expect(ignoring.complete).toBe(false);
    const noTotal = await read({ sections: SECTIONS.slice(0, 1), movies: { '3': many }, noTotal: true }, { pageSize: 3 });
    expect(noTotal.records).toHaveLength(4);
    expect(noTotal.complete).toBe(true);
  });

  it('marks a listing incomplete when overlapping pages reach the total by position but miss movies', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((k) => ({ ...lanternSeason, ratingKey: k, title: `Invented Film ${k}` }));
    const pages = [[a, b], [b, c]];
    const { fetch } = fakeFetch({ sections: SECTIONS.slice(0, 1), movies: {} });
    let n = 0;
    const overlapping = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/library/sections/3/all') return fetch(input, init);
      const page = pages[n++] ?? [];
      return new Response(JSON.stringify({ MediaContainer: { size: page.length, totalSize: 4, Metadata: page } }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: overlapping, pageSize: 2 });
    expect(res.records).toHaveLength(3);
    expect(res.complete).toBe(false);
    expect(res.warnings.join('\n')).toMatch(/3 of 4/);
  });

  /** A section-3 listing that answers each request with the next of `pages` (body and headers). */
  const scripted = (pages: { body: unknown; headers?: Record<string, string> }[]) => {
    const { fetch, calls } = fakeFetch({ sections: SECTIONS.slice(0, 1), movies: {} });
    let n = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== '/library/sections/3/all') return fetch(input, init);
      const p = pages[n++] ?? { body: { MediaContainer: { size: 0 } } };
      return new Response(JSON.stringify(p.body), { headers: { 'content-type': 'application/json', ...p.headers } });
    }) as typeof fetch;
    return { fetch: impl, calls };
  };
  const film = (k: string) => ({ ...lanternSeason, ratingKey: k, title: `Invented Film ${k}` });

  it('does not trust overlapping pages without a total, even when they end on an empty page', async () => {
    const { fetch } = scripted([
      { body: { MediaContainer: { size: 2, Metadata: [film('a'), film('b')] } } },
      { body: { MediaContainer: { size: 2, Metadata: [film('b'), film('c')] } } },
      { body: { MediaContainer: { size: 0 } } },
    ]);
    const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch, pageSize: 2 });
    expect(res.records).toHaveLength(3);
    expect(res.complete).toBe(false);
  });

  it('refuses a library list shorter than its own size', async () => {
    const { fetch } = fakeFetch({ sections: SECTIONS.slice(0, 1), movies: { '3': [film('a')] } });
    const short = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/library/sections/all') {
        return new Response(JSON.stringify({ MediaContainer: { size: 2, Directory: SECTIONS.slice(0, 1) } }), { headers: { 'content-type': 'application/json' } });
      }
      return fetch(input, init);
    }) as typeof fetch;
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: short })).rejects.toThrow(/2 libraries but listed 1/);
  });

  it('does not trust a read holding movies without a ratingKey', async () => {
    const bare = { ...film('a'), ratingKey: undefined };
    const { fetch } = scripted([
      { body: { MediaContainer: { size: 1, totalSize: 2, Metadata: [bare] } } },
      { body: { MediaContainer: { size: 1, totalSize: 2, Metadata: [bare] } } },
    ]);
    const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch, pageSize: 1 });
    expect(res.complete).toBe(false);
    expect(res.warnings.join('\n')).toMatch(/without a Plex id/);
  });

  it('trusts an empty page only when it says size 0', async () => {
    const first = { body: { MediaContainer: { size: 1, Metadata: [film('a')] } } };
    const claims = scripted([first, { body: { MediaContainer: { size: 200 } } }]);
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: claims.fetch, pageSize: 1 })).rejects.toThrow(
      /said it sent 200 movies/,
    );
    const emptyList = scripted([first, { body: { MediaContainer: { size: 200, Metadata: [] } } }]);
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: emptyList.fetch, pageSize: 1 })).rejects.toThrow(
      /said it sent 200 movies/,
    );
    const short = scripted([{ body: { MediaContainer: { size: 200, Metadata: [film('a')] } } }, { body: { MediaContainer: { size: 0 } } }]);
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: short.fetch, pageSize: 200 })).rejects.toThrow(
      /said it sent 200 movies but sent 1/,
    );
    const sizeless = scripted([first, { body: { MediaContainer: { Metadata: [] } } }]);
    const r = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: sizeless.fetch, pageSize: 1 });
    expect(r.complete).toBe(false);
    const silent = scripted([first, { body: { MediaContainer: {} } }]);
    const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: silent.fetch, pageSize: 1 });
    expect(res.complete).toBe(false);
    const explicit = scripted([first, { body: { MediaContainer: { size: 0 } } }]);
    expect((await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: explicit.fetch, pageSize: 1 })).complete).toBe(true);
  });

  it('takes the larger of the body and header totals', async () => {
    const { fetch } = scripted([
      { body: { MediaContainer: { size: 2, totalSize: 2, Metadata: [film('a'), film('b')] } }, headers: { 'X-Plex-Container-Total-Size': '5' } },
      { body: { MediaContainer: { size: 0, totalSize: 2 } } },
    ]);
    const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch, pageSize: 2 });
    expect(res.complete).toBe(false);
  });

  it('refuses a listing answer without a MediaContainer instead of reading it as the end', async () => {
    const { fetch } = scripted([{ body: { MediaContainer: { size: 2, Metadata: [film('a'), film('b')] } } }, { body: { error: 'busy' } }]);
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch, pageSize: 2 })).rejects.toThrow(/MediaContainer/);
  });

  it('reads a library named twice (by title and by key) once', async () => {
    const res = await read({ sections: SECTIONS, movies: { '3': [lanternSeason] } }, { sections: ['Movies', '3'] });
    expect(res.records).toHaveLength(1);
    expect(res.calls.filter((c) => c.url.pathname === '/library/sections/3/all')).toHaveLength(1);
  });

  it('keeps the largest reported total when a later page drops or lowers it', async () => {
    const [a, b] = ['a', 'b'].map((k) => ({ ...lanternSeason, ratingKey: k, title: `Invented Film ${k}` }));
    for (const last of [{}, { totalSize: 0 }]) {
      const pages = [{ size: 2, totalSize: 5, Metadata: [a, b] }, { size: 0, Metadata: [], ...last }];
      const { fetch } = fakeFetch({ sections: SECTIONS.slice(0, 1), movies: {} });
      let n = 0;
      const shrinking = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname !== '/library/sections/3/all') return fetch(input, init);
        return new Response(JSON.stringify({ MediaContainer: pages[n++] ?? { size: 0, Metadata: [] } }), {
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;
      const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: shrinking, pageSize: 2 });
      expect(res.records).toHaveLength(2);
      expect(res.complete).toBe(false);
    }
  });

  it('keeps paging past a short page when the server caps the page size and gives no total', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...lanternSeason, ratingKey: `k${i}`, title: `Invented Film ${i}` }));
    const res = await read({ sections: SECTIONS.slice(0, 1), movies: { '3': many }, serverPageSize: 2, noTotal: true }, { pageSize: 4 });
    expect(res.records).toHaveLength(5);
    expect(res.complete).toBe(true);
  });

  it('guards against an empty page that claims more movies', async () => {
    const { fetch, calls } = fakeFetch({ sections: SECTIONS.slice(0, 1), movies: {} });
    const lying = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/library/sections/3/all') {
        calls.push({ url, init: init ?? {} });
        return new Response(JSON.stringify({ MediaContainer: { size: 0, totalSize: 50, offset: 0, Metadata: [] } }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const res = await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'client-0001', version: 't', fetch: lying });
    expect(res.records).toHaveLength(0);
    expect(calls.filter((c) => c.url.pathname === '/library/sections/3/all')).toHaveLength(1);
    expect(res.warnings.join('\n')).toMatch(/fewer movies than it reported/);
    expect(res.complete).toBe(false);
  });

  it('falls back when the server ignores includeGuids: fetches details for matched items, warns once', async () => {
    const details = { '5012': glassHarbor2009 };
    const res = await read({
      sections: SECTIONS.slice(0, 1),
      movies: { '3': [glassHarbor2009, lanternSeason] },
      ignoreIncludeGuids: true,
      details,
    });
    expect(res.records[0]?.imdbIdHint).toBe('tt9000002');
    expect(res.records[1]?.imdbIdHint ?? null).toBeNull();
    const detailCalls = res.calls.filter((c) => c.url.pathname.startsWith('/library/metadata/'));
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0]?.url.pathname).toBe('/library/metadata/5012');
    expect(res.warnings.filter((w) => /external ids/.test(w))).toHaveLength(1);
    expectSafeRequests(res.calls);
  });

  it('url-encodes a non-numeric ratingKey in a detail request', async () => {
    const odd = { ...glassHarbor2009, ratingKey: 'a/b c', Director: undefined };
    const res = await read({ sections: SECTIONS.slice(0, 1), movies: { '3': [odd] }, details: { 'a/b c': { ...odd, Director: [{ tag: 'Teodor Brask' }] } } });
    const detail = res.calls.find((c) => c.url.pathname.startsWith('/library/metadata/')) as Call;
    expect(detail.url.pathname).toBe('/library/metadata/a%2Fb%20c');
    expect(res.records[0]?.sourceDirector).toBe('Teodor Brask');
  });
});

// ---------- errors ----------

describe('server errors', () => {
  const respond = (res: Response | Error) =>
    (async () => {
      if (res instanceof Error) throw res;
      return res;
    }) as unknown as typeof fetch;

  it('maps 401 to a token message', async () => {
    const err = (await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: respond(new Response('', { status: 401 })) }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(err).toBeInstanceOf(ImportError);
    expect((err as Error).message).toMatch(/token.*expired or wrong/i);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('refuses an XML or HTML answer with a clear message', async () => {
    const xml = new Response('<?xml version="1.0"?><MediaContainer/>', { status: 200, headers: { 'content-type': 'text/xml' } });
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: respond(xml) })).rejects.toThrow(/XML/);
    const html = new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: respond(html) })).rejects.toThrow(
      /Plex Media Server/,
    );
  });

  it('never repeats the token in an error, even when the cause carries it', async () => {
    const boom = new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED token=${TOKEN}`), { code: 'ECONNREFUSED' }) });
    const err = (await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: respond(boom) }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(ImportError);
    expect(err.message).toMatch(/Could not reach the Plex server at http:\/\/127\.0\.0\.1:32400/);
    expect(err.message).not.toContain(TOKEN);
    const leaky = new TypeError('fetch failed', { cause: new Error(`bad header X-Plex-Token: ${TOKEN}`) });
    const err2 = (await readPlexLibrary({ url: SERVER, token: TOKEN, clientId: 'c', version: 't', fetch: respond(leaky) }).catch((e: unknown) => e)) as Error;
    expect(err2.message).toContain('[redacted]');
    expect(err2.message).not.toContain(TOKEN);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TOKEN);
  });

  it('reports a redirect as an error instead of following it', async () => {
    const err = await readPlexLibrary({
      url: SERVER,
      token: TOKEN,
      clientId: 'c',
      version: 't',
      fetch: respond(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })),
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(ImportError);
  });
});

// ---------- mapping ----------

describe('mapping Plex movies', () => {
  const map = (ms: PlexMetadata[], o: Parameters<typeof mapPlexItems>[1] = {}) => mapPlexItems(ms, o);

  it('maps the fields, owned, watched, rating and IMDb hint, and stores no summary or art', () => {
    const res = map([glassHarbor2009]);
    const r = res.records[0] as ImportRecord;
    expect(r).toMatchObject({
      sourceTitle: 'The Glass Harbor',
      sourceYear: 2009,
      sourceDirector: 'Teodor Brask',
      sourceGenre: 'Mystery, Thriller',
      sourceRuntimeMin: 128,
      collection: 'Harbor Films',
      imdbIdHint: 'tt9000002',
      owned: true,
      sourceOwnedRaw: 'plex',
      status: 'watched',
      watchedAt: '2024-06-10',
      myRating: 7,
      source: 'plex',
      fillOnly: true,
    });
    expect(r.imdbIdExact).toBeUndefined();
    expect(r.tconst).toBeUndefined();
    expect(r.watchedEra).toBeUndefined();
    expect(r.externalIds).toBeUndefined();
    expect(JSON.stringify(res.records)).not.toMatch(/summary|thumb|5012/);
  });

  it('reads a legacy IMDb agent guid, and no hint from TMDB-only or local items', () => {
    const legacy = { ...lanternSeason, guid: 'com.plexapp.agents.imdb://tt9000027?lang=en', Guid: undefined };
    const tmdbOnly = { ...lanternSeason, guid: 'com.plexapp.agents.themoviedb://12345?lang=en' };
    const res = map([legacy, tmdbOnly, lanternSeason]);
    expect(res.records.map((r) => r.imdbIdHint ?? null)).toEqual(['tt9000027', null, null]);
  });

  it('adds an edition only when the normalizer knows the word, and warns about free-text editions', () => {
    const res = map([
      { ...glassHarbor2009, editionTitle: "Director's Cut", duration: 140 * 60000 },
      { ...glassHarbor2009, ratingKey: '5014', editionTitle: 'Final' },
    ]);
    expect(res.records.map((r) => r.sourceTitle)).toEqual(["The Glass Harbor (Director's Cut)", 'The Glass Harbor']);
    expect(res.warnings.join('\n')).toMatch(/"Final"/);
  });

  it('maps ratings: whole numbers kept, fractions rounded with a warning, 0 and missing left out, and none when ratings are off', () => {
    const rated = (userRating: unknown) => ({ ...lanternSeason, userRating }) as PlexMetadata;
    const res = map([rated(7.0), rated(7.5), rated(0), rated(undefined), rated(11), rated(0.4)]);
    expect(res.records.map((r) => r.myRating)).toEqual([7, 8, undefined, undefined, undefined, undefined]);
    expect(res.warnings.join('\n')).toMatch(/rounded/);
    expect(res.warnings.join('\n')).toMatch(/out of range/);
    expect(map([rated(9)], { ratings: false }).records[0]?.myRating).toBeUndefined();
  });

  it('marks watched from viewCount only; a partial play or no plays gives a new-item status, someday by default', () => {
    const res = map([
      { ...lanternSeason, viewCount: 1 },
      { ...lanternSeason, ratingKey: 'p', viewOffset: 600000 },
      { ...lanternSeason, ratingKey: 'q' },
    ]);
    expect(res.records[0]).toMatchObject({ status: 'watched' });
    expect(res.records[0]?.watchedAt).toBeUndefined();
    for (const r of res.records.slice(1)) {
      expect(r.status).toBeUndefined();
      expect(r.statusIfNew).toBe('someday');
    }
    expect(res.counts).toMatchObject({ watched: 1, unwatched: 2 });
  });

  it('honours --unwatched-status queue and skip', () => {
    const ms = [{ ...lanternSeason, viewCount: 1 }, { ...lanternSeason, ratingKey: 'q', title: 'Unseen' }];
    expect(map(ms, { unwatchedStatus: 'queue' }).records[1]?.statusIfNew).toBe('queue');
    const skipped = map(ms, { unwatchedStatus: 'skip' });
    expect(skipped.records.map((r) => r.sourceTitle)).toEqual(['Lantern Season']);
    expect(skipped.counts.skippedUnwatched).toBe(1);
  });

  it('drops the dates of a bulk-marked library but keeps it watched', () => {
    const day = noon('2023-02-01');
    const ms = Array.from({ length: 10 }, (_, i) => ({
      ...lanternSeason,
      ratingKey: `b${i}`,
      title: `Invented Film ${i}`,
      viewCount: 1,
      lastViewedAt: i < 6 ? day : noon(`2022-0${i - 5}-15`),
    }));
    const res = map(ms);
    expect(res.records.every((r) => r.status === 'watched')).toBe(true);
    expect(res.records.slice(0, 6).every((r) => r.watchedAt === undefined)).toBe(true);
    expect(res.records.slice(6).every((r) => typeof r.watchedAt === 'string')).toBe(true);
    expect(res.warnings.join('\n')).toMatch(/6 movies.*same day/);
    const three = map(ms.map((m, i) => ({ ...m, lastViewedAt: i < 3 ? day : noon(`2021-0${i}-15`) })));
    expect(three.records.slice(0, 3).every((r) => r.watchedAt === undefined)).toBe(true);
    const two = map(ms.map((m, i) => ({ ...m, lastViewedAt: i < 2 ? day : noon(`2021-0${i}-15`) })));
    expect(two.records.every((r) => typeof r.watchedAt === 'string')).toBe(true);
  });

  it('skips non-movie items and items without a title', () => {
    const res = map([{ ...lanternSeason, type: 'episode' }, { ...lanternSeason, title: '  ' }, lanternSeason]);
    expect(res.records).toHaveLength(1);
    expect(res.counts.skipped).toBe(2);
  });

  it('keeps Unicode titles and a non-numeric ratingKey', () => {
    const res = map([{ ...lanternSeason, ratingKey: 'plex-abc', title: 'Ñandú: Ōkami (Reprise)' }]);
    expect(res.records[0]?.sourceTitle).toBe('Ñandú: Ōkami (Reprise)');
  });

  it('folds one film from two libraries into one record, but never two editions', () => {
    const res = map([
      glassHarbor2009,
      { ...glassHarbor2009, ratingKey: '9001', viewCount: 0, userRating: undefined },
      { ...glassHarbor2009, ratingKey: '9002', editionTitle: 'Extended Edition', duration: 140 * 60000, viewCount: 0 },
    ]);
    expect(res.records.map((r) => r.sourceTitle)).toEqual(['The Glass Harbor', 'The Glass Harbor (Extended Edition)']);
    expect(res.records[0]).toMatchObject({ status: 'watched', myRating: 7 });
  });

  it('never folds records that share an IMDb hint but name different films', () => {
    const wrong = { ...lanternSeason, Guid: [{ id: 'imdb://tt9000002' }] };
    const res = map([
      glassHarbor2009,
      { ...wrong, ratingKey: 'w1', title: 'Lantern Season', year: 1978 },
      { ...glassHarbor2009, ratingKey: 'w2', year: 1978 },
    ]);
    expect(res.records).toHaveLength(3);
  });

  it('never folds a missing runtime into known ones, or runtimes more than 3 minutes apart', () => {
    const res = map([
      { ...glassHarbor2009, duration: undefined },
      { ...glassHarbor2009, ratingKey: 'r100', duration: 100 * 60000 },
      { ...glassHarbor2009, ratingKey: 'r140', duration: 140 * 60000 },
      { ...glassHarbor2009, ratingKey: 'r102', duration: 102 * 60000 },
    ]);
    expect(res.records.map((r) => r.sourceRuntimeMin)).toEqual([null, 100, 140]);
  });

  it('never folds editions named only in the title, or films whose title years differ', () => {
    const editions = map([
      { ...glassHarbor2009, title: 'The Glass Harbor (Theatrical)', viewCount: 0, userRating: undefined },
      { ...glassHarbor2009, ratingKey: 'e2', title: 'The Glass Harbor (Extended Edition)' },
    ]);
    expect(editions.records.map((r) => [r.sourceTitle, r.status ?? null, r.myRating ?? null])).toEqual([
      ['The Glass Harbor (Theatrical)', null, null],
      ['The Glass Harbor (Extended Edition)', 'watched', 7],
    ]);
    const years = map([
      { ...glassHarbor2009, title: 'The Glass Harbor (1978)' },
      { ...glassHarbor2009, ratingKey: 'y2', title: 'The Glass Harbor (2009)', viewCount: 0, userRating: undefined },
    ]);
    expect(years.records).toHaveLength(2);
  });

  it('drops a placeholder director credit, so a folded copy keeps the real one', () => {
    const res = map([
      { ...glassHarbor2009, Director: [{ tag: 'Unknown' }] },
      { ...glassHarbor2009, ratingKey: 'u2' },
    ]);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]?.sourceDirector).toBe('Teodor Brask');
  });

  it('flattens brackets inside an edition name so the tag stays readable', () => {
    const res = map([{ ...glassHarbor2009, editionTitle: "Director's Cut (4K)" }]);
    expect(res.records[0]?.sourceTitle).toBe("The Glass Harbor (Director's Cut 4K)");
  });

  it('never folds records whose directors are clearly different people', () => {
    const res = map([
      glassHarbor2009,
      { ...glassHarbor2009, ratingKey: 'd2', Director: [{ tag: 'Selma Ruiz' }], viewCount: 0, userRating: undefined },
      { ...glassHarbor2009, ratingKey: 'd3', Director: undefined },
    ]);
    // The row without directors fits both films, so nothing folds.
    expect(res.records.map((r) => [r.sourceDirector, r.status ?? null])).toEqual([
      ['Teodor Brask', 'watched'],
      ['Selma Ruiz', null],
      [null, 'watched'],
    ]);
  });

  it('does not let listing order decide where an ambiguous row folds', () => {
    const a = { ...glassHarbor2009, ratingKey: 'p1', viewCount: 0, userRating: undefined };
    const b = { ...glassHarbor2009, ratingKey: 'p2', Director: [{ tag: 'Selma Ruiz' }], viewCount: 0, userRating: undefined };
    const sparse = { ...glassHarbor2009, ratingKey: 'p3', Director: undefined, viewCount: 1, userRating: 9 };
    for (const order of [[a, b, sparse], [sparse, a, b], [b, sparse, a]]) {
      const res = map(order);
      expect(res.records).toHaveLength(3);
      const rated = res.records.filter((r) => r.myRating === 9);
      expect(rated.map((r) => r.sourceDirector ?? null)).toEqual([null]);
    }
    // Runtimes that chain (100, 102, 104) do not fold either.
    const chain = map([100, 102, 104].map((m, i) => ({ ...glassHarbor2009, ratingKey: `r${i}`, duration: m * 60000 })));
    expect(chain.records).toHaveLength(3);
  });

  it('folds by every year in a group, not only the first', () => {
    const res = map([
      { ...glassHarbor2009, year: 2000 },
      { ...glassHarbor2009, ratingKey: 'y1', year: 2001 },
    ]);
    expect(res.records.map((r) => r.sourceYear)).toEqual([2000]);
    // 1999 and 2001 each fit 2000 but not each other: no group, nothing folds.
    const spread = map([
      { ...glassHarbor2009, year: 2000 },
      { ...glassHarbor2009, ratingKey: 'y1', year: 1999 },
      { ...glassHarbor2009, ratingKey: 'y2', year: 2001 },
    ]);
    expect(spread.records.map((r) => r.sourceYear)).toEqual([2000, 1999, 2001]);
  });

  it('counts a movie in several libraries once when looking for a bulk-marked day', () => {
    const copies = [0, 1, 2].map((i) => ({ ...glassHarbor2009, ratingKey: `c${i}` }));
    const others = Array.from({ length: 6 }, (_, i) => ({
      ...lanternSeason,
      ratingKey: `o${i}`,
      title: `Invented Film ${i}`,
      viewCount: 1,
      lastViewedAt: noon(`2022-0${i + 1}-15`),
    }));
    const res = map([...copies, ...others]);
    expect(res.records[0]?.watchedAt).toBe('2024-06-10');
    expect(res.warnings.join('\n')).not.toMatch(/same day/);
  });
});

describe('a saved listing (--from-file)', () => {
  it('does not count saved movies without a ratingKey toward the total', () => {
    const bare = { ...lanternSeason, ratingKey: undefined };
    const page = { MediaContainer: { librarySectionID: 3, totalSize: 2, size: 1, Metadata: [bare] } };
    expect(parsePlexDump(JSON.stringify([page, page])).complete).toBe(false);
  });

  it('reads one container, an array of containers, or a bare list', () => {
    const one = JSON.stringify({ MediaContainer: { size: 1, Metadata: [glassHarbor2009] } });
    const many = JSON.stringify([{ MediaContainer: { Metadata: [glassHarbor2009] } }, { MediaContainer: { Metadata: [lanternSeason] } }]);
    expect(parsePlexDump(one)).toMatchObject({ movies: [glassHarbor2009], complete: false });
    expect(parsePlexDump(many).movies).toHaveLength(2);
    expect(parsePlexDump(JSON.stringify([lanternSeason]))).toMatchObject({ movies: [lanternSeason], complete: false });
    expect(() => parsePlexDump('<MediaContainer/>')).toThrow(ImportError);
    expect(() => parsePlexDump('{"hello":1}')).toThrow(/Plex listing/);
  });

  it('is complete only when every library holds as many distinct movies as its saved total', () => {
    const page = (offset: number, ms: PlexMetadata[], totalSize: number, librarySectionID: number | string = 3) => ({
      MediaContainer: { offset, size: ms.length, totalSize, librarySectionID, Metadata: ms },
    });
    const a = { ...lanternSeason, ratingKey: 'a' };
    const b = { ...lanternSeason, ratingKey: 'b' };
    const c = { ...lanternSeason, ratingKey: 'c' };
    expect(parsePlexDump(JSON.stringify(page(0, [a, b], 2))).complete).toBe(true);
    expect(parsePlexDump(JSON.stringify(page(0, [a], 500))).complete).toBe(false);
    expect(parsePlexDump(JSON.stringify([page(0, [a, b], 3), page(2, [c], 3)])).complete).toBe(true);
    expect(parsePlexDump(JSON.stringify([page(0, [a, b], 3), page(1, [b], 3)])).complete).toBe(false);
    expect(parsePlexDump(JSON.stringify([page(0, [a], 1, 3), page(0, [b], 2, '7')])).complete).toBe(false);
  });

  it('keeps a movie on overlapping saved pages once', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((k) => ({ ...lanternSeason, ratingKey: k, title: `Invented Film ${k}` }));
    const dump = parsePlexDump(
      JSON.stringify([
        { MediaContainer: { totalSize: 3, librarySectionID: 3, Metadata: [a, b] } },
        { MediaContainer: { totalSize: 3, librarySectionID: 3, Metadata: [b, c] } },
      ]),
    );
    expect(dump.movies.map((m) => m.ratingKey)).toEqual(['a', 'b', 'c']);
    expect(dump.complete).toBe(true);
  });
});

// ---------- applying to a library ----------

describe('importing into the library', () => {
  const plexImport = (ms: PlexMetadata[], o: Parameters<typeof mapPlexItems>[1] = {}) =>
    applyImport(db, mapPlexItems(ms, o).records, { mode: 'merge' });

  it('adds owned movies with source plex, matched by the hint, and a re-import changes nothing', () => {
    const first = plexImport([glassHarbor2009, lanternSeason]);
    expect(first.added).toBe(2);
    const [a, b] = items();
    expect(a).toMatchObject({ tconst: 'tt9000002', owned: true, source: 'plex', status: 'watched', myRating: 7, sourceOwnedRaw: 'plex' });
    expect(b).toMatchObject({ owned: true, source: 'plex', status: 'someday' });
    const again = plexImport([glassHarbor2009, lanternSeason]);
    expect(again).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
  });

  it('adds two items for two editions with one IMDb id and runtimes 12 minutes apart', () => {
    plexImport([
      { ...glassHarbor2009, editionTitle: "Director's Cut", duration: 140 * 60000 },
      { ...glassHarbor2009, ratingKey: '5014', editionTitle: 'Final' },
    ]);
    expect(items().map((i) => [i.sourceTitle, i.sourceRuntimeMin])).toEqual([
      ["The Glass Harbor (Director's Cut)", 140],
      ['The Glass Harbor', 128],
    ]);
  });

  it('keeps editions apart across separate imports, also with equal runtimes', () => {
    plexImport([{ ...glassHarbor2009, editionTitle: 'Theatrical', viewCount: 0, userRating: undefined }]);
    plexImport([{ ...glassHarbor2009, ratingKey: '5099', editionTitle: "Director's Cut", userRating: 9 }]);
    plexImport([{ ...glassHarbor2009, ratingKey: '5100', viewCount: 0, userRating: undefined }]);
    expect(items().map((i) => [i.sourceTitle, i.status, i.myRating])).toEqual([
      ['The Glass Harbor (Theatrical)', 'someday', null],
      ["The Glass Harbor (Director's Cut)", 'watched', 9],
      ['The Glass Harbor', 'someday', null],
    ]);
    expect(plexImport([{ ...glassHarbor2009, ratingKey: '5099', editionTitle: "Director's Cut", userRating: 9 }])).toMatchObject({ added: 0, unchanged: 1 });
  });

  it('keeps an edition with brackets in its name apart from the bare edition', () => {
    plexImport([{ ...glassHarbor2009, viewCount: 0, userRating: undefined }]);
    plexImport([{ ...glassHarbor2009, ratingKey: '5101', editionTitle: "Director's Cut [4K]", userRating: 9 }]);
    expect(items().map((i) => [i.sourceTitle, i.status, i.myRating])).toEqual([
      ['The Glass Harbor', 'someday', null],
      ["The Glass Harbor (Director's Cut 4K)", 'watched', 9],
    ]);
  });

  it('keeps a nested edition title from another source apart from a bare Plex movie', () => {
    expect(titleEditionTag("The Glass Harbor (Director's Cut (4K))")).toBe('director s cut 4k');
    expect(titleEditionTag('The Glass Harbor (2009) (4K)')).toBe('4k');
    expect(titleEditionTag('The Glass Harbor')).toBe('');
    applyImport(
      db,
      [{ sourceTitle: "The Glass Harbor (Director's Cut (4K))", sourceYear: 2009, sourceRuntimeMin: 128, source: 'csv', status: 'someday', imdbIdHint: 'tt9000002' }],
      { mode: 'merge' },
    );
    plexImport([{ ...glassHarbor2009, userRating: 9 }]);
    const nested = items().find((i) => i.sourceTitle === "The Glass Harbor (Director's Cut (4K))");
    expect(nested).toMatchObject({ status: 'someday', myRating: null });
  });

  it('never downgrades a watched movie, never clears a rating, and marks an existing movie owned', () => {
    applyImport(
      db,
      [{ sourceTitle: 'The Glass Harbor', sourceYear: 2009, source: 'imdb', status: 'watched', myRating: 9, ownedIfNew: false, imdbIdHint: 'tt9000002', imdbIdExact: true }],
      { mode: 'merge' },
    );
    expect(items()[0]).toMatchObject({ owned: false, status: 'watched', myRating: 9 });
    plexImport([{ ...glassHarbor2009, viewCount: 0, userRating: undefined, lastViewedAt: undefined }]);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ owned: true, status: 'watched', myRating: 9 });
  });

  it('keeps an existing item\'s own descriptive fields and only fills blanks', () => {
    applyImport(db, [{ sourceTitle: 'The Glass Harbor', sourceYear: 2009, sourceDirector: 'Teodor Brask', sourceGenre: 'Noir', source: 'apple-tv' }], { mode: 'merge' });
    plexImport([glassHarbor2009]);
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ sourceGenre: 'Noir', collection: 'Harbor Films', sourceRuntimeMin: 128 });
  });

  it('never moves an existing unwatched movie with --unwatched-status', () => {
    applyImport(db, [{ sourceTitle: 'Lantern Season', sourceYear: 1978, source: 'csv', status: 'priority' }], { mode: 'merge' });
    for (const unwatchedStatus of ['queue', 'someday'] as const) plexImport([lanternSeason], { unwatchedStatus });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ status: 'priority', owned: true });
  });

  it('gives new unwatched movies the chosen status', () => {
    plexImport([lanternSeason], { unwatchedStatus: 'queue' });
    expect(items()[0]?.status).toBe('queue');
  });
});

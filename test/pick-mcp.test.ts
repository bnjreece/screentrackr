/**
 * MCP tools of Track D: pick_movie, where_to_watch, and whereToWatch on
 * get_movie. Run in-process over the SDK's in-memory transport.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { saveConfig } from '../src/core/config.js';
import { openDb, type Db } from '../src/core/db.js';
import { addFromCatalog } from '../src/core/library.js';
import { pickMovies } from '../src/core/pick.js';
import { createMcpServer } from '../src/mcp/server.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

let tmp: string;
let home: string;
let db: Db;
let client: Client;
let ids: Record<string, number>;
const savedEnv = { LC_ALL: process.env.LC_ALL, LANG: process.env.LANG, LC_MESSAGES: process.env.LC_MESSAGES };

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  // The default country comes from the locale; pin it for these tests.
  process.env.LC_ALL = 'en_US.UTF-8';
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-pick-mcp-'));
  home = join(tmp, 'home');
  const seed = openDb(home);
  await buildCatalog(seed, { cacheDir: FIXTURES });
  seed.close();
});

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(join(home, 'config.json'), { force: true });
  db = openDb(home);
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items;');
  ids = {
    w03: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    q04: addFromCatalog(db, 'tt9000004', { status: 'queue' }).id,
    p20: addFromCatalog(db, 'tt9000020', { status: 'priority' }).id,
    q05: addFromCatalog(db, 'tt9000005', { status: 'queue' }).id,
    s18: addFromCatalog(db, 'tt9000018', { status: 'someday' }).id,
  };
  const server = createMcpServer(db);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'screentrackr-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  db.close();
});

describe('pick_movie', () => {
  it('teaches the defaults and asks the client to call again for another pick', async () => {
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === 'pick_movie')!;
    expect(t.description).toMatch(/call pick_movie again/);
    expect(t.description).toMatch(/queue, priority or someday/);
    expect(t.description).not.toContain('\u2014');
    const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
    for (const k of ['count', 'seed', 'priorityFirst', 'anyStatus', 'scope', 'genres', 'decades', 'lists', 'owned', 'excludeWatched', 'maxVotes']) {
      expect(props).toHaveProperty(k);
    }
    for (const k of ['sort', 'order', 'limit', 'offset']) expect(props).not.toHaveProperty(k);
  });

  it('agrees with the core (and so with the CLI) for the same seed', async () => {
    const r = await call('pick_movie', { seed: 5, count: 3, anyStatus: true });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(JSON.parse(JSON.stringify(pickMovies(db, { seed: 5, count: 3, anyStatus: true }))));
    expect(text(r)).toMatch(/^Picked from 5 movies:/);
    expect(text(r)).toMatch(/Where to watch: https:\/\/www\.justwatch\.com\/us\/search\?q=/);
  });

  it('defaults to unwatched, and reports an empty pick plainly', async () => {
    const r = await call('pick_movie', { count: 10, seed: 1 });
    const picks = (r.structuredContent as { picks: { library: { status: string } }[] }).picks;
    expect(picks).toHaveLength(4);
    for (const p of picks) expect(p.library.status).not.toBe('watched');
    const none = await call('pick_movie', { genres: ['Western'] });
    expect(none.isError).toBeFalsy();
    expect(none.structuredContent).toEqual({ total: 0, picks: [] });
    expect(text(none)).toBe('No movie fits these filters.');
  });

  it('priorityFirst says it drew from priority movies', async () => {
    const r = await call('pick_movie', { priorityFirst: true, seed: 1 });
    expect(r.structuredContent).toMatchObject({ total: 1, priorityOnly: true, matched: 4 });
    expect(text(r)).toMatch(/^Picked from 1 priority movies \(4 match in all\):/);
  });

  it('rejects a count over 10 and search-only fields', async () => {
    expect((await call('pick_movie', { count: 11 })).isError).toBe(true);
    expect((await call('pick_movie', { sort: 'rating' })).isError).toBe(true);
    expect((await call('pick_movie', { anyStatus: true, status: ['queue'] })).isError).toBe(true);
  });

  it('uses the saved country', async () => {
    saveConfig(home, { version: 1, country: 'gb' });
    const r = await call('pick_movie', { seed: 1 });
    expect((r.structuredContent as { picks: { whereToWatch: string }[] }).picks[0]!.whereToWatch).toMatch(/^https:\/\/www\.justwatch\.com\/uk\//);
  });
});

describe('where_to_watch', () => {
  it('builds the link by id or tconst', async () => {
    const byId = await call('where_to_watch', { id: ids.q05 });
    expect(byId.isError).toBeFalsy();
    expect(byId.structuredContent).toEqual({ title: 'Salt & Signal', country: 'us', url: 'https://www.justwatch.com/us/search?q=Salt%20%26%20Signal' });
    expect(text(byId)).toBe('Salt & Signal on JustWatch (us): https://www.justwatch.com/us/search?q=Salt%20%26%20Signal');
    const byTconst = await call('where_to_watch', { tconst: 'TT9000024', country: 'GB' });
    expect(byTconst.structuredContent).toEqual({ title: 'The Slow Planet', country: 'uk', url: 'https://www.justwatch.com/uk/search?q=The%20Slow%20Planet' });
  });

  it('uses the saved country, and still answers when config.json is broken', async () => {
    saveConfig(home, { version: 1, country: 'de' });
    expect((await call('where_to_watch', { id: ids.p20 })).structuredContent).toMatchObject({ country: 'de' });
    writeFileSync(join(home, 'config.json'), '{broken');
    expect((await call('where_to_watch', { id: ids.p20 })).structuredContent).toMatchObject({ country: 'us' });
  });

  it('errors on a missing movie, a bad country, or neither id nor tconst', async () => {
    expect(text(await call('where_to_watch', { id: 99999 }))).toMatch(/not found/);
    expect((await call('where_to_watch', { tconst: 'tt9999999' })).isError).toBe(true);
    expect((await call('where_to_watch', { id: ids.p20, country: 'usa' })).isError).toBe(true);
    expect((await call('where_to_watch', {})).isError).toBe(true);
    expect((await call('where_to_watch', { id: ids.p20, tconst: 'tt9000020' })).isError).toBe(true);
  });
});

describe('get_movie whereToWatch', () => {
  it('includes the link for a library movie and for a catalog movie', async () => {
    const lib = await call('get_movie', { id: ids.p20 });
    expect(lib.structuredContent!.whereToWatch).toBe('https://www.justwatch.com/us/search?q=A%20Room%20Downstairs');
    expect(text(lib)).toMatch(/Where to watch: https:\/\/www\.justwatch\.com\/us\/search\?q=A%20Room%20Downstairs/);
    const cat = await call('get_movie', { tconst: 'tt9000024' });
    expect(cat.structuredContent!.whereToWatch).toBe('https://www.justwatch.com/us/search?q=The%20Slow%20Planet');
  });
});

/** MCP watch_stats and the list tools, over the SDK's in-memory transport. All titles are made up. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { addFromCatalog, getItem } from '../src/core/library.js';
import { listItemIds } from '../src/core/lists.js';
import { watchStats } from '../src/core/stats.js';
import { addViewing } from '../src/core/viewings.js';
import { createMcpServer } from '../src/mcp/server.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

let tmp: string;
let home: string;
let db: Db;
let client: Client;
let ids: Record<string, number>;

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}
const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-mcp-stats-lists-'));
  home = join(tmp, 'home');
  const seed = openDb(home);
  await buildCatalog(seed, { cacheDir: FIXTURES });
  seed.close();
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(async () => {
  db = openDb(home);
  db.sql.exec('DELETE FROM list_items; DELETE FROM lists; DELETE FROM viewings; DELETE FROM match_candidates; DELETE FROM library_items;');
  ids = {
    q3: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    s4a: addFromCatalog(db, 'tt9000004', { status: 'queue' }).id,
    s4b: addFromCatalog(db, 'tt9000004', { status: 'watched' }).id,
  };
  addViewing(db, ids.q3 as number, { watchedAt: '2024-02-01', source: 'manual', sourceRef: 'manual:0000000000000001' });
  addViewing(db, ids.q3 as number, { watchedAt: '2025-02-01', source: 'letterboxd', sourceRef: 'https://boxd.it/m1' });
  addViewing(db, ids.s4b as number, { watchedAt: '2025-03-01', source: 'trakt', sourceRef: '42' });
  const server = createMcpServer(db);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'screentrackr-test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
});
afterEach(async () => {
  await client.close();
  db.close();
});

describe('annotations', () => {
  it('marks reads, writes and the destructive delete', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.watch_stats!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(by.list_lists!.annotations).toMatchObject({ readOnlyHint: true });
    expect(by.create_list!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.list_add!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.list_remove!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(by.delete_list!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // Never describe stats as another service's feature.
    expect(by.watch_stats!.description).not.toMatch(/letterboxd|trakt|pro\b/i);
  });
});

describe('watch_stats', () => {
  it('returns the same numbers the CLI uses (one core)', async () => {
    const r = await call('watch_stats', { year: 2025 });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual(JSON.parse(JSON.stringify(watchStats(db, { year: 2025 }))));
    expect(r.structuredContent).toMatchObject({ year: 2025, plays: 2, films: 2, rewatches: 1 });
    expect(text(r)).toMatch(/^In 2025: 2 plays \(1 rewatch\) of 2 films\.$/m);
  });

  it('refuses a list that does not exist, and bad input', async () => {
    expect(text(await call('watch_stats', { lists: ['Nope'] }))).toMatch(/No list named "Nope"/);
    expect((await call('watch_stats', { by: 'month' })).isError).toBe(true);
    expect((await call('watch_stats', { year: 99 })).isError).toBe(true);
  });

  it('library_stats gains playsThisYear and rated', async () => {
    const r = await call('library_stats');
    expect(r.structuredContent).toMatchObject({ total: 3, rated: 0 });
    expect(typeof r.structuredContent?.playsThisYear).toBe('number');
  });
});

describe('list tools', () => {
  it('create, list, add, remove, delete', async () => {
    const c = await call('create_list', { name: 'Halloween', description: 'October' });
    expect(c.structuredContent).toMatchObject({ name: 'Halloween', description: 'October', count: 0 });
    expect((await call('create_list', { name: 'HALLOWEEN' })).isError).toBe(true);

    const add = await call('list_add', { list: 'halloween', ids: [ids.q3], tconsts: ['tt9000030'], addMissing: true });
    expect(add.isError, text(add)).toBeFalsy();
    const created = (add.structuredContent as { created: { id: number }[] }).created;
    expect(getItem(db, created[0]!.id)).toMatchObject({ status: 'queue', owned: false });
    expect(listItemIds(db, 'Halloween')).toEqual([ids.q3 as number, created[0]!.id].sort((a, b) => a - b));

    const ls = await call('list_lists');
    expect(ls.structuredContent).toMatchObject({ lists: [{ name: 'Halloween', count: 2 }] });
    expect(text(ls)).toMatch(/- Halloween \(2 movies\): October/);

    const rem = await call('list_remove', { list: 'Halloween', ids: [ids.q3, ids.s4a] });
    expect(rem.structuredContent).toMatchObject({ removed: [ids.q3], notMember: [ids.s4a], list: { count: 1 } });

    const del = await call('delete_list', { name: 'Halloween' });
    expect(text(del)).toMatch(/1 movie was in it/);
    expect(getItem(db, created[0]!.id)).not.toBeNull();
  });

  it('list_add is all or nothing: an ambiguous tconst lists the ids', async () => {
    await call('create_list', { name: 'Fincher' });
    const r = await call('list_add', { list: 'Fincher', ids: [ids.q3], tconsts: ['tt9000004'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/tt9000004 matches 2 library items/);
    expect(text(r)).toContain(`#${ids.s4a}`);
    expect(listItemIds(db, 'Fincher')).toEqual([]);
    const missing = await call('list_add', { list: 'Fincher', tconsts: ['tt9000030'] });
    expect(text(missing)).toMatch(/addMissing: true/);
    expect(text(await call('list_add', { list: 'Fincher', ids: [999999] }))).toMatch(/id 999999 is not in your library/);
    expect(text(await call('list_add', { list: 'Fincher' }))).toMatch(/at least one id or tconst/);
  });

  it('search_movies takes lists', async () => {
    await call('create_list', { name: 'Halloween' });
    await call('list_add', { list: 'Halloween', ids: [ids.s4b] });
    const r = await call('search_movies', { lists: ['Halloween'] });
    expect(r.structuredContent).toMatchObject({ total: 1 });
  });
});

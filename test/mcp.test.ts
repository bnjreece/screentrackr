/**
 * MCP server tests. Most run the real server in-process over the SDK's
 * in-memory transport. The stdout-hygiene test (Review Focus #1) spawns the
 * built `node dist/cli/index.js mcp` and speaks raw JSON-RPC over stdio.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { openDb, type Db } from '../src/core/db.js';
import { addFromCatalog, getItem } from '../src/core/library.js';
import { createMcpServer } from '../src/mcp/server.js';

const ROOT = join(import.meta.dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');

// Synthetic fixture facts (see test/fixtures/make-imdb-fixtures.ts):
// Dana Fincher directs tt9000003 (8.6), 04 (8.4), 09, 10, 19, 20 (8.1).

let tmp: string;
let catalogHome: string;
let db: Db;
let client: Client;
let ids: Record<string, number>;

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
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-mcp-'));
  catalogHome = join(tmp, 'catalog-home');
  const seed = openDb(catalogHome);
  await buildCatalog(seed, { cacheDir: FIXTURES });
  seed.close();
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  db = openDb(catalogHome);
  db.sql.exec('DELETE FROM match_candidates; DELETE FROM library_items;');
  ids = {
    q03: addFromCatalog(db, 'tt9000003', { status: 'watched' }).id,
    s04a: addFromCatalog(db, 'tt9000004', { status: 'queue' }).id,
    s04b: addFromCatalog(db, 'tt9000004', { status: 'watched' }).id,
    r20: addFromCatalog(db, 'tt9000020', { status: 'priority' }).id,
    d06: addFromCatalog(db, 'tt9000006', { status: 'watched' }).id,
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

describe('tools/list', () => {
  it('returns the 6 tools with their annotations', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      ['add_to_library', 'get_movie', 'library_stats', 'remove_from_library', 'search_movies', 'update_movie'].sort(),
    );
    expect(byName.search_movies!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(byName.get_movie!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.library_stats!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.update_movie!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(byName.add_to_library!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.remove_from_library!.annotations).toMatchObject({ destructiveHint: true });
  });

  it('search_movies teaches the filter semantics', async () => {
    const { tools } = await client.listTools();
    const d = tools.find((t) => t.name === 'search_movies')!.description!;
    expect(d).toMatch(/OR within/i);
    expect(d).toMatch(/AND across/i);
    expect(d).toMatch(/queue, priority or someday/);
    expect(d).toMatch(/scope: "all"/);
    expect(d).toMatch(/notInLibrary/);
    expect(d).toMatch(/IMDb rating/);
    expect(d).toMatch(/minVotes/);
    expect(d).toMatch(/1000/);
    expect(d).not.toContain('—');
    const props = (tools.find((t) => t.name === 'search_movies')!.inputSchema as { properties: Record<string, unknown> }).properties;
    for (const k of ['scope', 'directors', 'actors', 'genres', 'minRating', 'unwatched', 'notInLibrary', 'sort', 'limit']) {
      expect(props).toHaveProperty(k);
    }
  });
});

describe('search_movies', () => {
  it('returns structured results with the expected tconsts and a short text summary', async () => {
    const r = await call('search_movies', { directors: ['fincher'], minRating: 7.5 });
    expect(r.isError).toBeFalsy();
    const results = (r.structuredContent as { total: number; results: { tconst: string; library: { editions: number } | null }[] }).results;
    expect(results.map((x) => x.tconst).sort()).toEqual(['tt9000003', 'tt9000004', 'tt9000020']);
    expect(results.find((x) => x.tconst === 'tt9000004')!.library!.editions).toBe(2);
    expect(r.structuredContent!.total).toBe(3);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]!.type).toBe('text');
    expect(text(r)).toContain('Quiet Ledger');
    expect(text(r).split('\n').length).toBeLessThanOrEqual(20);
  });

  it('keeps the text summary to 20 lines for a large page', async () => {
    const r = await call('search_movies', { scope: 'all', minVotes: 0, limit: 200 });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as { results: unknown[] }).results.length).toBeGreaterThan(20);
    expect(text(r).split('\n').length).toBeLessThanOrEqual(20);
  });

  it('scope all with notInLibrary excludes owned movies', async () => {
    const r = await call('search_movies', { scope: 'all', directors: ['fincher'], notInLibrary: true, limit: 50 });
    const ts = (r.structuredContent as { results: { tconst: string }[] }).results.map((x) => x.tconst);
    expect(ts).not.toContain('tt9000003');
    expect(ts).toContain('tt9000019');
  });

  it('invalid filters come back as a tool error, not a crash', async () => {
    const bad = await call('search_movies', { notInLibrary: true });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/notInLibrary/);
    const badSort = await call('search_movies', { sort: 'bogus' });
    expect(badSort.isError).toBe(true);
  });

  it('scope all before setup is a tool error with the setup hint', async () => {
    const empty = openDb(join(tmp, `empty-${Date.now()}`));
    const server = createMcpServer(empty);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(st), c.connect(ct)]);
    try {
      const r = (await c.callTool({ name: 'search_movies', arguments: { scope: 'all' } })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(text(r)).toContain('Catalog not built. Run `screentrackr setup`.');
      const lib = (await c.callTool({ name: 'search_movies', arguments: {} })) as ToolResult;
      expect(lib.isError).toBeFalsy();
    } finally {
      await c.close();
      empty.close();
    }
  });
});

describe('get_movie and library_stats', () => {
  it('get_movie by id returns the item and its catalog record', async () => {
    const r = await call('get_movie', { id: ids.q03 });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { movie: { tconst: string; directors: string[] }; library: { id: number }[] };
    expect(s.movie.tconst).toBe('tt9000003');
    expect(s.movie.directors).toEqual(['Dana Fincher']);
    expect(s.library.map((i) => i.id)).toEqual([ids.q03]);
  });

  it('get_movie by tconst lists every edition, and works for movies outside the library', async () => {
    const two = await call('get_movie', { tconst: 'tt9000004' });
    expect((two.structuredContent as { library: { id: number }[] }).library.map((i) => i.id)).toEqual([ids.s04a, ids.s04b]);
    const out = await call('get_movie', { tconst: 'tt9000019' });
    expect(out.isError).toBeFalsy();
    expect(out.structuredContent).toMatchObject({ movie: { title: 'Wolf Season' }, library: [] });
  });

  it('get_movie needs exactly one of id or tconst, and reports a missing movie', async () => {
    expect((await call('get_movie', {})).isError).toBe(true);
    expect((await call('get_movie', { id: ids.q03, tconst: 'tt9000003' })).isError).toBe(true);
    const missing = await call('get_movie', { id: 99999 });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/99999/);
  });

  it('library_stats returns counts', async () => {
    const r = await call('library_stats');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ total: 5, byStatus: { watched: 3, queue: 1, priority: 1, someday: 0 } });
    expect(text(r)).toMatch(/5/);
  });
});

describe('update_movie', () => {
  it('an ambiguous tconst (two editions) is an error that lists the ids, and writes nothing', async () => {
    const r = await call('update_movie', { tconst: 'tt9000004', status: 'watched' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(String(ids.s04a));
    expect(text(r)).toContain(String(ids.s04b));
    expect(getItem(db, ids.s04a!)!.status).toBe('queue');
  });

  it('updates by id or by an unambiguous tconst', async () => {
    const r = await call('update_movie', { id: ids.s04a, status: 'watched', watchedEra: '2020s', myRating: 9, watchedAt: '2026-10-01' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ id: ids.s04a, status: 'watched', watchedEra: '2020s', myRating: 9, watchedAt: '2026-10-01' });

    const t = await call('update_movie', { tconst: 'tt9000020', myRating: 7 });
    expect(t.isError).toBeFalsy();
    expect(getItem(db, ids.r20!)!.myRating).toBe(7);

    const clear = await call('update_movie', { id: ids.r20, myRating: null });
    expect(clear.isError).toBeFalsy();
    expect(getItem(db, ids.r20!)!.myRating).toBeNull();
  });

  it('rejects bad input', async () => {
    expect((await call('update_movie', { id: ids.q03, myRating: 11 })).isError).toBe(true);
    expect((await call('update_movie', { id: ids.q03 })).isError).toBe(true);
    expect((await call('update_movie', { status: 'watched' })).isError).toBe(true);
    expect((await call('update_movie', { id: 99999, status: 'watched' })).isError).toBe(true);
    expect((await call('update_movie', { tconst: 'tt9000019', status: 'watched' })).isError).toBe(true);
  });
});

describe('an unverified IMDb hint is not an identity', () => {
  const hinted = () =>
    Number(
      db.sql
        .prepare(
          "INSERT INTO library_items (tconst, source_title, status, my_rating, match_status, source) VALUES ('tt9000019', 'Glasshaven Quay', 'watched', 8, 'unmatched', 'csv')",
        )
        .run().lastInsertRowid,
    );

  it('get_movie and update_movie by tconst ignore an unresolved item holding that tconst', async () => {
    const id = hinted();
    const got = await call('get_movie', { tconst: 'tt9000019' });
    expect(got.isError).toBeFalsy();
    expect(got.structuredContent).toMatchObject({ movie: { title: 'Wolf Season' }, library: [] });

    const upd = await call('update_movie', { tconst: 'tt9000019', status: 'watched', myRating: 2 });
    expect(upd.isError).toBe(true);
    expect(getItem(db, id)!.myRating).toBe(8);

    // By id it is still reachable, and get_movie does not present the hint's catalog record.
    const byId = await call('get_movie', { id });
    expect(byId.structuredContent).toMatchObject({ movie: null, library: [{ id }] });
    expect((await call('update_movie', { id, myRating: 6 })).isError).toBeFalsy();
    expect(getItem(db, id)!.myRating).toBe(6);
    expect((await call('remove_from_library', { id })).isError).toBeFalsy();
    expect(getItem(db, id)).toBeNull();
  });
});

describe('add_to_library and remove_from_library', () => {
  it('adds a catalog movie, refuses a silent second edition, then removes it', async () => {
    const a = await call('add_to_library', { tconst: 'tt9000019', status: 'priority' });
    expect(a.isError).toBeFalsy();
    const item = a.structuredContent as { id: number; tconst: string; status: string };
    expect(item).toMatchObject({ tconst: 'tt9000019', status: 'priority' });

    const again = await call('add_to_library', { tconst: 'tt9000019' });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain(String(item.id));
    const edition = await call('add_to_library', { tconst: 'tt9000019', newEdition: true });
    expect(edition.isError).toBeFalsy();

    const rm = await call('remove_from_library', { id: item.id });
    expect(rm.isError).toBeFalsy();
    expect(getItem(db, item.id)).toBeNull();
    expect((await call('remove_from_library', { id: item.id })).isError).toBe(true);
  });

  it('add_to_library rejects a tconst not in the catalog', async () => {
    expect((await call('add_to_library', { tconst: 'tt0000001' })).isError).toBe(true);
  });
});

describe('stdio session (Review Focus #1)', () => {
  it('every stdout line is a JSON-RPC message', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp', '--home', catalogHome], {
      env: { ...process.env, SCREENTRACKR_HOME: join(tmp, 'never-used-home') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => (stderr += d));
    const gotCall = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; stdout=${stdout} stderr=${stderr}`)), 20_000);
      child.stdout.on('data', (d: string) => {
        stdout += d;
        if (/"id":3\b/.test(stdout)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_movies', arguments: { directors: ['fincher'] } } });
    await gotCall;
    child.stdin.end();
    expect(await exited).toBe(0);

    const lines = stdout.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const msgs = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id?: number; result?: Record<string, unknown> });
    for (const m of msgs) expect(m.jsonrpc).toBe('2.0');
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3]);
    expect((msgs[0]!.result as { serverInfo: { name: string } }).serverInfo.name).toBe('screentrackr');
    expect((msgs[1]!.result as { tools: unknown[] }).tools).toHaveLength(6);
    expect((msgs[2]!.result as { isError?: boolean }).isError).toBeFalsy();
  }, 30_000);
});

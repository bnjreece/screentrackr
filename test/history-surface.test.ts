/**
 * `log`, `history` and `set --watched-at` on the command line, and the MCP
 * tools log_viewing, list_viewings and remove_viewing: both run core/history.ts,
 * so they give the same answers. The CLI is the built `dist/cli/index.js`
 * against a temp home. All titles are made up; no catalog is built.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../src/core/db.js';
import { localToday } from '../src/core/history.js';
import { createMcpServer } from '../src/mcp/server.js';
import { addViewing, viewingsOf } from '../src/core/viewings.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

let tmp: string;
let home: string;
let n = 0;

function cli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI, '--home', home, ...args], {
    env: { ...process.env, SCREENTRACKR_HOME: join(tmp, 'never-used') },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}
const cliJson = <T = Record<string, unknown>>(args: string[]): T => {
  const r = cli([...args, '--json']);
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as T;
};

/** Open the temp home, run fn, close it (the CLI opens it itself in between). */
function withDb<T>(fn: (db: Db) => T): T {
  const db = openDb(home);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const addItem = (db: Db, title: string, year: number, status = 'queue') =>
  Number(
    db.sql.prepare("INSERT INTO library_items (source_title, source_year, status, match_status, source) VALUES (?, ?, ?, 'unmatched', 'paste')").run(title, year, status)
      .lastInsertRowid,
  );

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-hist-'));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => {
  home = join(tmp, `home-${n++}`);
  withDb(() => undefined);
});

describe('screentrackr log', () => {
  it('logs today by default, marks watched, and each log is its own play', () => {
    const id = withDb((db) => addItem(db, 'Pale Rooftops', 1994));
    const first = cliJson<{ viewing: { id: number; watchedAt: string; source: string }; item: { status: string }; plays: number }>(['log', String(id)]);
    expect(first.viewing).toMatchObject({ watchedAt: localToday(), source: 'manual' });
    expect(first.item.status).toBe('watched');
    const text = cli(['log', 'Pale Rooftops', '--on', '2020-02-02', '--rewatch', '--rating', '7']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toMatch(/Logged a play of Pale Rooftops \(1994\) \(item \d+\) on 2020-02-02, a rewatch, rated 7: viewing \d+\./);
    expect(text.stdout).toMatch(/Plays: 2\./);
    withDb((db) => {
      expect(viewingsOf(db, id)).toHaveLength(2);
      expect(db.sql.prepare('SELECT my_rating FROM library_items WHERE id = ?').get(id)).toEqual({ my_rating: 7 });
    });
  });

  it('--keep-status leaves the status; bad input exits 1 and writes nothing', () => {
    const id = withDb((db) => addItem(db, 'Quiet Ledger', 2001, 'priority'));
    expect(cliJson<{ item: { status: string } }>(['log', String(id), '--on', '2021-01-01', '--keep-status']).item.status).toBe('priority');
    for (const args of [
      ['log', String(id), '--on', '2999-01-01'],
      ['log', String(id), '--on', '2021-02-30'],
      ['log', String(id), '--rating', '11'],
      ['log', 'No Such Film'],
      ['log'],
    ]) {
      const r = cli(args);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/^Error: /);
    }
    withDb((db) => expect(viewingsOf(db, id)).toHaveLength(1));
  });

  it('refuses a title that matches two items, listing their ids', () => {
    withDb((db) => {
      addItem(db, 'Twin Rivers', 2001);
      addItem(db, 'Twin Rivers', 2001);
    });
    const r = cli(['log', 'Twin Rivers']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/matches 2 library items/);
  });
});

describe('screentrackr history', () => {
  it('lists plays newest first with R, sources and ids, and filters', () => {
    const ids = withDb((db) => {
      const a = addItem(db, 'Pale Rooftops', 1994, 'watched');
      const b = addItem(db, 'Quiet Ledger', 2001, 'watched');
      addViewing(db, a, { watchedAt: '2019-01-01', source: 'trakt', sourceRef: '9007199254740993' });
      const lb = addViewing(db, a, { watchedAt: '2024-10-31', source: 'letterboxd', sourceRef: 'https://boxd.it/e1', rating: 8 });
      const tr = addViewing(db, a, { watchedAt: '2024-10-31', source: 'trakt', sourceRef: '12' });
      addViewing(db, b, { watchedAt: '2024-06-06', source: 'plex' });
      addViewing(db, b, { watchedAt: null, source: 'trakt' });
      return { a, b, lb: lb.id, tr: tr.id };
    });
    const r = cli(['history']);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toMatch(new RegExp(`^2024-10-31  R  Pale Rooftops \\(1994\\)  letterboxd\\+trakt  rated 8  #${ids.tr} #${ids.lb}$`));
    expect(lines[1]).toMatch(/^2024-06-06     Quiet Ledger \(2001\)  plex  #\d+$/);
    expect(lines[2]).toMatch(/^2019-01-01     Pale Rooftops/);
    expect(lines[3]).toMatch(/^no date {8}Quiet Ledger/);
    expect(lines[4]).toBe('4 plays.');

    expect(cliJson<{ total: number }>(['history', '--year', '2024']).total).toBe(2);
    expect(cliJson<{ total: number }>(['history', String(ids.a)]).total).toBe(2);
    expect(cliJson<{ total: number }>(['history', '--source', 'plex']).total).toBe(1);
    expect(cliJson<{ total: number }>(['history', '--from', '2024-01-01', '--to', '2024-07-01']).total).toBe(1);
    const limited = cli(['history', '-n', '1']);
    expect(limited.stdout).toMatch(/\.\.\. 3 more \(-n 4 shows them all\)/);
    // Trakt's int64 play ids stay strings.
    const all = cliJson<{ plays: { viewings: { sourceRef: string | null }[] }[] }>(['history']);
    expect(all.plays.flatMap((p) => p.viewings.map((v) => v.sourceRef))).toContain('9007199254740993');
    expect(cli(['history', '--source', 'netflix']).code).toBe(1);
    expect(cli(['history', '-n', '0']).code).toBe(1);
    expect(cli(['history', '--from', '2024-13-01']).code).toBe(1);
  });

  it('says so when nothing matches', () => {
    expect(cli(['history']).stdout.trim()).toBe('No plays match.');
  });

  it('--remove deletes one viewing by id, and only takes an id', () => {
    const { id, later } = withDb((db) => {
      const id = addItem(db, 'Pale Rooftops', 1994, 'watched');
      addViewing(db, id, { watchedAt: '2019-01-01', source: 'manual' });
      return { id, later: addViewing(db, id, { watchedAt: '2022-01-01', source: 'trakt' }).id };
    });
    expect(cli(['history', '--remove', String(later), 'Pale Rooftops']).code).toBe(1);
    expect(cli(['history', '--remove', 'Pale Rooftops']).code).toBe(1);
    const r = cli(['history', '--remove', String(later)]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`Removed viewing ${later} \\(2022-01-01, from trakt\\) of Pale Rooftops \\(1994\\) \\(item ${id}\\)\\. Watched date: 2019-01-01\\.`));
    expect(cli(['history', '--remove', String(later)]).code).toBe(1);
  });
});

describe('screentrackr set --watched-at / --clear-watched-at', () => {
  it('refuses a date earlier than a play, naming it, and clears every play with a count', () => {
    const { id, v } = withDb((db) => {
      const id = addItem(db, 'Pale Rooftops', 1994, 'watched');
      return { id, v: addViewing(db, id, { watchedAt: '2022-05-05', source: 'trakt' }).id };
    });
    const refused = cli(['set', String(id), '--watched-at', '2021-01-01']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toMatch(new RegExp(`viewing ${v}.*history --remove ${v}`));
    withDb((db) => expect(viewingsOf(db, id)).toHaveLength(1));
    expect(cli(['set', String(id), '--watched-at', '2023-01-01']).code).toBe(0);
    const cleared = cli(['set', String(id), '--clear-watched-at']);
    expect(cleared.stdout).toMatch(/removed 2 plays/);
    withDb((db) => expect(viewingsOf(db, id)).toEqual([]));
  });
});

describe('MCP history tools', () => {
  let db: Db;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[]; structuredContent?: Record<string, unknown> };

  beforeEach(async () => {
    db = openDb(home);
    const server = createMcpServer(db);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'history-test', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
  });
  afterEach(async () => {
    await client.close();
    db.close();
  });

  it('annotates the tools: list is read-only, remove is destructive', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.list_viewings?.annotations).toMatchObject({ readOnlyHint: true });
    expect(by.remove_viewing?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(by.log_viewing?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    for (const t of ['log_viewing', 'list_viewings', 'remove_viewing']) expect(by[t]?.description).not.toContain('—');
  });

  it('log_viewing records a play; remove_viewing deletes it by id', async () => {
    const id = addItem(db, 'Pale Rooftops', 1994);
    const logged = await call('log_viewing', { id, date: '2021-04-04', rating: 9, rewatch: false });
    expect(logged.isError).toBeFalsy();
    expect(logged.structuredContent).toMatchObject({ viewing: { watchedAt: '2021-04-04', rating: 9, rewatch: false, source: 'manual' }, item: { status: 'watched', myRating: 9 } });
    const vid = (logged.structuredContent as { viewing: { id: number } }).viewing.id;
    expect((await call('log_viewing', { id, date: '2999-01-01' })).isError).toBe(true);
    expect((await call('log_viewing', { date: '2021-01-01' })).isError).toBe(true);
    expect((await call('log_viewing', { id: 999999 })).isError).toBe(true);
    const removed = await call('remove_viewing', { viewingId: vid });
    expect(removed.isError).toBeFalsy();
    expect(viewingsOf(db, id)).toEqual([]);
    expect((await call('remove_viewing', { viewingId: vid })).isError).toBe(true);
  });

  it('list_viewings gives what `history --json` gives for the same filters', async () => {
    const a = addItem(db, 'Pale Rooftops', 1994, 'watched');
    const b = addItem(db, 'Quiet Ledger', 2001, 'watched');
    addViewing(db, a, { watchedAt: '2019-01-01', source: 'trakt' });
    addViewing(db, a, { watchedAt: '2024-10-31', source: 'letterboxd', rating: 8 });
    addViewing(db, a, { watchedAt: '2024-10-31', source: 'trakt' });
    addViewing(db, b, { watchedAt: '2024-06-06', source: 'plex' });
    addViewing(db, b, { watchedAt: null, source: 'trakt' });
    const cases: [Record<string, unknown>, string[]][] = [
      [{}, []],
      [{ year: 2024 }, ['--year', '2024']],
      [{ id: a }, [String(a)]],
      [{ source: 'trakt', limit: 2 }, ['--source', 'trakt', '-n', '2']],
      [{ from: '2024-01-01', to: '2024-12-31' }, ['--from', '2024-01-01', '--to', '2024-12-31']],
    ];
    for (const [args, flags] of cases) {
      const mcp = (await call('list_viewings', args)).structuredContent;
      expect(mcp, JSON.stringify(args)).toEqual(cliJson(['history', ...flags]));
    }
    expect((await call('list_viewings', { id: a, tconst: 'tt9000001' })).isError).toBe(true);
    expect((await call('list_viewings', { from: '2024-1-1' })).isError).toBe(true);
  });
});

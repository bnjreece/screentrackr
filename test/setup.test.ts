/**
 * Catalog setup from an MCP client: the setup lock, the background SetupJob,
 * and the setup_catalog / catalog_status tools. The real worker thread runs
 * from dist/ (built by global-setup) against a cache pre-filled with the
 * synthetic fixtures, so nothing is downloaded.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATASETS, datasetFile } from '../src/core/catalog/download.js';
import { catalogReady, openDb, type Db } from '../src/core/db.js';
import { cacheDir } from '../src/core/home.js';
import { getItem } from '../src/core/library.js';
import { acquireSetupLock, IMDB_CREDIT, SETUP_LOCK_FILE, SetupBusyError, setupLockHolder, type SetupResult } from '../src/core/setup.js';
import { createMcpServer, SETUP_HINT } from '../src/mcp/server.js';
import { inProcessRunner, PROGRESS_LINES, SetupJob, workerRunner, type SetupRunner } from '../src/mcp/setup-job.js';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'imdb');
const WORKER = pathToFileURL(join(ROOT, 'dist', 'mcp', 'setup-worker.js'));

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
}

const text = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('\n');

let tmp: string;
let home: string;
let db: Db | null;
let client: Client | null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screentrackr-setup-'));
  home = join(tmp, 'home');
  db = null;
  client = null;
});

afterEach(async () => {
  await client?.close();
  db?.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** Fill home's cache with the fixture datasets so setup never downloads. */
function seedCache(h: string): void {
  mkdirSync(cacheDir(h), { recursive: true });
  for (const d of DATASETS) copyFileSync(join(FIXTURES, datasetFile(d)), join(cacheDir(h), datasetFile(d)));
}

/** A pid that is certainly not running: a child that has already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', '0']);
  return r.pid as number;
}

async function connect(job?: SetupJob): Promise<(name: string, args?: Record<string, unknown>) => Promise<ToolResult>> {
  db = openDb(home);
  const server = createMcpServer(db, job ? { setupJob: job } : {});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'setup-test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const c = client;
  return async (name, args = {}) => (await c.callTool({ name, arguments: args })) as ToolResult;
}

/** A runner the test controls: resolve or reject it by hand, push progress lines. */
function manualRunner() {
  let resolve!: (r: SetupResult) => void;
  let reject!: (e: Error) => void;
  let progress!: (m: string) => void;
  const calls: unknown[] = [];
  const runner: SetupRunner = (input, onProgress) => {
    calls.push(input);
    progress = onProgress;
    return new Promise<SetupResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  return { runner, calls, resolve: (r: SetupResult) => resolve(r), reject: (e: Error) => reject(e), progress: (m: string) => progress(m) };
}

const FAKE_RESULT: SetupResult = {
  catalog: { movies: 3, rated: 3, people: 2, castRows: 1, seconds: 1 },
  downloads: [],
  matching: { matched: 0, ambiguous: 0, unmatched: 0 },
  credit: IMDB_CREDIT,
};

describe('setup lock', () => {
  it('is exclusive while held and free once released', () => {
    mkdirSync(home, { recursive: true });
    const release = acquireSetupLock(home);
    expect(setupLockHolder(home)).toBe(process.pid);
    expect(() => acquireSetupLock(home)).toThrow(SetupBusyError);
    release();
    expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(false);
    expect(setupLockHolder(home)).toBeNull();
    acquireSetupLock(home)();
  });

  it('replaces a lock left by a dead process, a very old lock and a garbled one', () => {
    mkdirSync(home, { recursive: true });
    const path = join(home, SETUP_LOCK_FILE);
    for (const content of [
      JSON.stringify({ pid: deadPid(), startedAt: Date.now() }),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 13 * 60 * 60 * 1000 }),
      '{not json',
    ]) {
      writeFileSync(path, content);
      expect(setupLockHolder(home)).toBeNull();
      const release = acquireSetupLock(home);
      expect(setupLockHolder(home)).toBe(process.pid);
      release();
    }
  });
});

describe('SetupJob', () => {
  it('runs in the background, keeps the latest progress lines and reports success', async () => {
    let clock = 1_000_000;
    const m = manualRunner();
    const job = new SetupJob(home, m.runner, () => clock);
    expect(job.status()).toMatchObject({ state: 'idle', startedAt: null, progress: [] });

    const started = job.start({ refresh: false, withCast: false, includeTvMovies: true });
    expect(started.state).toBe('running');
    expect(m.calls).toEqual([{ home, refresh: false, withCast: false, includeTvMovies: true }]);
    for (let i = 1; i <= PROGRESS_LINES + 3; i++) m.progress(`step ${i}`);
    clock += 42_000;
    const mid = job.status();
    expect(mid.elapsedSeconds).toBe(42);
    expect(mid.progress).toHaveLength(PROGRESS_LINES);
    expect(mid.progress.at(-1)).toBe(`step ${PROGRESS_LINES + 3}`);
    expect(mid.progress[0]).toBe('step 4');

    expect(() => job.start({ refresh: false, withCast: true, includeTvMovies: false })).toThrow(SetupBusyError);

    m.resolve(FAKE_RESULT);
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'succeeded', result: FAKE_RESULT, error: null, elapsedSeconds: 42 });
  });

  it('reports a failure and can be started again', async () => {
    const m = manualRunner();
    const job = new SetupJob(home, m.runner);
    job.start({ refresh: false, withCast: true, includeTvMovies: false });
    m.reject(new Error('Download of title.basics.tsv.gz failed: HTTP 503'));
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'failed', error: 'Download of title.basics.tsv.gz failed: HTTP 503' });

    job.start({ refresh: true, withCast: true, includeTvMovies: false });
    expect(job.status()).toMatchObject({ state: 'running', error: null, options: { refresh: true } });
    m.resolve(FAKE_RESULT);
    await job.settled();
    expect(job.status().state).toBe('succeeded');
  });

  it('turns a runner that throws synchronously into a failed run', async () => {
    const job = new SetupJob(home, () => {
      throw new Error('no worker');
    });
    job.start({ refresh: false, withCast: true, includeTvMovies: false });
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'failed', error: 'no worker' });
  });

  it('refuses to start while another process holds the setup lock', () => {
    mkdirSync(home, { recursive: true });
    const release = acquireSetupLock(home);
    try {
      const job = new SetupJob(home, manualRunner().runner);
      expect(() => job.start({ refresh: false, withCast: true, includeTvMovies: false })).toThrow(/already running/);
      expect(job.status().state).toBe('idle');
    } finally {
      release();
    }
  });

  it('the in-process runner builds the catalog from the cache and releases the lock', async () => {
    seedCache(home);
    openDb(home).close();
    const lines: string[] = [];
    const result = await inProcessRunner({ home, refresh: false, withCast: true, includeTvMovies: false }, (m) => lines.push(m));
    expect(result.catalog.movies).toBeGreaterThan(0);
    expect(result.downloads.every((d) => !d.downloaded)).toBe(true);
    expect(lines.join('\n')).toMatch(/Using cached title\.basics/);
    expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(false);
  });
});

describe('setup_catalog and catalog_status tools', () => {
  it('before setup: catalog_status says not built and points at setup_catalog', async () => {
    const call = await connect(new SetupJob(home, manualRunner().runner));
    const r = await call('catalog_status');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ catalog: { ready: false, movies: null }, setup: { state: 'idle' } });
    expect(text(r)).toContain('Catalog not built yet.');
    expect(text(r)).toContain('setup_catalog');
  });

  it('catalog-dependent tools name setup_catalog in their error', async () => {
    const call = await connect(new SetupJob(home, manualRunner().runner));
    const r = await call('search_movies', { scope: 'all' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(`Catalog not built. Run \`screentrackr setup\`. ${SETUP_HINT}`);
    const add = await call('add_to_library', { tconst: 'tt9000003' });
    expect(add.isError).toBe(true);
    expect(text(add)).toContain(SETUP_HINT);
  });

  it('starts once, reports progress while running, then failure, and retries', async () => {
    const m = manualRunner();
    const call = await connect(new SetupJob(home, m.runner));
    const first = await call('setup_catalog', { withCast: false });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({ started: true, setup: { state: 'running', options: { withCast: false, refresh: false } } });
    expect(text(first)).toMatch(/catalog_status/);

    m.progress('Downloading title.basics.tsv.gz');
    const again = await call('setup_catalog');
    expect(again.structuredContent).toMatchObject({ started: false, setup: { state: 'running' } });
    expect(text(again)).toMatch(/already running/);
    expect(m.calls).toHaveLength(1);

    const mid = await call('catalog_status');
    expect(text(mid)).toContain('Downloading title.basics.tsv.gz');

    m.reject(new Error('Download of title.basics.tsv.gz from https://example.invalid/ failed: HTTP 503'));
    await new Promise((r) => setImmediate(r));
    const failed = await call('catalog_status');
    expect(failed.isError).toBeFalsy();
    expect(failed.structuredContent).toMatchObject({ setup: { state: 'failed' } });
    expect(text(failed)).toMatch(/Setup failed: Download of title\.basics/);
    expect(text(failed)).toMatch(/setup_catalog again/);

    const retry = await call('setup_catalog');
    expect(retry.structuredContent).toMatchObject({ started: true });
    expect(m.calls).toHaveLength(2);
  });

  it('is a tool error when a terminal setup holds the lock', async () => {
    const call = await connect(new SetupJob(home, manualRunner().runner));
    const release = acquireSetupLock(home);
    try {
      const r = await call('setup_catalog');
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Setup is already running \(process \d+\)/);
    } finally {
      release();
    }
  });

  it('builds the real catalog in a worker thread, then search works and a second call is a no-op', async () => {
    seedCache(home);
    const call = await connect(new SetupJob(home, workerRunner(WORKER)));
    const itemId = Number(
      db!.sql.prepare("INSERT INTO library_items (source_title, source_year, source, status) VALUES ('Quiet Ledger', 1999, 'csv', 'watched')").run()
        .lastInsertRowid,
    );

    const start = await call('setup_catalog');
    expect(start.structuredContent).toMatchObject({ started: true });

    let status: ToolResult | null = null;
    for (let i = 0; i < 200; i++) {
      status = await call('catalog_status');
      if ((status.structuredContent as { setup: { state: string } }).setup.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status!.structuredContent, text(status!)).toMatchObject({ catalog: { ready: true, withCast: true }, setup: { state: 'succeeded' } });
    expect(text(status!)).toContain(IMDB_CREDIT);
    expect(catalogReady(db!)).toBe(true);
    expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(false);
    // Setup refreshed matching, and left the status alone.
    expect(getItem(db!, itemId)).toMatchObject({ tconst: 'tt9000003', matchStatus: 'matched', status: 'watched' });

    const all = await call('search_movies', { scope: 'all', directors: ['fincher'], minVotes: 0 });
    expect(all.isError, text(all)).toBeFalsy();
    expect((all.structuredContent as { total: number }).total).toBeGreaterThan(0);

    const noop = await call('setup_catalog');
    expect(noop.structuredContent).toMatchObject({ started: false, catalog: { ready: true } });
    expect(text(noop)).toMatch(/refresh: true/);
  }, 30_000);
});

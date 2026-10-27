/**
 * Catalog setup from an MCP client: the setup lock, the background SetupJob,
 * and the setup_catalog / catalog_status tools. The real worker thread runs
 * from dist/ (built by global-setup) against a cache pre-filled with the
 * synthetic fixtures, so nothing is downloaded.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/core/catalog/build.js';
import { DATASETS, datasetFile } from '../src/core/catalog/download.js';
import { catalogReady, openDb, type Db } from '../src/core/db.js';
import { cacheDir } from '../src/core/home.js';
import { getItem } from '../src/core/library.js';
import { acquireSetupLock, IMDB_CREDIT, matchingPending, SetupBusyError, setupRunning, type SetupResult } from '../src/core/setup.js';
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
  mkdirSync(home);
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

async function connect(job?: SetupJob): Promise<(name: string, args?: Record<string, unknown>) => Promise<ToolResult>> {
  db = openDb(home);
  const server = createMcpServer(db, job ? { setupJob: job } : {});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'setup-test', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const c = client;
  return async (name, args = {}) => (await c.callTool({ name, arguments: args })) as ToolResult;
}

/** Poll catalog_status until the setup is no longer running. */
async function waitForSetup(call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
  for (let i = 0; i < 400; i++) {
    const status = await call('catalog_status');
    if ((status.structuredContent as { setup: { state: string } }).setup.state !== 'running') return status;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('setup did not finish');
}

/** A runner the test controls: resolve or reject it by hand, push progress lines. */
function manualRunner() {
  let resolve!: (r: SetupResult) => void;
  let reject!: (e: Error) => void;
  let progress!: (m: string) => void;
  const calls: unknown[] = [];
  let stops = 0;
  const runner: SetupRunner = (input, onProgress) => {
    calls.push(input);
    progress = onProgress;
    const done = new Promise<SetupResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      done,
      stop: async () => {
        stops++;
        reject(new Error('stopped'));
        await done.catch(() => {});
      },
    };
  };
  return {
    runner,
    calls,
    stops: () => stops,
    resolve: (r: SetupResult) => resolve(r),
    reject: (e: Error) => reject(e),
    progress: (m: string) => progress(m),
  };
}

const FULL = { refresh: false, withCast: true, includeTvMovies: false, matchOnly: false };

const FAKE_RESULT: SetupResult = {
  catalog: { movies: 3, rated: 3, people: 2, castRows: 1, seconds: 1 },
  downloads: [],
  matching: { matched: 0, ambiguous: 0, unmatched: 0 },
  credit: IMDB_CREDIT,
};

/** Run `code` in a child Node process with `acquireSetupLock` and `home` in scope; resolves with its stdout once it exits. */
function child(code: string, opts: { onStdout?: (out: string, kill: () => void) => void } = {}): Promise<string> {
  const script = [`const { acquireSetupLock } = await import(process.argv[1]);`, `const home = process.argv[2];`, code].join('\n');
  const mod = pathToFileURL(join(ROOT, 'dist', 'core', 'setup.js')).href;
  return new Promise<string>((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script, mod, home]);
    let out = '';
    c.stdout.on('data', (d) => {
      out += d;
      opts.onStdout?.(out, () => c.kill('SIGKILL'));
    });
    c.on('exit', () => resolve(out));
  });
}

describe('setup lock', () => {
  it('is exclusive while held and free once released', () => {
    const release = acquireSetupLock(home);
    expect(setupRunning(home)).toBe(process.pid);
    expect(() => acquireSetupLock(home)).toThrow(SetupBusyError);
    expect(() => acquireSetupLock(home)).toThrow(`Setup is already running (process ${process.pid})`);
    release();
    release(); // Twice is harmless.
    expect(setupRunning(home)).toBeUndefined();
    acquireSetupLock(home)();
  });

  it('is exclusive across processes', async () => {
    const release = acquireSetupLock(home);
    try {
      const out = await child("try { acquireSetupLock(home); process.stdout.write('won'); } catch (e) { process.stdout.write(e.name); }");
      expect(out).toBe('SetupBusyError');
    } finally {
      release();
    }
    const out = await child("acquireSetupLock(home)(); process.stdout.write('won');");
    expect(out).toBe('won');
  });

  it('is freed by the operating system when its holder is killed', async () => {
    let killedWhileHeld = false;
    await child("globalThis.held = acquireSetupLock(home); process.stdout.write('held'); setInterval(() => {}, 1000);", {
      onStdout: (out, kill) => {
        if (out === 'held') {
          killedWhileHeld = setupRunning(home) !== undefined;
          kill();
        }
      },
    });
    expect(killedWhileHeld).toBe(true);
    expect(setupRunning(home)).toBeUndefined();
    expect(() => acquireSetupLock(home)()).not.toThrow();
  });

  it('only one of many simultaneous contenders gets it', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        child("try { globalThis.held = acquireSetupLock(home); process.stdout.write('won'); setTimeout(() => {}, 1500); } catch (e) { process.stdout.write(e.name); }"),
      ),
    );
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r === 'SetupBusyError')).toHaveLength(7);
  }, 20_000);
});

describe('SetupJob', () => {
  it('runs in the background, keeps the latest progress lines and reports success', async () => {
    let clock = 1_000_000;
    const m = manualRunner();
    const job = new SetupJob(home, m.runner, () => clock);
    expect(job.status()).toMatchObject({ state: 'idle', startedAt: null, progress: [] });

    const started = job.start({ refresh: false, withCast: false, includeTvMovies: true, matchOnly: false });
    expect(started.state).toBe('running');
    expect(m.calls).toEqual([{ home, refresh: false, withCast: false, includeTvMovies: true, matchOnly: false }]);
    // The job holds the setup lock while the work runs.
    expect(setupRunning(home)).toBe(process.pid);
    for (let i = 1; i <= PROGRESS_LINES + 3; i++) m.progress(`step ${i}`);
    clock += 42_000;
    const mid = job.status();
    expect(mid.elapsedSeconds).toBe(42);
    expect(mid.progress).toHaveLength(PROGRESS_LINES);
    expect(mid.progress.at(-1)).toBe(`step ${PROGRESS_LINES + 3}`);
    expect(mid.progress[0]).toBe('step 4');

    expect(() => job.start(FULL)).toThrow(/already running/);

    m.resolve(FAKE_RESULT);
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'succeeded', result: FAKE_RESULT, error: null, elapsedSeconds: 42 });
    expect(setupRunning(home)).toBeUndefined();
  });

  it('reports a failure and can be started again', async () => {
    const m = manualRunner();
    const job = new SetupJob(home, m.runner);
    job.start(FULL);
    m.reject(new Error('Download of title.basics.tsv.gz failed: HTTP 503'));
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'failed', error: 'Download of title.basics.tsv.gz failed: HTTP 503' });
    expect(setupRunning(home)).toBeUndefined();

    job.start({ ...FULL, refresh: true });
    expect(job.status()).toMatchObject({ state: 'running', error: null, options: { refresh: true } });
    m.resolve(FAKE_RESULT);
    await job.settled();
    expect(job.status().state).toBe('succeeded');
  });

  it('turns a runner that throws synchronously into a failed run', async () => {
    const job = new SetupJob(home, () => {
      throw new Error('no worker');
    });
    job.start(FULL);
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'failed', error: 'no worker' });
    expect(setupRunning(home)).toBeUndefined();
  });

  it('leaves the lock to the operating system at process exit (no exit hook that frees it early)', async () => {
    const before = process.listenerCount('exit');
    const m = manualRunner();
    const job = new SetupJob(home, m.runner);
    job.start(FULL);
    expect(process.listenerCount('exit')).toBe(before);
    m.resolve(FAKE_RESULT);
    await job.settled();
  });

  it('stop() ends a running setup and releases the lock', async () => {
    const m = manualRunner();
    const job = new SetupJob(home, m.runner);
    job.start(FULL);
    await job.stop();
    expect(m.stops()).toBe(1);
    expect(job.status().state).toBe('failed');
    expect(setupRunning(home)).toBeUndefined();
    await job.stop(); // Idle: nothing to do.
  });

  it('refuses to start while another process holds the setup lock', () => {
    const release = acquireSetupLock(home);
    try {
      const job = new SetupJob(home, manualRunner().runner);
      expect(() => job.start(FULL)).toThrow(/already running/);
      expect(job.status().state).toBe('idle');
    } finally {
      release();
    }
  });

  it('the in-process runner builds the catalog from the cache and releases the lock', async () => {
    seedCache(home);
    openDb(home).close();
    const lines: string[] = [];
    const result = await inProcessRunner({ home, ...FULL }, (m) => lines.push(m)).done;
    expect(result.catalog!.movies).toBeGreaterThan(0);
    expect(result.downloads.every((d) => !d.downloaded)).toBe(true);
    expect(lines.join('\n')).toMatch(/Using cached title\.basics/);
  });

  it('a worker that dies mid-setup fails the job and frees the lock for a retry', async () => {
    const crash = join(tmp, 'crash-worker.mjs');
    writeFileSync(
      crash,
      "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ type: 'progress', message: 'Downloading' }); process.exit(7);",
    );
    const job = new SetupJob(home, workerRunner(pathToFileURL(crash)));
    job.start(FULL);
    await job.settled();
    expect(job.status()).toMatchObject({ state: 'failed', progress: ['Downloading'] });
    expect(job.status().error).toMatch(/exit code 7/);
    expect(setupRunning(home)).toBeUndefined();
    expect(() => acquireSetupLock(home)()).not.toThrow();
  });

  it('stop() terminates a worker that is still running', async () => {
    const hang = join(tmp, 'hang-worker.mjs');
    writeFileSync(hang, 'setInterval(() => {}, 1000);');
    const job = new SetupJob(home, workerRunner(pathToFileURL(hang)));
    job.start(FULL);
    expect(job.isRunning).toBe(true);
    await job.stop();
    expect(job.status().state).toBe('failed');
    expect(setupRunning(home)).toBeUndefined();
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

  it('finishes matching that a build left pending, without downloading or rebuilding', async () => {
    seedCache(home);
    const call = await connect(new SetupJob(home, workerRunner(WORKER)));
    const seed = openDb(home);
    await buildCatalog(seed, { cacheDir: cacheDir(home) });
    seed.close();
    // The build committed but the rematch after it never ran (the app quit, say).
    expect(matchingPending(db!)).toBe(true);
    const itemId = Number(
      db!.sql.prepare("INSERT INTO library_items (source_title, source_year, source, status) VALUES ('Quiet Ledger', 1999, 'csv', 'queue')").run()
        .lastInsertRowid,
    );
    const status = await call('catalog_status');
    expect(status.structuredContent).toMatchObject({ catalog: { ready: true, matchingPending: true } });
    expect(text(status)).toMatch(/did not finish/);

    const start = await call('setup_catalog');
    expect(start.structuredContent).toMatchObject({ started: true, setup: { options: { matchOnly: true } } });
    const done = await waitForSetup(call);
    expect(done.structuredContent, text(done)).toMatchObject({
      catalog: { matchingPending: false },
      setup: { state: 'succeeded', result: { catalog: null, downloads: [] } },
    });
    expect(text(done)).toMatch(/Library matching finished/);
    expect(getItem(db!, itemId)).toMatchObject({ tconst: 'tt9000003', matchStatus: 'matched' });

    const noop = await call('setup_catalog');
    expect(noop.structuredContent).toMatchObject({ started: false });
  }, 30_000);

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

    const status = await waitForSetup(call);
    expect(status.structuredContent, text(status)).toMatchObject({ catalog: { ready: true, withCast: true }, setup: { state: 'succeeded' } });
    expect(text(status)).toContain(IMDB_CREDIT);
    expect(catalogReady(db!)).toBe(true);
    expect(setupRunning(home)).toBeUndefined();
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

/**
 * The background catalog setup behind the MCP `setup_catalog` and
 * `catalog_status` tools. Setup downloads about 1 GB and takes minutes, far
 * longer than an MCP request may wait, so `start` returns at once and the
 * client polls `status`. The work runs in a worker thread with its own
 * database connection (Claude Desktop's built-in Node cannot spawn a child
 * `node` process); if worker threads are unavailable it runs on this thread.
 *
 * The job takes the setup lock itself before starting the work and releases
 * it once the work has ended, however it ended, so a worker that dies (out of
 * memory, say) never leaves a lock behind.
 */
import { Worker } from 'node:worker_threads';
import { openDb } from '../core/db.js';
import { acquireSetupLock, runSetup, type SetupResult } from '../core/setup.js';

export interface SetupInput {
  home: string;
  refresh: boolean;
  withCast: boolean;
  includeTvMovies: boolean;
  /** Only redo the library matching a previous build left pending. */
  matchOnly: boolean;
}

/** One running setup: its outcome, and a way to stop it early. */
export interface SetupRun {
  done: Promise<SetupResult>;
  /** Stop the work if it can be stopped, resolving once it has. */
  stop(): Promise<void>;
}

/**
 * Starts one setup, reporting progress lines as it goes. The caller already
 * holds the setup lock, so the runner must not take it.
 */
export type SetupRunner = (input: SetupInput, onProgress: (msg: string) => void) => SetupRun;

export type SetupState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface SetupJobStatus {
  state: SetupState;
  options: Omit<SetupInput, 'home'> | null;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedSeconds: number | null;
  /** The latest progress lines, oldest first. */
  progress: string[];
  result: SetupResult | null;
  error: string | null;
}

/** How many progress lines `status` keeps. */
export const PROGRESS_LINES = 8;

type WorkerMessage = { type: 'progress'; message: string } | { type: 'done'; result: SetupResult } | { type: 'error'; message: string };

/** Run setup on this thread with a second database connection. It can't be stopped early. */
export const inProcessRunner: SetupRunner = (input, onProgress) => {
  const done = (async () => {
    const db = openDb(input.home);
    try {
      return await runSetup(db, { ...input, lockHeld: true, onProgress });
    } finally {
      db.close();
    }
  })();
  return { done, stop: async () => {} };
};

/**
 * Run setup in a worker thread loaded from `url` (by default the compiled
 * setup-worker.js next to this file). Falls back to `inProcessRunner` only
 * when the worker cannot be created at all.
 */
export function workerRunner(url: URL = new URL('./setup-worker.js', import.meta.url)): SetupRunner {
  return (input, onProgress) => {
    let worker: Worker;
    try {
      worker = new Worker(url, { workerData: input });
    } catch {
      return inProcessRunner(input, onProgress);
    }
    let exited = false;
    const exit = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    const done = new Promise<SetupResult>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };
      worker.on('message', (m: WorkerMessage) => {
        if (m.type === 'progress') onProgress(m.message);
        else if (m.type === 'done') settle(() => resolve(m.result));
        else settle(() => reject(new Error(m.message)));
      });
      worker.on('error', (err) => settle(() => reject(err)));
      worker.on('exit', (code) => {
        exited = true;
        settle(() => reject(new Error(`Setup stopped before it finished (worker exit code ${code}).`)));
      });
    });
    // After the listeners: adding a 'message' listener refs the worker again.
    // Unreferenced, a running setup never keeps the process alive on its own.
    worker.unref();
    // The lock is released when `done` settles; wait for the thread to end
    // first, so no worker is still touching the cache once the lock is free.
    const finished = done.then(
      async (r) => {
        await exit;
        return r;
      },
      async (err: unknown) => {
        if (!exited) await worker.terminate();
        throw err;
      },
    );
    return {
      done: finished,
      async stop() {
        if (!exited) await worker.terminate();
        await finished.catch(() => {});
      },
    };
  };
}

export class SetupJob {
  private state: SetupState = 'idle';
  private options: Omit<SetupInput, 'home'> | null = null;
  private startedAt: number | null = null;
  private finishedAt: number | null = null;
  private progress: string[] = [];
  private result: SetupResult | null = null;
  private error: string | null = null;
  private run: SetupRun | null = null;
  private running: Promise<void> | null = null;
  private release: (() => void) | null = null;
  private readonly onExit = () => this.release?.();

  constructor(
    readonly home: string,
    private readonly runner: SetupRunner = workerRunner(),
    private readonly now: () => number = Date.now,
  ) {}

  get isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Start a setup in the background. Throws SetupBusyError when this job or
   * another process (a terminal `screentrackr setup`) is already running one.
   */
  start(options: Omit<SetupInput, 'home'>): SetupJobStatus {
    if (this.state === 'running') throw new Error('Setup is already running.');
    const release = acquireSetupLock(this.home);
    this.release = release;
    // If the process exits mid-setup the worker dies with it: drop the lock now.
    process.once('exit', this.onExit);

    this.state = 'running';
    this.options = { ...options };
    this.startedAt = this.now();
    this.finishedAt = null;
    this.progress = [];
    this.result = null;
    this.error = null;

    const onProgress = (msg: string) => {
      this.progress.push(msg);
      if (this.progress.length > PROGRESS_LINES) this.progress.splice(0, this.progress.length - PROGRESS_LINES);
    };
    let run: SetupRun;
    try {
      run = this.runner({ home: this.home, ...options }, onProgress);
    } catch (err) {
      run = { done: Promise.reject(err instanceof Error ? err : new Error(String(err))), stop: async () => {} };
    }
    this.run = run;
    this.running = run.done
      .then(
        (result) => {
          this.result = result;
          this.state = 'succeeded';
        },
        (err: unknown) => {
          this.error = err instanceof Error ? err.message : String(err);
          this.state = 'failed';
        },
      )
      .finally(() => {
        this.finishedAt = this.now();
        this.run = null;
        this.running = null;
        release();
        this.release = null;
        process.off('exit', this.onExit);
      });
    return this.status();
  }

  /** Resolves once the current run (if any) has finished. */
  async settled(): Promise<void> {
    await this.running;
  }

  /** Stop a running setup (the server is shutting down) and release its lock. */
  async stop(): Promise<void> {
    await this.run?.stop();
    await this.settled();
  }

  status(): SetupJobStatus {
    const end = this.finishedAt ?? this.now();
    return {
      state: this.state,
      options: this.options ? { ...this.options } : null,
      startedAt: this.startedAt !== null ? new Date(this.startedAt).toISOString() : null,
      finishedAt: this.finishedAt !== null ? new Date(this.finishedAt).toISOString() : null,
      elapsedSeconds: this.startedAt !== null ? Math.round((end - this.startedAt) / 1000) : null,
      progress: [...this.progress],
      result: this.result,
      error: this.error,
    };
  }
}

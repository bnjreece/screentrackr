/**
 * The background catalog setup behind the MCP `setup_catalog` and
 * `catalog_status` tools. Setup downloads about 1 GB and takes minutes, far
 * longer than an MCP request may wait, so `start` returns at once and the
 * client polls `status`. The work runs in a worker thread with its own
 * database connection (Claude Desktop's built-in Node cannot spawn a child
 * `node` process); if worker threads are unavailable it runs on this thread.
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDb } from '../core/db.js';
import { runSetup, SETUP_LOCK_FILE, setupLockHolder, SetupBusyError, type SetupResult } from '../core/setup.js';

export interface SetupInput {
  home: string;
  refresh: boolean;
  withCast: boolean;
  includeTvMovies: boolean;
}

/** Runs one setup to completion, reporting progress lines as it goes. */
export type SetupRunner = (input: SetupInput, onProgress: (msg: string) => void) => Promise<SetupResult>;

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

/** Run setup on this thread with a second database connection. */
export const inProcessRunner: SetupRunner = async (input, onProgress) => {
  const db = openDb(input.home);
  try {
    return await runSetup(db, { ...input, onProgress });
  } finally {
    db.close();
  }
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
    // Never keep the process alive just for setup: when the client disconnects
    // the server exits, and the next setup_catalog continues from the cache.
    worker.unref();
    return new Promise<SetupResult>((resolve, reject) => {
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
      worker.on('exit', (code) => settle(() => reject(new Error(`Setup stopped unexpectedly (worker exit code ${code}).`))));
    });
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
  private running: Promise<void> | null = null;
  private readonly onExit = () => {
    // The worker dies with the process; drop its lock so the next run needn't wait for staleness.
    if (this.state === 'running') rmSync(join(this.home, SETUP_LOCK_FILE), { force: true });
  };

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
    if (this.state === 'running') throw new SetupBusyError(process.pid);
    const holder = setupLockHolder(this.home);
    if (holder !== null) throw new SetupBusyError(holder);

    this.state = 'running';
    this.options = { ...options };
    this.startedAt = this.now();
    this.finishedAt = null;
    this.progress = [];
    this.result = null;
    this.error = null;
    process.once('exit', this.onExit);

    const onProgress = (msg: string) => {
      this.progress.push(msg);
      if (this.progress.length > PROGRESS_LINES) this.progress.splice(0, this.progress.length - PROGRESS_LINES);
    };
    let run: Promise<SetupResult>;
    try {
      run = this.runner({ home: this.home, ...options }, onProgress);
    } catch (err) {
      run = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    this.running = run.then(
      (result) => {
        this.result = result;
        this.state = 'succeeded';
      },
      (err: unknown) => {
        this.error = err instanceof Error ? err.message : String(err);
        this.state = 'failed';
      },
    ).finally(() => {
      this.finishedAt = this.now();
      this.running = null;
      process.off('exit', this.onExit);
    });
    return this.status();
  }

  /** Resolves once the current run (if any) has finished. For tests and shutdown. */
  async settled(): Promise<void> {
    await this.running;
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

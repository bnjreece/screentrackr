/**
 * Worker thread entry for the MCP `setup_catalog` tool. Runs the same setup
 * as `screentrackr setup` on its own database connection, so the MCP server's
 * thread stays free to answer requests during the several minutes it takes.
 * Messages to the parent: { type: 'progress', message }, then exactly one of
 * { type: 'done', result } or { type: 'error', message }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../core/db.js';
import { runSetup } from '../core/setup.js';
import type { SetupInput } from './setup-job.js';

const port = parentPort;
if (!port) throw new Error('setup-worker must run as a worker thread');

const input = workerData as SetupInput;
let db: ReturnType<typeof openDb> | null = null;
try {
  db = openDb(input.home);
  const result = await runSetup(db, {
    refresh: input.refresh,
    withCast: input.withCast,
    includeTvMovies: input.includeTvMovies,
    matchOnly: input.matchOnly,
    // The parent SetupJob took the setup lock for this run.
    lockHeld: true,
    onProgress: (message) => port.postMessage({ type: 'progress', message }),
  });
  port.postMessage({ type: 'done', result });
} catch (err) {
  port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
} finally {
  db?.close();
}

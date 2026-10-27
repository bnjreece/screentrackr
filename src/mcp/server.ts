/**
 * The screentrackr MCP server. Tool definitions live in src/mcp/tools/, one
 * module per area; every tool validates its input with zod and calls core/,
 * the same code the CLI runs, so the two never disagree. Each tool returns
 * `structuredContent` (JSON) plus one short text summary (at most 20 lines).
 * User errors come back as tool errors (`isError: true`), never as crashes.
 *
 * Over stdio, stdout carries JSON-RPC only. Nothing here writes to stdout.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Db } from '../core/db.js';
import { SetupJob } from './setup-job.js';
import type { RegisterTools, ToolContext } from './tools/common.js';
import { register as historyTools } from './tools/history.js';
import { register as libraryTools } from './tools/library.js';
import { register as listsTools } from './tools/lists.js';
import { register as movieTools } from './tools/movie.js';
import { register as pickTools } from './tools/pick.js';
import { register as searchTools } from './tools/search.js';
import { register as setupTools } from './tools/setup.js';
import { register as statsTools } from './tools/stats.js';
import { register as whereTools } from './tools/where.js';

export { SETUP_HINT } from './tools/common.js';

/** Every tool module, in the order their tools are listed. */
const MODULES: readonly RegisterTools[] = [searchTools, movieTools, statsTools, libraryTools, setupTools, historyTools, pickTools, whereTools, listsTools];

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface McpServerOptions {
  /** The background setup used by setup_catalog and catalog_status. Defaults to a worker-thread job over db.home. */
  setupJob?: SetupJob;
}

/**
 * Build the MCP server over an open database. The caller owns `db` and its
 * lifetime; connect the returned server to any transport.
 */
export function createMcpServer(db: Db, opts: McpServerOptions = {}): McpServer {
  const ctx: ToolContext = { db, setupJob: opts.setupJob ?? new SetupJob(db.home) };
  const server = new McpServer(
    { name: 'screentrackr', version: version() },
    {
      instructions:
        'screentrackr knows the user\'s movie library (status, own rating) and the IMDb catalog. Use search_movies for questions about what to watch; write tools take a library id or tconst, never a title. If a tool says the catalog is not built, offer to run setup_catalog, then poll catalog_status until it finishes.',
    },
  );
  for (const register of MODULES) register(server, ctx);
  return server;
}

/**
 * Serve over stdio until the client disconnects (stdin ends). Resolves once
 * the server has closed. All diagnostics go to stderr.
 */
export async function serveStdio(db: Db): Promise<void> {
  const setupJob = new SetupJob(db.home);
  const server = createMcpServer(db, { setupJob });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  const stop = () => {
    void server.close();
  };
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  try {
    await server.connect(transport);
    await closed;
  } finally {
    process.stdin.off('end', stop);
    process.stdin.off('close', stop);
    // The client is gone: don't leave a setup downloading in the background.
    await setupJob.stop();
  }
}

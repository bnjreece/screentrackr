/**
 * Shared pieces of the MCP tool modules: the result and error helpers, the
 * id and tconst input schemas, and the short text formatters. Every tool
 * module exports a `register(server, ctx)` that server.ts calls once.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../../core/db.js';
import { LibraryError } from '../../core/library.js';
import { CatalogMissingError } from '../../core/search.js';
import type { LibraryItem } from '../../core/types.js';
import type { SetupJob } from '../setup-job.js';

/** What every tool module gets: the open database and the background setup job. */
export interface ToolContext {
  db: Db;
  setupJob: SetupJob;
}

/** A tool module: registers its tools on the server. */
export type RegisterTools = (server: McpServer, ctx: ToolContext) => void;

/** The most lines a text summary may have. */
export const MAX_TEXT_LINES = 20;

export const TCONST_RE = /^tt\d{7,}$/i;

export const id = z.number().int().min(1).describe('Library item id (from search results or get_movie).');
export const tconst = z.string().trim().regex(TCONST_RE, 'Expected an IMDb id such as tt0123456').describe('IMDb id, e.g. tt0123456.');

/** A user-facing tool failure, reported as `isError: true` with this message. */
export class ToolInputError extends LibraryError {}

export function ok(data: object, text: string): CallToolResult {
  const lines = text.split('\n');
  const capped = lines.length > MAX_TEXT_LINES ? [...lines.slice(0, MAX_TEXT_LINES - 1), '...'] : lines;
  return { structuredContent: data as Record<string, unknown>, content: [{ type: 'text', text: capped.join('\n') }] };
}

/** Appended to "Catalog not built" errors: an MCP-only user can build it without a terminal. */
export const SETUP_HINT = 'Or call the setup_catalog tool to build it from here (a one-time download of about 1 GB that takes several minutes).';

export function fail(err: unknown): CallToolResult {
  let message = err instanceof Error ? err.message : String(err);
  if (err instanceof CatalogMissingError) message = `${message} ${SETUP_HINT}`;
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wrap a tool body so any thrown error becomes a tool error result. */
export function handler<A>(fn: (args: A) => CallToolResult): (args: A) => CallToolResult {
  return (args) => {
    try {
      return fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

export const LINKED = new Set(['matched', 'manual']);

export function yearPart(year: number | null): string {
  return year !== null ? ` (${year})` : '';
}

export function itemLine(i: LibraryItem): string {
  const bits = [`#${i.id}`, `${i.sourceTitle}${yearPart(i.sourceYear)}`, i.status];
  if (i.watchedEra) bits.push(`watched ${i.watchedEra}`);
  if (i.myRating !== null) bits.push(`my rating ${i.myRating}`);
  if (i.sourceRuntimeMin !== null) bits.push(`${i.sourceRuntimeMin} min`);
  return bits.join(', ');
}

export function ambiguousError(ref: string, items: LibraryItem[], what: string): ToolInputError {
  return new ToolInputError(
    `${ref} matches ${items.length} library items (editions). ${what} by id instead:\n${items.map((i) => `  ${itemLine(i)}`).join('\n')}`,
  );
}

export function exactlyOne(args: { id?: number | undefined; tconst?: string | undefined }): void {
  if ((args.id === undefined) === (args.tconst === undefined)) throw new ToolInputError('Pass exactly one of id or tconst.');
}

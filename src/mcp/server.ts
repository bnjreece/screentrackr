/**
 * The screentrackr MCP server. Tool definitions only: every tool validates its
 * input with zod and calls core/, the same code the CLI runs, so the two never
 * disagree. Each tool returns `structuredContent` (JSON) plus one short text
 * summary (at most 20 lines). User errors come back as tool errors
 * (`isError: true`), never as crashes.
 *
 * Over stdio, stdout carries JSON-RPC only. Nothing here writes to stdout.
 */
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { catalogReady, type Db } from '../core/db.js';
import { ALL_SCOPE_MIN_VOTES, FilterShape } from '../core/filters.js';
import { addFromCatalog, getItem, LibraryError, removeItem, resolveRef, updateItem, type ItemPatch } from '../core/library.js';
import { getCatalogMovie, type CatalogMovie } from '../core/movie.js';
import { CatalogMissingError, searchMovies, type MovieResult } from '../core/search.js';
import { libraryStats } from '../core/stats.js';
import { STATUSES, WATCHED_ERAS, type LibraryItem } from '../core/types.js';

/** The most lines a text summary may have. */
const MAX_TEXT_LINES = 20;

const TCONST_RE = /^tt\d{7,}$/i;

const id = z.number().int().min(1).describe('Library item id (from search results or get_movie).');
const tconst = z.string().trim().regex(TCONST_RE, 'Expected an IMDb id such as tt0123456').describe('IMDb id, e.g. tt0123456.');

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** A user-facing tool failure, reported as `isError: true` with this message. */
class ToolInputError extends LibraryError {}

function ok(data: object, text: string): CallToolResult {
  const lines = text.split('\n');
  const capped = lines.length > MAX_TEXT_LINES ? [...lines.slice(0, MAX_TEXT_LINES - 1), '...'] : lines;
  return { structuredContent: data as Record<string, unknown>, content: [{ type: 'text', text: capped.join('\n') }] };
}

function fail(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

/** Wrap a tool body so any thrown error becomes a tool error result. */
function handler<A>(fn: (args: A) => CallToolResult): (args: A) => CallToolResult {
  return (args) => {
    try {
      return fn(args);
    } catch (err) {
      return fail(err);
    }
  };
}

const LINKED = new Set(['matched', 'manual']);

function yearPart(year: number | null): string {
  return year !== null ? ` (${year})` : '';
}

function resultLine(r: MovieResult): string {
  const parts = [`${r.title}${yearPart(r.year)}`];
  if (r.rating !== null) parts.push(`IMDb ${r.rating.toFixed(1)}`);
  if (r.runtimeMin !== null) parts.push(`${r.runtimeMin} min`);
  if (r.directors.length) parts.push(r.directors.slice(0, 2).join(', '));
  if (r.library) {
    const lib = [`#${r.library.id}`, r.library.status];
    if (r.library.myRating !== null) lib.push(`my ${r.library.myRating}`);
    if (r.library.editions > 1) lib.push(`${r.library.editions} editions`);
    parts.push(`[${lib.join(' ')}]`);
  } else parts.push('[not in library]');
  return `- ${parts.join(' | ')}${r.tconst ? ` ${r.tconst}` : ''}`;
}

function searchText(total: number, offset: number, results: MovieResult[]): string {
  if (results.length === 0) return total === 0 ? 'No movies match.' : `No results on this page (${total} match in all).`;
  const head = `${total} match. Showing ${offset + 1} to ${offset + results.length}:`;
  const room = MAX_TEXT_LINES - 2;
  const shown = results.slice(0, room).map(resultLine);
  const more = results.length - shown.length;
  return [head, ...shown, ...(more > 0 ? [`... ${more} more in structuredContent.results`] : [])].join('\n');
}

function itemLine(i: LibraryItem): string {
  const bits = [`#${i.id}`, `${i.sourceTitle}${yearPart(i.sourceYear)}`, i.status];
  if (i.watchedEra) bits.push(`watched ${i.watchedEra}`);
  if (i.myRating !== null) bits.push(`my rating ${i.myRating}`);
  if (i.sourceRuntimeMin !== null) bits.push(`${i.sourceRuntimeMin} min`);
  return bits.join(', ');
}

function movieText(movie: CatalogMovie | null, items: LibraryItem[]): string {
  const lines: string[] = [];
  if (movie) {
    lines.push(`${movie.title}${yearPart(movie.year)} ${movie.tconst}`);
    if (movie.rating !== null) lines.push(`IMDb ${movie.rating.toFixed(1)} (${movie.votes ?? 0} votes)`);
    if (movie.runtimeMin !== null) lines.push(`${movie.runtimeMin} min`);
    if (movie.genres.length) lines.push(`Genres: ${movie.genres.join(', ')}`);
    if (movie.directors.length) lines.push(`Directed by ${movie.directors.join(', ')}`);
    if (movie.cast.length) lines.push(`Cast: ${movie.cast.join(', ')}`);
  }
  if (items.length === 0) lines.push('Not in your library.');
  else lines.push(`In your library:`, ...items.map((i) => `  ${itemLine(i)}`));
  return lines.join('\n');
}

function ambiguousError(ref: string, items: LibraryItem[], what: string): ToolInputError {
  return new ToolInputError(
    `${ref} matches ${items.length} library items (editions). ${what} by id instead:\n${items.map((i) => `  ${itemLine(i)}`).join('\n')}`,
  );
}

function exactlyOne(args: { id?: number | undefined; tconst?: string | undefined }): void {
  if ((args.id === undefined) === (args.tconst === undefined)) throw new ToolInputError('Pass exactly one of id or tconst.');
}

const SEARCH_DESCRIPTION = [
  'Search movies in your library (default) or in the whole IMDb-derived catalog.',
  'Filters combine with OR within a list and AND across fields: directors ["Fincher", "Villeneuve"] with genres ["Thriller"] means (Fincher OR Villeneuve) AND Thriller.',
  'Names match partially and case-insensitively. genreMode "all" requires every listed genre.',
  '"Unwatched" (unwatched: true) means status queue, priority or someday; status lists exact statuses (queue, priority, someday, watched).',
  'scope: "all" searches every movie in the catalog, annotated with your library status; add notInLibrary: true to find movies you do not own, for example "what should I buy or rent" (unwatched may be added and changes nothing, since a movie you do not have is unwatched).',
  'Genres: IMDb tags at most three genres per movie, so a strict genre filter can miss movies people think of as that genre (Se7en is Crime, Drama, Mystery). In library scope, the store genre (Apple TV) of an owned movie also counts; scope "all" uses IMDb genres only. If a combined query returns nothing, say which filter excluded the near misses and offer to relax it.',
  `Ratings (minRating, sort "rating") are IMDb ratings from 0 to 10. minVotes defaults to ${ALL_SCOPE_MIN_VOTES} for scope "all" (so obscure titles do not flood results) and 0 for your library; myRatingMin filters on your own 1 to 10 rating.`,
  'Runtimes are in minutes. limit defaults to 20 (max 200); page with offset. Library movies that could not be matched to IMDb still appear, using their own title, director, genre and runtime, with matchStatus "unmatched".',
].join(' ');

/**
 * Build the MCP server over an open database. The caller owns `db` and its
 * lifetime; connect the returned server to any transport.
 */
export function createMcpServer(db: Db): McpServer {
  const server = new McpServer(
    { name: 'screentrackr', version: version() },
    {
      instructions:
        'screentrackr knows the user\'s movie library (status, own rating) and the IMDb catalog. Use search_movies for questions about what to watch; write tools take a library id or tconst, never a title.',
    },
  );

  server.registerTool(
    'search_movies',
    {
      title: 'Search movies',
      description: SEARCH_DESCRIPTION,
      inputSchema: FilterShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      const out = searchMovies(db, args);
      return ok(out, searchText(out.total, args.offset ?? 0, out.results));
    }),
  );

  server.registerTool(
    'get_movie',
    {
      title: 'Get one movie',
      description:
        'One movie by library id or IMDb tconst (exactly one). Returns the catalog record (genres, directors, cast, IMDb rating) and every library item matched or linked to it: a tconst can have more than one edition.',
      inputSchema: { id: id.optional(), tconst: tconst.optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      exactlyOne(args);
      let items: LibraryItem[];
      let movie: CatalogMovie | null = null;
      if (args.id !== undefined) {
        const item = getItem(db, args.id);
        if (!item) throw new ToolInputError(`Item ${args.id} not found`);
        items = [item];
        if (item.tconst && LINKED.has(item.matchStatus)) movie = getCatalogMovie(db, item.tconst);
      } else {
        const t = (args.tconst as string).toLowerCase();
        const r = resolveRef(db, t);
        items = r.kind === 'one' ? [r.item] : r.kind === 'many' ? r.items : [];
        movie = getCatalogMovie(db, t);
        if (!movie && items.length === 0) {
          throw catalogReady(db) ? new ToolInputError(`No movie ${t} in the catalog or your library`) : new CatalogMissingError();
        }
      }
      return ok({ movie, library: items }, movieText(movie, items));
    }),
  );

  server.registerTool(
    'library_stats',
    {
      title: 'Library stats',
      description: 'Counts for your library: total, by status, unmatched and ambiguous IMDb matches, top genres, top directors and movies by decade.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler(() => {
      const s = libraryStats(db);
      const text = [
        `${s.total} movies: ${STATUSES.map((st) => `${s.byStatus[st]} ${st}`).join(', ')}.`,
        `Unmatched ${s.unmatched}, ambiguous ${s.ambiguous}.`,
        ...(s.topGenres.length ? [`Top genres: ${s.topGenres.slice(0, 5).map(([g, n]) => `${g} ${n}`).join(', ')}`] : []),
        ...(s.topDirectors.length ? [`Top directors: ${s.topDirectors.slice(0, 5).map(([d, n]) => `${d} ${n}`).join(', ')}`] : []),
        ...(s.byDecade.length ? [`By decade: ${s.byDecade.map(([d, n]) => `${d} ${n}`).join(', ')}`] : []),
      ].join('\n');
      return ok(s, text);
    }),
  );

  server.registerTool(
    'update_movie',
    {
      title: 'Update a library movie',
      description:
        'Set status, watched era, watched date or your rating on one library item, by id or tconst (exactly one). A tconst finds only items matched or linked to it (the IMDb id stored on an unmatched item is an unchecked hint; use its id). A tconst with more than one library edition is rejected with the ids; pass id then. watchedEra only applies to status watched. myRating null clears it; watchedAt null clears the date.',
      inputSchema: {
        id: id.optional(),
        tconst: tconst.optional(),
        status: z.enum(STATUSES).optional().describe('queue, priority, someday or watched.'),
        watchedEra: z.enum(WATCHED_ERAS).nullable().optional().describe('When you watched it: long-ago, 2010s or 2020s.'),
        watchedAt: z.string().trim().nullable().optional().describe('Watched date, YYYY-MM-DD.'),
        myRating: z.number().int().min(1).max(10).nullable().optional().describe('Your rating, 1 to 10; null clears.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler((args) => {
      exactlyOne(args);
      const patch: ItemPatch = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.watchedEra !== undefined) patch.watchedEra = args.watchedEra;
      if (args.watchedAt !== undefined) patch.watchedAt = args.watchedAt;
      if (args.myRating !== undefined) patch.myRating = args.myRating;
      if (Object.keys(patch).length === 0) throw new ToolInputError('Nothing to change. Pass status, watchedEra, watchedAt or myRating.');

      let targetId: number;
      if (args.id !== undefined) targetId = args.id;
      else {
        const t = (args.tconst as string).toLowerCase();
        const r = resolveRef(db, t);
        if (r.kind === 'many') throw ambiguousError(t, r.items, 'Update one');
        if (r.kind === 'none') throw new ToolInputError(`${t} is not in your library`);
        targetId = r.item.id;
      }
      const item = updateItem(db, targetId, patch);
      return ok(item, `Updated ${itemLine(item)}.`);
    }),
  );

  server.registerTool(
    'add_to_library',
    {
      title: 'Add a movie to the library',
      description:
        'Add a catalog movie (by IMDb tconst) to your library, status queue unless given. If the movie is already in your library this fails listing the existing ids; pass newEdition: true to add another edition on purpose.',
      inputSchema: {
        tconst,
        status: z.enum(STATUSES).optional().describe('Initial status (default queue).'),
        newEdition: z.boolean().optional().describe('Add even when the movie is already in your library.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      if (!catalogReady(db)) throw new CatalogMissingError();
      const t = args.tconst.toLowerCase();
      if (!args.newEdition) {
        const existing = resolveRef(db, t);
        const items = existing.kind === 'one' ? [existing.item] : existing.kind === 'many' ? existing.items : [];
        if (items.length) {
          throw new ToolInputError(
            `${t} is already in your library. Pass newEdition: true to add another edition.\n${items.map((i) => `  ${itemLine(i)}`).join('\n')}`,
          );
        }
      }
      const item = addFromCatalog(db, t, args.status ? { status: args.status } : {});
      return ok(item, `Added ${itemLine(item)}.`);
    }),
  );

  server.registerTool(
    'remove_from_library',
    {
      title: 'Remove a library item',
      description: 'Permanently remove one library item by id, including its status, rating and notes. This cannot be undone.',
      inputSchema: { id },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      const item = getItem(db, args.id);
      if (!item) throw new ToolInputError(`Item ${args.id} not found`);
      removeItem(db, args.id);
      return ok({ removed: item }, `Removed ${itemLine(item)}.`);
    }),
  );

  return server;
}

/**
 * Serve over stdio until the client disconnects (stdin ends). Resolves once
 * the server has closed. All diagnostics go to stderr.
 */
export async function serveStdio(db: Db): Promise<void> {
  const server = createMcpServer(db);
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
  }
}

/** get_movie and update_movie: one movie, its library items, their plays and lists. */
import { z } from 'zod';
import { catalogReady, type Db } from '../../core/db.js';
import { getItem, resolveRef, updateItemDetailed, type ItemPatch } from '../../core/library.js';
import { listsOfItem } from '../../core/lists.js';
import { getCatalogMovie, type CatalogMovie } from '../../core/movie.js';
import { CatalogMissingError } from '../../core/search.js';
import { STATUSES, WATCHED_ERAS, type LibraryItem } from '../../core/types.js';
import { countPlays, viewingsOf, type Viewing } from '../../core/viewings.js';
import { ambiguousError, exactlyOne, handler, id, itemLine, LINKED, ok, tconst, ToolInputError, yearPart, type RegisterTools } from './common.js';

/** A library item as get_movie returns it: the item, every play (newest first), the play count and its lists. */
export type MovieLibraryItem = LibraryItem & { viewings: Viewing[]; plays: number; lists: string[] };

export function withHistory(db: Db, item: LibraryItem): MovieLibraryItem {
  const viewings = viewingsOf(db, item.id);
  return { ...item, viewings, plays: countPlays(viewings), lists: listsOfItem(db, item.id) };
}

function movieText(movie: CatalogMovie | null, items: MovieLibraryItem[]): string {
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
  else {
    lines.push(`In your library:`);
    for (const i of items) {
      const extra = [i.plays ? `${i.plays} play${i.plays === 1 ? '' : 's'}${i.watchedAt ? `, last ${i.watchedAt.slice(0, 10)}` : ''}` : '', i.lists.length ? `lists: ${i.lists.join(', ')}` : '']
        .filter(Boolean)
        .join('; ');
      lines.push(`  ${itemLine(i)}${extra ? ` (${extra})` : ''}`);
    }
  }
  return lines.join('\n');
}

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'get_movie',
    {
      title: 'Get one movie',
      description:
        'One movie by library id or IMDb tconst (exactly one). Returns the catalog record (genres, directors, cast, IMDb rating) and every library item matched or linked to it: a tconst can have more than one edition. Each library item carries its plays (viewings, newest first, with date, rewatch flag, rating and source), a play count and the names of your lists it is in.',
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
      const library = items.map((i) => withHistory(db, i));
      return ok({ movie, library }, movieText(movie, library));
    }),
  );

  server.registerTool(
    'update_movie',
    {
      title: 'Update a library movie',
      description:
        'Set status, watched era, watched date or your rating on one library item, by id or tconst (exactly one). A tconst finds only items matched or linked to it (the IMDb id stored on an unmatched item is an unchecked hint; use its id). A tconst with more than one library edition is rejected with the ids; pass id then. watchedEra only applies to status watched. myRating null clears it. The watched date is the latest play: watchedAt adds a play on that date, and a date earlier than a play the item already has is refused, naming that play; watchedAt null removes every play of the item and says how many.',
      inputSchema: {
        id: id.optional(),
        tconst: tconst.optional(),
        status: z.enum(STATUSES).optional().describe('queue, priority, someday or watched.'),
        watchedEra: z.enum(WATCHED_ERAS).nullable().optional().describe('When you watched it: long-ago, 2010s or 2020s.'),
        watchedAt: z.string().trim().nullable().optional().describe('Watched date, YYYY-MM-DD: adds a play on that date. null removes every play.'),
        myRating: z.number().int().min(1).max(10).nullable().optional().describe('Your rating, 1 to 10; null clears.'),
      },
      // watchedAt null deletes every play of the item (dates, ratings, refs): destructive.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
      const { item, viewingsRemoved } = updateItemDetailed(db, targetId, patch);
      const removed = args.watchedAt === null ? ` Removed ${viewingsRemoved} play${viewingsRemoved === 1 ? '' : 's'}.` : '';
      return ok({ ...item, ...(args.watchedAt === null ? { viewingsRemoved } : {}) }, `Updated ${itemLine(item)}.${removed}`);
    }),
  );
};

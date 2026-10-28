/** Watch history tools: log_viewing, list_viewings, remove_viewing. The same core as `log` and `history` (core/history.ts). */
import { z } from 'zod';
import type { Db } from '../../core/db.js';
import { HISTORY_DEFAULT_LIMIT, historyPlays, logViewing, removePlay, type HistoryPlay, type HistoryQuery } from '../../core/history.js';
import { getItem, resolveRef } from '../../core/library.js';
import { ITEM_SOURCES } from '../../core/types.js';
import { ambiguousError, handler, id, itemLine, ok, tconst, ToolInputError, yearPart, type RegisterTools } from './common.js';

const day = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');

/** The one library item an id or tconst names (a tconst with two editions is refused with their ids). */
function targetId(db: Db, args: { id?: number | undefined; tconst?: string | undefined }, what: string): number {
  if (args.id !== undefined) {
    if (!getItem(db, args.id)) throw new ToolInputError(`Item ${args.id} not found`);
    return args.id;
  }
  const t = (args.tconst as string).toLowerCase();
  const r = resolveRef(db, t);
  if (r.kind === 'many') throw ambiguousError(t, r.items, what);
  if (r.kind === 'none') throw new ToolInputError(`${t} is not in your library`);
  return r.item.id;
}

function playText(p: HistoryPlay): string {
  return [
    p.date ?? 'no date',
    p.rewatch ? 'rewatch' : '',
    `#${p.itemId} ${p.title}${yearPart(p.year)}`,
    p.sources.join('+'),
    p.rating !== null ? `rated ${p.rating}` : '',
    `viewing ${p.viewings.map((v) => v.id).join(', ')}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export const register: RegisterTools = (server, { db }) => {
  server.registerTool(
    'log_viewing',
    {
      title: 'Log a play',
      description:
        "Record that you watched one library movie, by id or tconst (exactly one). date is YYYY-MM-DD (default today, local time; more than a day ahead is refused). Each call is its own play. Marks the movie watched unless keepStatus. rating (1 to 10) is the rating at this play and also becomes the movie's rating. rewatch says whether it was a rewatch; leave it out and a play with an earlier play of the movie counts as one.",
      inputSchema: {
        id: id.optional(),
        tconst: tconst.optional(),
        date: z.string().trim().optional().describe('The date you watched it, YYYY-MM-DD (or an ISO date-time). Default today.'),
        rewatch: z.boolean().optional().describe('Whether this play was a rewatch. Omit to derive it from earlier plays.'),
        rating: z.number().int().min(1).max(10).optional().describe("Your rating at this play, 1 to 10 (also the movie's rating)."),
        keepStatus: z.boolean().optional().describe('Leave the status as it is instead of setting watched.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      if ((args.id === undefined) === (args.tconst === undefined)) throw new ToolInputError('Pass exactly one of id or tconst.');
      const itemId = targetId(db, args, 'Log one');
      const res = logViewing(db, itemId, {
        ...(args.date !== undefined ? { date: args.date } : {}),
        ...(args.rewatch !== undefined ? { rewatch: args.rewatch } : {}),
        ...(args.rating !== undefined ? { rating: args.rating } : {}),
        keepStatus: args.keepStatus === true,
      });
      return ok(res, `Logged a play on ${res.viewing.watchedAt ?? ''} (viewing ${res.viewing.id}): ${itemLine(res.item)}. Plays: ${res.plays}.`);
    }),
  );

  server.registerTool(
    'list_viewings',
    {
      title: 'List plays',
      description: `Your plays, newest first (plays with no known date last), for one library movie (id or tconst) or the whole library. One night recorded by two sources (Letterboxd and Trakt, say) is one play listing both sources and both viewing ids. rewatch is the source's own flag, else whether an earlier play of the film exists. year, from and to (YYYY-MM-DD, inclusive) and source narrow it; dateless plays match no date filter. total counts every match; limit (default ${HISTORY_DEFAULT_LIMIT}) caps how many come back.`,
      inputSchema: {
        id: id.optional(),
        tconst: tconst.optional(),
        year: z.number().int().min(1000).max(9999).optional().describe('Plays in this calendar year.'),
        from: day.optional().describe('Plays on or after this date.'),
        to: day.optional().describe('Plays on or before this date.'),
        source: z.enum(ITEM_SOURCES).optional().describe('Plays recorded by this source (manual is one you logged or set).'),
        limit: z.number().int().min(1).max(1000).optional().describe(`How many plays to return (default ${HISTORY_DEFAULT_LIMIT}).`),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    handler((args) => {
      if (args.id !== undefined && args.tconst !== undefined) throw new ToolInputError('Pass at most one of id or tconst.');
      const q: HistoryQuery = { limit: args.limit ?? HISTORY_DEFAULT_LIMIT };
      if (args.id !== undefined || args.tconst !== undefined) q.itemId = targetId(db, args, 'List one');
      if (args.year !== undefined) q.year = args.year;
      if (args.from !== undefined) q.from = args.from;
      if (args.to !== undefined) q.to = args.to;
      if (args.source !== undefined) q.source = args.source;
      const res = historyPlays(db, q);
      const text = res.total
        ? [`${res.total} play${res.total === 1 ? '' : 's'}${res.total > res.plays.length ? `, showing ${res.plays.length}` : ''}:`, ...res.plays.map(playText)].join('\n')
        : 'No plays match.';
      return ok(res, text);
    }),
  );

  server.registerTool(
    'remove_viewing',
    {
      title: 'Remove a play',
      description:
        "Delete one viewing by its id (from list_viewings or get_movie), never by title. The movie's watched date becomes its latest play left. Plays recorded by an import can come back if that source is imported again with the play still in it.",
      inputSchema: { viewingId: z.number().int().min(1).describe('The viewing id.') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    handler((args) => {
      const res = removePlay(db, args.viewingId);
      return ok(res, `Removed viewing ${res.removed.id} (${res.removed.watchedAt ?? 'no date'}, from ${res.removed.source}) of ${itemLine(res.item)}.`);
    }),
  );
};

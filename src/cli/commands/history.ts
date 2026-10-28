/** `screentrackr log` and `screentrackr history`: record plays and list them (core/history.ts, shared with MCP). */
import type { Db } from '../../core/db.js';
import { HISTORY_DEFAULT_LIMIT, historyPlays, logViewing, removePlay, type HistoryPlay, type HistoryQuery } from '../../core/history.js';
import { resolveRef } from '../../core/library.js';
import { ITEM_SOURCES, type ItemSource, type LibraryItem } from '../../core/types.js';
import { toId, toInt } from '../args.js';
import { bool, str, type Command } from '../command.js';
import { UserError } from '../context.js';
import { itemLine } from '../format.js';

/** Resolve a reference to exactly one library item, or fail listing what it matched (never guesses). */
function oneItem(db: Db, ref: string, hint: string): LibraryItem {
  const r = resolveRef(db, ref);
  if (r.kind === 'one') return r.item;
  if (r.kind === 'many') {
    throw new UserError(`"${ref}" matches ${r.items.length} library items. ${hint}\n${r.items.map(itemLine).join('\n')}`, {
      candidates: r.items.map((i) => ({ id: i.id, title: i.sourceTitle, year: i.sourceYear, runtimeMin: i.sourceRuntimeMin, tconst: i.tconst, status: i.status })),
    });
  }
  throw new UserError(`No library item matches "${ref}"`);
}

const titleOf = (title: string, year: number | null) => `${title}${year !== null ? ` (${year})` : ''}`;

export const log: Command = {
  name: 'log',
  summary: 'Record a play of a movie (default today)',
  usage: 'log <id|tconst|title> [--on <date>] [--rewatch] [--rating <1-10>] [--keep-status]',
  details: [
    'Each `log` is its own play, so two logged on one day stay two (history and counts still show one night as one play).',
    'The movie is marked watched unless --keep-status. --rating also sets the movie\'s rating, as a diary entry does. A date more than a day ahead is refused.',
    'A play is a rewatch when you say so (--rewatch), or when you say nothing and an earlier play of the movie exists.',
  ].join('\n'),
  options: {
    on: { type: 'string', value: '<date>', description: 'The date you watched it, YYYY-MM-DD (default today)' },
    rewatch: { type: 'boolean', description: 'Mark the play a rewatch' },
    rating: { type: 'string', value: '<1-10>', description: "Your rating at this play (also the movie's rating)" },
    'keep-status': { type: 'boolean', description: 'Leave the status as it is (default: watched)' },
  },
  run(ctx, pos, values) {
    const ref = pos.join(' ').trim();
    if (!ref) throw new UserError('Usage: screentrackr log <id|tconst|title> [--on <date>]');
    const rating = toInt('rating', str(values, 'rating'));
    const db = ctx.db();
    const target = oneItem(db, ref, 'Log one by its id:');
    const on = str(values, 'on');
    const res = logViewing(db, target.id, {
      ...(on !== undefined ? { date: on } : {}),
      ...(bool(values, 'rewatch') ? { rewatch: true } : {}),
      ...(rating !== undefined ? { rating } : {}),
      keepStatus: bool(values, 'keep-status'),
    });
    ctx.emit(res, () =>
      [
        `Logged a play of ${titleOf(res.item.sourceTitle, res.item.sourceYear)} (item ${res.item.id}) on ${res.viewing.watchedAt ?? ''}${res.viewing.rewatch ? ', a rewatch' : ''}${res.viewing.rating !== null ? `, rated ${res.viewing.rating}` : ''}: viewing ${res.viewing.id}.`,
        `Plays: ${res.plays}. Watched date: ${res.item.watchedAt ?? 'none'}. Status: ${res.item.status}.`,
      ].join('\n'),
    );
  },
};

function playLine(p: HistoryPlay): string {
  return [
    (p.date ?? 'no date').padEnd(10),
    p.rewatch ? 'R' : ' ',
    titleOf(p.title, p.year),
    p.sources.join('+'),
    p.rating !== null ? `rated ${p.rating}` : '',
    p.viewings.map((v) => `#${v.id}`).join(' '),
  ]
    .filter(Boolean)
    .join('  ');
}

export const history: Command = {
  name: 'history',
  summary: 'List your plays, newest first',
  usage: 'history [<id|tconst|title>] [--year <yyyy>] [--from <date>] [--to <date>] [--source <source>] [-n <limit>] [--remove <viewing-id>]',
  details: [
    `Each line is one play: its date, R for a rewatch, the movie, the sources that recorded it, the rating given at that play and its viewing ids (#12). One night recorded by two sources (Letterboxd and Trakt, say) is one line with both. Plays with no known date come last. Shows the newest ${HISTORY_DEFAULT_LIMIT} unless -n says otherwise.`,
    '--remove <viewing-id> deletes that one viewing (by id only, never by title); the watched date becomes the latest play left.',
    `Sources: ${ITEM_SOURCES.join(', ')} (manual is a play you logged or set).`,
  ].join('\n'),
  options: {
    year: { type: 'string', value: '<yyyy>', description: 'Plays in this calendar year' },
    from: { type: 'string', value: '<date>', description: 'Plays on or after this date, YYYY-MM-DD' },
    to: { type: 'string', value: '<date>', description: 'Plays on or before this date, YYYY-MM-DD' },
    source: { type: 'string', value: '<source>', description: 'Plays recorded by this source' },
    count: { type: 'string', short: 'n', value: '<limit>', description: `How many plays to show (default ${HISTORY_DEFAULT_LIMIT})` },
    remove: { type: 'string', value: '<viewing-id>', description: 'Delete one viewing by its id' },
  },
  run(ctx, pos, values) {
    const removeId = str(values, 'remove');
    const ref = pos.join(' ').trim();
    const year = toInt('year', str(values, 'year'));
    const limit = toInt('count', str(values, 'count'));
    const from = str(values, 'from');
    const to = str(values, 'to');
    const source = str(values, 'source');
    if (removeId !== undefined) {
      if (ref || year !== undefined || limit !== undefined || from !== undefined || to !== undefined || source !== undefined) {
        throw new UserError('--remove takes only a viewing id (from `screentrackr history`); nothing else goes with it.');
      }
      const id = toId(removeId, 'a viewing id (the #number `screentrackr history` shows)');
      const res = removePlay(ctx.db(), id);
      const v = res.removed;
      ctx.emit(res, () =>
        `Removed viewing ${v.id} (${v.watchedAt ?? 'no date'}, from ${v.source}) of ${titleOf(res.item.sourceTitle, res.item.sourceYear)} (item ${res.item.id}). Watched date: ${res.item.watchedAt ?? 'none'}.`,
      );
      return;
    }
    if (source !== undefined && !(ITEM_SOURCES as readonly string[]).includes(source)) {
      throw new UserError(`Unknown source "${source}" (expected ${ITEM_SOURCES.join(', ')})`);
    }
    if (limit !== undefined && limit < 1) throw new UserError(`-n expects a whole number from 1 (got ${limit})`);
    const db = ctx.db();
    const q: HistoryQuery = { limit: limit ?? HISTORY_DEFAULT_LIMIT };
    if (ref) q.itemId = oneItem(db, ref, 'Show one by its id:').id;
    if (year !== undefined) q.year = year;
    if (from !== undefined) q.from = from;
    if (to !== undefined) q.to = to;
    if (source !== undefined) q.source = source as ItemSource;
    const res = historyPlays(db, q);
    ctx.emit(res, () => {
      if (!res.total) return 'No plays match.';
      const lines = res.plays.map(playLine);
      if (res.total > res.plays.length) lines.push(`... ${res.total - res.plays.length} more (-n ${res.total} shows them all)`);
      lines.push(`${res.total} play${res.total === 1 ? '' : 's'}.`);
      return lines.join('\n');
    });
  },
};
